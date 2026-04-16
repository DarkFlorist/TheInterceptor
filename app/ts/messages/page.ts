import * as funtypes from 'funtypes'
import { InterceptorMessageToInpage } from '../types/interceptor-messages.js'
import { RawInterceptedRequest } from '../utils/requests.js'
import { TransportEnvelope } from './shared.js'

export const PAGE_RPC_REQUEST = 'rpc.request'
export const PAGE_RPC_RESPONSE = 'rpc.response'
export const PAGE_RPC_EVENT = 'rpc.event'

export type PageRequestPayload = {
	method: RawInterceptedRequest['method']
	params?: readonly unknown[]
	usingInterceptorWithoutSigner: boolean
	interceptorRequest: true
}

export type PagePortToBackgroundEnvelope = TransportEnvelope<typeof PAGE_RPC_REQUEST, PageRequestPayload>
export type PagePortToPageEnvelope = TransportEnvelope<typeof PAGE_RPC_RESPONSE | typeof PAGE_RPC_EVENT, InterceptorMessageToInpage>

const PageRequestPayloadRuntype = funtypes.Intersect(
	funtypes.Union(
		funtypes.ReadonlyObject({
			method: funtypes.String,
			params: funtypes.Union(funtypes.ReadonlyArray(funtypes.Unknown), funtypes.Undefined),
		}).asReadonly(),
		funtypes.ReadonlyObject({
			method: funtypes.String,
		}).asReadonly(),
	),
	funtypes.ReadonlyObject({
		interceptorRequest: funtypes.Literal(true),
		usingInterceptorWithoutSigner: funtypes.Boolean,
	}),
)
const PagePortEnvelopeRuntype = funtypes.Union(
	funtypes.ReadonlyObject({
		kind: funtypes.Literal('request'),
		id: funtypes.Number,
		action: funtypes.Literal(PAGE_RPC_REQUEST),
		payload: funtypes.Unknown,
	}),
	funtypes.ReadonlyObject({
		kind: funtypes.Literal('response'),
		id: funtypes.Number,
		action: funtypes.Literal(PAGE_RPC_RESPONSE),
		ok: funtypes.Literal(true),
		payload: funtypes.Unknown,
	}),
	funtypes.ReadonlyObject({
		kind: funtypes.Literal('response'),
		id: funtypes.Number,
		action: funtypes.Literal(PAGE_RPC_RESPONSE),
		ok: funtypes.Literal(false),
		error: funtypes.Intersect(
			funtypes.ReadonlyObject({ message: funtypes.String }),
			funtypes.Partial({
				code: funtypes.Number,
				data: funtypes.Unknown,
			}),
		),
	}),
	funtypes.ReadonlyObject({
		kind: funtypes.Literal('event'),
		action: funtypes.Literal(PAGE_RPC_EVENT),
		payload: funtypes.Unknown,
	}),
)

export function isPagePortEnvelope(value: unknown): value is PagePortToBackgroundEnvelope | PagePortToPageEnvelope {
	return PagePortEnvelopeRuntype.safeParse(value).success
}

export function isPageRequestPayload(value: unknown): value is PageRequestPayload {
	return PageRequestPayloadRuntype.safeParse(value).success
}
