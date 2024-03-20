import * as funtypes from 'funtypes'
import { EthereumQuantity } from '../types/wire-types.js'

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

export async function fetchWithTimeout(resource: RequestInfo | URL, init?: RequestInit | undefined, timeoutMs: number = 60000) {
	const controller = new AbortController()
	const id = setTimeout(() => controller.abort(), timeoutMs)
	try {
		const response = await fetch(resource, { ...init, signal: controller.signal })
		clearTimeout(id)
		return response
	} catch(error: unknown) {
		if (error instanceof DOMException && error.message === 'The user aborted a request.') throw new Error('Fetch request timed out.')
		throw error
	}
}

export const safeGetTab = async (tabId: number) => {
	const tab = await browser.tabs.get(tabId)
	try {
		const error = browser.runtime.lastError
		if (error !== undefined && error.message !== undefined) throw new Error(error.message)
		return tab
	} catch (e: unknown){
		return undefined
	}
}

export const safeGetWindow = async (windowId: number) => {
	const tab = await browser.windows.get(windowId)
	try {
		const error = browser.runtime.lastError
		if (error !== undefined && error.message !== undefined) throw new Error(error.message)
		return tab
	} catch (e: unknown){
		return undefined
	}
}

export const updateTabIfExists = async (tabId: number, updateProperties: browser.tabs._UpdateUpdateProperties) => {
	try {
		const tab = await browser.tabs.update(tabId, updateProperties)
		const error = browser.runtime.lastError
		if (error !== undefined && error.message !== undefined) throw new Error(error.message)
		return tab
	} catch (e: unknown){
		return undefined
	}
}

export const updateWindowIfExists = async (tabId: number, updateProperties: browser.windows._UpdateUpdateInfo) => {
	try {
		const window = await browser.windows.update(tabId, updateProperties)
		const error = browser.runtime.lastError
		if (error !== undefined && error.message !== undefined) throw new Error(error.message)
		return window
	} catch (e: unknown){
		return undefined
	}
}
