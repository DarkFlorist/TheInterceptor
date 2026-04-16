import { UiRole, createUiCommandRequestEnvelope, createUiQueryRequestEnvelope, createUiSnapshotRequestEnvelope, getUiPortName, parseUiPopupEventEnvelope, parseUiPopupReply, parseUiResponseEnvelope } from '../messages/ui.js'
import { toMessageError } from '../messages/shared.js'
import { MessageToPopup, PopupMessage } from '../types/interceptor-messages.js'
import { PopupReplyOption, PopupRequests, PopupRequestsReplyReturn } from '../types/interceptor-reply-messages.js'
import * as funtypes from 'funtypes'

type EventHandler = (message: MessageToPopup) => void

type UiPortState = {
	role: UiRole
	port: browser.runtime.Port | undefined
	nextRequestId: number
	pending: Map<number, { resolve: (value: funtypes.Static<typeof PopupReplyOption>) => void, reject: (reason: Error) => void }>
	listeners: Set<EventHandler>
}

type UiPortClient = ReturnType<typeof createUiPortClient>

function createUiPortClient(role: UiRole) {
	const state: UiPortState = {
		role,
		port: undefined,
		nextRequestId: 1,
		pending: new Map(),
		listeners: new Set(),
	}

	const onMessage = (message: unknown) => {
		const popupMessage = parseUiPopupEventEnvelope(message)
		if (popupMessage !== undefined) {
			for (const listener of state.listeners) listener(popupMessage)
			return
		}
		const response = parseUiResponseEnvelope(message)
		if (response === undefined) return
		const pending = state.pending.get(response.id)
		if (pending === undefined) return
		state.pending.delete(response.id)
		if (response.ok) {
			pending.resolve(response.payload)
			return
		}
		pending.reject(new Error(response.error.message))
	}

	const postRequest = (
		port: browser.runtime.Port,
		envelope: ReturnType<typeof createUiCommandRequestEnvelope> | ReturnType<typeof createUiQueryRequestEnvelope> | ReturnType<typeof createUiSnapshotRequestEnvelope>,
	) => new Promise<funtypes.Static<typeof PopupReplyOption>>((resolve, reject) => {
		state.pending.set(envelope.id, { resolve, reject })
		port.postMessage(envelope)
	})

	const ensurePort = () => {
		if (state.port !== undefined) return state.port
		const port = browser.runtime.connect({ name: getUiPortName(state.role) })
		port.onMessage.addListener((message: unknown) => onMessage(message))
		port.onDisconnect.addListener(() => {
			state.port = undefined
		})
		state.port = port
		void postRequest(port, createUiSnapshotRequestEnvelope(state.nextRequestId++))
		return port
	}

	const request = (envelope: ReturnType<typeof createUiCommandRequestEnvelope> | ReturnType<typeof createUiQueryRequestEnvelope> | ReturnType<typeof createUiSnapshotRequestEnvelope>) => {
		return postRequest(ensurePort(), envelope)
	}

	return {
		sendCommand(message: PopupMessage) {
			return request(createUiCommandRequestEnvelope(state.nextRequestId++, message))
		},

		async sendQuery<Request extends PopupRequests>(message: Request): Promise<PopupRequestsReplyReturn<Request>> {
			const result = await request(createUiQueryRequestEnvelope(state.nextRequestId++, message))
			if (result === undefined) return undefined
			return parseUiPopupReply(message, result)
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
