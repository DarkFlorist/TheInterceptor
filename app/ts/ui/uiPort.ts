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
const logConfirmTransactionUiPort = (role: UiRole, message: string, data?: unknown) => {
	if (role !== 'confirmTransaction') return
	if (data === undefined) {
		console.info(`[confirm-tx-debug] uiPort ${ message }`)
		return
	}
	console.info(`[confirm-tx-debug] uiPort ${ message }`, data)
}

function requestSnapshot(state: UiPortState, port: browser.runtime.Port) {
	logConfirmTransactionUiPort(state.role, 'sending snapshot request', { requestId: state.nextRequestId })
	state.pending.set(state.nextRequestId, { resolve: () => undefined, reject: () => undefined })
	port.postMessage(createUiSnapshotRequestEnvelope(state.nextRequestId++))
}

export function createUiPortClient(role: UiRole) {
	const state: UiPortState = {
		role,
		port: undefined,
		nextRequestId: 1,
		pending: new Map(),
		listeners: new Set(),
	}

	const onMessage = (message: unknown) => {
		logConfirmTransactionUiPort(role, 'received raw port message', message)
		const popupMessage = parseUiPopupEventEnvelope(message)
		if (popupMessage !== undefined) {
			if (
				role === 'confirmTransaction'
				&& (popupMessage.method === 'popup_update_confirm_transaction_dialog'
					|| popupMessage.method === 'popup_update_confirm_transaction_dialog_pending_transactions')
			) {
				logConfirmTransactionUiPort(role, 'received event', { method: popupMessage.method })
			}
			for (const listener of state.listeners) listener(popupMessage)
			return
		}
		const response = parseUiResponseEnvelope(message)
		if (response === undefined) return
		logConfirmTransactionUiPort(role, 'parsed response', { action: response.action, ok: response.ok, id: response.id })
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
		logConfirmTransactionUiPort(state.role, 'connected')
		port.onMessage.addListener((message: unknown) => onMessage(message))
		port.onDisconnect.addListener(() => {
			logConfirmTransactionUiPort(state.role, 'disconnected')
			state.port = undefined
		})
		state.port = port
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
			const shouldRequestSnapshot = state.listeners.size === 0
			state.listeners.add(listener)
			const port = ensurePort()
			if (shouldRequestSnapshot) requestSnapshot(state, port)
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
