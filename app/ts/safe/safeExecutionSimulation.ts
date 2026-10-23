import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { MutableStateOverrides } from '../types/ethSimulate-types.js'
import type { PreSimulationTransaction, SimulationStateInput } from '../types/visualizer-types.js'
import type { EthereumSendableSignedTransaction } from '../types/wire-types.js'
import { encodeAbiValues, encodeFunctionCall } from '../utils/abiRuntime.js'
import { addressString, bytes32String, dataStringWith0xStart, generate256BitRandomBigInt, stringToUint8Array } from '../utils/bigint.js'
import { getSafeTxHash } from '../utils/eip712.js'
import { keccak256 } from '../utils/ethereumPrimitives.js'
import { createSafeTx, getSafeContractStateAtBlock, type SafeContractState } from './safeCore.js'
import { prevalidatedSafeSignature, SAFE_EXECUTION_ABI } from './safeExecution.js'

// The account that sends simulated Gnosis Safe executions. It is random for each background session, so a called contract can't recognise the simulation by a known tx.origin. On-chain, too, a Safe's transactions are often sent by accounts that aren't its owners, such as relayers.
export const SAFE_EXECUTION_SIMULATION_EXECUTOR = generate256BitRandomBigInt() >> 96n

// The storage slot of `mapping(address => mapping(bytes32 => uint256)) approvedHashes` in every Gnosis Safe version Interceptor supports (SUPPORTED_SAFE_VERSIONS in safeCore.ts).
const SAFE_APPROVED_HASHES_SLOT = 8n
// The executor's tip, the default formEthSendTransaction gives a transaction.
const EXECUTOR_MAX_PRIORITY_FEE_PER_GAS = 10n ** 8n // 0.1 nanoeth/gas
// Gas for execTransaction's own work around the Safe's call: its calldata, the signature checks, the nonce update, its event and the Safe's guard if it has one.
const SAFE_EXECUTION_GAS_OVERHEAD = 100_000n
const SAFE_EXECUTION_GAS_PER_SIGNATURE = 10_000n

export const isSafeExecutionSimulation = (transaction: Pick<PreSimulationTransaction, 'simulationOptions'>) => transaction.simulationOptions?.executeThroughSafe === true

const compareAddresses = (first: bigint, second: bigint) => first < second ? -1 : first > second ? 1 : 0

const getApprovedHashStorageSlot = (owner: bigint, safeTxHash: bigint) => keccak256(encodeAbiValues(
	['bytes32', 'bytes32'],
	[bytes32String(safeTxHash), keccak256(encodeAbiValues(['address', 'uint256'], [addressString(owner), SAFE_APPROVED_HASHES_SLOT]))],
))

// The Safe needs `threshold` owner signatures; the lowest owners sign, as execTransaction requires signatures sorted by owner.
const getApprovingOwners = (safeState: SafeContractState) => [...safeState.owners].sort(compareAddresses).slice(0, Number(safeState.threshold))

// The Safe's own call: from the Safe, to the called contract.
type SafeCall = Pick<Extract<EthereumSendableSignedTransaction, { readonly type: '1559' }>, 'from' | 'chainId' | 'gas' | 'value' | 'input' | 'hash'> & { readonly to: bigint }

function createExecutorTransaction(safeCall: SafeCall, safeState: SafeContractState, executorNonce: bigint, maxFeePerGas: bigint): EthereumSendableSignedTransaction {
	const signatures: `0x${ string }` = `0x${ getApprovingOwners(safeState).map((owner) => prevalidatedSafeSignature(owner).slice(2)).join('') }`
	return {
		type: '1559',
		from: SAFE_EXECUTION_SIMULATION_EXECUTOR,
		chainId: safeCall.chainId,
		nonce: executorNonce,
		maxFeePerGas,
		maxPriorityFeePerGas: EXECUTOR_MAX_PRIORITY_FEE_PER_GAS,
		// The Safe passes on at most 63/64 of the remaining gas to its call.
		gas: safeCall.gas * 64n / 63n + SAFE_EXECUTION_GAS_OVERHEAD + SAFE_EXECUTION_GAS_PER_SIGNATURE * safeState.threshold,
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
 * The simulation assumes the Safe's owners approved the call. The first block's state overrides mark the call's SafeTx hash as approved (approvedHashes) by the Safe's lowest `threshold` owners, and the execution carries their pre-validated signatures. The Safe can reach this state on-chain, through approveHash.
 * The SafeTx hash includes the Safe's nonce at execution, and each earlier execution of the same Safe in the input raises it by one if it succeeds. So an execution is approved at every nonce from the Safe's nonce at the parent block up to that nonce plus its number of earlier executions.
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
	const preparedInput = input.map((block) => ({ ...block, transactions: block.transactions.map((transaction) => {
		if (!isSafeExecutionSimulation(transaction)) return transaction
		const { signedTransaction } = transaction
		if (signedTransaction.type !== '1559') throw new Error('A Gnosis Safe execution simulation requires an EIP-1559 transaction.')
		if (signedTransaction.to === null) throw new Error('A Gnosis Safe execution cannot create a contract.')
		const safeCall: SafeCall = { ...signedTransaction, to: signedTransaction.to }
		const safeAddress = safeCall.from
		const safeState = safeStates.get(safeAddress)
		if (safeState === undefined) throw new Error('The Gnosis Safe state of the execution was not read.')
		const earlierExecutions = earlierExecutionsBySafe.get(safeAddress) ?? 0n
		earlierExecutionsBySafe.set(safeAddress, earlierExecutions + 1n)
		const approvedHashSlots = approvedHashSlotsBySafe.get(safeAddress) ?? {}
		for (let nonce = safeState.nonce; nonce <= safeState.nonce + earlierExecutions; nonce++) {
			const safeTxHash = BigInt(getSafeTxHash(createSafeTx(safeCall.chainId, safeAddress, { to: safeCall.to, value: safeCall.value, input: safeCall.input }, nonce)))
			for (const owner of getApprovingOwners(safeState)) approvedHashSlots[getApprovedHashStorageSlot(owner, safeTxHash)] = 1n
		}
		approvedHashSlotsBySafe.set(safeAddress, approvedHashSlots)
		const executedTransaction = createExecutorTransaction(safeCall, safeState, executorNonce, maxFeePerGas)
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

// When the Safe's call fails, execTransaction reverts with GS013 and drops the call's own revert reason, so the bare code is explained instead.
export function describeSafeExecutionFailure(transaction: Pick<PreSimulationTransaction, 'simulationOptions'>, decodedErrorMessage: string) {
	if (!isSafeExecutionSimulation(transaction) || decodedErrorMessage !== 'GS013') return decodedErrorMessage
	return 'The Gnosis Safe\'s call reverted (GS013). The Safe does not pass on the call\'s own revert reason.'
}
