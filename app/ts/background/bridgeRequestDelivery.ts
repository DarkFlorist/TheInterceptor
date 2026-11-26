import { classifyRequestId, type RawInterceptedRequest } from '../utils/requests.js'

export function acknowledgeAndTrackBridgeRequest(
	latestReceivedRequestIds: Map<string, number>,
	socketIdentifier: string,
	request: Pick<RawInterceptedRequest, 'requestId' | 'method'>,
	acknowledge: () => void,
): 'handle' | 'duplicate' | 'invalid' {
	const idKind = classifyRequestId(request)
	const latestReceivedRequestId = latestReceivedRequestIds.get(socketIdentifier)
	acknowledge()
	switch (idKind) {
		case 'invalid': return 'invalid'
		case 'diagnostic': return 'handle'
		case 'ordered': {
			if (latestReceivedRequestId !== undefined && request.requestId <= latestReceivedRequestId) return 'duplicate'
			latestReceivedRequestIds.set(socketIdentifier, request.requestId)
			return 'handle'
		}
	}
}
