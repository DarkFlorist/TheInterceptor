import * as assert from 'assert'
import { beforeEach, describe, test } from 'bun:test'
import { ExportedSettings } from '../../app/ts/types/exportedSettingsTypes.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import { browserStorageLocalSet } from '../../app/ts/utils/storageUtils.js'
import { withSilencedConsole } from './consoleSilence.js'

type StorageKeyInput = string | string[] | Record<string, unknown> | undefined | null

function createBrowserStorageMock() {
	const storageState: Record<string, unknown> = {}
	let signingPreferenceWriteGate: { started: () => void, waitForRelease: Promise<void> } | undefined
	let addressBookWriteGate: { started: () => void, waitForRelease: Promise<void> } | undefined

	const getItems = (keys?: StorageKeyInput) => {
		if (keys === undefined || keys === null) return { ...storageState }
		if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
		if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
		return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
	}

	const removeItems = (keys: string | string[]) => {
		for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
	}

	const browserMock = {
		runtime: {
			lastError: undefined,
			async sendMessage() {
				return undefined
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get(keys?: StorageKeyInput) {
					return getItems(keys)
				},
				async set(items: Record<string, unknown>) {
					if ('userAddressBookEntriesV3' in items && addressBookWriteGate !== undefined) {
						const gate = addressBookWriteGate
						addressBookWriteGate = undefined
						gate.started()
						await gate.waitForRelease
					}
					if ('signingAddressPreferences' in items && signingPreferenceWriteGate !== undefined) {
						const gate = signingPreferenceWriteGate
						signingPreferenceWriteGate = undefined
						gate.started()
						await gate.waitForRelease
					}
					Object.assign(storageState, items)
				},
				async remove(keys: string | string[]) {
					removeItems(keys)
				},
			},
		},
	}

	const installGlobals = () => {
		Object.defineProperty(globalThis, 'browser', { value: browserMock, configurable: true, writable: true })
		Object.defineProperty(globalThis, 'chrome', { value: { runtime: { id: 'test-extension' } }, configurable: true, writable: true })
	}

	installGlobals()

	return {
		blockNextAddressBookWrite() {
			let markStarted: () => void = () => undefined
			let release: () => void = () => undefined
			const started = new Promise<void>((resolve) => { markStarted = resolve })
			const waitForRelease = new Promise<void>((resolve) => { release = resolve })
			addressBookWriteGate = { started: markStarted, waitForRelease }
			return { started, release }
		},
		blockNextSigningPreferenceWrite() {
			let markStarted: () => void = () => undefined
			let release: () => void = () => undefined
			const started = new Promise<void>((resolve) => { markStarted = resolve })
			const waitForRelease = new Promise<void>((resolve) => { release = resolve })
			signingPreferenceWriteGate = { started: markStarted, waitForRelease }
			return { started, release }
		},
		reset() {
			for (const key of Object.keys(storageState)) delete storageState[key]
			addressBookWriteGate = undefined
			signingPreferenceWriteGate = undefined
			installGlobals()
		},
	}
}

const browserMock = createBrowserStorageMock()
const settingsModulePromise = import('../../app/ts/background/settings.js')
const signingAddressSelectionModulePromise = import('../../app/ts/background/signingAddressSelection.js')
const storageVariablesModulePromise = import('../../app/ts/background/storageVariables.js')

const testRpcNetwork: RpcNetwork = {
	name: 'Test Mainnet',
	chainId: 1n,
	httpsRpc: 'https://example.test/rpc',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
}

const buildVersion10Import = (): ExportedSettings => ({
	name: 'InterceptorSettingsAndAddressBook',
	version: '1.0',
	exportedDate: '2026-05-21',
	settings: {
		activeSimulationAddress: 0x1010101010101010101010101010101010101010n,
		activeChain: 1n,
		useSignersAddressAsActiveAddress: false,
		websiteAccess: [],
		simulationMode: false,
		addressInfos: [],
		contacts: undefined,
		useTabsInsteadOfPopup: false,
	},
})

const buildVersion12Import = (useTabsInsteadOfPopup: boolean, metamaskCompatibilityMode: boolean): ExportedSettings => ({
	name: 'InterceptorSettingsAndAddressBook',
	version: '1.2',
	exportedDate: '2026-05-21',
	settings: {
		activeSimulationAddress: 0x1111111111111111111111111111111111111111n,
		rpcNetwork: testRpcNetwork,
		useSignersAddressAsActiveAddress: false,
		websiteAccess: [],
		simulationMode: true,
		addressInfos: [],
		contacts: undefined,
		useTabsInsteadOfPopup,
		metamaskCompatibilityMode,
	},
})

const buildVersion13Import = (): ExportedSettings => ({
	name: 'InterceptorSettingsAndAddressBook',
	version: '1.3',
	exportedDate: '2026-05-21',
	settings: {
		activeSimulationAddress: 0x3333333333333333333333333333333333333333n,
		rpcNetwork: testRpcNetwork,
		openedPage: { page: 'Settings' },
		useSignersAddressAsActiveAddress: false,
		websiteAccess: [],
		simulationMode: false,
		addressInfos: [],
		contacts: undefined,
		useTabsInsteadOfPopup: false,
		metamaskCompatibilityMode: false,
	},
})

const buildVersion14Import = (useTabsInsteadOfPopup: boolean, metamaskCompatibilityMode: boolean, websiteAccess: ExportedSettings['settings']['websiteAccess'] = []): ExportedSettings => ({
	name: 'InterceptorSettingsAndAddressBook',
	version: '1.4',
	exportedDate: '2026-05-21',
	settings: {
		activeSimulationAddress: 0x2222222222222222222222222222222222222222n,
		rpcNetwork: testRpcNetwork,
		openedPage: { page: 'Settings' },
		useSignersAddressAsActiveAddress: false,
		websiteAccess,
		simulationMode: true,
		addressBookEntries: [],
		useTabsInsteadOfPopup,
		metamaskCompatibilityMode,
	},
})

describe('settings import', () => {
	beforeEach(() => {
		browserMock.reset()
	})

	test('resets the simulation address and restores the opened page from version 1.3 exports', async () => {
		const { defaultActiveAddresses, getPage, getSettings, importSettingsAndAddressBook } = await settingsModulePromise

		await importSettingsAndAddressBook(buildVersion13Import())

		const settings = await getSettings()
		assert.equal(settings.simulationMode, false)
		assert.equal(settings.activeSimulationAddress, defaultActiveAddresses[0]?.address)
		assert.equal(settings.activeSigningSafeAddress, undefined)
		assert.deepEqual(settings.activeRpcNetwork, testRpcNetwork)
		assert.deepEqual(await getPage(), { page: 'Settings' })
	})

	test('restores the opened page from version 1.4 exports', async () => {
		const { getPage, importSettingsAndAddressBook } = await settingsModulePromise

		await importSettingsAndAddressBook(buildVersion14Import(false, false))

		assert.deepEqual(await getPage(), { page: 'Settings' })
	})

	test('imports an original version 1.6 JSON export without hosting origins', async () => {
		const { exportSettingsAndAddressBook, getSafeAppsCompatibilityMode, getSafeAppsHostOrigins, importSettingsAndAddressBook, setSafeAppsCompatibilityMode, setSafeAppsHostOrigins } = await settingsModulePromise
		await setSafeAppsCompatibilityMode(true)
		const exported = await exportSettingsAndAddressBook()
		if (exported.version !== '1.7') throw new Error('Expected current settings export version')
		const { safeAppsHostOrigins: _hostingOrigins, ...legacySettings } = exported.settings
		const legacy = { ...exported, version: '1.6', settings: legacySettings }
		const originalJson = JSON.stringify(legacy, (_key, value: unknown) => typeof value === 'bigint' ? `0x${ value.toString(16) }` : value)
		await setSafeAppsHostOrigins(['https://old-selection.example'])
		await importSettingsAndAddressBook(ExportedSettings.parse(JSON.parse(originalJson)))
		assert.equal(await getSafeAppsCompatibilityMode(), true)
		assert.deepEqual(await getSafeAppsHostOrigins(), ['https://old-selection.example'])
		assert.equal(ExportedSettings.safeParse({ ...legacy, version: '1.7' }).success, false)
	})

	test('repairs malformed stored hosting origins before settings and export read them', async () => {
		const { exportSettingsAndAddressBook, getEnabledSafeAppsHostOrigins, getSafeAppsHostOrigins, setSafeAppsCompatibilityMode } = await settingsModulePromise
		await setSafeAppsCompatibilityMode(true)
		for (const invalidOrigins of [['https://*.invalid.example'], ['https://duplicate.example', 'https://duplicate.example'], Array.from({ length: 33 }, (_, index) => `https://site-${ index }.example`)]) {
			await browser.storage.local.set({ safeAppsHostOrigins: invalidOrigins })
			await withSilencedConsole(async () => {
				assert.deepEqual(await getSafeAppsHostOrigins(), [])
				assert.deepEqual(await getEnabledSafeAppsHostOrigins(), [])
				const exported = await exportSettingsAndAddressBook()
				assert.equal(exported.version, '1.7')
				assert.deepEqual(exported.settings.safeAppsHostOrigins, [])
			})
			assert.deepEqual((await browser.storage.local.get('safeAppsHostOrigins')).safeAppsHostOrigins, [])
		}
	})

	test('round-trips Safe settings in version 1.7 exports', async () => {
		const signingSafeAddress = 0x4444444444444444444444444444444444444444n
		const signerAddress = 0x4545454545454545454545454545454545454545n
		const { changeSimulationMode, exportSettingsAndAddressBook, getSafeAppsCompatibilityMode, getSettings, getSigningAddressPreferences, importSettingsAndAddressBook, rememberSigningAddressPreference, setSafeAppsCompatibilityMode } = await settingsModulePromise
		const { updateUserAddressBookEntries, getTabState } = await storageVariablesModulePromise
		const { getSigningAddressSelectionTransition } = await signingAddressSelectionModulePromise
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Exported signing Safe',
			address: signingSafeAddress,
			chainId: testRpcNetwork.chainId,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [signerAddress],
		}])
		await changeSimulationMode({
			simulationMode: false,
			activeSimulationAddress: 0x5555555555555555555555555555555555555555n,
			activeSigningSafeAddress: signingSafeAddress,
		})
		await rememberSigningAddressPreference({ signerAddress, selection: 'safe', safeAddress: signingSafeAddress, chainId: testRpcNetwork.chainId })
		await setSafeAppsCompatibilityMode(true)
		const { setSafeAppsHostOrigins, getSafeAppsHostOrigins } = await settingsModulePromise
		await setSafeAppsHostOrigins(['https://safe-app.example', 'https://another.example:8443'])

		const exportedSettings = await exportSettingsAndAddressBook()
		assert.equal(exportedSettings.version, '1.7')
		if (exportedSettings.version !== '1.7') throw new Error('Expected current settings export version')
		assert.equal(exportedSettings.settings.activeSigningSafeAddress, signingSafeAddress)
		assert.deepEqual(exportedSettings.settings.signingAddressPreferences, [{ signerAddress, selection: 'safe', safeAddress: signingSafeAddress, chainId: testRpcNetwork.chainId }])
		assert.equal(exportedSettings.settings.safeAppsCompatibilityMode, true)

		browserMock.reset()
		await importSettingsAndAddressBook(ExportedSettings.parse(JSON.parse(JSON.stringify(ExportedSettings.serialize(exportedSettings)))))
		const importedSettings = await getSettings()
		assert.equal(importedSettings.activeSigningSafeAddress, signingSafeAddress)
		assert.equal(await getSafeAppsCompatibilityMode(), true)
		assert.deepEqual(await getSafeAppsHostOrigins(), ['https://safe-app.example', 'https://another.example:8443'])
		assert.deepEqual(await getSigningAddressPreferences(), exportedSettings.settings.signingAddressPreferences)
		const previousTabState = await getTabState(1)
		const transition = await getSigningAddressSelectionTransition(importedSettings, previousTabState, {
			...previousTabState,
			signerAccounts: [signerAddress],
			activeSigningAddress: signerAddress,
		})
		assert.equal(transition.shouldActivate, false)
		assert.equal((await getSettings()).activeSigningSafeAddress, signingSafeAddress)
	})

	test('publishes imported Safe preferences only after their address book entry', async () => {
		const signingSafeAddress = 0x4646464646464646464646464646464646464646n
		const signerAddress = 0x4747474747474747474747474747474747474747n
		const { changeSimulationMode, exportSettingsAndAddressBook, getSettings, getSigningAddressPreferences, importSettingsAndAddressBook, rememberSigningAddressPreference } = await settingsModulePromise
		const { updateUserAddressBookEntries } = await storageVariablesModulePromise
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Ordered import Safe',
			address: signingSafeAddress,
			chainId: testRpcNetwork.chainId,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [signerAddress],
		}])
		await changeSimulationMode({ simulationMode: false, activeSigningSafeAddress: signingSafeAddress })
		await rememberSigningAddressPreference({ signerAddress, selection: 'safe', safeAddress: signingSafeAddress, chainId: testRpcNetwork.chainId })
		const exportedSettings = await exportSettingsAndAddressBook()

		browserMock.reset()
		const addressBookWriteGate = browserMock.blockNextAddressBookWrite()
		const importPromise = importSettingsAndAddressBook(exportedSettings)
		await addressBookWriteGate.started

		assert.equal((await getSettings()).activeSigningSafeAddress, undefined)
		assert.deepEqual(await getSigningAddressPreferences(), [])
		addressBookWriteGate.release()
		await importPromise
		assert.equal((await getSettings()).activeSigningSafeAddress, signingSafeAddress)
		assert.deepEqual(await getSigningAddressPreferences(), [{ signerAddress, selection: 'safe', safeAddress: signingSafeAddress, chainId: testRpcNetwork.chainId }])
	})

	test('clears a pre-existing signing Safe when importing a legacy export', async () => {
		const signingSafeAddress = 0x6666666666666666666666666666666666666666n
		const signerAddress = 0x6767676767676767676767676767676767676767n
		const { changeSimulationMode, getSettings, getSigningAddressPreferences, importSettingsAndAddressBook, rememberSigningAddressPreference } = await settingsModulePromise
		const { getTabState } = await storageVariablesModulePromise
		const { getSigningAddressSelectionTransition } = await signingAddressSelectionModulePromise
		await changeSimulationMode({
			simulationMode: false,
			activeSigningSafeAddress: signingSafeAddress,
		})
		await rememberSigningAddressPreference({ signerAddress, selection: 'safe', safeAddress: signingSafeAddress, chainId: testRpcNetwork.chainId })
		const baseLegacyExport = buildVersion14Import(false, false)
		if (baseLegacyExport.version !== '1.4') throw new Error('Expected legacy settings export')
		const legacyExport: ExportedSettings = {
			...baseLegacyExport,
			settings: {
				...baseLegacyExport.settings,
				simulationMode: false,
				addressBookEntries: [{
					type: 'safe',
					name: 'Legacy signing Safe',
					address: signingSafeAddress,
					chainId: testRpcNetwork.chainId,
					entrySource: 'User',
					useAsActiveAddress: true,
					safeSignerAddresses: [signerAddress],
				}],
			},
		}

		await importSettingsAndAddressBook(legacyExport)

		const importedSettings = await getSettings()
		assert.equal(importedSettings.activeSigningSafeAddress, undefined)
		assert.deepEqual(await getSigningAddressPreferences(), [])
		const previousTabState = await getTabState(1)
		const transition = await getSigningAddressSelectionTransition(importedSettings, previousTabState, {
			...previousTabState,
			signerAccounts: [signerAddress],
			activeSigningAddress: signerAddress,
		})
		assert.equal(transition.shouldActivate, true)
		assert.deepEqual(transition.selection, { type: 'signer', address: signerAddress })
	})

	test('keeps experimental Safe Apps compatibility disabled for legacy imports', async () => {
		const { getSafeAppsCompatibilityMode, getSafeAppsHostOrigins, importSettingsAndAddressBook, setSafeAppsCompatibilityMode, setSafeAppsHostOrigins } = await settingsModulePromise
		assert.equal(await getSafeAppsCompatibilityMode(), false)
		await setSafeAppsCompatibilityMode(true)
		await setSafeAppsHostOrigins(['https://legacy.example'])

		await importSettingsAndAddressBook(buildVersion14Import(false, false))

		assert.equal(await getSafeAppsCompatibilityMode(), false)
		assert.deepEqual(await getSafeAppsHostOrigins(), ['https://legacy.example'])
	})

	test('serializes legacy preference clearing after an in-flight preference write', async () => {
		const signingSafeAddress = 0x6868686868686868686868686868686868686868n
		const signerAddress = 0x6969696969696969696969696969696969696969n
		const { getSigningAddressPreferences, importSettingsAndAddressBook, rememberSigningAddressPreference } = await settingsModulePromise
		const writeGate = browserMock.blockNextSigningPreferenceWrite()
		const preferenceWrite = rememberSigningAddressPreference({ signerAddress, selection: 'safe', safeAddress: signingSafeAddress, chainId: testRpcNetwork.chainId })
		await writeGate.started

		const legacyImport = importSettingsAndAddressBook(buildVersion14Import(false, false))
		writeGate.release()
		await Promise.all([preferenceWrite, legacyImport])

		assert.deepEqual(await getSigningAddressPreferences(), [])
	})

	test('clears stale signing preferences when importing version 1.0', async () => {
		const signingSafeAddress = 0x7070707070707070707070707070707070707070n
		const signerAddress = 0x7171717171717171717171717171717171717171n
		const { getSettings, getSigningAddressPreferences, importSettingsAndAddressBook, rememberSigningAddressPreference } = await settingsModulePromise
		const { getTabState, updateUserAddressBookEntries } = await storageVariablesModulePromise
		const { getSigningAddressSelectionTransition } = await signingAddressSelectionModulePromise
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Pre-import signing Safe',
			address: signingSafeAddress,
			chainId: testRpcNetwork.chainId,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [signerAddress],
		}])
		await rememberSigningAddressPreference({ signerAddress, selection: 'safe', safeAddress: signingSafeAddress, chainId: testRpcNetwork.chainId })

		await importSettingsAndAddressBook(buildVersion10Import())

		const importedSettings = await getSettings()
		assert.equal(importedSettings.activeSigningSafeAddress, undefined)
		assert.deepEqual(await getSigningAddressPreferences(), [])
		const previousTabState = await getTabState(1)
		const transition = await getSigningAddressSelectionTransition(importedSettings, previousTabState, {
			...previousTabState,
			signerAccounts: [signerAddress],
			activeSigningAddress: signerAddress,
		})
		assert.equal(transition.shouldActivate, true)
		assert.deepEqual(transition.selection, { type: 'signer', address: signerAddress })
	})

	test('resets a legacy version 1.4 unified address instead of inferring a signing Safe', async () => {
		const safeAddress = 0x7777777777777777777777777777777777777777n
		const legacyExport = buildVersion14Import(false, false)
		if (legacyExport.version !== '1.4') throw new Error('Expected version 1.4 test settings')
		const signingSafeExport: ExportedSettings = {
			...legacyExport,
			settings: {
				...legacyExport.settings,
				activeSimulationAddress: safeAddress,
				simulationMode: false,
				addressBookEntries: [{ type: 'safe', name: 'Legacy Safe', address: safeAddress, chainId: 1n, entrySource: 'User', useAsActiveAddress: true }],
			},
		}
		const { defaultActiveAddresses, getSettings, importSettingsAndAddressBook } = await settingsModulePromise

		await importSettingsAndAddressBook(signingSafeExport)

		const settings = await getSettings()
		assert.equal(settings.activeSimulationAddress, defaultActiveAddresses[0]?.address)
		assert.equal(settings.activeSigningSafeAddress, undefined)
	})

	test('ignores the legacy shared address and defaults independent simulation state without storage migration', async () => {
		const safeAddress = 0x8888888888888888888888888888888888888888n
		await browser.storage.local.set({
			activeSimulationAddress: safeAddress,
			simulationMode: false,
			useSignersAddressAsActiveAddress: false,
		})
		const { defaultActiveAddresses, getSettings } = await settingsModulePromise
		const storageBeforeRead = await browser.storage.local.get()
		const firstSettings = await getSettings()
		const secondSettings = await getSettings()

		assert.equal(firstSettings.activeSimulationAddress, defaultActiveAddresses[0]?.address)
		assert.equal(secondSettings.activeSimulationAddress, defaultActiveAddresses[0]?.address)
		assert.equal(firstSettings.activeSigningSafeAddress, undefined)
		assert.deepEqual(await browser.storage.local.get(), storageBeforeRead)
	})

	test('reads an explicitly stored independent simulation address without a schema marker', async () => {
		const activeSimulationAddress = 0x7777777777777777777777777777777777777777n
		await browserStorageLocalSet({ independentActiveSimulationAddress: activeSimulationAddress })
		const { getSettings } = await settingsModulePromise

		const firstSettings = await getSettings()
		const secondSettings = await getSettings()

		assert.equal(firstSettings.activeSimulationAddress, activeSimulationAddress)
		assert.equal(secondSettings.activeSimulationAddress, activeSimulationAddress)
	})

	test('restores metamask compatibility mode from version 1.4 exports', async () => {
		const { getMetamaskCompatibilityMode, getUseTabsInsteadOfPopup, importSettingsAndAddressBook, setMetamaskCompatibilityMode, setUseTabsInsteadOfPopup } = await settingsModulePromise
		await setUseTabsInsteadOfPopup(true)
		await setMetamaskCompatibilityMode(false)

		await importSettingsAndAddressBook(buildVersion14Import(false, true))

		assert.equal(await getUseTabsInsteadOfPopup(), false)
		assert.equal(await getMetamaskCompatibilityMode(), true)
	})

	test('does not import version 1.2 metamask mode into the tab-popup preference', async () => {
		const { getMetamaskCompatibilityMode, getUseTabsInsteadOfPopup, importSettingsAndAddressBook, setMetamaskCompatibilityMode, setUseTabsInsteadOfPopup } = await settingsModulePromise
		await setUseTabsInsteadOfPopup(true)
		await setMetamaskCompatibilityMode(false)

		await importSettingsAndAddressBook(buildVersion12Import(false, true))

		assert.equal(await getUseTabsInsteadOfPopup(), false)
		assert.equal(await getMetamaskCompatibilityMode(), true)
	})

	test('sanitizes imported website access icons before persisting them', async () => {
		const { getWebsiteAccess, importSettingsAndAddressBook } = await settingsModulePromise
		await importSettingsAndAddressBook(buildVersion14Import(false, false, [
			{ website: { websiteOrigin: 'remote.example', icon: 'https://remote.example/favicon.png', title: 'Remote' }, access: true },
			{ website: { websiteOrigin: 'cached.example', icon: 'data:image/png;base64,Y2FjaGVk', title: 'Cached' }, access: true },
		]))

		const storedWebsiteAccess = (await browser.storage.local.get('websiteAccess')).websiteAccess
		assert.equal(Array.isArray(storedWebsiteAccess), true)
		if (!Array.isArray(storedWebsiteAccess)) throw new Error('Expected imported websiteAccess to be stored as an array')
		assert.equal(storedWebsiteAccess[0]?.website.icon, undefined)
		assert.equal(storedWebsiteAccess[1]?.website.icon, 'data:image/png;base64,Y2FjaGVk')

		const websiteAccess = await getWebsiteAccess()
		assert.equal(websiteAccess[0]?.website.icon, undefined)
		assert.equal(websiteAccess[1]?.website.icon, 'data:image/png;base64,Y2FjaGVk')
	})
})


test('all historical schemas normalize through their own fields and round-trip without borrowing newer capabilities', async () => {
	const { defaultActiveAddresses, defaultRpcs, exportSettingsAndAddressBook, getPage, getSettings, getSafeAppsCompatibilityMode, getSafeAppsHostOrigins, getMetamaskCompatibilityMode, importSettingsAndAddressBook, setPage, setMetamaskCompatibilityMode, setSafeAppsCompatibilityMode, setSafeAppsHostOrigins } = await settingsModulePromise
	browserMock.reset()
	const exported = await exportSettingsAndAddressBook()
	const serialized: unknown = ExportedSettings.serialize(exported)
	if (typeof serialized !== 'object' || serialized === null || !('settings' in serialized) || typeof serialized.settings !== 'object' || serialized.settings === null) throw new Error('Missing serialized settings')
	const source = {
		...serialized.settings,
		activeChain: '0x1',
		addressInfos: [],
		contacts: [],
		activeSimulationAddress: '0x1111111111111111111111111111111111111111',
		activeSigningSafeAddress: '0x2222222222222222222222222222222222222222',
		rpcNetwork: { ...testRpcNetwork, chainId: '0x1' },
		openedPage: { page: 'Settings' },
		metamaskCompatibilityMode: false,
		safeAppsCompatibilityMode: true,
		safeAppsHostOrigins: ['https://selected.example'],
	}
	for (const { version, modern, page, compatibility, hosting } of [
		{ version: '1.0', modern: false, page: false, compatibility: false, hosting: false },
		{ version: '1.1', modern: false, page: false, compatibility: false, hosting: false },
		{ version: '1.2', modern: false, page: false, compatibility: false, hosting: false },
		{ version: '1.3', modern: false, page: true, compatibility: false, hosting: false },
		{ version: '1.4', modern: false, page: true, compatibility: false, hosting: false },
		{ version: '1.5', modern: true, page: true, compatibility: false, hosting: false },
		{ version: '1.6', modern: true, page: true, compatibility: true, hosting: false },
		{ version: '1.7', modern: true, page: true, compatibility: true, hosting: true },
	]) {
		browserMock.reset()
		await setPage({ page: 'Home' })
		await setMetamaskCompatibilityMode(true)
		await setSafeAppsCompatibilityMode(true)
		await setSafeAppsHostOrigins(['https://previous.example'])
		// Historical codecs discard fields belonging to newer versions before capability-based normalization.
		const parsed = ExportedSettings.parse({ name: exported.name, version, exportedDate: exported.exportedDate, settings: source })
		assert.deepEqual(ExportedSettings.parse(ExportedSettings.serialize(parsed)), parsed)
		await importSettingsAndAddressBook(parsed)
		const settings = await getSettings()
		assert.equal(settings.activeSimulationAddress, modern ? 0x1111111111111111111111111111111111111111n : defaultActiveAddresses[0]?.address)
		assert.equal(settings.activeSigningSafeAddress, modern ? 0x2222222222222222222222222222222222222222n : undefined)
		assert.deepEqual(settings.activeRpcNetwork, version === '1.0' ? defaultRpcs[0] : testRpcNetwork)
		assert.deepEqual(await getPage(), { page: page ? 'Settings' : 'Home' })
		assert.equal(await getMetamaskCompatibilityMode(), version === '1.0' || version === '1.1')
		assert.equal(await getSafeAppsCompatibilityMode(), compatibility)
		assert.deepEqual(await getSafeAppsHostOrigins(), hosting ? ['https://selected.example'] : ['https://previous.example'])
	}
})
