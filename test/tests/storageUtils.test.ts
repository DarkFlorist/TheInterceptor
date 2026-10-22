import * as assert from 'assert'
import { beforeEach, describe, test } from 'bun:test'
import { encodeErrorString } from './errorDataFixtures.js'
import type { TransactionCreationError } from '../../app/ts/types/error.js'

const storedItems: Record<string, unknown> = {}
const writes: Record<string, unknown>[] = []
let storageReadError: Error | undefined

Object.defineProperty(globalThis, 'browser', {
	configurable: true,
	writable: true,
	value: {
		storage: {
			local: {
				get: async (keys: string | readonly string[]) => {
					if (storageReadError !== undefined) throw storageReadError
					const requestedKeys = Array.isArray(keys) ? keys : [keys]
					return Object.fromEntries(requestedKeys.filter((key) => key in storedItems).map((key) => [key, storedItems[key]]))
				},
				set: async (items: Record<string, unknown>) => {
					writes.push(items)
					Object.assign(storedItems, items)
				},
				remove: async () => undefined,
			},
		},
	},
})

const { browserStorageLocalGet, browserStorageLocalGet2, browserStorageLocalGet2Result, browserStorageLocalSet, browserStorageLocalSet2 } = await import('../../app/ts/utils/storageUtils.js')

const createFailedToSimulatePendingTransaction = (error: TransactionCreationError, transactionCreationFailureReason: string | undefined) => {
	const activeAddress = 0x1111111111111111111111111111111111111111n
	const created = new Date('2024-01-01T00:00:00.000Z')
	const website = { websiteOrigin: 'https://example.com', icon: undefined, title: undefined }
	const uniqueRequestIdentifier = { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } }
	const originalRequestParameters = { method: 'eth_sendTransaction' as const, params: [{ from: activeAddress, to: 0x2222222222222222222222222222222222222222n, value: 0n, input: new Uint8Array() }] as const }
	const transactionToSimulate = { website, created, originalRequestParameters, transactionIdentifier: 1n, success: false as const, error }
	return {
		type: 'Transaction' as const,
		transactionOrMessageCreationStatus: 'FailedToSimulate' as const,
		popupOrTabId: { type: 'popup' as const, id: 1 },
		originalRequestParameters,
		uniqueRequestIdentifier,
		simulationMode: true,
		activeAddress,
		created,
		transactionIdentifier: 1n,
		transactionToSimulate,
		website,
		approvalStatus: { status: 'WaitingForUser' as const },
		popupVisualisation: {
			statusCode: 'failed' as const,
			data: {
				activeAddress,
				simulationMode: true,
				simulationStartedTimestamp: created,
				uniqueRequestIdentifier,
				transactionToSimulate,
				...(transactionCreationFailureReason === undefined ? {} : { transactionCreationFailureReason }),
				signerName: 'NoSignerDetected' as const,
				error: { code: -32000, message: 'eth_simulateV1 rejected the stack', decodedErrorMessage: 'eth_simulateV1 rejected the stack' },
				simulationState: { blockNumber: 123n, simulationConductedTimestamp: created },
			},
		},
	}
}

// The confirmation popup reads storage with browserStorageLocalGet2 and the background with browserStorageLocalGet2Result.
const readStoredTransactionCreationFailureReasons = async () => {
	const backgroundRead = await browserStorageLocalGet2Result('pendingTransactionsAndMessages')
	if (!backgroundRead.success) throw backgroundRead.error
	return [await browserStorageLocalGet2('pendingTransactionsAndMessages'), backgroundRead.value].map((items) => (items.pendingTransactionsAndMessages ?? []).map((pending) => {
		if (pending.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'FailedToSimulate') return undefined
		return pending.popupVisualisation.data.transactionCreationFailureReason
	}))
}

describe('local storage codecs', () => {
	beforeEach(() => {
		for (const key of Object.keys(storedItems)) delete storedItems[key]
		writes.length = 0
		storageReadError = undefined
	})

	test('serializes only present active-address properties, including explicit clears', async () => {
		await browserStorageLocalSet({ activeSigningAddress: undefined, activeSigningSafeAddress: 2n, independentActiveSimulationAddress: 1n })
		assert.deepEqual(writes[0], {
			activeSigningAddress: 'missing',
			activeSigningSafeAddress: '0x0000000000000000000000000000000000000002',
			independentActiveSimulationAddress: '0x0000000000000000000000000000000000000001',
		})

		await browserStorageLocalSet({ simulationMode: true })
		assert.deepEqual(writes[1], { simulationMode: true })
		assert.deepEqual(await browserStorageLocalGet(['activeSigningAddress', 'activeSigningSafeAddress', 'independentActiveSimulationAddress']), {
			activeSigningAddress: undefined,
			activeSigningSafeAddress: 2n,
			independentActiveSimulationAddress: 1n,
		})
	})

	test('distinguishes absent, explicitly cleared, and corrupt active-address properties', async () => {
		assert.deepEqual(await browserStorageLocalGet('activeSigningAddress'), {})

		storedItems.activeSigningAddress = 'missing'
		assert.deepEqual(await browserStorageLocalGet('activeSigningAddress'), { activeSigningAddress: undefined })

		storedItems.activeSigningAddress = 'not-an-address'
		await assert.rejects(browserStorageLocalGet('activeSigningAddress'))
	})

	test('reports pending-item validation failures without absorbing storage read failures', async () => {
		storedItems.pendingTransactionsAndMessages = 'corrupt'
		const invalidResult = await browserStorageLocalGet2Result('pendingTransactionsAndMessages')
		assert.equal(invalidResult.success, false)

		storageReadError = new Error('Storage temporarily unavailable')
		await assert.rejects(browserStorageLocalGet2Result('pendingTransactionsAndMessages'), /Storage temporarily unavailable/)
	})

	test('derives the missing failure reason of failed transactions stored by older versions', async () => {
		// Older versions stored no failure reason and replaced the raw message with the insufficient balance explanation.
		const legacyInsufficientBalanceMessage = 'Insufficient ETH balance. Available: 1 ETH. Attempting to send: 2 ETH.'
		await browserStorageLocalSet2({ pendingTransactionsAndMessages: [
			createFailedToSimulatePendingTransaction({ code: -32000, message: 'execution reverted', data: encodeErrorString('STF') }, undefined),
			createFailedToSimulatePendingTransaction({ code: -32000, message: legacyInsufficientBalanceMessage, data: '0x' }, undefined),
			createFailedToSimulatePendingTransaction({ code: -32000, message: legacyInsufficientBalanceMessage, data: encodeErrorString('ERC20: transfer amount exceeds balance') }, undefined),
			createFailedToSimulatePendingTransaction({ code: -32000, message: 'execution reverted', data: encodeErrorString('STF') }, 'Reason derived by the background'),
		] })

		const expectedReasons = [
			'STF - possible Uniswap V3 error: Token transfer from the sender via safeTransferFrom failed, usually due to insufficient token balance or allowance',
			legacyInsufficientBalanceMessage,
			'ERC20: transfer amount exceeds balance',
			'Reason derived by the background',
		]
		assert.deepEqual(await readStoredTransactionCreationFailureReasons(), [expectedReasons, expectedReasons])
	})
})
