import * as assert from 'assert'
import { describe, test } from 'bun:test'
import * as ts from 'typescript'
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

const { approvalsOrNoneIfUnreadable, captureRpcNetwork, getAdmittedRpcNetworkSnapshot, getSettingsSnapshot, getWebsiteApprovalsSnapshot, requireReadableSettings, requireReadableApprovals, settingsForPublication, settingsEvenIfRpcConfigurationUnusable, settingsOnAdmittedRpcNetwork } = await import('../../app/ts/background/settings.js')

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
	test('requireReadableSettings returns available settings and otherwise throws the unavailable error', () => {
		assert.equal(requireReadableSettings(available), settings)
		assert.throws(() => requireReadableSettings(unavailableWithApprovals), isRpcConfigurationUnavailableError)
		assert.throws(() => requireReadableSettings(unavailableUnreadable), isRpcConfigurationUnavailableError)
	})

	test('settingsEvenIfRpcConfigurationUnusable returns available settings and otherwise undefined', () => {
		assert.equal(settingsEvenIfRpcConfigurationUnusable(available), settings)
		assert.equal(settingsEvenIfRpcConfigurationUnusable(unavailableWithApprovals), undefined)
		assert.equal(settingsEvenIfRpcConfigurationUnusable(unavailableUnreadable), undefined)
	})

	test('approvalsOrNoneIfUnreadable keeps readable approvals and fails closed to none when they are unreadable', () => {
		assert.equal(approvalsOrNoneIfUnreadable(available), approvals)
		assert.equal(approvalsOrNoneIfUnreadable(unavailableWithApprovals), approvals)
		assert.deepEqual(approvalsOrNoneIfUnreadable(unavailableUnreadable), [])
		assert.equal(approvalsOrNoneIfUnreadable({ status: 'readable', websiteAccess: approvals }), approvals)
		assert.deepEqual(approvalsOrNoneIfUnreadable({ status: 'unreadable', error: storageError }), [])
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
			const pinned = await getAdmittedRpcNetworkSnapshot(admittedRpcNetwork)
			assert.equal(pinned.status, 'available')
			assert.equal('settings' in pinned, false)
			assert.equal(pinned.status === 'available' && 'activeRpcNetwork' in pinned.storedFields, false)
			assert.equal(settingsOnAdmittedRpcNetwork(pinned)?.activeRpcNetwork.chainId, 10n)
			assert.equal(settingsOnAdmittedRpcNetwork(pinned)?.simulationMode, false)
			// getSettingsSnapshot still reports the persisted network.
			assert.equal(requireReadableSettings(await getSettingsSnapshot()).activeRpcNetwork.chainId, 1n)
		} finally {
			for (const key of ['activeRpcNetwork', 'rpcEntries', 'simulationMode']) delete storageState[key]
		}
	})

	test('shares the storage read with getSettingsSnapshot, so both report the same failed read', async () => {
		const admittedRpcNetwork = captureRpcNetwork(settings)
		storageReadError = storageError
		try {
			assert.deepEqual(await getAdmittedRpcNetworkSnapshot(admittedRpcNetwork), { status: 'unreadable', error: storageError })
			const unpinned = await getSettingsSnapshot()
			assert.equal(unpinned.status === 'unavailable' ? unpinned.websiteApprovals.status : unpinned.status, 'unreadable')
			assert.equal(unpinned.status === 'unavailable' && unpinned.websiteApprovals.status === 'unreadable' ? unpinned.websiteApprovals.error : undefined, storageError)
		} finally {
			storageReadError = undefined
		}
	})
})

const repositoryRoot = new URL('../../', import.meta.url).pathname
const readyRpcSettingsFixturePath = `${ repositoryRoot }test/fixtures/readyRpcSettings/projections.ts`

// The fail-closed decisions take ReadyRpcSettings, so picking a weaker projection for them must fail to compile rather than fail open.
test('only the ready projection produces settings a fail-closed decision accepts', async () => {
	const configFile = ts.readConfigFile(`${ repositoryRoot }tsconfig.json`, ts.sys.readFile)
	const { options } = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repositoryRoot)
	const program = ts.createProgram([readyRpcSettingsFixturePath], { ...options, noEmit: true, rootDir: repositoryRoot })
	const fixture = program.getSourceFile(readyRpcSettingsFixturePath)
	if (fixture === undefined) throw new Error('Missing ready RPC settings fixture')
	const errorLines = ts.getPreEmitDiagnostics(program, fixture).flatMap((diagnostic) => diagnostic.start === undefined ? [] : [fixture.getLineAndCharacterOfPosition(diagnostic.start).line + 1])
	const expectedLines = (await Bun.file(readyRpcSettingsFixturePath).text()).split('\n').flatMap((line, index) => line.includes('// expect-type-error') ? [index + 1] : [])
	assert.equal(expectedLines.length, 2)
	assert.deepEqual([...new Set(errorLines)].sort((first, second) => first - second), expectedLines)
})
