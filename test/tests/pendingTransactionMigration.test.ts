import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { encodeErrorString } from './errorDataFixtures.js'
import type { TransactionCreationError } from '../../app/ts/types/error.js'

const defineGlobal = (name: PropertyKey, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })

function installBrowserMock() {
	const storageState: Record<string, unknown> = {}
	const storageWrites: Record<string, unknown>[] = []
	defineGlobal('browser', {
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					if (keys === undefined || keys === null) return { ...storageState }
					if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
					if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
					return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
				},
				async set(items: Record<string, unknown>) {
					storageWrites.push(items)
					Object.assign(storageState, items)
				},
				async remove(keys: string | string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
				},
			},
		},
	})
	return storageWrites
}

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

// The confirmation popup hydrates from storage directly, so the migrated reasons are read back the way it reads them.
const readStoredTransactionCreationFailureReasons = async () => {
	const { browserStorageLocalGet2 } = await import('../../app/ts/utils/storageUtils.js')
	return ((await browserStorageLocalGet2('pendingTransactionsAndMessages')).pendingTransactionsAndMessages ?? []).map((pending) => {
		if (pending.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'FailedToSimulate') return undefined
		return pending.popupVisualisation.data.transactionCreationFailureReason
	})
}

describe('pending transaction migration', () => {
	test('stores the missing failure reason of failed transactions stored by older versions', async () => {
		installBrowserMock()
		const { browserStorageLocalSet2 } = await import('../../app/ts/utils/storageUtils.js')
		const { migratePendingTransactionCreationFailureReasons } = await import('../../app/ts/background/pendingTransactionMigration.js')
		// Older versions stored no failure reason and replaced the raw message with the insufficient balance explanation.
		const legacyInsufficientBalanceMessage = 'Insufficient ETH balance. Available: 1 ETH. Attempting to send: 2 ETH.'
		await browserStorageLocalSet2({ pendingTransactionsAndMessages: [
			createFailedToSimulatePendingTransaction({ code: -32000, message: 'execution reverted', data: encodeErrorString('STF') }, undefined),
			createFailedToSimulatePendingTransaction({ code: -32000, message: legacyInsufficientBalanceMessage, data: '0x' }, undefined),
			createFailedToSimulatePendingTransaction({ code: -32000, message: legacyInsufficientBalanceMessage, data: encodeErrorString('ERC20: transfer amount exceeds balance') }, undefined),
			createFailedToSimulatePendingTransaction({ code: -32000, message: 'execution reverted', data: encodeErrorString('STF') }, 'Reason derived by the background'),
		] })

		await migratePendingTransactionCreationFailureReasons()

		assert.deepEqual(await readStoredTransactionCreationFailureReasons(), [
			'STF - possible Uniswap V3 error: Token transfer from the sender via safeTransferFrom failed, usually due to insufficient token balance or allowance',
			legacyInsufficientBalanceMessage,
			'ERC20: transfer amount exceeds balance',
			'Reason derived by the background',
		])
	})

	test('does not rewrite storage when every failed transaction already has a reason', async () => {
		const storageWrites = installBrowserMock()
		const { browserStorageLocalSet2 } = await import('../../app/ts/utils/storageUtils.js')
		const { migratePendingTransactionCreationFailureReasons } = await import('../../app/ts/background/pendingTransactionMigration.js')
		await browserStorageLocalSet2({ pendingTransactionsAndMessages: [createFailedToSimulatePendingTransaction({ code: -32000, message: 'execution reverted', data: '0x' }, 'Reason derived by the background')] })
		const writesBeforeMigration = storageWrites.length

		await migratePendingTransactionCreationFailureReasons()

		assert.equal(storageWrites.length, writesBeforeMigration)
		assert.deepEqual(await readStoredTransactionCreationFailureReasons(), ['Reason derived by the background'])
	})
})
