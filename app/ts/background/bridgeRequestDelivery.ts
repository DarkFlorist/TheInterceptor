import { classifyRequestId, type RawInterceptedRequest } from '../utils/requests.js'

export const INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE = 'interceptor_bridge_acknowledgement'

export function acknowledgeAndTrackBridgeRequest(
	latestReceivedRequestIds: Map<string, number>,
	socketIdentifier: string,
	request: Pick<RawInterceptedRequest, 'requestId' | 'method'>,
	acknowledge: () => void,
): 'handle' | 'duplicate' | 'invalid' {
	const idKind = classifyRequestId(request)
	const latestReceivedRequestId = latestReceivedRequestIds.get(socketIdentifier)
	acknowledge()
	if (idKind === 'invalid') return 'invalid'
	if (idKind === 'diagnostic') return 'handle'
	if (latestReceivedRequestId !== undefined && request.requestId <= latestReceivedRequestId) return 'duplicate'
	latestReceivedRequestIds.set(socketIdentifier, request.requestId)
	return 'handle'
}
