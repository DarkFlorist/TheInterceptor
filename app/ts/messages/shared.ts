import * as funtypes from 'funtypes'

export type MessageError = {
	message: string
	code?: number
	data?: unknown
}

export type TransportRequestEnvelope<Action extends string = string, Payload = unknown> = {
	kind: 'request'
	id: number
	action: Action
	payload: Payload
}

export type TransportResponseEnvelope<Action extends string = string, Payload = unknown> = {
	kind: 'response'
	id: number
	action: Action
	ok: true
	payload: Payload
} | {
	kind: 'response'
	id: number
	action: Action
	ok: false
	error: MessageError
}

export type TransportEventEnvelope<Action extends string = string, Payload = unknown> = {
	kind: 'event'
	action: Action
	payload: Payload
}

export type TransportEnvelope<Action extends string = string, Payload = unknown> =
	| TransportRequestEnvelope<Action, Payload>
	| TransportResponseEnvelope<Action, Payload>
	| TransportEventEnvelope<Action, Payload>

const ObjectRecord = funtypes.ReadonlyRecord(funtypes.String, funtypes.Unknown)
export const MessageErrorRuntype = funtypes.Intersect(
	funtypes.ReadonlyObject({ message: funtypes.String }),
	funtypes.Partial({
		code: funtypes.Number,
		data: funtypes.Unknown,
	}),
)

export function createTransportRequestEnvelope<Action extends string, Payload>(id: number, action: Action, payload: Payload): TransportRequestEnvelope<Action, Payload> {
	return { kind: 'request', id, action, payload }
}

export function createTransportSuccessResponseEnvelope<Action extends string, Payload>(id: number, action: Action, payload: Payload): TransportResponseEnvelope<Action, Payload> {
	return { kind: 'response', id, action, ok: true, payload }
}

export function createTransportErrorResponseEnvelope<Action extends string>(id: number, action: Action, error: MessageError): TransportResponseEnvelope<Action> {
	return { kind: 'response', id, action, ok: false, error }
}

export function createTransportEventEnvelope<Action extends string, Payload>(action: Action, payload: Payload): TransportEventEnvelope<Action, Payload> {
	return { kind: 'event', action, payload }
}
const TransportEnvelopeRuntype = funtypes.Union(
	funtypes.ReadonlyObject({
		kind: funtypes.Literal('request'),
		id: funtypes.Number,
		action: funtypes.String,
		payload: funtypes.Unknown,
	}),
	funtypes.ReadonlyObject({
		kind: funtypes.Literal('response'),
		id: funtypes.Number,
		action: funtypes.String,
		ok: funtypes.Literal(true),
		payload: funtypes.Unknown,
	}),
	funtypes.ReadonlyObject({
		kind: funtypes.Literal('response'),
		id: funtypes.Number,
		action: funtypes.String,
		ok: funtypes.Literal(false),
		error: MessageErrorRuntype,
	}),
	funtypes.ReadonlyObject({
		kind: funtypes.Literal('event'),
		action: funtypes.String,
		payload: funtypes.Unknown,
	}),
)

export function isObject(value: unknown): value is Record<string, unknown> {
	return ObjectRecord.safeParse(value).success
}

export function isTransportEnvelope(value: unknown): value is TransportEnvelope {
	return TransportEnvelopeRuntype.safeParse(value).success
}

export function toMessageError(error: unknown): MessageError {
	if (error instanceof Error) return { message: error.message }
	if (isObject(error) && typeof error.message === 'string') {
		return {
			message: error.message,
			...typeof error.code === 'number' ? { code: error.code } : {},
			...('data' in error ? { data: error.data } : {}),
		}
	}
	return { message: 'Unknown error' }
}
