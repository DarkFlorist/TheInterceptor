import { type EthSimulateV1Params, EthSimulateV1Result } from '../types/ethSimulate-types.js'
import { addressString } from '../utils/bigint.js'

const PROBE_SENDER = 0xc000000000000000000000000000000000000000n
// Must differ from the sender: a node with EIP-7708 active logs no transfer to the same account, so a self-transfer would make a working RPC look unsupported.
const PROBE_RECEIVER = 0xc000000000000000000000000000000000000001n

export const ETH_SIMULATE_SUPPORT_PROBE: EthSimulateV1Params['params'][0] = {
	blockStateCalls: [{
		blockOverrides: {
			baseFeePerGas: 0x9n
		},
		stateOverrides: {
			[addressString(PROBE_SENDER)]: {
				balance: 0x1312d0000n,
			}
		},
		calls: [
			{
				from: PROBE_SENDER,
				to: PROBE_RECEIVER,
				value: 0x1n,
				maxFeePerGas: 0xfn,
			}
		]
	}],
	validation: true,
	traceTransfers: true
}

export const ethSimulateSupportProbeReturnedEthLog = (serializedResult: unknown) => {
	const result = EthSimulateV1Result.safeParse(serializedResult)
	if (!result.success) return false
	const probeCall = result.value[0]?.calls[0]
	return probeCall?.status === 'success' && probeCall.logs.length === 1
}
