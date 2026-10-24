import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransactionsToInput } from '../simulation/services/SimulationModeEthereumClientService.js'
import { getGasEstimateFromSimulation } from '../simulation/services/simulationGasEstimation.js'
import { mockSignTransaction } from '../simulation/services/simulationTransactionSigning.js'
import type { ErrorWithCodeAndOptionalData } from '../types/error.js'
import type { MutableStateOverrides } from '../types/ethSimulate-types.js'
import type { PreSimulationTransaction, SimulationInputTransaction, SimulationStateInput } from '../types/visualizer-types.js'
import type { SafeTx } from '../types/personal-message-definitions.js'
import type { EthereumSendableSignedTransaction, EthereumUnsignedTransaction } from '../types/wire-types.js'
import { encodeAbiValues, encodeFunctionCall } from '../utils/abiRuntime.js'
import { addressString, bytes32String, dataStringWith0xStart, generate256BitRandomBigInt, stringToUint8Array } from '../utils/bigint.js'
import { getSafeTxHash } from '../utils/eip712.js'
import { keccak256 } from '../utils/ethereumPrimitives.js'
import { createSafeTxFromMessage, getSafeContractStateAtBlock, type SafeContractState } from './safeCore.js'
import { prevalidatedSafeSignature, SAFE_EXECUTION_ABI } from './safeExecution.js'
import { ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED } from '../utils/constants.js'
import type { DistributiveOmit } from '../utils/typescript.js'
import { last } from '../utils/array.js'
import { isGnosisSafeExecution } from '../utils/transactionGasAccounting.js'
import { isSafeCallRevert, SAFE_CALL_REVERTED_MESSAGE } from './safeExecutionFailure.js'

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

// execTransaction's selector. A call to any Safe's execTransaction is encoded within the calldata of the calls that relay it, so its selector's occurrences in a transaction's calldata bound the Safe executions the transaction can make, whichever contracts relay them and however deeply.
const EXEC_TRANSACTION_SELECTOR = stringToUint8Array(encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [addressString(0n), 0n, '0x', 0n, 0n, 0n, 0n, addressString(0n), addressString(0n), '0x']).slice(0, 10))

// At most this many relayed executions are counted. A page can stuff calldata with the selector, and each counted execution makes every later Safe execution hash and approve one more nonce; real transactions relay a Safe execution rarely, and hardly ever this often.
const MAX_COUNTED_RELAYED_EXECUTIONS = 16n

const countExecTransactionSelectors = (data: Uint8Array) => {
	let occurrences = 0n
	for (let index = 0; index + EXEC_TRANSACTION_SELECTOR.length <= data.length; index++) {
		if (EXEC_TRANSACTION_SELECTOR.every((byte, offset) => data[index + offset] === byte)) occurrences++
	}
	return occurrences
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
 * Prepares every Gnosis Safe execution in the input (isGnosisSafeExecution: a Safe proposal, or a Safe's own call in simulation mode) to run the way the Safe runs it on-chain: SAFE_EXECUTION_SIMULATION_EXECUTOR calls the Safe's execTransaction with real fees in a block with the real base fee, and the Safe makes the call. The transaction's signedTransaction stays the Safe's call that the dialog shows; the call the node runs is its executedTransaction.
 * The simulation assumes the Safe's owners approved the call. The first block's state overrides mark the call's SafeTx hash as approved (approvedHashes) by every owner of the Safe at the parent block, and the execution carries their pre-validated signatures. The Safe can reach this state on-chain, through approveHash. An owner that an earlier execution on the stack removes still signs, so an execution after such a removal can fail the Safe's signature check (GS026).
 * The approvals are visible: a called contract that reads its Safe's approvedHashes for the current SafeTx hash finds them set, as it would if the owners had approved with approveHash, but not if they sign off-chain. A preview runs before the owners have signed, so it has to make the Safe accept approvals it doesn't have yet. The alternatives can be told apart as well: replacing the ecrecover precompile to accept made-up signatures puts code at its address, and lowering the threshold changes getThreshold. approvedHashes is the one of them the Safe can reach on-chain, and a contract can only see it by inspecting its own Safe, unlike a tx.origin that is a contract or a zero base fee.
 * The SafeTx hash includes the Safe's nonce at execution, and each earlier execution of the same Safe in the input raises it by one if it succeeds: a simulated execution of the Safe, or a call to its execTransaction that an earlier transaction makes, directly or relayed through other Safes, batches or contracts. So an execution is approved at every nonce from the Safe's nonce at the parent block up to that nonce plus the earlier simulated executions of the Safe and every execTransaction selector in the earlier transactions' calldata (countExecTransactionSelectors). Counting every selector can only approve nonces the Safe won't reach, which does no harm.
 * The selectors bound only the executions whose calls appear in the calldata, and at most MAX_COUNTED_RELAYED_EXECUTIONS of them count. A contract that executes a Safe more often than the calls it is handed, by repeating one or by building its own, or more often than that, raises the nonce past the approved range, and a later execution of that Safe then fails the signature check (GS025) in the preview: a visible failure, never a success that wouldn't happen. Reading each Safe's nonce from the simulation before every execution would close this, at the cost of a simulation per execution on every simulation of the stack.
 * The first block also funds the executor for every execution's gas at its maximum fee.
 */
export async function prepareSafeExecutionSimulationInput(input: SimulationStateInput, ethereum: EthereumClientService, parentBlockNumber: bigint, baseFeePerGas: bigint): Promise<SimulationStateInput> {
	const safeAddresses = new Set(input.flatMap((block) => block.transactions.filter(isGnosisSafeExecution).map((transaction) => getSafeExecution(transaction).safeAddress)))
	if (safeAddresses.size === 0) return input
	const safeStates = new Map(await Promise.all([...safeAddresses].map(async (safeAddress) => [safeAddress, await getSafeContractStateAtBlock(ethereum, safeAddress, parentBlockNumber)] as const)))
	const maxFeePerGas = baseFeePerGas * 2n + EXECUTOR_MAX_PRIORITY_FEE_PER_GAS
	const earlierSimulatedExecutionsBySafe = new Map<bigint, bigint>()
	let earlierExecTransactionCalls = 0n
	const approvedHashSlotsBySafe = new Map<bigint, Record<string, bigint>>()
	let executorNonce = 0n
	let executorBalance = 0n
	const preparedInput = input.map((block) => ({ ...block, transactions: block.transactions.map((transaction) => {
		if (!isGnosisSafeExecution(transaction)) {
			earlierExecTransactionCalls += countExecTransactionSelectors(transaction.signedTransaction.input)
			return transaction
		}
		const { signedTransaction } = transaction
		const execution = getSafeExecution(transaction)
		const { safeAddress } = execution
		const safeState = safeStates.get(safeAddress)
		if (safeState === undefined) throw new Error('The Gnosis Safe state of the execution was not read.')
		const earlierSimulatedExecutions = earlierSimulatedExecutionsBySafe.get(safeAddress) ?? 0n
		const earlierExecutions = earlierSimulatedExecutions + (earlierExecTransactionCalls < MAX_COUNTED_RELAYED_EXECUTIONS ? earlierExecTransactionCalls : MAX_COUNTED_RELAYED_EXECUTIONS)
		earlierSimulatedExecutionsBySafe.set(safeAddress, earlierSimulatedExecutions + 1n)
		// The data the Safe calls or delegate-calls with, a MultiSend batch included.
		earlierExecTransactionCalls += countExecTransactionSelectors(execution.message.data)
		const approvedHashSlots = approvedHashSlotsBySafe.get(safeAddress) ?? {}
		for (let nonce = safeState.nonce; nonce <= safeState.nonce + earlierExecutions; nonce++) {
			const safeTxHash = BigInt(getSafeTxHash(createSafeTxFromMessage(execution.chainId, safeAddress, { ...execution.message, nonce })))
			for (const owner of getSigningOwners(safeState)) approvedHashSlots[getApprovedHashStorageSlot(owner, safeTxHash)] = 1n
		}
		approvedHashSlotsBySafe.set(safeAddress, approvedHashSlots)
		const executedTransaction = createExecutorTransaction(execution, signedTransaction, getSigningOwners(safeState), executorNonce, maxFeePerGas)
		executorNonce += 1n
		executorBalance += executedTransaction.gas * maxFeePerGas
		return { ...transaction, executedTransaction }
	}) }))
	const [firstBlock, ...laterBlocks] = preparedInput
	if (firstBlock === undefined) return preparedInput
	const stateOverrides: MutableStateOverrides = { ...firstBlock.stateOverrides }
	for (const [safeAddress, approvedHashSlots] of approvedHashSlotsBySafe) {
		const safeOverride = stateOverrides[addressString(safeAddress)]
		stateOverrides[addressString(safeAddress)] = { ...safeOverride, stateDiff: { ...safeOverride?.stateDiff, ...approvedHashSlots } }
	}
	stateOverrides[addressString(SAFE_EXECUTION_SIMULATION_EXECUTOR)] = { ...stateOverrides[addressString(SAFE_EXECUTION_SIMULATION_EXECUTOR)], balance: executorBalance }
	return [{ ...firstBlock, stateOverrides }, ...laterBlocks]
}

/**
 * Estimates a Gnosis Safe's own call the way the simulation runs it: as the executor's execTransaction call on top of the simulation input, so the call sees the executor as tx.origin and the real base fee, and the estimate covers execTransaction's own work and the Safe's guard. The estimate becomes the gas of the Safe's call, which prepareSafeExecutionSimulationInput turns into the executor's gas limit.
 */
export async function estimateSafeExecutionGas(
	ethereum: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationInput: SimulationStateInput,
	safeCallWithoutGas: DistributiveOmit<EthereumUnsignedTransaction, 'gas'>,
	safeCallFields: Pick<PreSimulationTransaction, 'website' | 'created' | 'originalRequestParameters' | 'transactionIdentifier'>,
): Promise<{ error: ErrorWithCodeAndOptionalData } | { gas: bigint }> {
	const parentBlock = await ethereum.getBlock(requestAbortController)
	if (parentBlock === null) throw new Error('The latest block is null')
	const blockGasLimit = parentBlock.gasLimit
	const safeCall: PreSimulationTransaction = {
		...safeCallFields,
		signedTransaction: mockSignTransaction({ ...safeCallWithoutGas, gas: blockGasLimit }),
		simulationOptions: { requiredChainId: ethereum.getChainId(), simulateWithZeroBaseFee: false, executeThroughSafe: true },
	}
	// appendTransactionsToInput puts the Safe's call alone in a new last block.
	const preparedInput = await prepareSafeExecutionSimulationInput(appendTransactionsToInput(simulationInput, [safeCall]), ethereum, parentBlock.number, parentBlock.baseFeePerGas ?? 15_000_000n)
	const lastBlock = last(preparedInput)
	const executedTransaction = last(lastBlock?.transactions ?? [])?.executedTransaction
	if (lastBlock === undefined || executedTransaction === undefined) throw new Error('The Gnosis Safe execution to estimate was not prepared.')
	// Recognised from the failed call itself, because the estimate's error keeps only the call's return data.
	let safeCallReverted = false
	const simulateWithGasLimit = async (gasLimit: bigint) => {
		const input = [...preparedInput.slice(0, -1), { ...lastBlock, transactions: [{ ...safeCall, executedTransaction: { ...executedTransaction, gas: gasLimit } }] }]
		const result = last(last(await ethereum.simulate(input, parentBlock.number, requestAbortController))?.calls ?? [])
		safeCallReverted = result?.status === 'failure' && isSafeCallRevert(result.error, result.returnData)
		return result
	}
	const initialResult = await simulateWithGasLimit(blockGasLimit)
	if (initialResult === undefined) return { error: { code: ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED, message: 'ETH Simulate Failed to estimate gas', data: '0x' } }
	const estimate = await getGasEstimateFromSimulation(initialResult, blockGasLimit, simulateWithGasLimit)
	if ('error' in estimate && (safeCallReverted || isSafeCallRevert(estimate.error))) return { error: { ...estimate.error, message: SAFE_CALL_REVERTED_MESSAGE } }
	return estimate
}
