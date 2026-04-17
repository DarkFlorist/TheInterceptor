import * as funtypes from 'funtypes'
import { MessageToPopup, MessageToPopupPayload, PopupMessage } from '../types/interceptor-messages.js'
import { PopupMessageReplyRequests, PopupReplyOption, PopupRequestMethod, PopupRequests, PopupRequestsReplies, PopupRequestsReplyByMethod, PopupRequestsReplyReturn } from '../types/interceptor-reply-messages.js'
import { serialize } from '../types/wire-types.js'
import { TransportValue } from '../utils/json.js'
import {
	MessageErrorRuntype,
	TransportEnvelope,
	TransportEventEnvelope,
	TransportRequestEnvelope,
	TransportResponseEnvelope,
	createTransportErrorResponseEnvelope,
	createTransportEventEnvelope,
	createTransportRequestEnvelope,
	createTransportSuccessResponseEnvelope,
} from './shared.js'

export const UI_PORT_NAME_PREFIX = 'ui:'
export const UI_COMMAND_ACTION = 'ui.command.popup'
export const UI_QUERY_ACTION = 'ui.query.popup'
export const UI_EVENT_ACTION = 'ui.event.popup'
export const UI_SNAPSHOT_ACTION = 'ui.snapshot'

export type UiRole =
	| 'main'
	| 'addressBook'
	| 'changeChain'
	| 'confirmTransaction'
	| 'fetchSimulationStack'
	| 'interceptorAccess'
	| 'settingsView'
	| 'websiteAccess'

export type MainOrConfirmUiRole = Extract<UiRole, 'main' | 'confirmTransaction'>
export type UiPopupEventTarget = 'all' | Extract<UiRole, 'confirmTransaction'>

const UiPopupEventTargetRuntype = funtypes.Union(
	funtypes.Literal('all'),
	funtypes.Literal('confirmTransaction'),
)

const serializeUiCommandMessage = (message: PopupMessage) => serialize(PopupMessage, message)
const serializeUiQueryMessage = (message: PopupRequests) => serialize(PopupMessageReplyRequests, message)
const serializeUiEventMessage = (message: MessageToPopupPayload) => serialize(MessageToPopupPayload, message)
const serializeUiReplyMessage = (message: funtypes.Static<typeof PopupReplyOption>) => PopupReplyOption.serialize(message)

type SerializedUiCommandMessage = ReturnType<typeof serializeUiCommandMessage>
type SerializedUiQueryMessage = ReturnType<typeof serializeUiQueryMessage>
type SerializedUiEventMessage = ReturnType<typeof serializeUiEventMessage>
export type SerializedUiReplyMessage = ReturnType<typeof serializeUiReplyMessage>

const UiCommandPayloadRuntype = funtypes.ReadonlyObject({
	message: PopupMessage,
})

const UiQueryPayloadRuntype = funtypes.ReadonlyObject({
	message: PopupMessageReplyRequests,
})

const UiPopupEventPayloadRuntype = funtypes.ReadonlyObject({
	role: UiPopupEventTargetRuntype,
	message: MessageToPopupPayload,
})

const UiCommandRequestEnvelopeRuntype = funtypes.ReadonlyObject({
	kind: funtypes.Literal('request'),
	id: funtypes.Number,
	action: funtypes.Literal(UI_COMMAND_ACTION),
	payload: UiCommandPayloadRuntype,
})

const UiQueryRequestEnvelopeRuntype = funtypes.ReadonlyObject({
	kind: funtypes.Literal('request'),
	id: funtypes.Number,
	action: funtypes.Literal(UI_QUERY_ACTION),
	payload: UiQueryPayloadRuntype,
})

const UiSnapshotRequestEnvelopeRuntype = funtypes.ReadonlyObject({
	kind: funtypes.Literal('request'),
	id: funtypes.Number,
	action: funtypes.Literal(UI_SNAPSHOT_ACTION),
	payload: funtypes.Undefined,
})

const UiPopupEventEnvelopeRuntype = funtypes.ReadonlyObject({
	kind: funtypes.Literal('event'),
	action: funtypes.Literal(UI_EVENT_ACTION),
	payload: UiPopupEventPayloadRuntype,
})

const UiResponseActionRuntype = funtypes.Union(
	funtypes.Literal(UI_COMMAND_ACTION),
	funtypes.Literal(UI_QUERY_ACTION),
	funtypes.Literal(UI_SNAPSHOT_ACTION),
)

const UiSuccessResponseEnvelopeRuntype = funtypes.ReadonlyObject({
	kind: funtypes.Literal('response'),
	id: funtypes.Number,
	action: UiResponseActionRuntype,
	ok: funtypes.Literal(true),
	payload: PopupReplyOption,
})

const UiErrorResponseEnvelopeRuntype = funtypes.ReadonlyObject({
	kind: funtypes.Literal('response'),
	id: funtypes.Number,
	action: UiResponseActionRuntype,
	ok: funtypes.Literal(false),
	error: MessageErrorRuntype,
})

const UI_ROLES: readonly UiRole[] = [
	'main',
	'addressBook',
	'changeChain',
	'confirmTransaction',
	'fetchSimulationStack',
	'interceptorAccess',
	'settingsView',
	'websiteAccess',
]

const uiRoleByPortName: Record<string, UiRole> = {}
for (const role of UI_ROLES) {
	uiRoleByPortName[getUiPortName(role)] = role
}

export type UiCommandPayload = {
	message: SerializedUiCommandMessage
}

export type UiQueryPayload = {
	message: SerializedUiQueryMessage
}

export type UiPopupEventPayload = {
	role: UiPopupEventTarget
	message: SerializedUiEventMessage
}

export type UiSnapshotPayload = {
	role: UiRole
}

export type UiPortEnvelope = TransportEnvelope<
	typeof UI_COMMAND_ACTION | typeof UI_QUERY_ACTION | typeof UI_EVENT_ACTION | typeof UI_SNAPSHOT_ACTION,
	UiCommandPayload | UiQueryPayload | UiPopupEventPayload | UiSnapshotPayload | SerializedUiReplyMessage
>

export type UiParsedRequestEnvelope =
	| funtypes.Static<typeof UiCommandRequestEnvelopeRuntype>
	| funtypes.Static<typeof UiQueryRequestEnvelopeRuntype>
	| funtypes.Static<typeof UiSnapshotRequestEnvelopeRuntype>

export type UiParsedResponseEnvelope =
	| funtypes.Static<typeof UiSuccessResponseEnvelopeRuntype>
	| funtypes.Static<typeof UiErrorResponseEnvelopeRuntype>

export function getUiPortName(role: UiRole) {
	return `${ UI_PORT_NAME_PREFIX }${ role }`
}

export function getUiRoleFromPortName(portName: string): UiRole | undefined {
	return uiRoleByPortName[portName]
}

export function createUiCommandPayload(message: PopupMessage): UiCommandPayload {
	return { message: serializeUiCommandMessage(message) }
}

export function createUiCommandRequestEnvelope(id: number, message: PopupMessage): TransportRequestEnvelope<typeof UI_COMMAND_ACTION, UiCommandPayload> {
	return createTransportRequestEnvelope(id, UI_COMMAND_ACTION, createUiCommandPayload(message))
}

export function createUiQueryPayload(message: PopupRequests): UiQueryPayload {
	return { message: serializeUiQueryMessage(message) }
}

export function createUiQueryRequestEnvelope(id: number, message: PopupRequests): TransportRequestEnvelope<typeof UI_QUERY_ACTION, UiQueryPayload> {
	return createTransportRequestEnvelope(id, UI_QUERY_ACTION, createUiQueryPayload(message))
}

export function createUiPopupEventPayload(role: UiPopupEventTarget, message: MessageToPopupPayload): UiPopupEventPayload {
	return { role, message: serializeUiEventMessage(message) }
}

export function createUiSnapshotRequestEnvelope(id: number): TransportRequestEnvelope<typeof UI_SNAPSHOT_ACTION, undefined> {
	return createTransportRequestEnvelope(id, UI_SNAPSHOT_ACTION, undefined)
}

export function createUiPopupEventEnvelope(role: UiPopupEventTarget, message: MessageToPopupPayload): TransportEventEnvelope<typeof UI_EVENT_ACTION, UiPopupEventPayload> {
	return createTransportEventEnvelope(UI_EVENT_ACTION, createUiPopupEventPayload(role, message))
}

export function createUiSuccessResponseEnvelope<Action extends typeof UI_COMMAND_ACTION | typeof UI_QUERY_ACTION | typeof UI_SNAPSHOT_ACTION>(
	id: number,
	action: Action,
	payload: SerializedUiReplyMessage,
): TransportResponseEnvelope<Action, SerializedUiReplyMessage> {
	return createTransportSuccessResponseEnvelope(id, action, payload)
}

export function createUiErrorResponseEnvelope<Action extends typeof UI_COMMAND_ACTION | typeof UI_QUERY_ACTION | typeof UI_SNAPSHOT_ACTION>(
	id: number,
	action: Action,
	message: string,
	code?: number,
	data?: TransportValue,
): TransportResponseEnvelope<Action> {
	return createTransportErrorResponseEnvelope(id, action, {
		message,
		...(code === undefined ? {} : { code }),
		...(data === undefined ? {} : { data }),
	})
}

export function parseUiRequestEnvelope(value: unknown): UiParsedRequestEnvelope | undefined {
	const commandEnvelope = UiCommandRequestEnvelopeRuntype.safeParse(value)
	if (commandEnvelope.success) return commandEnvelope.value
	const queryEnvelope = UiQueryRequestEnvelopeRuntype.safeParse(value)
	if (queryEnvelope.success) return queryEnvelope.value
	const snapshotEnvelope = UiSnapshotRequestEnvelopeRuntype.safeParse(value)
	if (snapshotEnvelope.success) return snapshotEnvelope.value
	return undefined
}

export function parseUiPopupEventEnvelope(value: unknown): MessageToPopup | undefined {
	const parsed = UiPopupEventEnvelopeRuntype.safeParse(value)
	if (!parsed.success) return undefined
	return { role: parsed.value.payload.role, ...parsed.value.payload.message }
}

export function parseUiResponseEnvelope(value: unknown): UiParsedResponseEnvelope | undefined {
	const success = UiSuccessResponseEnvelopeRuntype.safeParse(value)
	if (success.success) return success.value
	const error = UiErrorResponseEnvelopeRuntype.safeParse(value)
	if (error.success) return error.value
	return undefined
}

type ParsedUiReplyMessage = funtypes.Static<typeof PopupReplyOption>

const popupReplyParsers: { [Method in PopupRequestMethod]: (payload: Exclude<ParsedUiReplyMessage, undefined>) => PopupRequestsReplyByMethod[Method] } = {
	popup_requestMakeMeRichData: payload => PopupRequestsReplies.popup_requestMakeMeRichData.parse(payload),
	popup_requestActiveAddresses: payload => PopupRequestsReplies.popup_requestActiveAddresses.parse(payload),
	popup_requestSimulationMode: payload => PopupRequestsReplies.popup_requestSimulationMode.parse(payload),
	popup_requestLatestUnexpectedError: payload => PopupRequestsReplies.popup_requestLatestUnexpectedError.parse(payload),
	popup_requestInterceptorSimulationInput: payload => PopupRequestsReplies.popup_requestInterceptorSimulationInput.parse(payload),
	popup_requestCompleteVisualizedSimulation: payload => PopupRequestsReplies.popup_requestCompleteVisualizedSimulation.parse(payload),
	popup_requestSimulationMetadata: payload => PopupRequestsReplies.popup_requestSimulationMetadata.parse(payload),
	popup_requestAbiAndNameFromBlockExplorer: payload => PopupRequestsReplies.popup_requestAbiAndNameFromBlockExplorer.parse(payload),
	popup_requestIdentifyAddress: payload => PopupRequestsReplies.popup_requestIdentifyAddress.parse(payload),
}

function parsePopupReplyByMethod<Method extends PopupRequestMethod>(method: Method, payload: Exclude<ParsedUiReplyMessage, undefined>): PopupRequestsReplyByMethod[Method] {
	return popupReplyParsers[method](payload)
}

export function parseUiPopupReply(message: Extract<PopupRequests, { method: 'popup_requestMakeMeRichData' }>, payload: Exclude<ParsedUiReplyMessage, undefined>): PopupRequestsReplyByMethod['popup_requestMakeMeRichData']
export function parseUiPopupReply(message: Extract<PopupRequests, { method: 'popup_requestActiveAddresses' }>, payload: Exclude<ParsedUiReplyMessage, undefined>): PopupRequestsReplyByMethod['popup_requestActiveAddresses']
export function parseUiPopupReply(message: Extract<PopupRequests, { method: 'popup_requestSimulationMode' }>, payload: Exclude<ParsedUiReplyMessage, undefined>): PopupRequestsReplyByMethod['popup_requestSimulationMode']
export function parseUiPopupReply(message: Extract<PopupRequests, { method: 'popup_requestLatestUnexpectedError' }>, payload: Exclude<ParsedUiReplyMessage, undefined>): PopupRequestsReplyByMethod['popup_requestLatestUnexpectedError']
export function parseUiPopupReply(message: Extract<PopupRequests, { method: 'popup_requestInterceptorSimulationInput' }>, payload: Exclude<ParsedUiReplyMessage, undefined>): PopupRequestsReplyByMethod['popup_requestInterceptorSimulationInput']
export function parseUiPopupReply(message: Extract<PopupRequests, { method: 'popup_requestCompleteVisualizedSimulation' }>, payload: Exclude<ParsedUiReplyMessage, undefined>): PopupRequestsReplyByMethod['popup_requestCompleteVisualizedSimulation']
export function parseUiPopupReply(message: Extract<PopupRequests, { method: 'popup_requestSimulationMetadata' }>, payload: Exclude<ParsedUiReplyMessage, undefined>): PopupRequestsReplyByMethod['popup_requestSimulationMetadata']
export function parseUiPopupReply(message: Extract<PopupRequests, { method: 'popup_requestAbiAndNameFromBlockExplorer' }>, payload: Exclude<ParsedUiReplyMessage, undefined>): PopupRequestsReplyByMethod['popup_requestAbiAndNameFromBlockExplorer']
export function parseUiPopupReply(message: Extract<PopupRequests, { method: 'popup_requestIdentifyAddress' }>, payload: Exclude<ParsedUiReplyMessage, undefined>): PopupRequestsReplyByMethod['popup_requestIdentifyAddress']
export function parseUiPopupReply<Request extends PopupRequests>(message: Request, payload: Exclude<ParsedUiReplyMessage, undefined>): PopupRequestsReplyReturn<Request>
export function parseUiPopupReply(message: PopupRequests, payload: Exclude<ParsedUiReplyMessage, undefined>) {
	switch (message.method) {
		case 'popup_requestMakeMeRichData': return parsePopupReplyByMethod(message.method, payload)
		case 'popup_requestActiveAddresses': return parsePopupReplyByMethod(message.method, payload)
		case 'popup_requestSimulationMode': return parsePopupReplyByMethod(message.method, payload)
		case 'popup_requestLatestUnexpectedError': return parsePopupReplyByMethod(message.method, payload)
		case 'popup_requestInterceptorSimulationInput': return parsePopupReplyByMethod(message.method, payload)
		case 'popup_requestCompleteVisualizedSimulation': return parsePopupReplyByMethod(message.method, payload)
		case 'popup_requestSimulationMetadata': return parsePopupReplyByMethod(message.method, payload)
		case 'popup_requestAbiAndNameFromBlockExplorer': return parsePopupReplyByMethod(message.method, payload)
		case 'popup_requestIdentifyAddress': return parsePopupReplyByMethod(message.method, payload)
	}
}
