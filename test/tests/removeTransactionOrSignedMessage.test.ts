import * as assert from 'assert'
import { describe, test } from 'bun:test'

type RuntimeMessage = {
	method?: string
	data?: unknown
}

const defineGlobal = (name: PropertyKey, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })

function createBrowserMock() {
	const storageState: Record<string, unknown> = {}

	const browserMock = {
		runtime: {
			lastError: null as unknown,
			async sendMessage(message: RuntimeMessage) {
				if (message.method === 'popup_isMainPopupWindowOpen') {
					return { method: 'popup_isMainPopupWindowOpen', data: { isOpen: false } }
				}
				return undefined
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					if (keys === undefined || keys === null) return { ...storageState }
					if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
					if (typeof keys === 'string') return { [keys]: storageState[keys] }
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
	}
	defineGlobal('browser', browserMock)
	defineGlobal('chrome', { runtime: { id: 'test-extension' } })

	return {
		reset() {
			for (const key of Object.keys(storageState)) delete storageState[key]
			browserMock.runtime.lastError = undefined
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

describe('removeTransactionOrSignedMessage', () => {
	test('keeps later raw transactions unchanged when removing an earlier same-sender transaction', async () => {
		const modules = await loadModules()
		browserMock.reset()
		await modules.updateInterceptorTransactionStack(() => ({
			operations: [
				{ type: 'Transaction' as const, preSimulationTransaction: makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 1n, nonce: 0n, method: 'eth_sendTransaction' }) },
				{ type: 'Transaction' as const, preSimulationTransaction: makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 2n, nonce: 0n, method: 'eth_sendRawTransaction' }) },
			],
		}))

		await modules.removeTransactionOrSignedMessage({}, undefined, {
			method: 'popup_removeTransactionOrSignedMessage',
			data: { type: 'Transaction', transactionIdentifier: 1n },
		})

		const stack = await modules.getInterceptorTransactionStack()
		const [remaining] = stack.operations.filter((operation) => operation.type === 'Transaction').map((operation) => operation.preSimulationTransaction)
		if (remaining === undefined) throw new Error('Expected remaining transaction')
		assert.equal(remaining.originalRequestParameters.method, 'eth_sendRawTransaction')
		assert.equal(remaining.signedTransaction.nonce, 0n)
	})

	test('decrements later interceptor-assigned transactions from the same sender', async () => {
		const modules = await loadModules()
		browserMock.reset()
		await modules.updateInterceptorTransactionStack(() => ({
			operations: [
				{ type: 'Transaction' as const, preSimulationTransaction: makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 1n, nonce: 0n }) },
				{ type: 'Transaction' as const, preSimulationTransaction: makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 2n, nonce: 1n }) },
			],
		}))

		await modules.removeTransactionOrSignedMessage({}, undefined, {
			method: 'popup_removeTransactionOrSignedMessage',
			data: { type: 'Transaction', transactionIdentifier: 1n },
		})

		const stack = await modules.getInterceptorTransactionStack()
		const [remaining] = stack.operations.filter((operation) => operation.type === 'Transaction').map((operation) => operation.preSimulationTransaction)
		if (remaining === undefined) throw new Error('Expected remaining transaction')
		assert.equal(remaining.originalRequestParameters.method, 'eth_sendTransaction')
		assert.equal(remaining.signedTransaction.nonce, 0n)
	})

	test('does not rewrite later transactions from a different sender', async () => {
		const modules = await loadModules()
		browserMock.reset()
		await modules.updateInterceptorTransactionStack(() => ({
			operations: [
				{ type: 'Transaction' as const, preSimulationTransaction: makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 1n, nonce: 0n, from: 0x1111111111111111111111111111111111111111n }) },
				{ type: 'Transaction' as const, preSimulationTransaction: makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 2n, nonce: 5n, from: 0x3333333333333333333333333333333333333333n }) },
			],
		}))

		await modules.removeTransactionOrSignedMessage({}, undefined, {
			method: 'popup_removeTransactionOrSignedMessage',
			data: { type: 'Transaction', transactionIdentifier: 1n },
		})

		const stack = await modules.getInterceptorTransactionStack()
		const [remaining] = stack.operations.filter((operation) => operation.type === 'Transaction').map((operation) => operation.preSimulationTransaction)
		if (remaining === undefined) throw new Error('Expected remaining transaction')
		assert.equal(remaining.signedTransaction.from, 0x3333333333333333333333333333333333333333n)
		assert.equal(remaining.signedTransaction.nonce, 5n)
	})

	test('does not rewrite later same-sender transactions with the same nonce', async () => {
		const modules = await loadModules()
		browserMock.reset()
		await modules.updateInterceptorTransactionStack(() => ({
			operations: [
				{ type: 'Transaction' as const, preSimulationTransaction: makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 1n, nonce: 0n }) },
				{ type: 'Transaction' as const, preSimulationTransaction: makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 2n, nonce: 0n }) },
			],
		}))

		await modules.removeTransactionOrSignedMessage({}, undefined, {
			method: 'popup_removeTransactionOrSignedMessage',
			data: { type: 'Transaction', transactionIdentifier: 1n },
		})

		const stack = await modules.getInterceptorTransactionStack()
		const [remaining] = stack.operations.filter((operation) => operation.type === 'Transaction').map((operation) => operation.preSimulationTransaction)
		if (remaining === undefined) throw new Error('Expected remaining transaction')
		assert.equal(remaining.originalRequestParameters.method, 'eth_sendTransaction')
		assert.equal(remaining.signedTransaction.nonce, 0n)
	})
})
