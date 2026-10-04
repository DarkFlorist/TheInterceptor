import type { WalletGetCapabilities } from '../types/JsonRpc-types.js'
import { GNOSIS_SAFE_EXECUTION_CAPABILITY, GNOSIS_SAFE_EXECUTION_CAPABILITY_VERSION } from '../types/JsonRpc-types.js'
import type { RPCReply } from '../types/interceptor-messages.js'
import { METAMASK_ERROR_NOT_AUTHORIZED } from '../utils/constants.js'
import { addressString } from '../utils/bigint.js'

type GnosisSafeExecutionCapability = {
	readonly supported: true
	readonly version: typeof GNOSIS_SAFE_EXECUTION_CAPABILITY_VERSION
	readonly activeSigner: `0x${ string }`
	readonly submissionMethod: 'eth_sendTransaction'
}

export function getWalletCapabilities(
	request: WalletGetCapabilities,
	activeAddress: bigint | undefined,
	activeChainId: bigint,
	activeSafeSigner: bigint | undefined,
): RPCReply {
	const [requestedAddress, requestedChainIds] = request.params
	if (activeAddress === undefined || requestedAddress !== activeAddress) {
		return {
			type: 'result',
			method: request.method,
			error: {
				code: METAMASK_ERROR_NOT_AUTHORIZED,
				message: 'The requested account has not been authorized by the user.',
			},
		}
	}
	if (activeSafeSigner === undefined || (requestedChainIds !== undefined && !requestedChainIds.includes(activeChainId))) {
		return { type: 'result', method: request.method, result: {} }
	}
	const safeExecutionCapability: GnosisSafeExecutionCapability = {
		supported: true,
		version: GNOSIS_SAFE_EXECUTION_CAPABILITY_VERSION,
		activeSigner: addressString(activeSafeSigner),
		submissionMethod: 'eth_sendTransaction',
	}
	const chainCapabilities: Readonly<Record<string, unknown>> = {
		[GNOSIS_SAFE_EXECUTION_CAPABILITY]: safeExecutionCapability,
	}
	return {
		type: 'result',
		method: request.method,
		result: { [`0x${ activeChainId.toString(16) }`]: chainCapabilities },
	}
}
