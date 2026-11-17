export const INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE = 'interceptor_bridge_acknowledgement'

// A request is handled only under an id that orders it, so it cannot reuse another request's identity: a non-negative safe integer, or the diagnostics' fixed id -1, which is never deduplicated and opens no confirmation.
export const isHandledBridgeRequestId = (requestId: number, method: string) => Number.isSafeInteger(requestId) && (requestId >= 0 || (requestId === -1 && method === 'InterceptorError'))

export function acknowledgeAndTrackBridgeRequest(
	latestReceivedRequestIds: Map<string, number>,
	socketIdentifier: string,
	requestId: number,
	acknowledge: () => void,
): boolean {
	// Only an ordered id takes part in the watermark: a malformed one is acknowledged but never recorded, so it cannot make later requests look already received.
	const requestIdIsOrdered = Number.isSafeInteger(requestId) && requestId >= 0
	const latestReceivedRequestId = latestReceivedRequestIds.get(socketIdentifier)
	const requestWasAlreadyReceived = requestIdIsOrdered && latestReceivedRequestId !== undefined && requestId <= latestReceivedRequestId
	acknowledge()
	if (requestWasAlreadyReceived) return false
	if (requestIdIsOrdered) latestReceivedRequestIds.set(socketIdentifier, requestId)
	return true
}
