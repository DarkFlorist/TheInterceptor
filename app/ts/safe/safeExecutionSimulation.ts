import { type EthereumClientService, getGasLeftInRpcBlock, getGasUsedInLastRpcBlock } from '../simulation/services/EthereumClientService.js'
import { DEFAULT_BLOCK_MANIPULATION } from '../config/defaults.js'
import { appendTransactionsToInput, getSimulatedSafeCallNonce } from '../simulation/services/SimulationModeEthereumClientService.js'
import { type AppendedTransactionRpcBlock, estimateGasInRpcBlockItRunsIn, getGasEstimateFromSimulation } from '../simulation/services/simulationGasEstimation.js'
import { mockSignTransaction } from '../simulation/services/simulationTransactionSigning.js'
import type { ErrorWithCodeAndOptionalData } from '../types/error.js'
import type { MutableStateOverrides } from '../types/ethSimulate-types.js'
import { authorizesExecutedCall, type GasEstimationPlacement, type PreSimulationTransaction, type ResolvedSimulationState, type SimulationInputTransaction, type SimulationStateInput, type TransactionSimulationOptions } from '../types/visualizer-types.js'
import type { EthereumSendableSignedTransaction, EthereumUnsignedTransaction } from '../types/wire-types.js'
import { encodeAbiValues, encodeFunctionCall } from '../utils/abiRuntime.js'
import { addressString, bytes32String, dataStringWith0xStart, generate256BitRandomBigInt, stringToUint8Array } from '../utils/bigint.js'
import { getSafeTxHash } from '../utils/eip712.js'
import { keccak256 } from '../utils/ethereumPrimitives.js'
import { createSafeTx, getSafeContractStateAtBlock, type SafeContractState } from './safeCore.js'
import { prevalidatedSafeSignature, SAFE_EXECUTION_ABI } from './safeExecution.js'
import { isSafeExecTransactionCall } from './safeExecutionRouting.js'
import { ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED } from '../utils/constants.js'
import type { DistributiveOmit } from '../utils/typescript.js'
import { last } from '../utils/array.js'
import { isSafeCallRevert, SAFE_CALL_REVERTED_MESSAGE } from './safeExecutionFailure.js'
import { getSimulatedBlockBaseFeePerGas } from '../simulation/services/simulationBlockParameters.js'
import { JsonRpcResponseError } from '../utils/errors.js'

// The account that sends simulated Gnosis Safe executions. It is random for each background session, so a called contract can't recognise the simulation by a known tx.origin. On-chain, too, a Safe's transactions are often sent by accounts that aren't its owners, such as relayers.
export const SAFE_EXECUTION_SIMULATION_EXECUTOR = generate256BitRandomBigInt() >> 96n

// The storage slot of `mapping(address => mapping(bytes32 => uint256)) approvedHashes` in every Gnosis Safe version Interceptor supports (SUPPORTED_SAFE_VERSIONS in safeCore.ts).
const SAFE_APPROVED_HASHES_SLOT = 8n
// The executor's tip, the default formEthSendTransaction gives a transaction.
const EXECUTOR_MAX_PRIORITY_FEE_PER_GAS = 10n ** 8n // 0.1 nanoeth/gas
// Gas for execTransaction's own work around the Safe's call: its calldata, the signature checks, the nonce update, its event and the Safe's guard if it has one. The node charges only the gas used, so a generous allowance only keeps an execution from failing for lack of gas.
const SAFE_EXECUTION_GAS_ALLOWANCE = 1_000_000n

// The executor's gas limit for a Safe's call with this gas: the Safe passes on at most 63/64 of the remaining gas to its call, and execTransaction's own work needs SAFE_EXECUTION_GAS_ALLOWANCE.
const getSafeExecutorGasLimit = (safeCallGas: bigint) => safeCallGas * 64n / 63n + SAFE_EXECUTION_GAS_ALLOWANCE

const compareAddresses = (first: bigint, second: bigint) => first < second ? -1 : first > second ? 1 : 0

const getApprovedHashStorageSlot = (owner: bigint, safeTxHash: bigint) => keccak256(encodeAbiValues(
	['bytes32', 'bytes32'],
	[bytes32String(safeTxHash), keccak256(encodeAbiValues(['address', 'uint256'], [addressString(owner), SAFE_APPROVED_HASHES_SLOT]))],
))

// A transaction that isn't a Gnosis Safe execution runs its own call, even if an earlier preparation gave it an executedTransaction: EthereumClientService rejects one that still has it.
function withoutExecutedTransaction(transaction: SimulationInputTransaction): SimulationInputTransaction {
	if (transaction.executedTransaction === undefined) return transaction
	const { executedTransaction: _executedTransaction, ...ownCall } = transaction
	return ownCall
}

// Every owner approves and signs, sorted as execTransaction requires. execTransaction checks only as many signatures as its threshold at execution, so an execution still passes after an earlier one on the stack raises the threshold.
const getSigningOwners = (safeState: SafeContractState) => [...safeState.owners].sort(compareAddresses)

// The Safe's own call: from the Safe, to the called contract.
type SafeCall = Pick<Extract<EthereumSendableSignedTransaction, { readonly type: '1559' }>, 'from' | 'chainId' | 'gas' | 'value' | 'input' | 'hash'> & { readonly to: bigint }

function createExecutorTransaction(safeCall: SafeCall, signingOwners: readonly bigint[], executorNonce: bigint, maxFeePerGas: bigint): EthereumSendableSignedTransaction {
	const signatures: `0x${ string }` = `0x${ signingOwners.map((owner) => prevalidatedSafeSignature(owner).slice(2)).join('') }`
	return {
		type: '1559',
		from: SAFE_EXECUTION_SIMULATION_EXECUTOR,
		chainId: safeCall.chainId,
		nonce: executorNonce,
		maxFeePerGas,
		maxPriorityFeePerGas: EXECUTOR_MAX_PRIORITY_FEE_PER_GAS,
		gas: getSafeExecutorGasLimit(safeCall.gas),
		to: safeCall.from,
		value: 0n,
		// A CALL without refund: safeTxGas, baseGas and gasPrice are zero, so execTransaction reverts if the Safe's call fails.
		input: stringToUint8Array(encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [addressString(safeCall.to), safeCall.value, dataStringWith0xStart(safeCall.input), 0n, 0n, 0n, 0n, addressString(0n), addressString(0n), signatures])),
		accessList: [],
		r: 0n,
		s: 0n,
		yParity: 'even',
		hash: safeCall.hash,
	}
}

/**
 * Prepares every Gnosis Safe execution in the input (a transaction whose simulation options authorize an executed call, authorizesExecutedCall) to run the way the Safe runs it on-chain: SAFE_EXECUTION_SIMULATION_EXECUTOR calls the Safe's execTransaction with real fees in a block with the real base fee, and the Safe makes the call. The transaction's signedTransaction stays the Safe's call; the call the node runs is its executedTransaction.
 * The simulation assumes the Safe's owners approved the call. The first block's state overrides mark the call's SafeTx hash as approved (approvedHashes) by every owner of the Safe at the parent block, and the execution carries their pre-validated signatures. The Safe can reach this state on-chain, through approveHash. An owner that an earlier execution on the stack removes still signs, so an execution after such a removal can fail the Safe's signature check (GS026).
 * The approvals are visible: a called contract that reads its Safe's approvedHashes for the current SafeTx hash finds them set, as it would if the owners had approved with approveHash, but not if they sign off-chain. A preview runs before the owners have signed, so it has to make the Safe accept approvals it doesn't have yet. The alternatives can be told apart as well: replacing the ecrecover precompile to accept made-up signatures puts code at its address, and lowering the threshold changes getThreshold. approvedHashes is the one of them the Safe can reach on-chain, and a contract can only see it by inspecting its own Safe, unlike a tx.origin that is a contract or a zero base fee.
 * The SafeTx hash includes the Safe's nonce at execution, and each earlier execution of the same Safe in the input raises it by one if it succeeds: a simulated Safe execution, or a call to the Safe's execTransaction, whether a stacked transaction or a Safe execution makes it. So an execution is approved at every nonce from the Safe's nonce at the parent block up to that nonce plus its number of earlier executions.
 * The first block also funds the executor for every execution's gas at its maximum fee.
 */
export async function prepareSafeExecutionSimulationInput(input: SimulationStateInput, ethereum: EthereumClientService, parentBlockNumber: bigint, baseFeePerGas: bigint): Promise<SimulationStateInput> {
	const safeAddresses = new Set(input.flatMap((block) => block.transactions.filter((transaction) => authorizesExecutedCall(transaction.simulationOptions)).map((transaction) => transaction.signedTransaction.from)))
	if (safeAddresses.size === 0 && input.every((block) => block.transactions.every((transaction) => transaction.executedTransaction === undefined))) return input
	const safeStates = new Map(await Promise.all([...safeAddresses].map(async (safeAddress) => [safeAddress, await getSafeContractStateAtBlock(ethereum, safeAddress, parentBlockNumber)] as const)))
	const maxFeePerGas = baseFeePerGas * 2n + EXECUTOR_MAX_PRIORITY_FEE_PER_GAS
	const earlierExecutionsBySafe = new Map<bigint, bigint>()
	const approvedHashSlotsBySafe = new Map<bigint, Record<string, bigint>>()
	let executorNonce = 0n
	let executorBalance = 0n
	const countExecution = (safeAddress: bigint) => earlierExecutionsBySafe.set(safeAddress, (earlierExecutionsBySafe.get(safeAddress) ?? 0n) + 1n)
	// A transaction's own call to a Safe's execTransaction, made by a stacked transaction or by a Safe execution.
	const countExecTransactionCall = ({ to, input }: EthereumSendableSignedTransaction) => {
		if (to !== null && safeStates.has(to) && isSafeExecTransactionCall(input)) countExecution(to)
	}
	const preparedInput = input.map((block) => ({ ...block, transactions: block.transactions.map((transaction) => {
		if (!authorizesExecutedCall(transaction.simulationOptions)) {
			countExecTransactionCall(transaction.signedTransaction)
			return withoutExecutedTransaction(transaction)
		}
		const { signedTransaction } = transaction
		if (signedTransaction.type !== '1559') throw new Error('A Gnosis Safe execution simulation requires an EIP-1559 transaction.')
		if (signedTransaction.to === null) throw new Error('A Gnosis Safe execution cannot create a contract.')
		const safeCall: SafeCall = { ...signedTransaction, to: signedTransaction.to }
		const safeAddress = safeCall.from
		const safeState = safeStates.get(safeAddress)
		if (safeState === undefined) throw new Error('The Gnosis Safe state of the execution was not read.')
		const earlierExecutions = earlierExecutionsBySafe.get(safeAddress) ?? 0n
		countExecution(safeAddress)
		countExecTransactionCall(signedTransaction)
		const approvedHashSlots = approvedHashSlotsBySafe.get(safeAddress) ?? {}
		for (let nonce = safeState.nonce; nonce <= safeState.nonce + earlierExecutions; nonce++) {
			const safeTxHash = BigInt(getSafeTxHash(createSafeTx(safeCall.chainId, safeAddress, { to: safeCall.to, value: safeCall.value, input: safeCall.input }, nonce)))
			for (const owner of getSigningOwners(safeState)) approvedHashSlots[getApprovedHashStorageSlot(owner, safeTxHash)] = 1n
		}
		approvedHashSlotsBySafe.set(safeAddress, approvedHashSlots)
		const executedTransaction = createExecutorTransaction(safeCall, getSigningOwners(safeState), executorNonce, maxFeePerGas)
		executorNonce += 1n
		executorBalance += executedTransaction.gas * maxFeePerGas
		return { ...transaction, executedTransaction }
	}) }))
	const [firstBlock, ...laterBlocks] = preparedInput
	// Without a Gnosis Safe execution there are no approvals to set and no executor to fund.
	if (firstBlock === undefined || executorNonce === 0n) return preparedInput
	const stateOverrides: MutableStateOverrides = { ...firstBlock.stateOverrides }
	for (const [safeAddress, approvedHashSlots] of approvedHashSlotsBySafe) {
		const safeOverride = stateOverrides[addressString(safeAddress)]
		stateOverrides[addressString(safeAddress)] = { ...safeOverride, stateDiff: { ...safeOverride?.stateDiff, ...approvedHashSlots } }
	}
	stateOverrides[addressString(SAFE_EXECUTION_SIMULATION_EXECUTOR)] = { ...stateOverrides[addressString(SAFE_EXECUTION_SIMULATION_EXECUTOR)], balance: executorBalance }
	return [{ ...firstBlock, stateOverrides }, ...laterBlocks]
}

// The fields of the Safe's call that its gas estimate stacks it with.
type SafeCallFields = Pick<PreSimulationTransaction, 'website' | 'created' | 'originalRequestParameters' | 'transactionIdentifier'>

/**
 * Estimates a Gnosis Safe's own call the way the simulation runs it: as the executor's execTransaction call on top of the simulation input, so the call sees the executor as tx.origin and the real base fee, and the estimate covers execTransaction's own work and the Safe's guard. The estimate becomes the gas of the Safe's call, which prepareSafeExecutionSimulationInput turns into the executor's gas limit (getSafeExecutorGasLimit).
 * With the 'newBlock' placement the call is estimated alone in a new block after the input. With 'appendedToSimulation' it is estimated where a wallet_sendCalls preview and approval run it: after the transactions of the input's last block, in that block's last RPC block or in a new RPC block that preparation starts for it. Which one depends on the executor's gas, and so on the estimate itself, so an estimate is checked against the input prepared with it (getRpcBlockOfSafeCall) and re-estimated once in the block preparation chooses.
 */
export async function estimateSafeExecutionGas(
	ethereum: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationInput: SimulationStateInput,
	safeCallWithoutGas: DistributiveOmit<EthereumUnsignedTransaction, 'gas'>,
	safeCallFields: SafeCallFields,
	placement: GasEstimationPlacement = 'newBlock',
): Promise<{ error: ErrorWithCodeAndOptionalData } | { gas: bigint }> {
	const parentBlock = await ethereum.getBlock(requestAbortController)
	if (parentBlock === null) throw new Error('The latest block is null')
	const blockGasLimit = parentBlock.gasLimit
	const safeCall: PreSimulationTransaction = {
		...safeCallFields,
		signedTransaction: mockSignTransaction({ ...safeCallWithoutGas, gas: blockGasLimit }),
		simulationOptions: createSafeExecutionSimulationOptions(ethereum.getChainId()),
	}
	const lastInputBlockIndex = simulationInput.length - 1
	const appendToLastInputBlock = placement === 'appendedToSimulation' && lastInputBlockIndex >= 0
	// appendTransactionsToInput puts the Safe's call alone in a new last block, or after the transactions of the last block.
	const preparedInput = await prepareSafeExecutionSimulationInput(appendTransactionsToInput(simulationInput, [safeCall], appendToLastInputBlock ? lastInputBlockIndex : undefined), ethereum, parentBlock.number, getSimulatedBlockBaseFeePerGas(parentBlock))
	const lastBlock = last(preparedInput)
	const executedTransaction = last(lastBlock?.transactions ?? [])?.executedTransaction
	if (lastBlock === undefined || executedTransaction === undefined) throw new Error('The Gnosis Safe execution to estimate was not prepared.')
	// The prepared input without the Safe's call. Preparation keeps every other transaction's executed call, and the approvals and executor funding stay in the first block.
	const inputBeforeSafeCall = [...preparedInput.slice(0, -1), { ...lastBlock, transactions: lastBlock.transactions.slice(0, -1) }]
	const withSafeCallGas = (gasLimit: bigint) => ({ ...safeCall, executedTransaction: { ...executedTransaction, gas: gasLimit } })
	// The call after the last block's transactions, or in a new block like the RPC block that preparation splits off for a call that does not fit (prepareEthSimulateV1Input).
	const inputWithSafeCallInLastBlock = (gasLimit: bigint): SimulationStateInput => [...preparedInput.slice(0, -1), { ...lastBlock, transactions: [...lastBlock.transactions.slice(0, -1), withSafeCallGas(gasLimit)] }]
	const inputWithSafeCallInNewBlock = (gasLimit: bigint): SimulationStateInput => [...inputBeforeSafeCall, { transactions: [withSafeCallGas(gasLimit)], stateOverrides: {}, signedMessages: [], blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION, simulateWithZeroBaseFee: lastBlock.simulateWithZeroBaseFee }]
	const estimateIn = async (inputWithSafeCall: (gasLimit: bigint) => SimulationStateInput, maxGas: bigint) => {
		// Recognised from the failed call itself, because the estimate's error keeps only the call's return data.
		let safeCallReverted = false
		const simulateWithGasLimit = async (gasLimit: bigint) => {
			const result = last(last(await ethereum.simulate(inputWithSafeCall(gasLimit), parentBlock.number, requestAbortController))?.calls ?? [])
			safeCallReverted = result?.status === 'failure' && isSafeCallRevert(result.error, result.returnData)
			return result
		}
		const initialResult = await simulateWithGasLimit(maxGas)
		if (initialResult === undefined) return { error: { code: ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED, message: 'ETH Simulate Failed to estimate gas', data: '0x' } }
		const estimate = await getGasEstimateFromSimulation(initialResult, maxGas, simulateWithGasLimit)
		if ('error' in estimate && (safeCallReverted || isSafeCallRevert(estimate.error))) return { error: { ...estimate.error, message: SAFE_CALL_REVERTED_MESSAGE } }
		return estimate
	}
	if (!appendToLastInputBlock) return await estimateIn(inputWithSafeCallInLastBlock, blockGasLimit)
	const preparedBeforeSafeCall = await ethereum.prepareEthSimulateV1Input(inputBeforeSafeCall, parentBlock.number, requestAbortController)
	const lastRpcBlockIndex = preparedBeforeSafeCall.rpcBlocks.length - 1
	// While its gas is at most what the last RPC block has left, preparation keeps the call in that block (fitsInRpcBlock), so every run of that estimate stays there.
	const gasLeftInLastRpcBlock = getGasLeftInRpcBlock(getGasUsedInLastRpcBlock(preparedBeforeSafeCall), blockGasLimit)
	// The RPC block that the preview and approval run the call in with the estimated gas, found by preparing the input as they do instead of by repeating preparation's rules: the executor's call gets the gas prepareSafeExecutionSimulationInput gives it (getSafeExecutorGasLimit), and prepareEthSimulateV1Input clamps it to the block gas limit and places it. This runs locally, without a simulation. The call is the input's last transaction, so it runs in the last RPC block, which is either the one before it or one preparation started for it.
	const getRpcBlockOfSafeCall = async (safeCallGas: bigint): Promise<AppendedTransactionRpcBlock> => {
		const runInput = [...preparedInput.slice(0, -1), { ...lastBlock, transactions: [...lastBlock.transactions.slice(0, -1), {
			...safeCall,
			signedTransaction: { ...safeCall.signedTransaction, gas: safeCallGas },
			executedTransaction: { ...executedTransaction, gas: getSafeExecutorGasLimit(safeCallGas) },
		}] }]
		const prepared = await ethereum.prepareEthSimulateV1Input(runInput, parentBlock.number, requestAbortController)
		return prepared.rpcBlocks.length - 1 === lastRpcBlockIndex ? 'lastRpcBlock' : 'nextRpcBlock'
	}
	// The placement protocol is shared with simulateEstimateGasAppendedToSimulation; only the estimate per block and the way to find the block preparation picks are the executor call's own.
	return await estimateGasInRpcBlockItRunsIn({
		lastRpcBlockHasRoom: gasLeftInLastRpcBlock > 0n,
		estimateIn: async (rpcBlock) => rpcBlock === 'lastRpcBlock'
			? await estimateIn(inputWithSafeCallInLastBlock, gasLeftInLastRpcBlock)
			: await estimateIn(inputWithSafeCallInNewBlock, blockGasLimit),
		getRpcBlockItRunsIn: getRpcBlockOfSafeCall,
		unplaceableEstimate: { error: { code: ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED, message: 'The gas of the Gnosis Safe\'s call could not be estimated in the block it runs in.', data: '0x' } },
	})
}

// The simulation options that mark a Gnosis Safe's own call to run through the Safe. Forming the call and estimating its gas both take them from here, so the estimate runs the call as the stack will.
export const createSafeExecutionSimulationOptions = (chainId: bigint): TransactionSimulationOptions => ({ requiredChainId: chainId, simulateWithZeroBaseFee: false, executeThroughSafe: true })

// How formEthSendTransaction forms a transaction that the simulation runs as an executor's call instead of as itself: the options that mark it, the source of its nonce field and its gas estimate.
export type ExecutedCallFormation = {
	readonly simulationOptions: TransactionSimulationOptions
	readonly getNonce: (requestAbortController: AbortController | undefined, simulationState: ResolvedSimulationState, from: bigint) => Promise<bigint>
	readonly estimateGas: (requestAbortController: AbortController | undefined, simulationState: ResolvedSimulationState, transaction: DistributiveOmit<EthereumUnsignedTransaction, 'gas'>, safeCallFields: SafeCallFields, placement: GasEstimationPlacement) => Promise<{ error: ErrorWithCodeAndOptionalData } | { gas: bigint }>
}

// The formation of a Gnosis Safe's own call in simulation mode: marked by createSafeExecutionSimulationOptions, numbered by getSimulatedSafeCallNonce and estimated as its executor's call on top of the stack. A failed stack simulation fails the estimate, as in simulateEstimateGas.
export const createSafeExecutionCallFormation = (ethereum: EthereumClientService): ExecutedCallFormation => ({
	simulationOptions: createSafeExecutionSimulationOptions(ethereum.getChainId()),
	getNonce: async (requestAbortController, simulationState, from) => await getSimulatedSafeCallNonce(ethereum, requestAbortController, simulationState, from),
	estimateGas: async (requestAbortController, simulationState, transaction, safeCallFields, placement) => {
		if (simulationState.kind === 'passthrough') throw new Error('Gnosis Safe transaction gas estimation requires the Interceptor simulator.')
		if (simulationState.value.success === false) throw new JsonRpcResponseError(simulationState.value.jsonRpcError)
		return await estimateSafeExecutionGas(ethereum, requestAbortController, simulationState.value.simulationStateInput, transaction, safeCallFields, placement)
	},
})
