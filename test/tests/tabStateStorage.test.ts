import * as assert from 'node:assert'
import { beforeEach, describe, test } from 'bun:test'
import type { TabState } from '../../app/ts/types/user-interface-types.js'
import { installBrowserMock } from '../harness/browserMock.js'

const browserMock = installBrowserMock()
const storedKeys = () => Object.keys(browserMock.readStorage())

const { clearTabStates, getAllTabStates } = await import('../../app/ts/background/storageVariables.js')
const { initializeTabStateStorage, keepTabStateCleanupAlive } = await import('../../app/ts/background/tabStateLifecycle.js')
const { setTabStateToStorage } = await import('../../app/ts/utils/storageUtils.js')

const tabState: TabState = {
	tabId: 12,
	website: undefined,
	signerConnected: false,
	signerName: 'NoSignerDetected',
	signerAccounts: [],
	signerAccountError: undefined,
	signerChain: undefined,
	tabIconDetails: {
		icon: '../img/head-not-active.png',
		iconReason: 'Not connected',
	},
	activeSigningAddress: undefined,
}

describe('tab state storage key selection', () => {
	beforeEach(async () => {
		await browserMock.browser.storage.local.clear()
	})

	test('reads exact tab state keys without parsing similarly prefixed storage', async () => {
		await setTabStateToStorage(tabState.tabId, tabState)
		await browserMock.browser.storage.local.set({ tabState_12_backup: { corrupt: true } })

		assert.deepEqual(await getAllTabStates(), [tabState])
	})

	test('clears exact tab state keys without deleting similarly prefixed storage', async () => {
		await setTabStateToStorage(tabState.tabId, tabState)
		await browserMock.browser.storage.local.set({ tabState_12_backup: { retained: true } })

		await clearTabStates()

		assert.equal(storedKeys().includes('tabState_12'), false)
		assert.deepEqual(await browserMock.browser.storage.local.get('tabState_12_backup'), { tabState_12_backup: { retained: true } })
	})
})

describe('tab state startup lifecycle', () => {
	beforeEach(async () => {
		await browserMock.browser.storage.local.clear()
	})

	test('waits for manifest v2 cleanup before background initialization completes', async () => {
		await setTabStateToStorage(tabState.tabId, tabState)

		await initializeTabStateStorage(2)

		assert.equal(storedKeys().includes('tabState_12'), false)
	})

	test('keeps manifest v3 activation alive until cleanup completes', async () => {
		await setTabStateToStorage(tabState.tabId, tabState)
		let activationLifetime: Promise<unknown> | undefined
		const activationEvent = new Event('activate')
		Object.defineProperty(activationEvent, 'waitUntil', {
			value: (promise: Promise<unknown>) => { activationLifetime = promise },
		})

		keepTabStateCleanupAlive(activationEvent)

		assert.notEqual(activationLifetime, undefined)
		await activationLifetime
		assert.equal(storedKeys().includes('tabState_12'), false)
	})
})
