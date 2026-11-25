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

const { getSettingsForConfigurationChange, getSettingsSnapshot, getWebsiteApprovalsSnapshot, requireReadableSettings } = await import('../../app/ts/background/settings.js')
const { approvalsOrNoneIfUnreadable, requireReadableApprovals } = await import('../../app/ts/background/websiteAccessPolicy.js')

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
const available = { status: 'active-network-readable', settings, rpcConfiguration: { status: 'ready', rpcEntries: [settings.activeRpcNetwork], activeRpcNetwork: settings.activeRpcNetwork } } as const
const unavailableWithApprovals = { status: 'active-network-unreadable', rpcConfiguration: { status: 'unavailable', reason: 'corrupt' }, websiteApprovals: { status: 'readable', websiteAccess: approvals } } as const
const unavailableUnreadable = { status: 'active-network-unreadable', rpcConfiguration: { status: 'unavailable', reason: 'read-failed', error: storageError }, websiteApprovals: { status: 'unreadable', error: storageError } } as const

describe('settings snapshot projections', () => {
	test('requireReadableSettings returns available settings and otherwise throws the unavailable error', () => {
		assert.equal(requireReadableSettings(available), settings)
		assert.throws(() => requireReadableSettings(unavailableWithApprovals), isRpcConfigurationUnavailableError)
		assert.throws(() => requireReadableSettings(unavailableUnreadable), isRpcConfigurationUnavailableError)
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

})

const withSilencedWarnings = async <T>(operation: () => Promise<T>) => {
	const originalWarn = console.warn
	console.warn = () => undefined
	try {
		return await operation()
	} finally {
		console.warn = originalWarn
	}
}

describe('website approvals snapshot', () => {
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

describe('RPC configuration comparison', () => {
	test('uses the installed network for comparison when the stored selection is unavailable', async () => {
		const persistedRpcNetwork = { ...settings.activeRpcNetwork, chainId: '0x1' }
		Object.assign(storageState, { activeRpcNetwork: 'corrupt', rpcEntries: [persistedRpcNetwork], simulationMode: false, websiteAccess: approvals })
		const installedNetwork = { ...settings.activeRpcNetwork, name: 'Installed network', chainId: 10n }
		try {
			const comparison = await withSilencedWarnings(async () => await getSettingsForConfigurationChange(installedNetwork))
			assert.equal(comparison.hasReadableActiveNetwork, false)
			assert.equal(comparison.settings.activeRpcNetwork.chainId, 10n)
			assert.equal(comparison.settings.simulationMode, false)
			assert.equal('websiteAccess' in comparison.settings, false)
			assert.equal((await withSilencedWarnings(getSettingsSnapshot)).status, 'active-network-unreadable')
		} finally {
			for (const key of ['activeRpcNetwork', 'rpcEntries', 'simulationMode', 'websiteAccess']) delete storageState[key]
		}
	})

	test('propagates the storage failure rather than comparing against fallback settings', async () => {
		storageReadError = storageError
		try {
			await assert.rejects(getSettingsForConfigurationChange(settings.activeRpcNetwork), (error: unknown) => error === storageError)
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

// Required readers may reject during an expected RPC outage, but generic reporting must not turn that state into an internal-error broadcast.
test('RPC configuration unavailability is classified as handled', async () => {
	const { createRpcConfigurationUnavailableError } = await import('../../app/ts/utils/rpcConfigurationError.js')
	const { classifyCaughtError, shouldSuppressUnexpectedErrorReport } = await import('../../app/ts/utils/errors.js')
	const error = createRpcConfigurationUnavailableError()
	assert.equal(isRpcConfigurationUnavailableError(error), true)
	assert.equal(classifyCaughtError(error), 'handled')
	assert.equal(shouldSuppressUnexpectedErrorReport(error), true)
})
