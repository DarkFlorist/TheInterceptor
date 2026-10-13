import * as assert from 'node:assert'
import { beforeEach, describe, test } from 'bun:test'
import { browserStorageLocalGet, browserStorageLocalGet2Result, browserStorageLocalSet } from '../../app/ts/utils/storageUtils.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'

const installBrowserMock = createPerTestBrowserMockInstaller()

// Records every storage write the code under test makes; seedStorage writes directly without being recorded, and failReads makes later reads reject.
function installRecordingStorageMock() {
	const browserMock = installBrowserMock()
	const { get: readStorage, set: seedStorage } = browserMock.browser.storage.local
	const writes: Readonly<Record<string, unknown>>[] = []
	let readError: Error | undefined
	browserMock.browser.storage.local.get = async (keys) => {
		if (readError !== undefined) throw readError
		return await readStorage(keys)
	}
	browserMock.browser.storage.local.set = async (items) => {
		writes.push(items)
		await seedStorage(items)
	}
	return { writes, seedStorage, failReads: (error: Error) => { readError = error } }
}

describe('local storage codecs', () => {
	let storage: ReturnType<typeof installRecordingStorageMock>
	beforeEach(() => {
		storage = installRecordingStorageMock()
	})

	test('serializes only present active-address properties, including explicit clears', async () => {
		await browserStorageLocalSet({ activeSigningAddress: undefined, activeSigningSafeAddress: 2n, independentActiveSimulationAddress: 1n })
		assert.deepEqual(storage.writes[0], {
			activeSigningAddress: 'missing',
			activeSigningSafeAddress: '0x0000000000000000000000000000000000000002',
			independentActiveSimulationAddress: '0x0000000000000000000000000000000000000001',
		})

		await browserStorageLocalSet({ simulationMode: true })
		assert.deepEqual(storage.writes[1], { simulationMode: true })
		assert.deepEqual(await browserStorageLocalGet(['activeSigningAddress', 'activeSigningSafeAddress', 'independentActiveSimulationAddress']), {
			activeSigningAddress: undefined,
			activeSigningSafeAddress: 2n,
			independentActiveSimulationAddress: 1n,
		})
	})

	test('distinguishes absent, explicitly cleared, and corrupt active-address properties', async () => {
		assert.deepEqual(await browserStorageLocalGet('activeSigningAddress'), {})

		await storage.seedStorage({ activeSigningAddress: 'missing' })
		assert.deepEqual(await browserStorageLocalGet('activeSigningAddress'), { activeSigningAddress: undefined })

		await storage.seedStorage({ activeSigningAddress: 'not-an-address' })
		await assert.rejects(browserStorageLocalGet('activeSigningAddress'))
	})

	test('reports pending-item validation failures without absorbing storage read failures', async () => {
		await storage.seedStorage({ pendingTransactionsAndMessages: 'corrupt' })
		const invalidResult = await browserStorageLocalGet2Result('pendingTransactionsAndMessages')
		assert.equal(invalidResult.success, false)

		storage.failReads(new Error('Storage temporarily unavailable'))
		await assert.rejects(browserStorageLocalGet2Result('pendingTransactionsAndMessages'), /Storage temporarily unavailable/)
	})
})
