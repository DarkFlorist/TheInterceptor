import { MessageToPopup, MessageToPopupPayload, PopupMessage } from '../types/interceptor-messages.js'
import { PopupMessageReplyRequests, PopupRequests, PopupRequestsReplies, PopupRequestsReplyReturn } from '../types/interceptor-reply-messages.js'
import { serialize } from '../types/wire-types.js'
import { TransportEnvelope, isObject, isTransportEnvelope } from './shared.js'

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

const serializeUiCommandMessage = (message: PopupMessage) => serialize(PopupMessage, message)
const serializeUiQueryMessage = (message: PopupRequests) => serialize(PopupMessageReplyRequests, message)
const serializeUiEventMessage = (message: MessageToPopupPayload) => serialize(MessageToPopupPayload, message)

type SerializedUiCommandMessage = ReturnType<typeof serializeUiCommandMessage>
type SerializedUiQueryMessage = ReturnType<typeof serializeUiQueryMessage>
type SerializedUiEventMessage = ReturnType<typeof serializeUiEventMessage>

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
	UiCommandPayload | UiQueryPayload | UiPopupEventPayload | UiSnapshotPayload | unknown
>

export function getUiPortName(role: UiRole) {
	return `${ UI_PORT_NAME_PREFIX }${ role }`
}

export function getUiRoleFromPortName(portName: string): UiRole | undefined {
	return uiRoleByPortName[portName]
}

export function createUiCommandPayload(message: PopupMessage): UiCommandPayload {
	return { message: serializeUiCommandMessage(message) }
}

export function parseUiCommandPayload(payload: unknown): PopupMessage | undefined {
	if (!isObject(payload) || !('message' in payload)) return undefined
	const parsed = PopupMessage.safeParse(payload.message)
	return parsed.success ? parsed.value : undefined
}

export function createUiQueryPayload(message: PopupRequests): UiQueryPayload {
	return { message: serializeUiQueryMessage(message) }
}

export function parseUiQueryPayload(payload: unknown): PopupRequests | undefined {
	if (!isObject(payload) || !('message' in payload)) return undefined
	const parsed = PopupMessageReplyRequests.safeParse(payload.message)
	return parsed.success ? parsed.value : undefined
}

export function createUiPopupEventPayload(role: UiPopupEventTarget, message: MessageToPopupPayload): UiPopupEventPayload {
	return { role, message: serializeUiEventMessage(message) }
}

export function parseUiPopupEventPayload(payload: unknown): MessageToPopup | undefined {
	if (!isObject(payload) || typeof payload.role !== 'string' || !isObject(payload.message)) return undefined
	const parsed = MessageToPopup.safeParse({ role: payload.role, ...payload.message })
	return parsed.success ? parsed.value : undefined
}

export function parseUiPopupReply<Request extends PopupRequests>(message: Request, payload: unknown): PopupRequestsReplyReturn<Request> {
	return PopupRequestsReplies[message.method].parse(payload) as PopupRequestsReplyReturn<Request>
}

export function isUiPortEnvelope(value: unknown): value is UiPortEnvelope {
	if (!isTransportEnvelope(value)) return false
	return value.action === UI_COMMAND_ACTION
		|| value.action === UI_QUERY_ACTION
		|| value.action === UI_EVENT_ACTION
		|| value.action === UI_SNAPSHOT_ACTION
}
