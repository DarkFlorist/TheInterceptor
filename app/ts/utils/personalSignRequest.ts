import type { VisualizedPersonalSignRequest } from '../types/personal-message-definitions.js'
import { MOCK_PRIVATE_KEYS_ADDRESS } from './constants.js'

export function isPossibleToSignMessage(visualizedPersonalSignRequest: VisualizedPersonalSignRequest, activeAddress: bigint) {
	return !(visualizedPersonalSignRequest.simulationMode && (activeAddress !== MOCK_PRIVATE_KEYS_ADDRESS || visualizedPersonalSignRequest.method !== 'personal_sign'))
}

// Whether a signature request can proceed without the send-anyway override: the simulation signer can sign it, or the RPC can simulate it, and signing mode always can. A quarantined request that can proceed still needs the acknowledgement. The popup's Confirm button and the background's accept check both decide this through this one rule.
export function canSignatureRequestProceedWithoutOverride(visualizedPersonalSignRequest: VisualizedPersonalSignRequest) {
	return isPossibleToSignMessage(visualizedPersonalSignRequest, visualizedPersonalSignRequest.activeAddress.address)
		|| visualizedPersonalSignRequest.rpcNetwork.httpsRpc !== undefined
}
