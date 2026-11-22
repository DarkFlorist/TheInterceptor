import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransactionsToInput, getSimulatedSafeCallNonce, simulatedCallFromInput } from '../simulation/services/SimulationModeEthereumClientService.js'
import { getGasEstimateFromSimulation } from '../simulation/services/simulationGasEstimation.js'
import { mockSignTransaction } from '../simulation/services/simulationTransactionSigning.js'
import type { ErrorWithCodeAndOptionalData } from '../types/error.js'
import type { MutableStateOverrides } from '../types/ethSimulate-types.js'
import { authorizesExecutedCall, type PreSimulationTransaction, type ResolvedSimulationState, type SimulationInputTransaction, type SimulationStateInput, type TransactionSimulationOptions, toSimulationStateInputMinimalData } from '../types/visualizer-types.js'
import type { SafeTx } from '../types/personal-message-definitions.js'
import type { EthereumSendableSignedTransaction, EthereumUnsignedTransaction } from '../types/wire-types.js'
import { decodeFunctionOutput, encodeAbiValues, encodeFunctionCall } from '../utils/abiRuntime.js'
import { addressString, bytes32String, dataStringWith0xStart, generate256BitRandomBigInt, stringToUint8Array } from '../utils/bigint.js'
import { getSafeTxHash } from '../utils/eip712.js'
import { keccak256 } from '../utils/ethereumPrimitives.js'
import { createSafeTxFromMessage, getSafeContractStateAtBlock, SAFE_ABI, type SafeContractState } from './safeCore.js'
import { prevalidatedSafeSignature, SAFE_EXECUTION_ABI } from './safeExecution.js'
import { ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED } from '../utils/constants.js'
import type { DistributiveOmit } from '../utils/typescript.js'
import { last } from '../utils/array.js'
import { isSafeCallRevert, SAFE_CALL_REVERTED_MESSAGE } from './safeExecutionFailure.js'
import { SAFE_EXEC_TRANSACTION_SELECTOR } from './safeExecutionRouting.js'
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

// What a Gnosis Safe executes: the SafeTx of a Safe proposal, or in simulation mode the Safe's own call, which is a CALL without refund. The SafeTx nonce is left out, because the Safe executes it at whatever nonce it has by then.
type SafeExecution = {
	readonly safeAddress: bigint
	readonly chainId: bigint
	readonly message: Omit<SafeTx['message'], 'nonce'>
}

function getSafeExecution({ safeTransaction, signedTransaction, simulationOptions }: SimulationInputTransaction): SafeExecution {
	if (safeTransaction !== undefined) {
		const { domain, message: { nonce: _nonce, ...message } } = safeTransaction.safeTx
		const chainId = domain.chainId ?? simulationOptions?.requiredChainId
		if (chainId === undefined) throw new Error('A Gnosis Safe proposal simulation requires an EIP-712 chain ID.')
		return { safeAddress: domain.verifyingContract, chainId, message }
	}
	if (signedTransaction.type !== '1559') throw new Error('A Gnosis Safe execution simulation requires an EIP-1559 transaction.')
	if (signedTransaction.to === null) throw new Error('A Gnosis Safe execution cannot create a contract.')
	return {
		safeAddress: signedTransaction.from,
		chainId: signedTransaction.chainId,
		message: { to: signedTransaction.to, value: signedTransaction.value, data: signedTransaction.input, operation: 0n, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: 0n, refundReceiver: 0n },
	}
}

// A call to any Safe's execTransaction that a transaction hands on, directly or relayed through other Safes, batches or contracts, is encoded within its calldata. This is the cheap test for whether an earlier transaction may have changed a Safe's nonce; a contract that builds an execTransaction call itself is not caught, and prepareSafeExecutionSimulationInput documents what happens then.
const containsExecTransactionSelector = (data: Uint8Array) => {
	for (let index = 0; index + SAFE_EXEC_TRANSACTION_SELECTOR.length <= data.length; index++) {
		if (SAFE_EXEC_TRANSACTION_SELECTOR.every((byte, offset) => data[index + offset] === byte)) return true
	}
	return false
}

// Reads a Gnosis Safe's nonce after a prepared simulation input runs on top of the given parent block, the block the input was prepared for, so a newer block cannot shift the nonce. prepareSafeExecutionSimulationInput takes it as a parameter so tests can answer for a node.
export type SafeNonceAfterInputReader = (preparedInputBefore: SimulationStateInput, safeAddress: bigint, parentBlockNumber: bigint) => Promise<bigint>

export const createSafeNonceAfterInputReader = (ethereum: EthereumClientService): SafeNonceAfterInputReader => async (preparedInputBefore, safeAddress, parentBlockNumber) => {
	const call = await simulatedCallFromInput(ethereum, undefined, { kind: 'simulated', value: preparedInputBefore }, { to: safeAddress, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, value: 0n, input: stringToUint8Array(encodeFunctionCall(SAFE_ABI, 'nonce', [])) }, 'latest', parentBlockNumber)
	if (!('result' in call) || call.result === undefined) throw new Error(`Failed to read the Gnosis Safe nonce in the simulation: ${ 'error' in call ? call.error?.message : 'no result' }`)
	return decodeFunctionOutput(SAFE_ABI, 'nonce', call.result)
}

type FirstBlockOverrides = {
	readonly approvedHashSlotsBySafe: ReadonlyMap<bigint, Record<string, bigint>>
	readonly executorBalance: bigint
}

// Every override is set in the first block, so it is in place before any execution runs.
function withFirstBlockOverrides(blocks: SimulationStateInput, { approvedHashSlotsBySafe, executorBalance }: FirstBlockOverrides): SimulationStateInput {
	const [firstBlock, ...laterBlocks] = blocks
	if (firstBlock === undefined) return blocks
	const stateOverrides: MutableStateOverrides = { ...firstBlock.stateOverrides }
	for (const [safeAddress, approvedHashSlots] of approvedHashSlotsBySafe) {
		const safeOverride = stateOverrides[addressString(safeAddress)]
		stateOverrides[addressString(safeAddress)] = { ...safeOverride, stateDiff: { ...safeOverride?.stateDiff, ...approvedHashSlots } }
	}
	stateOverrides[addressString(SAFE_EXECUTION_SIMULATION_EXECUTOR)] = { ...stateOverrides[addressString(SAFE_EXECUTION_SIMULATION_EXECUTOR)], balance: executorBalance }
	return [{ ...firstBlock, stateOverrides }, ...laterBlocks]
}

function createExecutorTransaction(execution: SafeExecution, safeCall: EthereumSendableSignedTransaction, signingOwners: readonly bigint[], executorNonce: bigint, maxFeePerGas: bigint): EthereumSendableSignedTransaction {
	const { message } = execution
	const signatures: `0x${ string }` = `0x${ signingOwners.map((owner) => prevalidatedSafeSignature(owner).slice(2)).join('') }`
	return {
		type: '1559',
		from: SAFE_EXECUTION_SIMULATION_EXECUTOR,
		chainId: execution.chainId,
		nonce: executorNonce,
		maxFeePerGas,
		maxPriorityFeePerGas: EXECUTOR_MAX_PRIORITY_FEE_PER_GAS,
		// The Safe passes on at most 63/64 of the remaining gas to its call.
		gas: safeCall.gas * 64n / 63n + SAFE_EXECUTION_GAS_ALLOWANCE,
		to: execution.safeAddress,
		value: 0n,
		// The SafeTx as the owners sign it, a delegate call included. With safeTxGas and gasPrice zero, as Interceptor creates them, execTransaction reverts if the Safe's call fails.
		input: stringToUint8Array(encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [addressString(message.to), message.value, dataStringWith0xStart(message.data), message.operation, message.safeTxGas, message.baseGas, message.gasPrice, addressString(message.gasToken), addressString(message.refundReceiver), signatures])),
		accessList: [],
		r: 0n,
		s: 0n,
		yParity: 'even',
		hash: safeCall.hash,
	}
}

/**
 * Prepares every Gnosis Safe execution in the input (authorizesExecutedCall: a Safe proposal, or a Safe's own call in simulation mode) to run the way the Safe runs it on-chain: SAFE_EXECUTION_SIMULATION_EXECUTOR calls the Safe's execTransaction with real fees in a block with the real base fee, and the Safe makes the call. The transaction's signedTransaction stays the Safe's call that the dialog shows; the call the node runs is its executedTransaction.
 * The simulation assumes the Safe's owners approved the call. The first block's state overrides mark the call's SafeTx hash as approved (approvedHashes) by every owner of the Safe at the parent block, and the execution carries their pre-validated signatures. The Safe can reach this state on-chain, through approveHash. An owner that an earlier execution on the stack removes still signs, so an execution after such a removal can fail the Safe's signature check (GS026).
 * The approvals are visible: a called contract that reads its Safe's approvedHashes for the current SafeTx hash finds them set, as it would if the owners had approved with approveHash, but not if they sign off-chain. A preview runs before the owners have signed, so it has to make the Safe accept approvals it doesn't have yet. The alternatives can be told apart as well: replacing the ecrecover precompile to accept made-up signatures puts code at its address, and lowering the threshold changes getThreshold. approvedHashes is the one of them the Safe can reach on-chain, and a contract can only see it by inspecting its own Safe, unlike a tx.origin that is a contract or a zero base fee.
 * The SafeTx hash includes the Safe's nonce at execution, so each execution is approved at exactly that nonce, and no approval exists that the owners' approveHash calls could not also have made. Without an earlier transaction that can execute the Safe, that is the Safe's nonce at the parent block. An earlier execution of the same Safe, or an earlier transaction whose calldata has an execTransaction selector (containsExecTransactionSelector), may have raised it, so the nonce is then read from the simulation of the input before the execution (readSafeNonceAfterInput), on the same parent block.
 * The nonce read can still differ from the nonce the execution runs at: a contract can build its own execTransaction call without being handed one in calldata, and the read sees only the approvals of the executions before it, while the final simulation sets every execution's approvals in the first block, so an earlier contract that branches on a later execution's approval acts differently in the two. Either way the execution runs at a nonce it was not prepared for. It then fails the signature check (GS025) in the preview unless its SafeTx hash at that nonce is approved anyway: by the approvals of another execution in the input with the same SafeTx, or by an owner's approveHash on-chain. Each of those approvals is one the owners can also give on-chain, so the preview never relies on an approval that cannot exist. This is narrower than verifying that every execution runs at the nonce it was prepared for, which would take another simulation per execution. Approving every nonce the Safe might have instead would let a page plant approvals at nonces the Safe never reaches, which a called contract could read to tell the preview from the real execution.
 * The first block also funds the executor for every execution's gas at its maximum fee.
 */
export async function prepareSafeExecutionSimulationInput(input: SimulationStateInput, ethereum: EthereumClientService, parentBlockNumber: bigint, baseFeePerGas: bigint, readSafeNonceAfterInput: SafeNonceAfterInputReader = createSafeNonceAfterInputReader(ethereum)): Promise<SimulationStateInput> {
	const safeAddresses = new Set(input.flatMap((block) => block.transactions.filter(authorizesExecutedCall).map((transaction) => getSafeExecution(transaction).safeAddress)))
	if (safeAddresses.size === 0 && input.every((block) => block.transactions.every((transaction) => transaction.executedTransaction === undefined))) return input
	const safeStates = new Map(await Promise.all([...safeAddresses].map(async (safeAddress) => [safeAddress, await getSafeContractStateAtBlock(ethereum, safeAddress, parentBlockNumber)] as const)))
	const maxFeePerGas = baseFeePerGas * 2n + EXECUTOR_MAX_PRIORITY_FEE_PER_GAS
	const executedSafes = new Set<bigint>()
	let earlierCalldataCanExecuteASafe = false
	const approvedHashSlotsBySafe = new Map<bigint, Record<string, bigint>>()
	let executorNonce = 0n
	let executorBalance = 0n
	const preparedBlocks: SimulationStateInput[number][] = []
	for (const block of input) {
		const preparedTransactions: SimulationInputTransaction[] = []
		for (const transaction of block.transactions) {
			if (!authorizesExecutedCall(transaction)) {
				if (containsExecTransactionSelector(transaction.signedTransaction.input)) earlierCalldataCanExecuteASafe = true
				preparedTransactions.push(withoutExecutedTransaction(transaction))
				continue
			}
			const { signedTransaction } = transaction
			const execution = getSafeExecution(transaction)
			const { safeAddress } = execution
			const safeState = safeStates.get(safeAddress)
			if (safeState === undefined) throw new Error('The Gnosis Safe state of the execution was not read.')
			const nonceMayHaveChanged = executedSafes.has(safeAddress) || earlierCalldataCanExecuteASafe
			const inputBeforeExecution = withFirstBlockOverrides([...preparedBlocks, { ...block, transactions: [...preparedTransactions] }], { approvedHashSlotsBySafe: new Map(approvedHashSlotsBySafe), executorBalance })
			const nonceAtExecution = nonceMayHaveChanged ? await readSafeNonceAfterInput(inputBeforeExecution, safeAddress, parentBlockNumber) : safeState.nonce
			executedSafes.add(safeAddress)
			// The data the Safe calls or delegate-calls with, a MultiSend batch included.
			if (containsExecTransactionSelector(execution.message.data)) earlierCalldataCanExecuteASafe = true
			const safeTxHash = BigInt(getSafeTxHash(createSafeTxFromMessage(execution.chainId, safeAddress, { ...execution.message, nonce: nonceAtExecution })))
			const approvedHashSlots = { ...approvedHashSlotsBySafe.get(safeAddress) }
			for (const owner of getSigningOwners(safeState)) approvedHashSlots[getApprovedHashStorageSlot(owner, safeTxHash)] = 1n
			approvedHashSlotsBySafe.set(safeAddress, approvedHashSlots)
			const executedTransaction = createExecutorTransaction(execution, signedTransaction, getSigningOwners(safeState), executorNonce, maxFeePerGas)
			executorNonce += 1n
			executorBalance += executedTransaction.gas * maxFeePerGas
			preparedTransactions.push({ ...transaction, executedTransaction })
		}
		preparedBlocks.push({ ...block, transactions: preparedTransactions })
	}
	// Without a Gnosis Safe execution there are no approvals to set and no executor to fund.
	if (executorNonce === 0n) return preparedBlocks
	return withFirstBlockOverrides(preparedBlocks, { approvedHashSlotsBySafe, executorBalance })
}

// The fields of the Safe's call that its gas estimate stacks it with.
type SafeCallFields = Pick<PreSimulationTransaction, 'website' | 'created' | 'originalRequestParameters' | 'transactionIdentifier'>

/**
 * Estimates a Gnosis Safe's call (a Safe proposal's, or in simulation mode the Safe's own) the way the simulation runs it: as the executor's execTransaction call on top of the simulation input, so the call sees the executor as tx.origin and the real base fee, and the estimate covers execTransaction's own work and the Safe's guard. The estimate becomes the gas of the Safe's call, which prepareSafeExecutionSimulationInput turns into the executor's gas limit.
 */
export async function estimateSafeExecutionGas(
	ethereum: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationInput: SimulationStateInput,
	safeCallWithoutGas: DistributiveOmit<EthereumUnsignedTransaction, 'gas'>,
	safeCallFields: SafeCallFields,
): Promise<{ error: ErrorWithCodeAndOptionalData } | { gas: bigint }> {
	const parentBlock = await ethereum.getBlock(requestAbortController)
	if (parentBlock === null) throw new Error('The latest block is null')
	const blockGasLimit = parentBlock.gasLimit
	const safeCall: PreSimulationTransaction = {
		...safeCallFields,
		signedTransaction: mockSignTransaction({ ...safeCallWithoutGas, gas: blockGasLimit }),
		simulationOptions: createSafeExecutionSimulationOptions(ethereum.getChainId()),
	}
	// appendTransactionsToInput puts the Safe's call alone in a new last block.
	const preparedInput = await prepareSafeExecutionSimulationInput(appendTransactionsToInput(simulationInput, [safeCall]), ethereum, parentBlock.number, getSimulatedBlockBaseFeePerGas(parentBlock))
	const lastBlock = last(preparedInput)
	const executedTransaction = last(lastBlock?.transactions ?? [])?.executedTransaction
	if (lastBlock === undefined || executedTransaction === undefined) throw new Error('The Gnosis Safe execution to estimate was not prepared.')
	// Recognised from the failed call itself, because the estimate's error keeps only the call's return data.
	let safeCallReverted = false
	const simulateWithGasLimit = async (gasLimit: bigint) => {
		const input = [...preparedInput.slice(0, -1), { ...lastBlock, transactions: [{ ...safeCall, executedTransaction: { ...executedTransaction, gas: gasLimit } }] }]
		const result = last(last(await ethereum.simulate(toSimulationStateInputMinimalData(input), parentBlock.number, requestAbortController))?.calls ?? [])
		safeCallReverted = result?.status === 'failure' && isSafeCallRevert(result.error, result.returnData)
		return result
	}
	const initialResult = await simulateWithGasLimit(blockGasLimit)
	if (initialResult === undefined) return { error: { code: ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED, message: 'ETH Simulate Failed to estimate gas', data: '0x' } }
	const estimate = await getGasEstimateFromSimulation(initialResult, blockGasLimit, simulateWithGasLimit)
	if ('error' in estimate && (safeCallReverted || isSafeCallRevert(estimate.error))) return { error: { ...estimate.error, message: SAFE_CALL_REVERTED_MESSAGE } }
	return estimate
}

// The simulation options that mark a Gnosis Safe's call to run through the Safe. Forming the call and estimating its gas both take them from here, so the estimate runs the call as the stack will.
export const createSafeExecutionSimulationOptions = (chainId: bigint): TransactionSimulationOptions => ({ requiredChainId: chainId, executeThroughSafe: true })

// How formEthSendTransaction forms a transaction that the simulation runs as an executor's call instead of as itself: the options that mark it, the source of its nonce field and its gas estimate.
export type ExecutedCallFormation = {
	readonly simulationOptions: TransactionSimulationOptions
	readonly getNonce: (requestAbortController: AbortController | undefined, simulationState: ResolvedSimulationState, from: bigint) => Promise<bigint>
	readonly estimateGas: (requestAbortController: AbortController | undefined, simulationState: ResolvedSimulationState, transaction: DistributiveOmit<EthereumUnsignedTransaction, 'gas'>, safeCallFields: SafeCallFields) => Promise<{ error: ErrorWithCodeAndOptionalData } | { gas: bigint }>
}

// The formation of a Gnosis Safe's call that runs through the Safe, a Safe proposal's or in simulation mode the Safe's own: marked by createSafeExecutionSimulationOptions, numbered by getSimulatedSafeCallNonce and estimated as its executor's call on top of the stack. A failed stack simulation fails the estimate, as in simulateEstimateGas.
export const createSafeExecutionCallFormation = (ethereum: EthereumClientService): ExecutedCallFormation => ({
	simulationOptions: createSafeExecutionSimulationOptions(ethereum.getChainId()),
	getNonce: async (requestAbortController, simulationState, from) => await getSimulatedSafeCallNonce(ethereum, requestAbortController, simulationState, from),
	estimateGas: async (requestAbortController, simulationState, transaction, safeCallFields) => {
		if (simulationState.kind === 'passthrough') throw new Error('Gnosis Safe transaction gas estimation requires the Interceptor simulator.')
		if (simulationState.value.success === false) throw new JsonRpcResponseError(simulationState.value.jsonRpcError)
		return await estimateSafeExecutionGas(ethereum, requestAbortController, simulationState.value.simulationStateInput, transaction, safeCallFields)
	},
})
