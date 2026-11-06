import type { BlockCalls, EthSimulateV1CallResult, EthSimulateV1Result, EthereumEvent } from '../../types/ethSimulate-types.js'
import { EthereumQuantity } from '../../types/wire-types.js'
import { bytes32String } from '../../utils/bigint.js'
import { EIP7708_SYSTEM_ADDRESS, ETHEREUM_LOGS_LOGGER_ADDRESS, TRANSFER_LOG } from '../../utils/constants.js'

const ETH_AMOUNT_BYTE_LENGTH = 32

// The log EIP-7708 specifies: Transfer(from, to) with the amount as one big endian word. Other logs from the address, such as a differently shaped one a future fork adds, are not read as transfers.
const isProtocolEthTransferLog = (log: EthereumEvent) => {
	const [signature, ...addressTopics] = log.topics
	return log.address === EIP7708_SYSTEM_ADDRESS
		&& signature !== undefined
		&& bytes32String(signature) === TRANSFER_LOG
		&& addressTopics.length === 2
		&& log.data.length === ETH_AMOUNT_BYTE_LENGTH
}

const hasProtocolEthTransferLog = (result: EthSimulateV1Result) => result.some((block) => block.calls.some((call) => call.status === 'success' && call.logs.some(isProtocolEthTransferLog)))

// Keyed by whatever casing the override's author used, so compare as numbers. Empty code leaves the account unable to run, so it cannot log. Overrides persist into later simulated blocks, so one in any block taints the whole request.
const overridesGiveSystemAddressCode = (blockStateCalls: readonly BlockCalls[]) => blockStateCalls.some((block) => Object.entries(block.stateOverrides ?? {}).some(([address, override]) => {
	return EthereumQuantity.parse(address) === EIP7708_SYSTEM_ADDRESS && (override?.code?.length ?? 0) > 0
}))

const withEthLoggerAddress = (call: EthSimulateV1CallResult): EthSimulateV1CallResult => {
	if (call.status === 'failure') return call
	return { ...call, logs: call.logs.map((log) => isProtocolEthTransferLog(log) ? { ...log, address: ETHEREUM_LOGS_LOGGER_ADDRESS } : log) }
}

// Nodes report ETH transfers from EIP7708_SYSTEM_ADDRESS once the fork is active, instead of the ETHEREUM_LOGS_LOGGER_ADDRESS tracer log every ETH feature here reads, so this relabels them. The address alone proves nothing: a node logs from it for any code placed there, and Safe delegate and Compound timelock simulations place code at an address a website or contract picks. LOG opcodes log the executing account, an account without code executes nothing, and neither a CREATE address nor a 7702 authority can be aimed at the address without a preimage or its private key, so the node is the only possible author exactly when the address has no code in the chain state the simulation starts from or in the request's overrides. A movePrecompileToAddress override aimed at the address needs no check, because a precompile runs without LOG opcodes. Anything else stays an ordinary log of an unknown contract.
export const recogniseProtocolEthTransferLogs = async (
	result: EthSimulateV1Result,
	blockStateCalls: readonly BlockCalls[],
	getSystemAddressCode: () => Promise<Uint8Array>,
): Promise<EthSimulateV1Result> => {
	if (!hasProtocolEthTransferLog(result)) return result
	if (overridesGiveSystemAddressCode(blockStateCalls)) return result
	if ((await getSystemAddressCode()).length > 0) return result
	return result.map((block) => ({ ...block, calls: block.calls.map(withEthLoggerAddress) }))
}
