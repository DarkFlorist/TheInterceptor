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
	return a.requestId == b.requestId && a.requestSocket.connectionName === b.requestSocket.connectionName && a.requestSocket.tabId === b.requestSocket.tabId
}

export async function fetchWithTimeout(resource: RequestInfo | URL, init?: RequestInit | undefined, timeoutS: number = 60000) {
	const controller = new AbortController()
	const id = setTimeout(() => controller.abort(), timeoutS)
	const response = await fetch(resource, { ...init, signal: controller.signal })
	clearTimeout(id)
	return response
}
