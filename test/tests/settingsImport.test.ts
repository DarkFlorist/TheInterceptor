import * as assert from 'assert'
import { beforeEach, describe, test } from 'bun:test'
import type { ExportedSettings } from '../../app/ts/types/exportedSettingsTypes.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import { browserStorageLocalGet, browserStorageLocalSet } from '../../app/ts/utils/storageUtils.js'

type StorageKeyInput = string | string[] | Record<string, unknown> | undefined | null

function createBrowserStorageMock() {
	const storageState: Record<string, unknown> = {}
	let signingPreferenceWriteGate: { started: () => void, waitForRelease: Promise<void> } | undefined
	let addressBookWriteGate: { started: () => void, waitForRelease: Promise<void> } | undefined
	let websiteAccessWriteGate: { started: () => void, waitForRelease: Promise<void> } | undefined
	let writeFailure: { key: string, error: Error } | undefined
	let setCallCount = 0
	let contentScriptUpdateHook: () => Promise<void> = async () => undefined
	const contentScriptUpdateBatches: { readonly id: string, readonly excludeMatches?: readonly string[] }[][] = []

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
		scripting: {
			getRegisteredContentScripts: async () => [{ id: 'inpage' }, { id: 'inpage2' }],
			registerContentScripts: async () => undefined,
			updateContentScripts: async (scripts: { readonly id: string, readonly excludeMatches?: readonly string[] }[]) => {
				await contentScriptUpdateHook()
				contentScriptUpdateBatches.push(scripts)
			},
			unregisterContentScripts: async () => undefined,
		},
		storage: {
			local: {
				async get(keys?: StorageKeyInput) {
					return getItems(keys)
				},
				async set(items: Record<string, unknown>) {
					setCallCount += 1
					if (writeFailure !== undefined && writeFailure.key in items) {
						const { error } = writeFailure
						writeFailure = undefined
						throw error
					}
					if ('userAddressBookEntriesV3' in items && addressBookWriteGate !== undefined) {
						const gate = addressBookWriteGate
						addressBookWriteGate = undefined
						gate.started()
						await gate.waitForRelease
					}
					if ('websiteAccess' in items && websiteAccessWriteGate !== undefined) {
						const gate = websiteAccessWriteGate
						websiteAccessWriteGate = undefined
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
		getSetCallCount: () => setCallCount,
		contentScriptUpdateBatches,
		onContentScriptUpdate(hook: () => Promise<void>) {
			contentScriptUpdateHook = hook
		},
		failNextWriteOf(key: string, error: Error) {
			writeFailure = { key, error }
		},
		blockNextAddressBookWrite() {
			let markStarted: () => void = () => undefined
			let release: () => void = () => undefined
			const started = new Promise<void>((resolve) => { markStarted = resolve })
			const waitForRelease = new Promise<void>((resolve) => { release = resolve })
			addressBookWriteGate = { started: markStarted, waitForRelease }
			return { started, release }
		},
		blockNextWebsiteAccessWrite() {
			let markStarted: () => void = () => undefined
			let release: () => void = () => undefined
			const started = new Promise<void>((resolve) => { markStarted = resolve })
			const waitForRelease = new Promise<void>((resolve) => { release = resolve })
			websiteAccessWriteGate = { started: markStarted, waitForRelease }
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
			websiteAccessWriteGate = undefined
			signingPreferenceWriteGate = undefined
			writeFailure = undefined
			setCallCount = 0
			contentScriptUpdateHook = async () => undefined
			contentScriptUpdateBatches.splice(0, contentScriptUpdateBatches.length)
			installGlobals()
		},
	}
}

const browserMock = createBrowserStorageMock()
const settingsModulePromise = import('../../app/ts/background/settings.js')
const { importSettingsAndAddressBook } = await import('../../app/ts/background/settingsImport.js')
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

const previousSafeAddress = 0x9090909090909090909090909090909090909090n
const previousSignerAddress = 0x9191919191919191919191919191919191919191n
const previousSimulationAddress = 0x9292929292929292929292929292929292929292n
const previousRpcNetwork: RpcNetwork = { ...testRpcNetwork, name: 'Previous network', httpsRpc: 'https://previous.example.test/rpc' }
const previousAddressBookEntry = { type: 'safe' as const, name: 'Previous Safe', address: previousSafeAddress, chainId: 1n, entrySource: 'User' as const, useAsActiveAddress: true, safeSignerAddresses: [previousSignerAddress] }
const previousWebsiteAccess = { website: { websiteOrigin: 'previous.example', icon: undefined, title: 'Previous' }, addressAccess: [], access: true }

const importedSafeAddress = 0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0n
const importedSignerAddress = 0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1n
const importedSimulationAddress = 0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2n
const importedLegacyActiveAddress = 0xa3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3n
const importedLegacyContactAddress = 0xa4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4n
const importedWebsiteAccess: ExportedSettings['settings']['websiteAccess'] = [
	{ website: { websiteOrigin: 'imported.example', icon: 'https://imported.example/favicon.png', title: 'Imported' }, addressAccess: [], access: true, interceptorDisabled: true },
]
const sanitizedImportedWebsiteAccess = [{ website: { websiteOrigin: 'imported.example', icon: undefined, title: 'Imported' }, addressAccess: [], access: true, interceptorDisabled: true }]

const buildVersion16Import = (): ExportedSettings => ({
	name: 'InterceptorSettingsAndAddressBook',
	version: '1.6',
	exportedDate: '2026-11-04',
	settings: {
		activeSimulationAddress: importedSimulationAddress,
		activeSigningSafeAddress: importedSafeAddress,
		signingAddressPreferences: [{ signerAddress: importedSignerAddress, selection: 'safe', safeAddress: importedSafeAddress, chainId: testRpcNetwork.chainId }],
		rpcNetwork: testRpcNetwork,
		openedPage: { page: 'Settings' },
		useSignersAddressAsActiveAddress: false,
		websiteAccess: importedWebsiteAccess,
		simulationMode: false,
		addressBookEntries: [{ type: 'safe', name: 'Imported Safe', address: importedSafeAddress, chainId: testRpcNetwork.chainId, entrySource: 'User', useAsActiveAddress: true, safeSignerAddresses: [importedSignerAddress] }],
		useTabsInsteadOfPopup: false,
		metamaskCompatibilityMode: false,
		safeAppsCompatibilityMode: false,
	},
})

const buildLegacyAddressImport = (version: '1.0' | '1.3'): ExportedSettings => {
	const legacySettings = {
		activeSimulationAddress: importedLegacyActiveAddress,
		useSignersAddressAsActiveAddress: false,
		websiteAccess: importedWebsiteAccess,
		simulationMode: false,
		addressInfos: [{ name: 'Imported active address', address: importedLegacyActiveAddress, askForAddressAccess: false }],
		contacts: [{ type: 'contact' as const, name: 'Imported contact', address: importedLegacyContactAddress, entrySource: 'User' as const }],
		useTabsInsteadOfPopup: false,
	}
	if (version === '1.0') return { name: 'InterceptorSettingsAndAddressBook', version, exportedDate: '2026-11-04', settings: { ...legacySettings, activeChain: 1n } }
	return { name: 'InterceptorSettingsAndAddressBook', version, exportedDate: '2026-11-04', settings: { ...legacySettings, rpcNetwork: testRpcNetwork, openedPage: { page: 'Settings' }, metamaskCompatibilityMode: false } }
}

const importedStorageKeys = [
	'openedPageV2',
	'userAddressBookEntriesV3',
	'simulationMode',
	'activeRpcNetwork',
	'independentActiveSimulationAddress',
	'activeSigningAddress',
	'activeSigningSafeAddress',
	'signingAddressPreferences',
	'useSignersAddressAsActiveAddress',
	'websiteAccess',
	'useTabsInsteadOfPopup',
	'metamaskCompatibilityMode',
	'safeAppsCompatibilityMode',
] as const

async function storePreviousSettings() {
	const settingsModule = await settingsModulePromise
	const { updateUserAddressBookEntries } = await storageVariablesModulePromise
	await updateUserAddressBookEntries(() => [previousAddressBookEntry])
	await settingsModule.changeSimulationMode({ simulationMode: true, rpcNetwork: previousRpcNetwork, activeSimulationAddress: previousSimulationAddress, activeSigningAddress: previousSignerAddress, activeSigningSafeAddress: previousSafeAddress })
	await settingsModule.rememberSigningAddressPreference({ signerAddress: previousSignerAddress, selection: 'safe', safeAddress: previousSafeAddress, chainId: 1n })
	await settingsModule.setPage({ page: 'Home' })
	await settingsModule.setUseSignersAddressAsActiveAddress(true, previousSignerAddress)
	await settingsModule.updateWebsiteAccess(() => [previousWebsiteAccess])
	await settingsModule.setUseTabsInsteadOfPopup(true)
	await settingsModule.setMetamaskCompatibilityMode(true)
	await settingsModule.setSafeAppsCompatibilityMode(true)
}

describe('settings import', () => {
	beforeEach(() => {
		browserMock.reset()
	})

	test('resets the simulation address and restores the opened page from version 1.3 exports', async () => {
		const { defaultActiveAddresses, getPage, getSettings } = await settingsModulePromise

		await importSettingsAndAddressBook(buildVersion13Import())

		const settings = await getSettings()
		assert.equal(settings.simulationMode, false)
		assert.equal(settings.activeSimulationAddress, defaultActiveAddresses[0]?.address)
		assert.equal(settings.activeSigningSafeAddress, undefined)
		assert.deepEqual(settings.activeRpcNetwork, testRpcNetwork)
		assert.deepEqual(await getPage(), { page: 'Settings' })
	})

	test('restores the opened page from version 1.4 exports', async () => {
		const { getPage } = await settingsModulePromise

		await importSettingsAndAddressBook(buildVersion14Import(false, false))

		assert.deepEqual(await getPage(), { page: 'Settings' })
	})

	test('round-trips Safe settings in version 1.6 exports', async () => {
		const signingSafeAddress = 0x4444444444444444444444444444444444444444n
		const signerAddress = 0x4545454545454545454545454545454545454545n
		const { changeSimulationMode, exportSettingsAndAddressBook, getSafeAppsCompatibilityMode, getSettings, getSigningAddressPreferences, rememberSigningAddressPreference, setSafeAppsCompatibilityMode } = await settingsModulePromise
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

		const exportedSettings = await exportSettingsAndAddressBook()
		assert.equal(exportedSettings.version, '1.6')
		if (exportedSettings.version !== '1.6') throw new Error('Expected current settings export version')
		assert.equal(exportedSettings.settings.activeSigningSafeAddress, signingSafeAddress)
		assert.deepEqual(exportedSettings.settings.signingAddressPreferences, [{ signerAddress, selection: 'safe', safeAddress: signingSafeAddress, chainId: testRpcNetwork.chainId }])
		assert.equal(exportedSettings.settings.safeAppsCompatibilityMode, true)

		browserMock.reset()
		await importSettingsAndAddressBook(exportedSettings)
		const importedSettings = await getSettings()
		assert.equal(importedSettings.activeSigningSafeAddress, signingSafeAddress)
		assert.equal(await getSafeAppsCompatibilityMode(), true)
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
		const { changeSimulationMode, exportSettingsAndAddressBook, getSettings, getSigningAddressPreferences, rememberSigningAddressPreference } = await settingsModulePromise
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
		const { changeSimulationMode, getSettings, getSigningAddressPreferences, rememberSigningAddressPreference } = await settingsModulePromise
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
		const { getSafeAppsCompatibilityMode, setSafeAppsCompatibilityMode } = await settingsModulePromise
		assert.equal(await getSafeAppsCompatibilityMode(), false)
		await setSafeAppsCompatibilityMode(true)

		await importSettingsAndAddressBook(buildVersion14Import(false, false))

		assert.equal(await getSafeAppsCompatibilityMode(), false)
	})

	test('serializes legacy preference clearing after an in-flight preference write', async () => {
		const signingSafeAddress = 0x6868686868686868686868686868686868686868n
		const signerAddress = 0x6969696969696969696969696969696969696969n
		const { getSigningAddressPreferences, rememberSigningAddressPreference } = await settingsModulePromise
		const writeGate = browserMock.blockNextSigningPreferenceWrite()
		const preferenceWrite = rememberSigningAddressPreference({ signerAddress, selection: 'safe', safeAddress: signingSafeAddress, chainId: testRpcNetwork.chainId })
		await writeGate.started

		const legacyImport = importSettingsAndAddressBook(buildVersion14Import(false, false))
		// Give an import that ignored the signing preference lock time to write before the earlier preference lands.
		await new Promise((resolve) => setTimeout(resolve, 0))
		writeGate.release()
		await Promise.all([preferenceWrite, legacyImport])

		assert.deepEqual(await getSigningAddressPreferences(), [])
	})

	test('clears stale signing preferences when importing version 1.0', async () => {
		const signingSafeAddress = 0x7070707070707070707070707070707070707070n
		const signerAddress = 0x7171717171717171717171717171717171717171n
		const { getSettings, getSigningAddressPreferences, rememberSigningAddressPreference } = await settingsModulePromise
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
		const { defaultActiveAddresses, getSettings } = await settingsModulePromise

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
		const { getMetamaskCompatibilityMode, getUseTabsInsteadOfPopup, setMetamaskCompatibilityMode, setUseTabsInsteadOfPopup } = await settingsModulePromise
		await setUseTabsInsteadOfPopup(true)
		await setMetamaskCompatibilityMode(false)

		await importSettingsAndAddressBook(buildVersion14Import(false, true))

		assert.equal(await getUseTabsInsteadOfPopup(), false)
		assert.equal(await getMetamaskCompatibilityMode(), true)
	})

	test('does not import version 1.2 metamask mode into the tab-popup preference', async () => {
		const { getMetamaskCompatibilityMode, getUseTabsInsteadOfPopup, setMetamaskCompatibilityMode, setUseTabsInsteadOfPopup } = await settingsModulePromise
		await setUseTabsInsteadOfPopup(true)
		await setMetamaskCompatibilityMode(false)

		await importSettingsAndAddressBook(buildVersion12Import(false, true))

		assert.equal(await getUseTabsInsteadOfPopup(), false)
		assert.equal(await getMetamaskCompatibilityMode(), true)
	})

	test('sanitizes imported website access icons before persisting them', async () => {
		const { getWebsiteAccess } = await settingsModulePromise
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

	for (const { version, buildImport, failingKey } of [
		{ version: '1.6', buildImport: buildVersion16Import, failingKey: 'websiteAccess' },
		{ version: '1.3', buildImport: () => buildLegacyAddressImport('1.3'), failingKey: 'userAddressBookEntriesV3' },
		{ version: '1.0', buildImport: () => buildLegacyAddressImport('1.0'), failingKey: 'safeAppsCompatibilityMode' },
	]) {
		test(`keeps every previous setting when storing a version ${ version } import fails`, async () => {
			await storePreviousSettings()
			const storageBeforeImport = await browser.storage.local.get([...importedStorageKeys])
			const storageFailure = new Error('Storage write failed')
			browserMock.failNextWriteOf(failingKey, storageFailure)

			await assert.rejects(importSettingsAndAddressBook(buildImport()), storageFailure)

			assert.deepEqual(await browser.storage.local.get([...importedStorageKeys]), storageBeforeImport)
		})
	}

	const repairableLegacyTokenAddress = 0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0n
	const repairableStoredAddressBook = [{ type: 'ERC20', name: 'Legacy token', address: '0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0', symbol: 'LGC', decimals: '0x100', entrySource: 'User' }]
	for (const { description, storedAddressBook } of [
		{ description: 'a repairable legacy', storedAddressBook: repairableStoredAddressBook },
		{ description: 'a corrupt', storedAddressBook: 'not an address book' },
	]) {
		test(`leaves ${ description } stored address book untouched when storing a legacy import fails`, async () => {
			await browser.storage.local.set({ userAddressBookEntriesV3: storedAddressBook })
			const storageBeforeImport = structuredClone(await browser.storage.local.get())
			const storageFailure = new Error('Storage write failed')
			// The address book is written by the same commit, so failing on a key written only there also catches a repair stored by an earlier write.
			browserMock.failNextWriteOf('websiteAccess', storageFailure)

			await assert.rejects(importSettingsAndAddressBook(buildLegacyAddressImport('1.3')), storageFailure)

			assert.deepStrictEqual(await browser.storage.local.get(), storageBeforeImport)
		})
	}

	test('stores a legacy import merged with a repaired address book in one storage write', async () => {
		const { getUserAddressBookEntries } = await storageVariablesModulePromise
		await browser.storage.local.set({ userAddressBookEntriesV3: repairableStoredAddressBook })
		const setCallCountBeforeImport = browserMock.getSetCallCount()

		await importSettingsAndAddressBook(buildLegacyAddressImport('1.3'))

		assert.equal(browserMock.getSetCallCount() - setCallCountBeforeImport, 1)
		assert.deepEqual(await getUserAddressBookEntries(), [
			{ type: 'contract', name: 'Legacy token', address: repairableLegacyTokenAddress, entrySource: 'User' },
			{ name: 'Imported active address', address: importedLegacyActiveAddress, askForAddressAccess: false, type: 'contact', useAsActiveAddress: true, entrySource: 'User' },
			{ type: 'contact', name: 'Imported contact', address: importedLegacyContactAddress, entrySource: 'User' },
		])
	})

	test('merges a legacy import into an address book update that is still being written', async () => {
		const { getUserAddressBookEntries, updateUserAddressBookEntries } = await storageVariablesModulePromise
		const addressBookWriteGate = browserMock.blockNextAddressBookWrite()
		const addressBookUpdate = updateUserAddressBookEntries(() => [previousAddressBookEntry])
		await addressBookWriteGate.started

		const legacyImport = importSettingsAndAddressBook(buildLegacyAddressImport('1.3'))
		// Give an import that ignored the address book lock time to read and write the entries before the earlier update lands.
		await new Promise((resolve) => setTimeout(resolve, 0))
		addressBookWriteGate.release()
		await Promise.all([addressBookUpdate, legacyImport])

		assert.deepEqual((await getUserAddressBookEntries()).map(({ address }) => address), [previousSafeAddress, importedLegacyActiveAddress, importedLegacyContactAddress])
	})

	test('replaces website access after a website access update that is still being written', async () => {
		const { getWebsiteAccess, updateWebsiteAccess } = await settingsModulePromise
		const websiteAccessWriteGate = browserMock.blockNextWebsiteAccessWrite()
		const websiteAccessUpdate = updateWebsiteAccess(() => [previousWebsiteAccess])
		await websiteAccessWriteGate.started

		const importPromise = importSettingsAndAddressBook(buildVersion16Import())
		// Give an import that ignored the website access lock time to write before the earlier update lands.
		await new Promise((resolve) => setTimeout(resolve, 0))
		websiteAccessWriteGate.release()
		await Promise.all([websiteAccessUpdate, importPromise])

		assert.deepEqual(await getWebsiteAccess(), sanitizedImportedWebsiteAccess)
	})

	test('refreshes the content script injection with the imported disabled websites', async () => {
		await importSettingsAndAddressBook(buildVersion16Import())

		assert.deepEqual(browserMock.contentScriptUpdateBatches.map((scripts) => scripts.map(({ id, excludeMatches }) => ({ id, excludeMatches }))), [[
			{ id: 'inpage2', excludeMatches: ['http://imported.example:80/*', 'https://imported.example:443/*'] },
			{ id: 'inpage', excludeMatches: ['http://imported.example:80/*', 'https://imported.example:443/*'] },
		]])
	})

	test('refreshes the content script injection after releasing the settings storage lock', async () => {
		const { getWebsiteAccess, updateWebsiteAccess } = await settingsModulePromise
		let websiteAccessDuringRefresh: Awaited<ReturnType<typeof getWebsiteAccess>> = []
		// The import awaits this hook, so an import still holding the lock would wait on this update forever.
		browserMock.onContentScriptUpdate(async () => {
			await updateWebsiteAccess((websiteAccess) => websiteAccess)
			websiteAccessDuringRefresh = await getWebsiteAccess()
		})

		await importSettingsAndAddressBook(buildVersion16Import())

		assert.deepEqual(websiteAccessDuringRefresh, sanitizedImportedWebsiteAccess)
	})

	test('does not refresh the content script injection when storing the import fails', async () => {
		const storageFailure = new Error('Storage write failed')
		browserMock.failNextWriteOf('websiteAccess', storageFailure)

		await assert.rejects(importSettingsAndAddressBook(buildVersion16Import()), storageFailure)

		assert.deepEqual(browserMock.contentScriptUpdateBatches, [])
	})

	test('keeps the stored optional settings that a commit omits', async () => {
		const { commitImportedSettings, defaultActiveAddresses } = await settingsModulePromise
		await storePreviousSettings()

		await commitImportedSettings({
			updateAddressBookEntries: (previousEntries) => previousEntries,
			simulationMode: false,
			activeSimulationAddress: defaultActiveAddresses[0]?.address,
			activeSigningSafeAddress: undefined,
			signingAddressPreferences: [],
			useSignersAddressAsActiveAddress: false,
			websiteAccess: [],
			useTabsInsteadOfPopup: false,
			safeAppsCompatibilityMode: false,
		})

		const { openedPageV2, activeRpcNetwork, metamaskCompatibilityMode, simulationMode } = await browserStorageLocalGet([...importedStorageKeys])
		assert.deepEqual(openedPageV2, { page: 'Home' })
		assert.deepEqual(activeRpcNetwork, previousRpcNetwork)
		assert.equal(metamaskCompatibilityMode, true)
		assert.equal(simulationMode, false)
	})

	test('replaces every imported setting from a version 1.6 export', async () => {
		await storePreviousSettings()

		await importSettingsAndAddressBook(buildVersion16Import())

		assert.deepEqual(await browserStorageLocalGet([...importedStorageKeys]), {
			openedPageV2: { page: 'Settings' },
			userAddressBookEntriesV3: [{ type: 'safe', name: 'Imported Safe', address: importedSafeAddress, chainId: testRpcNetwork.chainId, entrySource: 'User', useAsActiveAddress: true, safeSignerAddresses: [importedSignerAddress] }],
			simulationMode: false,
			activeRpcNetwork: testRpcNetwork,
			independentActiveSimulationAddress: importedSimulationAddress,
			activeSigningAddress: undefined,
			activeSigningSafeAddress: importedSafeAddress,
			signingAddressPreferences: [{ signerAddress: importedSignerAddress, selection: 'safe', safeAddress: importedSafeAddress, chainId: testRpcNetwork.chainId }],
			useSignersAddressAsActiveAddress: false,
			websiteAccess: sanitizedImportedWebsiteAccess,
			useTabsInsteadOfPopup: false,
			metamaskCompatibilityMode: false,
			safeAppsCompatibilityMode: false,
		})
	})

	test('merges legacy addresses into the address book and resets signing state from a version 1.3 export', async () => {
		const { defaultActiveAddresses } = await settingsModulePromise
		await storePreviousSettings()

		await importSettingsAndAddressBook(buildLegacyAddressImport('1.3'))

		assert.deepEqual(await browserStorageLocalGet([...importedStorageKeys]), {
			openedPageV2: { page: 'Settings' },
			userAddressBookEntriesV3: [
				previousAddressBookEntry,
				{ name: 'Imported active address', address: importedLegacyActiveAddress, askForAddressAccess: false, type: 'contact', useAsActiveAddress: true, entrySource: 'User' },
				{ type: 'contact', name: 'Imported contact', address: importedLegacyContactAddress, entrySource: 'User' },
			],
			simulationMode: false,
			activeRpcNetwork: testRpcNetwork,
			independentActiveSimulationAddress: defaultActiveAddresses[0]?.address,
			activeSigningAddress: undefined,
			activeSigningSafeAddress: undefined,
			signingAddressPreferences: [],
			useSignersAddressAsActiveAddress: false,
			websiteAccess: sanitizedImportedWebsiteAccess,
			useTabsInsteadOfPopup: false,
			metamaskCompatibilityMode: false,
			safeAppsCompatibilityMode: false,
		})
	})

	test('keeps the opened page and metamask mode and uses the default network for a version 1.0 export', async () => {
		const { defaultActiveAddresses, defaultRpcs } = await settingsModulePromise
		await storePreviousSettings()

		await importSettingsAndAddressBook(buildLegacyAddressImport('1.0'))

		assert.deepEqual(await browserStorageLocalGet([...importedStorageKeys]), {
			openedPageV2: { page: 'Home' },
			userAddressBookEntriesV3: [
				previousAddressBookEntry,
				{ name: 'Imported active address', address: importedLegacyActiveAddress, askForAddressAccess: false, type: 'contact', useAsActiveAddress: true, entrySource: 'User' },
				{ type: 'contact', name: 'Imported contact', address: importedLegacyContactAddress, entrySource: 'User' },
			],
			simulationMode: false,
			activeRpcNetwork: defaultRpcs[0],
			independentActiveSimulationAddress: defaultActiveAddresses[0]?.address,
			activeSigningAddress: undefined,
			activeSigningSafeAddress: undefined,
			signingAddressPreferences: [],
			useSignersAddressAsActiveAddress: false,
			websiteAccess: sanitizedImportedWebsiteAccess,
			useTabsInsteadOfPopup: false,
			metamaskCompatibilityMode: true,
			safeAppsCompatibilityMode: false,
		})
	})
})
