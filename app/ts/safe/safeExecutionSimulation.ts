import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransactionsToInput } from '../simulation/services/SimulationModeEthereumClientService.js'
import { getGasEstimateFromSimulation } from '../simulation/services/simulationGasEstimation.js'
import { mockSignTransaction } from '../simulation/services/simulationTransactionSigning.js'
import type { ErrorWithCodeAndOptionalData } from '../types/error.js'
import type { MutableStateOverrides } from '../types/ethSimulate-types.js'
import type { PreSimulationTransaction, SimulationStateInput } from '../types/visualizer-types.js'
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
import { decodeEthereumError } from '../utils/errorDecoding.js'

// The account that sends simulated Gnosis Safe executions. It is random for each background session, so a called contract can't recognise the simulation by a known tx.origin. On-chain, too, a Safe's transactions are often sent by accounts that aren't its owners, such as relayers.
export const SAFE_EXECUTION_SIMULATION_EXECUTOR = generate256BitRandomBigInt() >> 96n

// The storage slot of `mapping(address => mapping(bytes32 => uint256)) approvedHashes` in every Gnosis Safe version Interceptor supports (SUPPORTED_SAFE_VERSIONS in safeCore.ts).
const SAFE_APPROVED_HASHES_SLOT = 8n
// The executor's tip, the default formEthSendTransaction gives a transaction.
const EXECUTOR_MAX_PRIORITY_FEE_PER_GAS = 10n ** 8n // 0.1 nanoeth/gas
// Gas for execTransaction's own work around the Safe's call: its calldata, the signature checks, the nonce update, its event and the Safe's guard if it has one. The node charges only the gas used, so a generous allowance only keeps an execution from failing for lack of gas.
const SAFE_EXECUTION_GAS_ALLOWANCE = 1_000_000n

export const isSafeExecutionSimulation = (transaction: Pick<PreSimulationTransaction, 'simulationOptions'>) => transaction.simulationOptions?.executeThroughSafe === true

const compareAddresses = (first: bigint, second: bigint) => first < second ? -1 : first > second ? 1 : 0

const getApprovedHashStorageSlot = (owner: bigint, safeTxHash: bigint) => keccak256(encodeAbiValues(
	['bytes32', 'bytes32'],
	[bytes32String(safeTxHash), keccak256(encodeAbiValues(['address', 'uint256'], [addressString(owner), SAFE_APPROVED_HASHES_SLOT]))],
))

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
		// The Safe passes on at most 63/64 of the remaining gas to its call.
		gas: safeCall.gas * 64n / 63n + SAFE_EXECUTION_GAS_ALLOWANCE,
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
 * Prepares every Gnosis Safe execution in the input (isSafeExecutionSimulation) to run the way the Safe runs it on-chain: SAFE_EXECUTION_SIMULATION_EXECUTOR calls the Safe's execTransaction with real fees in a block with the real base fee, and the Safe makes the call. The transaction's signedTransaction stays the Safe's call; the call the node runs is its executedTransaction.
 * The simulation assumes the Safe's owners approved the call. The first block's state overrides mark the call's SafeTx hash as approved (approvedHashes) by every owner of the Safe at the parent block, and the execution carries their pre-validated signatures. The Safe can reach this state on-chain, through approveHash. An owner that an earlier execution on the stack removes still signs, so an execution after such a removal can fail the Safe's signature check (GS026).
 * The approvals are visible: a called contract that reads its Safe's approvedHashes for the current SafeTx hash finds them set, as it would if the owners had approved with approveHash, but not if they sign off-chain. A preview runs before the owners have signed, so it has to make the Safe accept approvals it doesn't have yet. The alternatives can be told apart as well: replacing the ecrecover precompile to accept made-up signatures puts code at its address, and lowering the threshold changes getThreshold. approvedHashes is the one of them the Safe can reach on-chain, and a contract can only see it by inspecting its own Safe, unlike a tx.origin that is a contract or a zero base fee.
 * The SafeTx hash includes the Safe's nonce at execution, and each earlier execution of the same Safe in the input raises it by one if it succeeds: a simulated Safe execution, or a call to the Safe's execTransaction, whether a stacked transaction or a Safe execution makes it. So an execution is approved at every nonce from the Safe's nonce at the parent block up to that nonce plus its number of earlier executions.
 * The first block also funds the executor for every execution's gas at its maximum fee.
 */
export async function prepareSafeExecutionSimulationInput(input: SimulationStateInput, ethereum: EthereumClientService, parentBlockNumber: bigint, baseFeePerGas: bigint): Promise<SimulationStateInput> {
	const safeAddresses = new Set(input.flatMap((block) => block.transactions.filter(isSafeExecutionSimulation).map((transaction) => transaction.signedTransaction.from)))
	if (safeAddresses.size === 0) return input
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
		if (!isSafeExecutionSimulation(transaction)) {
			countExecTransactionCall(transaction.signedTransaction)
			return transaction
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
	const simulateWithGasLimit = async (gasLimit: bigint) => {
		const input = [...preparedInput.slice(0, -1), { ...lastBlock, transactions: [{ ...safeCall, executedTransaction: { ...executedTransaction, gas: gasLimit } }] }]
		return last(last(await ethereum.simulate(input, parentBlock.number, requestAbortController))?.calls ?? [])
	}
	const initialResult = await simulateWithGasLimit(blockGasLimit)
	if (initialResult === undefined) return { error: { code: ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED, message: 'ETH Simulate Failed to estimate gas', data: '0x' } }
	const estimate = await getGasEstimateFromSimulation(initialResult, blockGasLimit, simulateWithGasLimit)
	if ('error' in estimate && isSafeCallRevert(estimate.error)) return { error: { ...estimate.error, message: SAFE_CALL_REVERTED_MESSAGE } }
	return estimate
}

// When the Safe's call fails, execTransaction reverts with GS013 and drops the call's own revert reason, so the bare code is explained instead.
const SAFE_CALL_REVERTED_MESSAGE = 'The Gnosis Safe\'s call reverted (GS013). The Safe does not pass on the call\'s own revert reason.'

// Nodes report the revert reason in the message, in the error's data, in the call's return data, or in several of them.
const isSafeCallRevert = (error: ErrorWithCodeAndOptionalData, returnData?: Uint8Array) => error.message.endsWith('GS013')
	|| [error.data, returnData === undefined ? undefined : dataStringWith0xStart(returnData)].some((data) => data !== undefined && decodeEthereumError([], { ...error, data }).reason === 'GS013')

export function describeSafeExecutionFailure(transaction: Pick<PreSimulationTransaction, 'simulationOptions'>, failure: { readonly error: ErrorWithCodeAndOptionalData, readonly returnData: Uint8Array }, decodedErrorMessage: string) {
	if (!isSafeExecutionSimulation(transaction) || !isSafeCallRevert(failure.error, failure.returnData)) return decodedErrorMessage
	return SAFE_CALL_REVERTED_MESSAGE
}
