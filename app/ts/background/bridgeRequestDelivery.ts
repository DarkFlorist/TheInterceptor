export function acknowledgeBridgeRequest(
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
