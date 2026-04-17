import * as funtypes from 'funtypes'
import { InterceptorMessageToInpage } from '../types/interceptor-messages.js'
import { serialize } from '../types/wire-types.js'
import { RawInterceptedRequest } from '../utils/requests.js'
import { TransportValue } from '../utils/json.js'
import {
	MessageErrorRuntype,
	TransportEnvelope,
	TransportEventEnvelope,
	TransportRequestEnvelope,
	TransportResponseEnvelope,
	createTransportEventEnvelope,
	createTransportRequestEnvelope,
	createTransportSuccessResponseEnvelope,
} from './shared.js'

export const PAGE_RPC_REQUEST = 'rpc.request'
export const PAGE_RPC_RESPONSE = 'rpc.response'
export const PAGE_RPC_EVENT = 'rpc.event'

export type PageRequestPayload = {
	method: RawInterceptedRequest['method']
	params?: readonly TransportValue[]
	usingInterceptorWithoutSigner: boolean
	interceptorRequest: true
}

export type PagePortToBackgroundEnvelope = TransportEnvelope<typeof PAGE_RPC_REQUEST, PageRequestPayload>
export type PagePortToPageEnvelope = TransportEnvelope<typeof PAGE_RPC_RESPONSE | typeof PAGE_RPC_EVENT, InterceptorMessageToInpage>

const PageRequestPayloadRuntype = funtypes.Intersect(
	funtypes.Union(
		funtypes.ReadonlyObject({
			method: funtypes.String,
			params: funtypes.Union(funtypes.ReadonlyArray(TransportValue), funtypes.Undefined),
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
const PageRequestEnvelopeRuntype = funtypes.ReadonlyObject({
	kind: funtypes.Literal('request'),
	id: funtypes.Number,
	action: funtypes.Literal(PAGE_RPC_REQUEST),
	payload: PageRequestPayloadRuntype,
})

const PageResponseEnvelopeRuntype = funtypes.ReadonlyObject({
	kind: funtypes.Literal('response'),
	id: funtypes.Number,
	action: funtypes.Literal(PAGE_RPC_RESPONSE),
	ok: funtypes.Literal(true),
	payload: InterceptorMessageToInpage,
})

const PageErrorResponseEnvelopeRuntype = funtypes.ReadonlyObject({
	kind: funtypes.Literal('response'),
	id: funtypes.Number,
	action: funtypes.Literal(PAGE_RPC_RESPONSE),
	ok: funtypes.Literal(false),
	error: MessageErrorRuntype,
})

const PageEventEnvelopeRuntype = funtypes.ReadonlyObject({
	kind: funtypes.Literal('event'),
	action: funtypes.Literal(PAGE_RPC_EVENT),
	payload: InterceptorMessageToInpage,
})

export type ParsedPageRequestEnvelope = funtypes.Static<typeof PageRequestEnvelopeRuntype>
export type ParsedPageToPageEnvelope =
	| funtypes.Static<typeof PageResponseEnvelopeRuntype>
	| funtypes.Static<typeof PageErrorResponseEnvelopeRuntype>
	| funtypes.Static<typeof PageEventEnvelopeRuntype>

const serializePageMessage = (message: InterceptorMessageToInpage) => serialize(InterceptorMessageToInpage, message)

export function isPagePortEnvelope(value: unknown): value is PagePortToBackgroundEnvelope | PagePortToPageEnvelope {
	return PageRequestEnvelopeRuntype.safeParse(value).success
		|| PageResponseEnvelopeRuntype.safeParse(value).success
		|| PageErrorResponseEnvelopeRuntype.safeParse(value).success
		|| PageEventEnvelopeRuntype.safeParse(value).success
}

export function isPageRequestPayload(value: unknown): value is PageRequestPayload {
	return PageRequestPayloadRuntype.safeParse(value).success
}

export function createPageRequestEnvelope(id: number, payload: PageRequestPayload): TransportRequestEnvelope<typeof PAGE_RPC_REQUEST, PageRequestPayload> {
	return createTransportRequestEnvelope(id, PAGE_RPC_REQUEST, payload)
}

export function createPageResponseEnvelope(id: number, message: InterceptorMessageToInpage): TransportResponseEnvelope<typeof PAGE_RPC_RESPONSE, ReturnType<typeof serializePageMessage>> {
	return createTransportSuccessResponseEnvelope(id, PAGE_RPC_RESPONSE, serializePageMessage(message))
}

export function createPageEventEnvelope(message: InterceptorMessageToInpage): TransportEventEnvelope<typeof PAGE_RPC_EVENT, ReturnType<typeof serializePageMessage>> {
	return createTransportEventEnvelope(PAGE_RPC_EVENT, serializePageMessage(message))
}

export function createPageErrorRequestEnvelope(id: number, message: string): TransportRequestEnvelope<typeof PAGE_RPC_REQUEST, PageRequestPayload> {
	return createPageRequestEnvelope(id, {
		interceptorRequest: true,
		usingInterceptorWithoutSigner: false,
		method: 'InterceptorError',
		params: [message],
	})
}

export function parsePageRequestEnvelope(value: unknown): ParsedPageRequestEnvelope | undefined {
	const parsed = PageRequestEnvelopeRuntype.safeParse(value)
	return parsed.success ? parsed.value : undefined
}

export function parsePageToPageEnvelope(value: unknown): ParsedPageToPageEnvelope | undefined {
	const response = PageResponseEnvelopeRuntype.safeParse(value)
	if (response.success) return response.value
	const errorResponse = PageErrorResponseEnvelopeRuntype.safeParse(value)
	if (errorResponse.success) return errorResponse.value
	const event = PageEventEnvelopeRuntype.safeParse(value)
	if (event.success) return event.value
	return undefined
}
