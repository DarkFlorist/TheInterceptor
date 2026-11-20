import type { VisualizedPersonalSignRequest } from '../types/personal-message-definitions.js'
import { MOCK_PRIVATE_KEYS_ADDRESS } from './constants.js'

export function isPossibleToSignMessage(visualizedPersonalSignRequest: VisualizedPersonalSignRequest, activeAddress: bigint) {
	return !(visualizedPersonalSignRequest.simulationMode && (activeAddress !== MOCK_PRIVATE_KEYS_ADDRESS || visualizedPersonalSignRequest.method !== 'personal_sign'))
}
