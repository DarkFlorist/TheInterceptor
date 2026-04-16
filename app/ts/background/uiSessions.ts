import { createRouter } from '../messaging/router.js'
import { MessageToPopupPayload, PopupMessage } from '../types/interceptor-messages.js'
import { PopupRequests } from '../types/interceptor-reply-messages.js'
import { UI_COMMAND_ACTION, UI_EVENT_ACTION, UI_QUERY_ACTION, UI_SNAPSHOT_ACTION, UiPopupEventPayload, UiPopupEventTarget, UiRole, createUiPopupEventPayload, getUiRoleFromPortName, isUiPortEnvelope, parseUiCommandPayload, parseUiQueryPayload } from '../messages/ui.js'
import { TransportEventEnvelope, TransportResponseEnvelope, toMessageError } from '../messages/shared.js'

type UiSession = {
	id: number
	role: UiRole
	port: browser.runtime.Port
}

type UiRouterContext = {
	role: UiRole
	port: browser.runtime.Port
}

type UiPopupRequestHandler = (message: PopupMessage | PopupRequests) => Promise<unknown>
type UiSnapshotHandler = (role: UiRole) => Promise<void>

let nextSessionId = 1
const sessions = new Map<number, UiSession>()

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
	for (const session of sessions.values()) {
		if (session.role === role) return true
	}
	return false
}

export function hasAnyUiSession() {
	return sessions.size > 0
}

function postResponse(port: browser.runtime.Port, message: TransportResponseEnvelope<string, unknown>) {
	port.postMessage(message)
}

export function publishUiPopupEvent(message: MessageToPopupPayload, role: UiPopupEventTarget = 'all') {
	const envelope: TransportEventEnvelope<typeof UI_EVENT_ACTION, UiPopupEventPayload> = {
		kind: 'event',
		action: UI_EVENT_ACTION,
		payload: createUiPopupEventPayload(role, message),
	}
	for (const session of sessions.values()) {
		if (role !== 'all' && session.role !== role) continue
		try {
			session.port.postMessage(envelope)
		} catch (error) {
			if (error instanceof Error && error.message.includes('disconnected port object')) continue
			throw error
		}
	}
}

export function installDefaultUiRouter(handlePopupRequest: UiPopupRequestHandler, handleSnapshot: UiSnapshotHandler) {
	uiRequestRouter
		.register<{ message: PopupMessage }>(UI_COMMAND_ACTION, async (_context, payload) => {
			return await handlePopupRequest(payload.message)
		})
		.register<{ message: PopupRequests }>(UI_QUERY_ACTION, async (_context, payload) => {
			return await handlePopupRequest(payload.message)
		})
		.register<undefined>(UI_SNAPSHOT_ACTION, async (context) => {
			await handleSnapshot(context.role)
			return undefined
		})
}

export async function onUiPortConnected(port: browser.runtime.Port, handleSnapshot: UiSnapshotHandler) {
	const session = registerUiPort(port)
	if (session === undefined) return false
	port.onMessage.addListener((rawMessage: unknown) => {
		void Promise.resolve((async () => {
			if (!isUiPortEnvelope(rawMessage) || rawMessage.kind !== 'request') return
			try {
				switch (rawMessage.action) {
					case UI_COMMAND_ACTION: {
						const message = parseUiCommandPayload(rawMessage.payload)
						if (message === undefined) throw new Error('Invalid UI command payload')
						const payload = await uiRequestRouter.dispatch(rawMessage.action, { role: session.role, port }, message)
						postResponse(port, { kind: 'response', action: rawMessage.action, id: rawMessage.id, ok: true, payload })
						return
					}
					case UI_QUERY_ACTION: {
						const message = parseUiQueryPayload(rawMessage.payload)
						if (message === undefined) throw new Error('Invalid UI query payload')
						const payload = await uiRequestRouter.dispatch(rawMessage.action, { role: session.role, port }, message)
						postResponse(port, { kind: 'response', action: rawMessage.action, id: rawMessage.id, ok: true, payload })
						return
					}
					case UI_SNAPSHOT_ACTION: {
						const payload = await uiRequestRouter.dispatch(rawMessage.action, { role: session.role, port }, undefined)
						postResponse(port, { kind: 'response', action: rawMessage.action, id: rawMessage.id, ok: true, payload })
						return
					}
					default:
						throw new Error(`Unsupported UI action "${ rawMessage.action }"`)
				}
			} catch (error) {
				postResponse(port, { kind: 'response', action: rawMessage.action, id: rawMessage.id, ok: false, error: toMessageError(error) })
			}
		})())
	})
	await handleSnapshot(session.role)
	return true
}
