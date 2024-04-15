import * as funtypes from 'funtypes'
import { EthereumQuantity } from '../types/wire-types.js'
import { anySignal } from './anySignal.js'

export type WebsiteSocket = funtypes.Static<typeof WebsiteSocket>
export const WebsiteSocket = funtypes.ReadonlyObject({
	tabId: funtypes.Number,
	connectionName: EthereumQuantity,
})

export type UniqueRequestIdentifier = funtypes.Static<typeof UniqueRequestIdentifier>
export const UniqueRequestIdentifier = funtypes.ReadonlyObject({
	requestId: funtypes.Number,
	requestSocket: WebsiteSocket,
}).asReadonly()

export type RawInterceptedRequest = funtypes.Static<typeof RawInterceptedRequest>
export const RawInterceptedRequest = funtypes.Intersect(
	funtypes.Union(
		funtypes.ReadonlyObject({
			method: funtypes.String,
			params: funtypes.Union(funtypes.Array(funtypes.Unknown), funtypes.Undefined)
		}).asReadonly(),
		funtypes.ReadonlyObject({ method: funtypes.String }).asReadonly()
	),
	funtypes.ReadonlyObject({
		interceptorRequest: funtypes.Boolean,
		usingInterceptorWithoutSigner: funtypes.Boolean,
		requestId: funtypes.Number,
	})
)

export type InterceptedRequest = funtypes.Static<typeof InterceptedRequest>
export const InterceptedRequest = funtypes.Intersect(
	funtypes.Union(
		funtypes.ReadonlyObject({
			method: funtypes.String,
			params: funtypes.Union(funtypes.Array(funtypes.Unknown), funtypes.Undefined)
		}).asReadonly(),
		funtypes.ReadonlyObject({ method: funtypes.String }).asReadonly()
	),
	funtypes.ReadonlyObject({
		interceptorRequest: funtypes.Boolean,
		usingInterceptorWithoutSigner: funtypes.Boolean,
		uniqueRequestIdentifier: UniqueRequestIdentifier,
	})
)
export type ProviderMessage = InterceptedRequest

export const getUniqueRequestIdentifierString = (uniqueRequestIdentifier: UniqueRequestIdentifier) => {
	return `${ uniqueRequestIdentifier.requestSocket.tabId }-${ uniqueRequestIdentifier.requestSocket.connectionName }-${ uniqueRequestIdentifier.requestId }`
}

export const doesUniqueRequestIdentifiersMatch = (a: UniqueRequestIdentifier, b: UniqueRequestIdentifier) => {
	return a.requestId === b.requestId && a.requestSocket.connectionName === b.requestSocket.connectionName && a.requestSocket.tabId === b.requestSocket.tabId
}

export async function fetchWithTimeout(resource: RequestInfo | URL, init: RequestInit | undefined, timeoutMs: number, requestAbortController: AbortController | undefined = undefined) {
	const timeoutAbortController = new AbortController()
	const timeoutId = setTimeout(() => timeoutAbortController.abort(new Error('Fetch request timed out.')), timeoutMs)
	const requestAndTimeoutSignal = requestAbortController === undefined ? timeoutAbortController.signal : anySignal([timeoutAbortController.signal, requestAbortController.signal])
	try {
		if (requestAndTimeoutSignal.aborted) throw requestAndTimeoutSignal.reason
		return await fetch(resource, { ...init, signal: requestAndTimeoutSignal })
	} catch(error: unknown) {
		if (error instanceof DOMException && error.message === 'The user aborted a request.') throw new Error('Fetch request timed out.')
		throw error
	} finally {
		clearTimeout(timeoutId)
	}
}

export const safeGetTab = async (tabId: number) => {
	try {
		const tab = await browser.tabs.get(tabId)
		checkAndThrowRuntimeLastError()
		return tab
	} catch (e: unknown){
		return undefined
	}
}

export const safeGetWindow = async (windowId: number) => {
	try {
		const tab = await browser.windows.get(windowId)
		checkAndThrowRuntimeLastError()
		return tab
	} catch (e: unknown){
		return undefined
	}
}

export const updateTabIfExists = async (tabId: number, updateProperties: browser.tabs._UpdateUpdateProperties) => {
	try {
		const tab = await browser.tabs.update(tabId, updateProperties)
		checkAndThrowRuntimeLastError()
		return tab
	} catch (e: unknown){
		return undefined
	}
}

export const updateWindowIfExists = async (tabId: number, updateProperties: browser.windows._UpdateUpdateInfo) => {
	try {
		const window = await browser.windows.update(tabId, updateProperties)
		checkAndThrowRuntimeLastError()
		return window
	} catch (e: unknown){
		return undefined
	}
}

export const checkAndThrowRuntimeLastError = () => {
	const error: browser.runtime._LastError | undefined | null = browser.runtime.lastError // firefox return `null` on no errors
	if (error !== null && error !== undefined && error.message !== undefined) throw new Error(error.message)
}
