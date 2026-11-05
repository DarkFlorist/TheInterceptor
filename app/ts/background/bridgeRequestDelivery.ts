export const INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE = 'interceptor_bridge_acknowledgement'

// A request is handled only under an id that orders it, so it cannot reuse another request's identity: a non-negative safe integer, or the diagnostics' fixed id -1, which is never deduplicated and opens no confirmation.
export const isHandledBridgeRequestId = (requestId: number, method: string) => Number.isSafeInteger(requestId) && (requestId >= 0 || (requestId === -1 && method === 'InterceptorError'))

export function acknowledgeAndTrackBridgeRequest(
	latestReceivedRequestIds: Map<string, number>,
	socketIdentifier: string,
	requestId: number,
	acknowledge: () => void,
): boolean {
	const latestReceivedRequestId = latestReceivedRequestIds.get(socketIdentifier)
	const requestWasAlreadyReceived = requestId >= 0 && latestReceivedRequestId !== undefined && requestId <= latestReceivedRequestId
	acknowledge()
	if (requestWasAlreadyReceived) return false
	if (requestId >= 0) latestReceivedRequestIds.set(socketIdentifier, requestId)
	return true
}
