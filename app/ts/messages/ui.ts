import { MessageToPopupPayload, PopupMessage } from '../types/interceptor-messages.js'
import { PopupRequests } from '../types/interceptor-reply-messages.js'
import { TransportEnvelope, isTransportEnvelope } from './shared.js'

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
	message: PopupMessage
}

export type UiQueryPayload = {
	message: PopupRequests
}

export type UiPopupEventPayload = {
	role: 'all' | 'confirmTransaction'
	message: MessageToPopupPayload
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

export function isUiPortEnvelope(value: unknown): value is UiPortEnvelope {
	if (!isTransportEnvelope(value)) return false
	return value.action === UI_COMMAND_ACTION
		|| value.action === UI_QUERY_ACTION
		|| value.action === UI_EVENT_ACTION
		|| value.action === UI_SNAPSHOT_ACTION
}
