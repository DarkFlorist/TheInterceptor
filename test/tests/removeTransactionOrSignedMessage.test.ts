import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import type { RemoveTransaction } from '../../app/ts/types/interceptor-messages.js'
import type { PreSimulationTransaction } from '../../app/ts/types/visualizer-types.js'
import type { EthereumSendableSignedTransaction, EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import { createPerTestRestorer } from '../harness/perTest.js'
import { createStubEthereumClient } from './stubEthereumClient.js'

const { installBrowserMockForTest } = createPerTestRestorer()

async function loadModules() {
	const [
		popupMessageHandlers,
		simulationModeEthereumClientService,
		storageVariables,
	] = await Promise.all([
		import('../../app/ts/background/popupMessageHandlers/simulation.js'),
		import('../../app/ts/simulation/services/SimulationModeEthereumClientService.js'),
		import('../../app/ts/background/storageVariables.js'),
	])

	return {
		// The handler only needs a client and price cache for popup refreshes, so it runs against a stub client that rejects every RPC request.
		removeTransactionOrSignedMessage: async (params: RemoveTransaction) => {
			const ethereum = createStubEthereumClient()
			await popupMessageHandlers.removeTransactionOrSignedMessage(ethereum, new TokenPriceService(ethereum, 60_000), params)
		},
		mockSignTransaction: simulationModeEthereumClientService.mockSignTransaction,
		getInterceptorTransactionStack: storageVariables.getInterceptorTransactionStack,
		updateInterceptorTransactionStack: storageVariables.updateInterceptorTransactionStack,
	}
}

function makeBaseUnsignedTransaction(): EthereumUnsignedTransaction {
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

function makePreSimulationTransaction(mockSignTransaction: (transaction: EthereumUnsignedTransaction) => EthereumSendableSignedTransaction, params: {
	transactionIdentifier: bigint
	nonce: bigint
	from?: bigint
	method?: 'eth_sendTransaction' | 'eth_sendRawTransaction'
}): PreSimulationTransaction {
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
			? { method: 'eth_sendTransaction', params: [{}] }
			: { method: 'eth_sendRawTransaction', params: [new Uint8Array([Number(params.transactionIdentifier)])] },
		transactionIdentifier: params.transactionIdentifier,
	}
}

function makeMessageOperation(messageIdentifier: bigint) {
	const signer = 0x1111111111111111111111111111111111111111n
	return {
		type: 'Message' as const,
		signedMessageTransaction: {
			website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
			created: new Date('2024-01-01T00:00:00.000Z'),
			fakeSignedFor: signer,
			originalRequestParameters: { method: 'personal_sign' as const, params: ['0x68656c6c6f', signer] as const },
			request: {
				method: 'personal_sign',
				params: ['0x68656c6c6f', '0x1111111111111111111111111111111111111111'],
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: Number(messageIdentifier), requestSocket: { tabId: 1, connectionName: 0n } },
			},
			simulationMode: true,
			messageIdentifier,
		},
	}
}

function makeTimeManipulationOperation(deltaToAdd: bigint) {
	return { type: 'TimeManipulation' as const, blockTimeManipulation: { type: 'AddToTimestamp' as const, deltaToAdd, deltaUnit: 'Seconds' as const } }
}

describe('removeTransactionOrSignedMessage', () => {
	test('removes the time manipulation of a removed message instead of leaving two in a row', async () => {
		installBrowserMockForTest()
		const modules = await loadModules()
		// Each time manipulation applies after the operation before it: 5 seconds after message 1, 7 seconds after message 2.
		await modules.updateInterceptorTransactionStack(() => ({
			operations: [
				makeMessageOperation(1n),
				makeTimeManipulationOperation(5n),
				makeMessageOperation(2n),
				makeTimeManipulationOperation(7n),
				makeMessageOperation(3n),
			],
		}))

		await modules.removeTransactionOrSignedMessage({
			method: 'popup_removeTransactionOrSignedMessage',
			data: { type: 'Message', messageIdentifier: 2n },
		})

		const stack = await modules.getInterceptorTransactionStack()
		assert.deepEqual(stack.operations.map((operation) => operation.type === 'Message' ? operation.signedMessageTransaction.messageIdentifier : operation.type), [1n, 'TimeManipulation', 3n])
		const [, remainingTimeManipulation] = stack.operations
		assert.equal(remainingTimeManipulation?.type === 'TimeManipulation' && remainingTimeManipulation.blockTimeManipulation.type === 'AddToTimestamp' ? remainingTimeManipulation.blockTimeManipulation.deltaToAdd : undefined, 5n)
	})


	test('keeps later raw transactions unchanged when removing an earlier same-sender transaction', async () => {
		installBrowserMockForTest()
		const modules = await loadModules()
		await modules.updateInterceptorTransactionStack(() => ({
			operations: [
				{ type: 'Transaction' as const, preSimulationTransaction: makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 1n, nonce: 0n, method: 'eth_sendTransaction' }) },
				{ type: 'Transaction' as const, preSimulationTransaction: makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 2n, nonce: 0n, method: 'eth_sendRawTransaction' }) },
			],
		}))

		await modules.removeTransactionOrSignedMessage({
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
		installBrowserMockForTest()
		const modules = await loadModules()
		await modules.updateInterceptorTransactionStack(() => ({
			operations: [
				{ type: 'Transaction' as const, preSimulationTransaction: makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 1n, nonce: 0n }) },
				{ type: 'Transaction' as const, preSimulationTransaction: makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 2n, nonce: 1n }) },
			],
		}))

		await modules.removeTransactionOrSignedMessage({
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
		installBrowserMockForTest()
		const modules = await loadModules()
		await modules.updateInterceptorTransactionStack(() => ({
			operations: [
				{ type: 'Transaction' as const, preSimulationTransaction: makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 1n, nonce: 0n, from: 0x1111111111111111111111111111111111111111n }) },
				{ type: 'Transaction' as const, preSimulationTransaction: makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 2n, nonce: 5n, from: 0x3333333333333333333333333333333333333333n }) },
			],
		}))

		await modules.removeTransactionOrSignedMessage({
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
		installBrowserMockForTest()
		const modules = await loadModules()
		await modules.updateInterceptorTransactionStack(() => ({
			operations: [
				{ type: 'Transaction' as const, preSimulationTransaction: makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 1n, nonce: 0n }) },
				{ type: 'Transaction' as const, preSimulationTransaction: makePreSimulationTransaction(modules.mockSignTransaction, { transactionIdentifier: 2n, nonce: 0n }) },
			],
		}))

		await modules.removeTransactionOrSignedMessage({
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
