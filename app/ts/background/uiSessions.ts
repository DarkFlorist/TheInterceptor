import { createRouter } from '../messaging/router.js'
import { MessageToPopupPayload, PopupMessage } from '../types/interceptor-messages.js'
import { PopupRequests } from '../types/interceptor-reply-messages.js'
import { UI_COMMAND_ACTION, UI_EVENT_ACTION, UI_QUERY_ACTION, UI_SNAPSHOT_ACTION, SerializedUiReplyMessage, UiPopupEventPayload, UiPopupEventTarget, UiRole, createUiErrorResponseEnvelope, createUiPopupEventEnvelope, createUiSuccessResponseEnvelope, getUiRoleFromPortName, parseUiRequestEnvelope } from '../messages/ui.js'
import { TransportEventEnvelope, toMessageError } from '../messages/shared.js'

type UiSession = {
	id: number
	role: UiRole
	port: browser.runtime.Port
}

type UiRouterContext = {
	role: UiRole
	port: browser.runtime.Port
}

type UiPopupRequestHandler = (message: PopupMessage | PopupRequests) => Promise<SerializedUiReplyMessage>
type UiSnapshotHandler = (role: UiRole) => Promise<void>

let nextSessionId = 1
const sessions = new Map<number, UiSession>()
const getAllUiSessions = () => Array.from(sessions.values())

export const uiRequestRouter = createRouter<UiRouterContext>()

export function registerUiPort(port: browser.runtime.Port) {
	const role = getUiRoleFromPortName(port.name)
	if (role === undefined) return undefined
	const session: UiSession = { id: nextSessionId++, role, port }
	sessions.set(session.id, session)
	port.onDisconnect.addListener(() => {
		sessions.delete(session.id)
	})
	return session
}

export function isUiPort(port: browser.runtime.Port) {
	return getUiRoleFromPortName(port.name) !== undefined
}

export function hasUiSession(role: UiRole) {
	return getAllUiSessions().some((session) => session.role === role)
}

export function hasAnyUiSession() {
	return sessions.size > 0
}

export function publishUiPopupEvent(message: MessageToPopupPayload, role: UiPopupEventTarget = 'all') {
	const envelope: TransportEventEnvelope<typeof UI_EVENT_ACTION, UiPopupEventPayload> = createUiPopupEventEnvelope(role, message)
	getAllUiSessions()
		.filter((session) => role === 'all' || session.role === role)
		.forEach((session) => {
			try {
				session.port.postMessage(envelope)
			} catch (error) {
				if (error instanceof Error && error.message.includes('disconnected port object')) return
				throw error
			}
		})
}

export function installDefaultUiRouter(handlePopupRequest: UiPopupRequestHandler, handleSnapshot: UiSnapshotHandler) {
	uiRequestRouter
		.register<PopupMessage>(UI_COMMAND_ACTION, async (_context, message) => {
			return await handlePopupRequest(message)
		})
		.register<PopupRequests>(UI_QUERY_ACTION, async (_context, message) => {
			return await handlePopupRequest(message)
		})
		.register<undefined>(UI_SNAPSHOT_ACTION, async (context) => {
			await handleSnapshot(context.role)
			return undefined
		})
}

export async function onUiPortConnected(port: browser.runtime.Port) {
	const session = registerUiPort(port)
	if (session === undefined) return false
	port.onMessage.addListener((rawMessage: unknown) => {
		void Promise.resolve((async () => {
			const message = parseUiRequestEnvelope(rawMessage)
			if (message === undefined) return
			try {
				switch (message.action) {
					case UI_COMMAND_ACTION: {
						const payload = await uiRequestRouter.dispatch(message.action, { role: session.role, port }, message.payload.message)
						port.postMessage(createUiSuccessResponseEnvelope(message.id, message.action, payload))
						return
					}
					case UI_QUERY_ACTION: {
						const payload = await uiRequestRouter.dispatch(message.action, { role: session.role, port }, message.payload.message)
						port.postMessage(createUiSuccessResponseEnvelope(message.id, message.action, payload))
						return
					}
					case UI_SNAPSHOT_ACTION: {
						const payload = await uiRequestRouter.dispatch(message.action, { role: session.role, port }, undefined)
						port.postMessage(createUiSuccessResponseEnvelope(message.id, message.action, payload))
						return
					}
				}
			} catch (error) {
				const parsedError = toMessageError(error)
				port.postMessage(createUiErrorResponseEnvelope(message.id, message.action, parsedError.message, parsedError.code, parsedError.data))
			}
		})())
	})
	return true
}
