// @ts-nocheck
import * as assert from 'assert'
import { describe, run, runIfRoot, should } from '../micro-should.js'

type RuntimeMessageListener = (message: unknown) => void

function createBrowserMock() {
	const listeners: RuntimeMessageListener[] = []
	const requests: { action: string, id: number }[] = []
	const port = {
		name: 'ui:confirmTransaction',
		onMessage: {
			addListener(listener: RuntimeMessageListener) {
				listeners.push(listener)
			},
			removeListener(listener: RuntimeMessageListener) {
				const index = listeners.indexOf(listener)
				if (index >= 0) listeners.splice(index, 1)
			},
		},
		onDisconnect: {
			addListener() { return undefined },
			removeListener() { return undefined },
		},
		postMessage(message: unknown) {
			if (typeof message !== 'object' || message === null) return
			if (!('kind' in message) || message.kind !== 'request') return
			if (!('id' in message) || typeof message.id !== 'number') return
			if (!('action' in message) || typeof message.action !== 'string') return
			requests.push({ action: message.action, id: message.id })
			if (message.action === 'ui.snapshot') {
				for (const listener of [...listeners]) {
					listener({
						kind: 'event',
						action: 'ui.event.popup',
						payload: {
							role: 'confirmTransaction',
							message: {
								method: 'popup_update_confirm_transaction_dialog_pending_transactions',
								data: {
									pendingTransactionAndSignableMessages: [],
									currentBlockNumber: '0x1',
								},
							},
						},
					})
				}
			}
			for (const listener of [...listeners]) {
				listener({
					kind: 'response',
					action: message.action,
					id: message.id,
					ok: true,
					payload: undefined,
				})
			}
		},
		disconnect() { return undefined },
	} as unknown as browser.runtime.Port

	// @ts-expect-error test shim intentionally overrides extension globals
	globalThis.browser = {
		runtime: {
			lastError: null,
			connect() {
				return port
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
	}

	return { requests }
}

describe('uiPort snapshot handshake', () => {
	should('requests snapshot when the first listener is added after the port already exists', async () => {
		const browserMock = createBrowserMock()
		const { createUiPortClient } = await import('../../app/ts/ui/uiPort.js')
		const client = createUiPortClient('confirmTransaction')
		const receivedMessages: string[] = []

		await client.sendCommand({ method: 'popup_requestSettings' })
		assert.deepStrictEqual(browserMock.requests.map((request) => request.action), ['ui.command.popup'])

		const removeListener = client.addListener((message: { method: string }) => {
			receivedMessages.push(message.method)
		})

		assert.deepStrictEqual(browserMock.requests.map((request) => request.action), ['ui.command.popup', 'ui.snapshot'])
		assert.deepStrictEqual(receivedMessages, ['popup_update_confirm_transaction_dialog_pending_transactions'])

		removeListener()
	})
})

runIfRoot(run, import.meta)
