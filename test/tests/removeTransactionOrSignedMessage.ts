// @ts-nocheck
import * as assert from 'assert'
import { describe, run, runIfRoot, should } from '../micro-should.js'

type RuntimeMessage = {
	method?: string
	type?: string
	data?: unknown
}

function createBrowserMock() {
	const storageState: Record<string, unknown> = {}

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
			async sendMessage(message: RuntimeMessage) {
				if (message.method === 'popup_isMainPopupWindowOpen') {
					return { type: 'RequestIsMainPopupWindowOpenReply', data: { isOpen: false } }
				}
				return undefined
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) { return getItems(keys) },
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
		reset() {
			for (const key of Object.keys(storageState)) delete storageState[key]
			// @ts-expect-error test shim intentionally overrides extension globals
			globalThis.browser.runtime.lastError = undefined
		},
	}
}

async function loadModules() {
	const [
		popupMessageHandlers,
		simulationModeEthereumClientService,
		storageVariables,
	] = await Promise.all([
		import('../../app/ts/background/popupMessageHandlers.js'),
		import('../../app/ts/simulation/services/SimulationModeEthereumClientService.js'),
		import('../../app/ts/background/storageVariables.js'),
	])

	return {
		removeTransactionOrSignedMessage: popupMessageHandlers.removeTransactionOrSignedMessage,
		mockSignTransaction: simulationModeEthereumClientService.mockSignTransaction,
		getInterceptorTransactionStack: storageVariables.getInterceptorTransactionStack,
		updateInterceptorTransactionStack: storageVariables.updateInterceptorTransactionStack,
	}
}

const browserMock = createBrowserMock()

function makeBaseUnsignedTransaction() {
	return {
		type: '1559' as const,
		from: 0x1111111111111111111111111111111111111111n,
		nonce: 0n,
		maxFeePerGas: 2n,
		maxPriorityFeePerGas: 1n,
		gas: 21_000n,
		to: 0x2222222222222222222222222222222222222222n,
		value: 0n,
		input: new Uint8Array(),
		chainId: 1n,
		accessList: [],
	}
}

function makePreSimulationTransaction(mockSignTransaction: (transaction: ReturnType<typeof makeBaseUnsignedTransaction>) => unknown, params: {
	transactionIdentifier: bigint
	nonce: bigint
	from?: bigint
	method?: 'eth_sendTransaction' | 'eth_sendRawTransaction'
}) {
	const method = params.method ?? 'eth_sendTransaction'
	const signedTransaction = mockSignTransaction({
		...makeBaseUnsignedTransaction(),
		from: params.from ?? 0x1111111111111111111111111111111111111111n,
		nonce: params.nonce,
	})

	return {
		signedTransaction,
		website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		created: new Date('2024-01-01T00:00:00.000Z'),
		originalRequestParameters: method === 'eth_sendTransaction'
			? { method: 'eth_sendTransaction' as const, params: [{}] }
			: { method: 'eth_sendRawTransaction' as const, params: [new Uint8Array([Number(params.transactionIdentifier)])] },
		transactionIdentifier: params.transactionIdentifier,
	}
}

export async function main() {
	const modules = await loadModules()
	const simulator = {} as never

	const seedStack = async (...transactions: ReturnType<typeof makePreSimulationTransaction>[]) => {
		await modules.updateInterceptorTransactionStack(() => ({
			operations: transactions.map((transaction) => ({ type: 'Transaction' as const, preSimulationTransaction: transaction }))
		}))
	}

	const getTransactions = async () => {
		const stack = await modules.getInterceptorTransactionStack()
		return stack.operations
			.filter((operation) => operation.type === 'Transaction')
			.map((operation) => operation.preSimulationTransaction)
	}

	const removeTransaction = async (transactionIdentifier: bigint) => {
		await modules.removeTransactionOrSignedMessage(simulator, {
			method: 'popup_removeTransactionOrSignedMessage',
			data: { type: 'Transaction', transactionIdentifier },
		})
	}

	describe('removeTransactionOrSignedMessage', () => {
		should('keeps later raw transactions unchanged when removing an earlier same-sender transaction', async () => {
			browserMock.reset()
			await seedStack(
				makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 1n, nonce: 0n, method: 'eth_sendTransaction' }),
				makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 2n, nonce: 0n, method: 'eth_sendRawTransaction' }),
			)

			await removeTransaction(1n)

			const [remaining] = await getTransactions()
			assert.equal(remaining.originalRequestParameters.method, 'eth_sendRawTransaction')
			assert.equal(remaining.signedTransaction.nonce, 0n)
		})

		should('decrements later interceptor-assigned transactions from the same sender', async () => {
			browserMock.reset()
			await seedStack(
				makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 1n, nonce: 0n }),
				makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 2n, nonce: 1n }),
			)

			await removeTransaction(1n)

			const [remaining] = await getTransactions()
			assert.equal(remaining.originalRequestParameters.method, 'eth_sendTransaction')
			assert.equal(remaining.signedTransaction.nonce, 0n)
		})

		should('does not rewrite later transactions from a different sender', async () => {
			browserMock.reset()
			await seedStack(
				makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 1n, nonce: 0n, from: 0x1111111111111111111111111111111111111111n }),
				makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 2n, nonce: 5n, from: 0x3333333333333333333333333333333333333333n }),
			)

			await removeTransaction(1n)

			const [remaining] = await getTransactions()
			assert.equal(remaining.signedTransaction.from, 0x3333333333333333333333333333333333333333n)
			assert.equal(remaining.signedTransaction.nonce, 5n)
		})

		should('does not rewrite later same-sender transactions with the same nonce', async () => {
			browserMock.reset()
			await seedStack(
				makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 1n, nonce: 0n }),
				makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 2n, nonce: 0n }),
			)

			await removeTransaction(1n)

			const [remaining] = await getTransactions()
			assert.equal(remaining.originalRequestParameters.method, 'eth_sendTransaction')
			assert.equal(remaining.signedTransaction.nonce, 0n)
		})
	})
}

await runIfRoot(async () => {
	await main()
	await run()
}, import.meta)
