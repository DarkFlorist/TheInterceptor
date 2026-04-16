import { UI_COMMAND_ACTION, UI_EVENT_ACTION, UI_QUERY_ACTION, UI_SNAPSHOT_ACTION, UiRole, getUiPortName } from '../messages/ui.js'
import { TransportRequestEnvelope, isObject, isTransportEnvelope, toMessageError } from '../messages/shared.js'
import { MessageToPopup, PopupMessage } from '../types/interceptor-messages.js'
import { PopupRequests, PopupRequestsReplies, PopupRequestsReplyReturn } from '../types/interceptor-reply-messages.js'

type EventHandler = (message: MessageToPopup) => void

type UiPortState = {
	role: UiRole
	port: browser.runtime.Port | undefined
	nextRequestId: number
	pending: Map<number, { resolve: (value: unknown) => void, reject: (reason: Error) => void }>
	listeners: Set<EventHandler>
}

type UiPortClient = ReturnType<typeof createUiPortClient>

function parsePopupReply<Request extends PopupRequests>(message: Request, value: unknown): PopupRequestsReplyReturn<Request> {
	return PopupRequestsReplies[message.method].parse(value) as PopupRequestsReplyReturn<Request>
}

function createUiPortClient(role: UiRole) {
	const state: UiPortState = {
		role,
		port: undefined,
		nextRequestId: 1,
		pending: new Map(),
		listeners: new Set(),
	}

	const onMessage = (message: unknown) => {
		if (!isTransportEnvelope(message)) return
		if (message.kind === 'event' && message.action === UI_EVENT_ACTION) {
			if (!isObject(message.payload) || typeof message.payload.role !== 'string' || !isObject(message.payload.message)) return
			const maybePopupMessage = MessageToPopup.safeParse({ role: message.payload.role, ...message.payload.message })
			if (!maybePopupMessage.success) return
			for (const listener of state.listeners) listener(maybePopupMessage.value)
			return
		}
		if (message.kind !== 'response') return
		const pending = state.pending.get(message.id)
		if (pending === undefined) return
		state.pending.delete(message.id)
		if (message.ok) {
			pending.resolve(message.payload)
			return
		}
		pending.reject(new Error(message.error.message))
	}

	const ensurePort = () => {
		if (state.port !== undefined) return state.port
		const port = browser.runtime.connect({ name: getUiPortName(state.role) })
		port.onMessage.addListener((message: unknown) => onMessage(message))
		port.onDisconnect.addListener(() => {
			state.port = undefined
		})
		state.port = port
		void request(UI_SNAPSHOT_ACTION, undefined)
		return port
	}

	const request = (action: string, payload: unknown) => {
		const port = ensurePort()
		const id = state.nextRequestId++
		return new Promise<unknown>((resolve, reject) => {
			state.pending.set(id, { resolve, reject })
			port.postMessage({ kind: 'request', id, action, payload } satisfies TransportRequestEnvelope)
		})
	}

	return {
		sendCommand(message: PopupMessage) {
			return request(UI_COMMAND_ACTION, { message })
		},

		async sendQuery<Request extends PopupRequests>(message: Request): Promise<PopupRequestsReplyReturn<Request>> {
			const result = await request(UI_QUERY_ACTION, { message })
			if (result === undefined) return undefined
			return parsePopupReply(message, result)
		},

		addListener(listener: EventHandler) {
			ensurePort()
			state.listeners.add(listener)
			return () => {
				state.listeners.delete(listener)
			}
		},
	}
}

let client: UiPortClient | undefined = undefined

export function initializeUiPort(role: UiRole) {
	client = createUiPortClient(role)
}

function getClient() {
	if (client === undefined) throw new Error('UI port client was not initialized for this page')
	return client
}

export async function sendUiPopupCommand(message: PopupMessage) {
	try {
		await getClient().sendCommand(message)
	} catch (error) {
		throw new Error(toMessageError(error).message)
	}
}

export async function sendUiPopupQuery<Request extends PopupRequests>(message: Request): Promise<PopupRequestsReplyReturn<Request>> {
	try {
		return await getClient().sendQuery(message)
	} catch {
		return undefined
	}
}

export function addUiPopupEventListener(listener: EventHandler) {
	return getClient().addListener(listener)
}
