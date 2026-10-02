import { RawInterceptedRequest, checkAndThrowRuntimeLastError, type InterceptedRequest, type WebsiteSocket } from '../utils/requests.js'
import { websiteSocketToString } from './backgroundUtils.js'

export const INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE = 'interceptor_bridge_acknowledgement'

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

// All ports use the same validation, acknowledgement and replay watermark, including ports with unsupported document origins.
export function receiveBridgeRequest(latestReceivedRequestIds: Map<string, number>, socket: WebsiteSocket, port: Pick<browser.runtime.Port, 'postMessage'>, payload: unknown): InterceptedRequest | undefined {
	if (typeof payload !== 'object' || payload === null || !('data' in payload) || typeof payload.data !== 'object' || payload.data === null || !('interceptorRequest' in payload.data)) return undefined
	const rawMessage = RawInterceptedRequest.parse(payload.data)
	const shouldHandleRequest = acknowledgeAndTrackBridgeRequest(latestReceivedRequestIds, websiteSocketToString(socket), rawMessage.requestId, () => {
		port.postMessage({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: rawMessage.requestId })
		checkAndThrowRuntimeLastError()
	})
	if (!shouldHandleRequest) return undefined
	return {
		method: rawMessage.method,
		...'params' in rawMessage ? { params: rawMessage.params } : {},
		interceptorRequest: rawMessage.interceptorRequest,
		usingInterceptorWithoutSigner: rawMessage.usingInterceptorWithoutSigner,
		uniqueRequestIdentifier: { requestId: rawMessage.requestId, requestSocket: socket },
		...(rawMessage.interceptorInternalRequest === true ? { interceptorInternalRequest: true as const } : {}),
	}
}
