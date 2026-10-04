import * as assert from 'assert'
import { beforeEach, describe, test } from 'bun:test'
import type { TabState } from '../../app/ts/types/user-interface-types.js'

const storageState: Record<string, unknown> = {}

Object.defineProperty(globalThis, 'browser', {
	configurable: true,
	writable: true,
	value: {
		storage: {
			local: {
				async get(keys?: string | readonly string[]) {
					if (keys === undefined) return { ...storageState }
					const requestedKeys = Array.isArray(keys) ? keys : [keys]
					return Object.fromEntries(requestedKeys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
				},
				async remove(keys: string | readonly string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
				},
			},
		},
	},
})

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
	beforeEach(() => {
		for (const key of Object.keys(storageState)) delete storageState[key]
	})

	test('reads exact tab state keys without parsing similarly prefixed storage', async () => {
		await setTabStateToStorage(tabState.tabId, tabState)
		storageState.tabState_12_backup = { corrupt: true }

		assert.deepEqual(await getAllTabStates(), [tabState])
	})

	test('clears exact tab state keys without deleting similarly prefixed storage', async () => {
		await setTabStateToStorage(tabState.tabId, tabState)
		storageState.tabState_12_backup = { retained: true }

		await clearTabStates()

		assert.equal('tabState_12' in storageState, false)
		assert.deepEqual(storageState.tabState_12_backup, { retained: true })
	})
})

describe('tab state startup lifecycle', () => {
	beforeEach(() => {
		for (const key of Object.keys(storageState)) delete storageState[key]
	})

	test('waits for manifest v2 cleanup before background initialization completes', async () => {
		await setTabStateToStorage(tabState.tabId, tabState)

		await initializeTabStateStorage(2)

		assert.equal('tabState_12' in storageState, false)
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
		assert.equal('tabState_12' in storageState, false)
	})
})
