import * as assert from 'assert'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import { installDomMock } from './domMock.js'

type RuntimeMessageListener = (message: unknown) => unknown

function installBrowserMock(sendMessageOverride?: (message: unknown, sentMessages: unknown[]) => unknown) {
	const listeners: RuntimeMessageListener[] = []
	const storageState: Record<string, unknown> = {}
	const sentMessages: unknown[] = []

	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: null,
				async sendMessage(message: unknown) {
					sentMessages.push(message)
					if (sendMessageOverride !== undefined) return await sendMessageOverride(message, sentMessages)
					if (typeof message === 'object' && message !== null && 'method' in message) {
						const typedMessage = message as { method?: string }
						if (typedMessage.method === 'popup_isMainPopupWindowOpen') {
							return { method: 'popup_isMainPopupWindowOpen', data: { isOpen: false } }
						}
						if (typedMessage.method === 'popup_readyAndListening') {
							return { method: 'popup_readyAndListening', data: { popupOrTabId: { type: 'popup', id: 1 } } }
						}
					}
					return undefined
				},
				getManifest: () => ({ manifest_version: 3 }),
				onMessage: {
					addListener(listener: RuntimeMessageListener) {
						listeners.push(listener)
					},
					removeListener(listener: RuntimeMessageListener) {
						const index = listeners.indexOf(listener)
						if (index >= 0) listeners.splice(index, 1)
					},
				},
				onConnect: { addListener: () => undefined, removeListener: () => undefined },
			},
			storage: {
				local: {
					async get(keys?: string | string[] | Record<string, unknown> | null) {
						if (keys === undefined || keys === null) return { ...storageState }
						if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
						if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
						return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
					},
					async set(items: Record<string, unknown>) {
						Object.assign(storageState, items)
					},
					async remove(keys: string | string[]) {
						for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
					},
				},
			},
			tabs: {
				async query() { return [] },
				async get() { return undefined },
				async update() { return undefined },
				onUpdated: { addListener: () => undefined, removeListener: () => undefined },
				onRemoved: { addListener: () => undefined, removeListener: () => undefined },
			},
			windows: {
				async get() { return undefined },
				async update() { return undefined },
			},
			action: {
				async setIcon() { return undefined },
				async setTitle() { return undefined },
				async setBadgeText() { return undefined },
				async setBadgeBackgroundColor() { return undefined },
			},
			browserAction: {
				async setIcon() { return undefined },
				async setTitle() { return undefined },
				async setBadgeText() { return undefined },
				async setBadgeBackgroundColor() { return undefined },
			},
			declarativeNetRequest: {
				async getDynamicRules() { return [] },
				async getSessionRules() { return [] },
				async updateDynamicRules() { return undefined },
				async updateSessionRules() { return undefined },
			},
		},
	})
	Object.defineProperty(globalThis, 'chrome', {
		configurable: true,
		writable: true,
		value: { runtime: { id: 'test-extension' } },
	})

	return {
		sentMessages,
		getSentMessages() {
			return [...sentMessages]
		},
		dispatch(message: unknown) {
			for (const listener of [...listeners]) listener(message)
		},
	}
}

async function unmountConfirmTransaction(dom: ReturnType<typeof installDomMock>) {
	await act(() => {
		render(null, dom.document.body)
	})
}

function makePendingTransaction(errorMessage = 'simulation failed') {
	const activeAddress = 0x1111111111111111111111111111111111111111n
	const recipientAddress = 0x2222222222222222222222222222222222222222n
	const transactionIdentifier = 1n
	const created = new Date('2024-01-01T00:00:00.000Z')
	const website = { websiteOrigin: 'https://example.com', icon: undefined, title: undefined }
	const originalRequestParameters = {
		method: 'eth_sendTransaction' as const,
		params: [{
			from: activeAddress,
			to: recipientAddress,
			value: 0n,
			gas: 21_000n,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
			input: new Uint8Array(),
		}],
	}
	const transactionToSimulate = {
		website,
		created,
		originalRequestParameters,
		transactionIdentifier,
		success: false as const,
		error: {
			code: -32000,
			message: errorMessage,
		},
	}

	return {
		type: 'Transaction' as const,
		transactionOrMessageCreationStatus: 'FailedToSimulate' as const,
		popupOrTabId: { type: 'popup' as const, id: 1 },
		originalRequestParameters,
		uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } },
		simulationMode: false,
		activeAddress,
		created,
		transactionIdentifier,
		transactionToSimulate,
		website,
		approvalStatus: { status: 'WaitingForUser' as const },
		popupVisualisation: {
			statusCode: 'failed' as const,
			data: {
				activeAddress,
				simulationMode: false,
				simulationStartedTimestamp: created,
				uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } },
				transactionToSimulate,
				signerName: 'NoSignerDetected' as const,
				error: {
					code: -32000,
					message: errorMessage,
					decodedErrorMessage: errorMessage,
				},
				simulationState: {
					blockNumber: 123n,
					simulationConductedTimestamp: created,
				},
			},
		},
	}
}

describe('confirm transaction rpc status bootstrap', () => {
	test('includes rpcConnectionStatus in the initial payload and renders the warning before later push events', async () => {
		const browser = installBrowserMock()
		const dom = installDomMock()
		const [
			{ browserStorageLocalSet, browserStorageLocalSet2 },
			{ defaultActiveAddresses, defaultRpcs },
			{ setRpcConnectionStatus },
			{ updateConfirmTransactionView },
			{ ConfirmTransaction },
			{ EthereumClientService },
			{ TokenPriceService },
		] = await Promise.all([
			import('../../app/ts/utils/storageUtils.js'),
			import('../../app/ts/background/settings.js'),
			import('../../app/ts/background/storageVariables.js'),
			import('../../app/ts/background/windows/confirmTransaction.js'),
			import('../../app/ts/components/pages/ConfirmTransaction.js'),
			import('../../app/ts/simulation/services/EthereumClientService.js'),
			import('../../app/ts/simulation/services/priceEstimator.js'),
		])

		const [defaultAddress] = defaultActiveAddresses
		if (defaultAddress === undefined) throw new Error('missing default address')
		const rpcNetwork = defaultRpcs[0]
		if (rpcNetwork === undefined) throw new Error('missing default rpc')

		await browserStorageLocalSet({
			activeSimulationAddress: defaultAddress.address,
			openedPageV2: { page: 'Home' },
			useSignersAddressAsActiveAddress: false,
			websiteAccess: [],
			activeRpcNetwork: rpcNetwork,
			simulationMode: false,
			makeCurrentAddressRich: false,
			fixedAddressRichList: [],
		})
		await browserStorageLocalSet2({
			pendingTransactionsAndMessages: [makePendingTransaction()],
		})
		await setRpcConnectionStatus({
			isConnected: false,
			lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'),
			latestBlock: undefined,
			rpcNetwork,
			retrying: false,
		})

		const ethereum = new EthereumClientService({
			rpcUrl: rpcNetwork.httpsRpc,
			clearCache() { /* noop test stub */ },
			async jsonRpcRequest(rpcRequest: { method: string }) {
				if (rpcRequest.method === 'eth_blockNumber') return '0x7b'
				throw new Error(`Unexpected RPC method: ${ rpcRequest.method }`)
			},
		}, async () => undefined, async () => undefined, rpcNetwork)
		const tokenPriceService = new TokenPriceService(ethereum, 0)

		await updateConfirmTransactionView(ethereum, tokenPriceService)

		const initialMessage = browser.sentMessages.find((message) =>
			typeof message === 'object'
			&& message !== null
			&& 'method' in message
			&& message.method === 'popup_update_confirm_transaction_dialog'
		)
		if (initialMessage === undefined || typeof initialMessage !== 'object' || initialMessage === null || !('data' in initialMessage)) {
			throw new Error('missing initial confirm transaction dialog message')
		}

		assert.equal(
			typeof initialMessage.data === 'object'
				&& initialMessage.data !== null
				&& 'rpcConnectionStatus' in initialMessage.data
				&& initialMessage.data.rpcConnectionStatus !== undefined
				&& initialMessage.data.rpcConnectionStatus.retrying === false,
			true,
		)

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})

		await act(() => {
			browser.dispatch(initialMessage)
		})

		assert.equal(dom.document.body.textContent?.includes('Retrying resumes when the extension becomes active.'), true)
		await unmountConfirmTransaction(dom)
		dom.restore()
	})

	test('hydrates from a later bootstrap reply when the first ready handshake happens before pending data exists', async () => {
		const dom = installDomMock()
		const pendingTransaction = makePendingTransaction()
		const { createPassthroughCompleteVisualizedSimulation } = await import('../../app/ts/types/visualizer-types.js')
		const { serialize } = await import('../../app/ts/types/wire-types.js')
		const { PopupRequestsReplies } = await import('../../app/ts/types/interceptor-reply-messages.js')
		const browser = installBrowserMock((message) => {
			if (typeof message !== 'object' || message === null || !('method' in message)) return undefined
			const typedMessage = message as { method?: string }
			if (typedMessage.method === 'popup_readyAndListening') {
				const readyCalls = browser.getSentMessages().filter((sentMessage) =>
					typeof sentMessage === 'object'
					&& sentMessage !== null
					&& 'method' in sentMessage
					&& sentMessage.method === 'popup_readyAndListening'
				).length
				if (readyCalls === 1) return undefined
				return serialize(PopupRequestsReplies.popup_readyAndListening, {
					method: 'popup_readyAndListening',
					data: {
						popupOrTabId: { type: 'popup', id: 1 },
						confirmTransactionBootstrap: {
							pendingTransactionAndSignableMessages: [pendingTransaction],
							currentBlockNumber: 123n,
							rpcConnectionStatus: undefined,
							visualizedSimulatorState: createPassthroughCompleteVisualizedSimulation(),
						},
					},
				})
			}
			if (typedMessage.method === 'popup_requestSettings') return undefined
			return undefined
		})
		const { ConfirmTransaction, CONFIRM_TRANSACTION_BOOTSTRAP_RETRY_DELAY_MS } = await import('../../app/ts/components/pages/ConfirmTransaction.js')

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})

		await new Promise((resolve) => setTimeout(resolve, CONFIRM_TRANSACTION_BOOTSTRAP_RETRY_DELAY_MS + 50))

		const readyCalls = browser.getSentMessages().filter((message) =>
			typeof message === 'object'
			&& message !== null
			&& 'method' in message
			&& message.method === 'popup_readyAndListening'
		).length
		assert.equal(readyCalls >= 2, true)

		assert.equal(dom.document.body.textContent?.includes('simulation failed'), true)
		assert.equal(dom.document.body.textContent?.includes('Initializing...'), false)
		await unmountConfirmTransaction(dom)
		dom.restore()
	})

	test('does not let a late bootstrap reply overwrite pushed pending transaction data', async () => {
		const dom = installDomMock()
		const stalePendingTransaction = makePendingTransaction('stale bootstrap transaction')
		const freshPendingTransaction = makePendingTransaction('fresh pushed transaction')
		const { createPassthroughCompleteVisualizedSimulation } = await import('../../app/ts/types/visualizer-types.js')
		const { serialize } = await import('../../app/ts/types/wire-types.js')
		const { UpdateConfirmTransactionDialogPendingTransactions } = await import('../../app/ts/types/interceptor-messages.js')
		const { PopupRequestsReplies } = await import('../../app/ts/types/interceptor-reply-messages.js')
		const browser = installBrowserMock(async (message) => {
			if (typeof message !== 'object' || message === null || !('method' in message)) return undefined
			const typedMessage = message as { method?: string }
			if (typedMessage.method === 'popup_readyAndListening') {
				await new Promise((resolve) => setTimeout(resolve, 25))
				return serialize(PopupRequestsReplies.popup_readyAndListening, {
					method: 'popup_readyAndListening',
					data: {
						popupOrTabId: { type: 'popup', id: 1 },
						confirmTransactionBootstrap: {
							pendingTransactionAndSignableMessages: [stalePendingTransaction],
							currentBlockNumber: 123n,
							rpcConnectionStatus: undefined,
							visualizedSimulatorState: createPassthroughCompleteVisualizedSimulation(),
						},
					},
				})
			}
			if (typedMessage.method === 'popup_requestSettings') return undefined
			return undefined
		})
		const { ConfirmTransaction } = await import('../../app/ts/components/pages/ConfirmTransaction.js')

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})

		await act(() => {
			browser.dispatch({
				role: 'all',
				...serialize(UpdateConfirmTransactionDialogPendingTransactions, {
					method: 'popup_update_confirm_transaction_dialog_pending_transactions',
					data: {
						pendingTransactionAndSignableMessages: [freshPendingTransaction],
						currentBlockNumber: 124n,
						rpcConnectionStatus: undefined,
					},
				}),
			})
		})
		await new Promise((resolve) => setTimeout(resolve, 50))

		assert.equal(dom.document.body.textContent?.includes('fresh pushed transaction'), true)
		assert.equal(dom.document.body.textContent?.includes('stale bootstrap transaction'), false)
		await unmountConfirmTransaction(dom)
		dom.restore()
	})

	test('hydrates pending transaction details from storage when the initial popup push is missed', async () => {
		const dom = installDomMock()
		installBrowserMock((message) => {
			if (typeof message !== 'object' || message === null || !('method' in message)) return undefined
			const typedMessage = message as { method?: string }
			if (typedMessage.method === 'popup_readyAndListening') return undefined
			if (typedMessage.method === 'popup_requestSettings') return undefined
			return undefined
		})
		const [
			{ browserStorageLocalSet2 },
			{ ConfirmTransaction },
		] = await Promise.all([
			import('../../app/ts/utils/storageUtils.js'),
			import('../../app/ts/components/pages/ConfirmTransaction.js'),
		])

		await browserStorageLocalSet2({
			pendingTransactionsAndMessages: [makePendingTransaction()],
		})

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})
		await new Promise((resolve) => setTimeout(resolve, 25))

		assert.equal(dom.document.body.textContent?.includes('simulation failed'), true)
		assert.equal(dom.document.body.textContent?.includes('Initializing...'), false)
		await unmountConfirmTransaction(dom)
		dom.restore()
	})
})
