import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { Settings } from '../../app/ts/types/interceptor-messages.js'
import type { WebsiteAccessArray } from '../../app/ts/types/websiteAccessTypes.js'
import { isRpcConfigurationUnavailableError } from '../../app/ts/utils/rpcConfigurationError.js'

const storageState: Record<string, unknown> = {}
const storageWrites: Record<string, unknown>[] = []
let storageReadError: Error | undefined

Object.defineProperty(globalThis, 'browser', {
	configurable: true,
	writable: true,
	value: {
		storage: {
			local: {
				async get(keys: string | readonly string[]) {
					if (storageReadError !== undefined) throw storageReadError
					const requestedKeys = Array.isArray(keys) ? keys : [keys]
					return Object.fromEntries(Object.entries(storageState).filter(([key]) => requestedKeys.includes(key)))
				},
				async set(items: Record<string, unknown>) {
					storageWrites.push(items)
					Object.assign(storageState, items)
				},
			},
		},
	},
})

const { approvalsOrNone, captureRpcNetwork, getSettingsSnapshot, getWebsiteApprovalsSnapshot, requireAvailableSettings, requireReadableApprovals, settingsForPublication, settingsIfAvailable, settingsOnAdmittedRpcNetwork } = await import('../../app/ts/background/settings.js')

const approvals: WebsiteAccessArray = [{ website: { websiteOrigin: 'approved.example', icon: undefined, title: undefined }, access: true }]
const settings: Settings = {
	activeSimulationAddress: 0x1111111111111111111111111111111111111111n,
	activeSigningSafeAddress: undefined,
	activeRpcNetwork: { name: 'Ethereum Mainnet', chainId: 1n, httpsRpc: 'https://ethereum.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true },
	openedPage: { page: 'Home' },
	useSignersAddressAsActiveAddress: false,
	websiteAccess: approvals,
	simulationMode: true,
}
const storageError = new Error('Storage unavailable')
const available = { status: 'available', settings, rpcConfiguration: { status: 'ready', rpcEntries: [settings.activeRpcNetwork], activeRpcNetwork: settings.activeRpcNetwork } } as const
const unavailableWithApprovals = { status: 'unavailable', rpcConfiguration: { status: 'unavailable', reason: 'corrupt' }, websiteApprovals: { status: 'readable', websiteAccess: approvals } } as const
const unavailableUnreadable = { status: 'unavailable', rpcConfiguration: { status: 'unavailable', reason: 'read-failed', error: storageError }, websiteApprovals: { status: 'unreadable', error: storageError } } as const

describe('settings snapshot projections', () => {
	test('requireAvailableSettings returns available settings and otherwise throws the unavailable error', () => {
		assert.equal(requireAvailableSettings(available), settings)
		assert.throws(() => requireAvailableSettings(unavailableWithApprovals), isRpcConfigurationUnavailableError)
		assert.throws(() => requireAvailableSettings(unavailableUnreadable), isRpcConfigurationUnavailableError)
	})

	test('settingsIfAvailable returns available settings and otherwise undefined', () => {
		assert.equal(settingsIfAvailable(available), settings)
		assert.equal(settingsIfAvailable(unavailableWithApprovals), undefined)
		assert.equal(settingsIfAvailable(unavailableUnreadable), undefined)
	})

	test('approvalsOrNone keeps readable approvals and fails closed to none when they are unreadable', () => {
		assert.equal(approvalsOrNone(available), approvals)
		assert.equal(approvalsOrNone(unavailableWithApprovals), approvals)
		assert.deepEqual(approvalsOrNone(unavailableUnreadable), [])
		assert.equal(approvalsOrNone({ status: 'readable', websiteAccess: approvals }), approvals)
		assert.deepEqual(approvalsOrNone({ status: 'unreadable', error: storageError }), [])
	})

	test('requireReadableApprovals returns readable approvals and rethrows the storage error', () => {
		assert.equal(requireReadableApprovals({ status: 'readable', websiteAccess: approvals }), approvals)
		assert.throws(() => requireReadableApprovals({ status: 'unreadable', error: storageError }), (error: unknown) => error === storageError)
	})

	const { activeRpcNetwork: _persistedRpcNetwork, ...storedFields } = settings
	const admittedRpcNetwork = captureRpcNetwork({ ...settings, activeRpcNetwork: { ...settings.activeRpcNetwork, name: 'Admitted network', chainId: 10n } })
	const admittedAvailable = { status: 'available', storedFields, admittedRpcNetwork } as const
	const admittedUnreadable = { status: 'unreadable', error: storageError } as const

	test('settingsOnAdmittedRpcNetwork combines the stored fields with the admitted network and otherwise returns undefined', () => {
		assert.deepEqual(settingsOnAdmittedRpcNetwork(admittedAvailable), { ...settings, activeRpcNetwork: admittedRpcNetwork.activeRpcNetwork })
		assert.equal(settingsOnAdmittedRpcNetwork(admittedUnreadable), undefined)
	})

	test('settingsForPublication publishes the settings on the admitted network and otherwise the fallback without approvals', () => {
		const fallback = { ...settings, simulationMode: false }
		assert.deepEqual(settingsForPublication(admittedAvailable, fallback), { ...settings, activeRpcNetwork: admittedRpcNetwork.activeRpcNetwork })
		assert.deepEqual(settingsForPublication(admittedUnreadable, fallback), { ...fallback, websiteAccess: [] })
	})
})

describe('website approvals snapshot', () => {
	const withSilencedWarnings = async <T>(operation: () => Promise<T>) => {
		const originalWarn = console.warn
		console.warn = () => undefined
		try {
			return await operation()
		} finally {
			console.warn = originalWarn
		}
	}

	for (const repairCorrupt of [true, false]) test(`reports a failed read as unreadable (repairCorrupt=${ repairCorrupt })`, async () => {
		storageReadError = storageError
		try {
			assert.deepEqual(await getWebsiteApprovalsSnapshot({ repairCorrupt }), { status: 'unreadable', error: storageError })
		} finally {
			storageReadError = undefined
		}
	})

	for (const repairCorrupt of [true, false]) test(`reads a corrupt value as no approvals and ${ repairCorrupt ? 'repairs' : 'does not write' } it`, async () => {
		storageState.websiteAccess = 'corrupt'
		storageWrites.splice(0, storageWrites.length)
		assert.deepEqual(await withSilencedWarnings(async () => await getWebsiteApprovalsSnapshot({ repairCorrupt })), { status: 'readable', websiteAccess: [] })
		assert.deepEqual(storageWrites, repairCorrupt ? [{ websiteAccess: [] }] : [])
		delete storageState.websiteAccess
	})
})

describe('admitted RPC network snapshot', () => {
	test('carries the admitted network beside the persisted fields instead of inside a Settings value', async () => {
		const persistedRpcNetwork = { ...settings.activeRpcNetwork, chainId: '0x1' }
		Object.assign(storageState, { activeRpcNetwork: persistedRpcNetwork, rpcEntries: [persistedRpcNetwork], simulationMode: false })
		const admittedRpcNetwork = captureRpcNetwork({ ...settings, activeRpcNetwork: { ...settings.activeRpcNetwork, name: 'Admitted network', chainId: 10n } })
		try {
			const pinned = await getSettingsSnapshot({ pinnedRpcNetwork: admittedRpcNetwork })
			assert.equal(pinned.status, 'available')
			assert.equal('settings' in pinned, false)
			assert.equal(pinned.status === 'available' && 'activeRpcNetwork' in pinned.storedFields, false)
			assert.equal(settingsOnAdmittedRpcNetwork(pinned)?.activeRpcNetwork.chainId, 10n)
			assert.equal(settingsOnAdmittedRpcNetwork(pinned)?.simulationMode, false)
			// The unpinned read still reports the persisted network.
			assert.equal(requireAvailableSettings(await getSettingsSnapshot()).activeRpcNetwork.chainId, 1n)
		} finally {
			for (const key of ['activeRpcNetwork', 'rpcEntries', 'simulationMode']) delete storageState[key]
		}
	})
})
