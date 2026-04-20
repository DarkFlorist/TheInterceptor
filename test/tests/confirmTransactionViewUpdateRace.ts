// @ts-nocheck
import * as assert from 'assert'
import type { MainOrConfirmUiRole } from '../../app/ts/messages/ui.js'
import { run, runIfRoot, should } from '../micro-should.js'

type RuntimeMessage = {
	role?: string
	method?: string
	data?: unknown
}

function createBrowserMock() {
	const storageState: Record<string, unknown> = {}
	const sentMessages: RuntimeMessage[] = []
	let nextPendingTransactionsReadBarrier: { promise: Promise<void>, release: () => void } | undefined = undefined

	const getItems = (keys?: string | string[] | Record<string, unknown> | null) => {
		if (keys === undefined || keys === null) return { ...storageState }
		if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
		if (typeof keys === 'string') return { [keys]: storageState[keys] }
		return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
	}

	const removeItems = (keys: string | string[]) => {
		const entries = Array.isArray(keys) ? keys : [keys]
		for (const key of entries) delete storageState[key]
	}

	// @ts-expect-error test shim intentionally overrides extension globals
	globalThis.browser = {
		runtime: {
			lastError: null,
			async sendMessage() { return undefined },
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					const items = getItems(keys)
					const includesPendingTransactions = Array.isArray(keys)
						? keys.includes('pendingTransactionsAndMessages')
						: keys === 'pendingTransactionsAndMessages'
					if (includesPendingTransactions && nextPendingTransactionsReadBarrier !== undefined) {
						const barrier = nextPendingTransactionsReadBarrier
						nextPendingTransactionsReadBarrier = undefined
						await barrier.promise
					}
					return items
				},
				async set(items: Record<string, unknown>) { Object.assign(storageState, items) },
				async remove(keys: string | string[]) { removeItems(keys) },
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
	}
	// @ts-expect-error test shim intentionally overrides extension globals
	globalThis.chrome = { runtime: { id: 'test-extension' } }

	return {
		sentMessages,
		blockNextPendingTransactionsRead() {
			if (nextPendingTransactionsReadBarrier !== undefined) throw new Error('pending transaction read already blocked')
			let resolveBarrier: (() => void) | undefined = undefined
			nextPendingTransactionsReadBarrier = {
				promise: new Promise<void>((resolve) => {
					resolveBarrier = resolve
				}),
				release: () => resolveBarrier?.(),
			}
			return () => nextPendingTransactionsReadBarrier?.release() ?? resolveBarrier?.()
		},
		async attachUiSession(role: MainOrConfirmUiRole) {
			const { registerUiPort } = await import('../../app/ts/background/uiSessions.js')
			const { getUiPortName } = await import('../../app/ts/messages/ui.js')
			const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
			const port = {
				name: getUiPortName(role),
				postMessage(message: unknown) {
					if (typeof message !== 'object' || message === null || !('kind' in message) || message.kind !== 'event') return
					if (!('payload' in message) || typeof message.payload !== 'object' || message.payload === null) return
					const { payload } = message
					if (!('role' in payload) || typeof payload.role !== 'string' || !('message' in payload) || typeof payload.message !== 'object' || payload.message === null) return
					const maybePopupMessage = MessageToPopup.safeParse({ role: payload.role, ...payload.message })
					if (!maybePopupMessage.success) return
					sentMessages.push(maybePopupMessage.value)
				},
				onDisconnect: { addListener: () => undefined, removeListener: () => undefined },
				onMessage: { addListener: () => undefined, removeListener: () => undefined },
				disconnect() {},
			} as unknown as browser.runtime.Port
			registerUiPort(port)
		},
	}
}

async function loadModules() {
	const [
		simulationModeEthereumClientService,
		confirmTransactionWindow,
		settings,
		storageUtils,
	] = await Promise.all([
		import('../../app/ts/simulation/services/SimulationModeEthereumClientService.js'),
		import('../../app/ts/background/windows/confirmTransaction.js'),
		import('../../app/ts/background/settings.js'),
		import('../../app/ts/utils/storageUtils.js'),
	])

	return {
		mockSignTransaction: simulationModeEthereumClientService.mockSignTransaction,
		updateConfirmTransactionView: confirmTransactionWindow.updateConfirmTransactionView,
		defaultActiveAddresses: settings.defaultActiveAddresses,
		browserStorageLocalSet2: storageUtils.browserStorageLocalSet2,
	}
}

export async function main() {
	const browserMock = createBrowserMock()
	await browserMock.attachUiSession('confirmTransaction')
	const modules = await loadModules()

	const fakeRpcNetwork = {
		name: 'Test Chain',
		chainId: 1337n,
		httpsRpc: 'https://example.invalid',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		currencyLogoUri: undefined,
		primary: true,
		minimized: true,
	}

	const activeAddress = modules.defaultActiveAddresses[0]?.address
	const recipientAddress = modules.defaultActiveAddresses[1]?.address
	if (activeAddress === undefined || recipientAddress === undefined) throw new Error('missing default addresses')

	const created = new Date('2024-01-01T00:00:00.000Z')
	const uniqueRequestIdentifier = { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } }
	const unsignedTransaction = {
		type: '1559' as const,
		from: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		nonce: 0n,
		maxFeePerGas: 1n,
		maxPriorityFeePerGas: 1n,
		gas: 21_000n,
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
		accessList: [],
	}
	const signedTransaction = modules.mockSignTransaction(unsignedTransaction)

	const makePopupVisualisation = (simulationConductedTimestamp: Date) => ({
		statusCode: 'success' as const,
		data: {
			activeAddress,
			simulationMode: true,
			simulationStartedTimestamp: created,
			uniqueRequestIdentifier,
			transactionToSimulate: {
				website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
				created,
				originalRequestParameters: {
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
				},
				transactionIdentifier: 1n,
				success: true as const,
				transaction: signedTransaction,
			},
			signerName: 'NoSignerDetected',
			addressBookEntries: [],
			tokenPriceEstimates: [],
			namedTokenIds: [],
			simulationState: {
				success: true as const,
				simulationStateInput: [],
				simulatedBlocks: [],
				blockNumber: 123n,
				blockTimestamp: created,
				baseFeePerGas: 0n,
				simulationConductedTimestamp,
				rpcNetwork: fakeRpcNetwork,
			},
			visualizedSimulationState: { success: true as const, visualizedBlocks: [] },
		},
	})

	const buildPendingTransaction = (popupVisualisation: ReturnType<typeof makePopupVisualisation>) => ({
		type: 'Transaction' as const,
		popupOrTabId: { type: 'popup' as const, id: 1 },
		originalRequestParameters: popupVisualisation.data.transactionToSimulate.originalRequestParameters,
		uniqueRequestIdentifier,
		simulationMode: true,
		activeAddress,
		created,
		transactionIdentifier: 1n,
		website: popupVisualisation.data.transactionToSimulate.website,
		approvalStatus: { status: 'WaitingForUser' as const },
		popupVisualisation,
		transactionOrMessageCreationStatus: 'Simulated' as const,
		transactionToSimulate: popupVisualisation.data.transactionToSimulate,
	})

	const buildSimulator = (blockNumber: bigint | Promise<bigint>) => ({
		ethereum: {
			getBlockNumber() {
				return blockNumber
			},
			getCachedBlock() {
				return {
					number: typeof blockNumber === 'bigint' ? blockNumber : 123n,
					timestamp: created,
					baseFeePerGas: 1n,
					gasLimit: 30_000_000n,
				}
			},
			async getBlock() {
				return {
					number: typeof blockNumber === 'bigint' ? blockNumber : 123n,
					timestamp: created,
					baseFeePerGas: 1n,
					gasLimit: 30_000_000n,
				}
			},
			getRpcEntry() {
				return fakeRpcNetwork
			},
			getChainId() {
				return fakeRpcNetwork.chainId
			},
		},
		tokenPriceService: {
			async estimateEthereumPricesForTokens() {
				return []
			},
		},
	})

	should('confirm transaction view ignores stale overlapping refresh results', async () => {
		browserMock.sentMessages.length = 0
		const oldTimestamp = new Date('2024-01-01T00:00:05.000Z')
		await modules.browserStorageLocalSet2({
			simulationMode: false,
			pendingTransactionsAndMessages: [buildPendingTransaction(makePopupVisualisation(oldTimestamp))],
		})

		let resolveSlowBlockNumber: ((value: bigint) => void) | undefined = undefined
		const delayedBlockNumber = new Promise<bigint>((resolve) => {
			resolveSlowBlockNumber = resolve
		})
		const staleUpdatePromise = modules.updateConfirmTransactionView(buildSimulator(delayedBlockNumber))
		await new Promise((resolve) => setTimeout(resolve, 0))

		const newerTimestamp = new Date('2024-01-01T00:00:09.000Z')
		await modules.browserStorageLocalSet2({
			simulationMode: false,
			pendingTransactionsAndMessages: [buildPendingTransaction(makePopupVisualisation(newerTimestamp))],
		})

		await modules.updateConfirmTransactionView(buildSimulator(124n))
		resolveSlowBlockNumber?.(123n)
		await staleUpdatePromise

		const lastPendingTransactionsMessage = browserMock.sentMessages
			.filter((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions')
			.at(-1)
		const lastConfirmTransactionState = browserMock.sentMessages
			.filter((message) => message.method === 'popup_update_confirm_transaction_dialog')
			.at(-1)

		assert.equal(lastConfirmTransactionState?.data.currentBlockNumber, 124n)
		assert.equal(
			lastPendingTransactionsMessage?.data.pendingTransactionAndSignableMessages[0]?.popupVisualisation?.data?.simulationState?.simulationConductedTimestamp?.getTime(),
			newerTimestamp.getTime(),
		)
	})

	should('confirm transaction view still publishes pending transactions while a stale bootstrap update is overtaken', async () => {
		browserMock.sentMessages.length = 0
		const releasePendingTransactionsRead = browserMock.blockNextPendingTransactionsRead()
		await modules.browserStorageLocalSet2({
			pendingTransactionsAndMessages: [buildPendingTransaction(makePopupVisualisation(new Date('2024-01-01T00:00:05.000Z')))],
		})

		const staleUpdatePromise = modules.updateConfirmTransactionView(buildSimulator(123n))
		await modules.browserStorageLocalSet2({
			pendingTransactionsAndMessages: [],
		})
		await modules.updateConfirmTransactionView(buildSimulator(124n))
		releasePendingTransactionsRead()
		await staleUpdatePromise

		const pendingTransactionsMessage = browserMock.sentMessages
			.find((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions')

		assert.equal(pendingTransactionsMessage?.data.pendingTransactionAndSignableMessages.length, 1)
	})
}

await runIfRoot(async () => {
	await main()
	await run()
}, import.meta)
