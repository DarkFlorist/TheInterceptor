import { serialize } from '../../app/ts/types/wire-types.js'
import * as assert from 'assert'
import * as fs from 'node:fs'
import { beforeEach, describe, test } from 'bun:test'
import * as ts from 'typescript'
import { ExportedSettings } from '../../app/ts/types/exportedSettingsTypes.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import { browserStorageLocalSet } from '../../app/ts/utils/storageUtils.js'

type StorageKeyInput = string | string[] | Record<string, unknown> | undefined | null

function createBrowserStorageMock() {
	const storageState: Record<string, unknown> = {}
	let signingPreferenceWriteGate: { started: () => void, waitForRelease: Promise<void> } | undefined
	let addressBookWriteGate: { started: () => void, waitForRelease: Promise<void> } | undefined
	let nextSetError: Error | undefined
	const setCalls: Record<string, unknown>[] = []

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
					setCalls.push(items)
					if (nextSetError !== undefined) {
						const error = nextSetError
						nextSetError = undefined
						throw error
					}
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
		failNextWrite(error: Error) {
			nextSetError = error
		},
		takeSetCalls() {
			return setCalls.splice(0, setCalls.length)
		},
		reset() {
			for (const key of Object.keys(storageState)) delete storageState[key]
			addressBookWriteGate = undefined
			signingPreferenceWriteGate = undefined
			nextSetError = undefined
			setCalls.splice(0, setCalls.length)
			installGlobals()
		},
	}
}

const browserMock = createBrowserStorageMock()
const settingsModulePromise = Promise.all([import('../../app/ts/background/settings.js'), import('../../app/ts/background/settingsImport.js')]).then(([settingsModule, settingsImportModule]) => ({
	...settingsModule,
	...settingsImportModule,
	readRetiredHostingOriginsStorage: async () => (await browser.storage.local.get('safeAppsHostOrigins')).safeAppsHostOrigins,
	seedRetiredHostingOriginsStorage: async (origins: readonly string[]) => await browser.storage.local.set({ safeAppsHostOrigins: origins }),
	setMetamaskCompatibilityMode: settingsModule.persistMetamaskCompatibilityMode,
}))
const signingAddressSelectionModulePromise = import('../../app/ts/background/signingAddressSelection.js')
const storageVariablesModulePromise = import('../../app/ts/background/storageVariables.js')

const settingsStorageModulePaths = {
	settings: 'app/ts/background/settings.ts',
	storageVariables: 'app/ts/background/storageVariables.ts',
	settingsImport: 'app/ts/background/settingsImport.ts',
	settingsStorageTransaction: 'app/ts/background/settingsStorageTransaction.ts',
}

const parseSourceFile = (path: string) => ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)

const forEachDescendant = (node: ts.Node, visit: (descendant: ts.Node) => void) => {
	ts.forEachChild(node, (child) => {
		visit(child)
		forEachDescendant(child, visit)
	})
}

const getStringLiterals = (node: ts.Node) => {
	const literals: string[] = []
	forEachDescendant(node, (descendant) => { if (ts.isStringLiteral(descendant) || ts.isNoSubstitutionTemplateLiteral(descendant)) literals.push(descendant.text) })
	return literals
}

const getObjectLiteralPropertyNames = (objectLiteral: ts.ObjectLiteralExpression) => objectLiteral.properties.flatMap((property) => (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? [property.name.text] : [])

const isStorageWriteFunctionName = (name: string) => name.endsWith('StorageWrite')

// An object literal passed straight to an owner's …StorageWrite function is that owner's input, whose fields may share a key's name; any other object literal naming a key builds raw storage items.
const isOwnerStorageWriteArgument = (objectLiteral: ts.ObjectLiteralExpression) => ts.isCallExpression(objectLiteral.parent) && ts.isIdentifier(objectLiteral.parent.expression) && isStorageWriteFunctionName(objectLiteral.parent.expression.text)

const getStorageItemObjectKeys = (node: ts.Node) => {
	const keys: string[] = []
	forEachDescendant(node, (descendant) => { if (ts.isObjectLiteralExpression(descendant) && !isOwnerStorageWriteArgument(descendant)) keys.push(...getObjectLiteralPropertyNames(descendant)) })
	return keys
}

// The keys a module writes through its own …StorageWrite functions, which makes it the owner of those keys.
const getKeysWrittenByStorageWriteFunctions = (sourceFile: ts.SourceFile) => {
	const keys: string[] = []
	forEachDescendant(sourceFile, (node) => {
		const isStorageWriteFunction = (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isStorageWriteFunctionName(node.name.text)) || (ts.isFunctionDeclaration(node) && node.name !== undefined && isStorageWriteFunctionName(node.name.text))
		if (!isStorageWriteFunction) return
		keys.push(...getStorageItemObjectKeys(node))
	})
	return keys
}

const readWholeStorage = async () => structuredClone(await browser.storage.local.get(null))

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
		const { exportSettingsAndAddressBook, getGnosisSafeSessionCompatibilityMode, readRetiredHostingOriginsStorage, importSettingsAndAddressBook, setGnosisSafeSessionCompatibilityMode, seedRetiredHostingOriginsStorage } = await settingsModulePromise
		await setGnosisSafeSessionCompatibilityMode(true)
		const exported = await exportSettingsAndAddressBook()
		if (exported.version !== '1.7') throw new Error('Expected current settings export version')
		const legacy = { ...exported, version: '1.6' }
		const originalJson = JSON.stringify(legacy, (_key, value: unknown) => typeof value === 'bigint' ? `0x${ value.toString(16) }` : value)
		await seedRetiredHostingOriginsStorage(['https://old-selection.example'])
		await importSettingsAndAddressBook(ExportedSettings.parse(JSON.parse(originalJson)))
		assert.equal(await getGnosisSafeSessionCompatibilityMode(), true)
		assert.deepEqual(await readRetiredHostingOriginsStorage(), ['https://old-selection.example'])
	})

	test('exports ignore retired hosting origins without reading, repairing or rewriting the raw legacy value', async () => {
		const { exportSettingsAndAddressBook } = await settingsModulePromise
		for (const stored of ['not-a-list', ['https://*.invalid.example'], ['https://valid.example'], { arbitrary: 'legacy data' }]) {
			await browser.storage.local.set({ safeAppsHostOrigins: stored })
			const exported = await exportSettingsAndAddressBook()
			assert.equal('safeAppsHostOrigins' in exported.settings, false)
			assert.deepEqual((await browser.storage.local.get('safeAppsHostOrigins')).safeAppsHostOrigins, stored)
		}
	})

	test('round-trips Gnosis Safe settings in version 1.7 exports', async () => {
		const signingSafeAddress = 0x4444444444444444444444444444444444444444n
		const signerAddress = 0x4545454545454545454545454545454545454545n
		const { changeSimulationMode, exportSettingsAndAddressBook, getGnosisSafeSessionCompatibilityMode, getSettings, getSigningAddressPreferences, importSettingsAndAddressBook, rememberSigningAddressPreference, setGnosisSafeSessionCompatibilityMode } = await settingsModulePromise
		const { updateUserAddressBookEntries, getTabState } = await storageVariablesModulePromise
		const { getSigningAddressSelectionTransition } = await signingAddressSelectionModulePromise
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Exported signing Gnosis Safe',
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
		await setGnosisSafeSessionCompatibilityMode(true)
		const { seedRetiredHostingOriginsStorage, readRetiredHostingOriginsStorage } = await settingsModulePromise
		await seedRetiredHostingOriginsStorage(['https://safe-app.example', 'https://another.example:8443'])

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
		assert.equal(await getGnosisSafeSessionCompatibilityMode(), true)
		assert.equal(await readRetiredHostingOriginsStorage(), undefined)
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

	test('publishes imported Gnosis Safe preferences only after their address book entry', async () => {
		const signingSafeAddress = 0x4646464646464646464646464646464646464646n
		const signerAddress = 0x4747474747474747474747474747474747474747n
		const { changeSimulationMode, exportSettingsAndAddressBook, getSettings, getSigningAddressPreferences, importSettingsAndAddressBook, rememberSigningAddressPreference } = await settingsModulePromise
		const { updateUserAddressBookEntries } = await storageVariablesModulePromise
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Ordered import Gnosis Safe',
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

	test('clears a pre-existing signing Gnosis Safe when importing a legacy export', async () => {
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
					name: 'Legacy signing Gnosis Safe',
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

	test('keeps experimental Gnosis Safe Apps compatibility disabled for legacy imports', async () => {
		const { getGnosisSafeSessionCompatibilityMode, readRetiredHostingOriginsStorage, importSettingsAndAddressBook, setGnosisSafeSessionCompatibilityMode, seedRetiredHostingOriginsStorage } = await settingsModulePromise
		assert.equal(await getGnosisSafeSessionCompatibilityMode(), false)
		await setGnosisSafeSessionCompatibilityMode(true)
		await seedRetiredHostingOriginsStorage(['https://legacy.example'])

		await importSettingsAndAddressBook(buildVersion14Import(false, false))

		assert.equal(await getGnosisSafeSessionCompatibilityMode(), false)
		assert.deepEqual(await readRetiredHostingOriginsStorage(), ['https://legacy.example'])
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
			name: 'Pre-import signing Gnosis Safe',
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

	test('resets a legacy version 1.4 unified address instead of inferring a signing Gnosis Safe', async () => {
		const safeAddress = 0x7777777777777777777777777777777777777777n
		const legacyExport = buildVersion14Import(false, false)
		if (legacyExport.version !== '1.4') throw new Error('Expected version 1.4 test settings')
		const signingSafeExport: ExportedSettings = {
			...legacyExport,
			settings: {
				...legacyExport.settings,
				activeSimulationAddress: safeAddress,
				simulationMode: false,
				addressBookEntries: [{ type: 'safe', name: 'Legacy Gnosis Safe', address: safeAddress, chainId: 1n, entrySource: 'User', useAsActiveAddress: true }],
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

	const preImportSigningPreference = { signerAddress: 0x9595959595959595959595959595959595959595n, selection: 'signer' as const, chainId: testRpcNetwork.chainId }

	const preImportSafeAppsHostOrigins = ['https://pre-import.example']

	const storePreImportSettings = async () => {
		const { changeSimulationMode, persistMetamaskCompatibilityMode, rememberSigningAddressPreference, setPage, setGnosisSafeSessionCompatibilityMode, seedRetiredHostingOriginsStorage, setUseTabsInsteadOfPopup, updateWebsiteAccess } = await settingsModulePromise
		const { updateUserAddressBookEntries } = await storageVariablesModulePromise
		await updateUserAddressBookEntries(() => [{ type: 'contact', name: 'Pre-import contact', address: 0x9191919191919191919191919191919191919191n, entrySource: 'User', useAsActiveAddress: true }])
		await changeSimulationMode({ simulationMode: false, rpcNetwork: testRpcNetwork, activeSimulationAddress: 0x9292929292929292929292929292929292929292n, activeSigningAddress: 0x9393939393939393939393939393939393939393n, activeSigningSafeAddress: 0x9494949494949494949494949494949494949494n })
		await rememberSigningAddressPreference(preImportSigningPreference)
		await updateWebsiteAccess(() => [{ website: { websiteOrigin: 'pre-import.example', icon: undefined, title: 'Pre-import' }, access: false }])
		await setPage({ page: 'Home' })
		await setUseTabsInsteadOfPopup(false)
		await setGnosisSafeSessionCompatibilityMode(true)
		await seedRetiredHostingOriginsStorage(preImportSafeAppsHostOrigins)
		await persistMetamaskCompatibilityMode(true)
	}

	// One export per accepted version, each with a check of the values that version imports or preserves over storePreImportSettings.
	const buildImportOfEveryVersion = async () => {
		const settings = await settingsModulePromise
		const version15SimulationAddress = 0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1n
		const version15SigningSafeAddress = 0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2n
		const version15SigningPreference = { signerAddress: 0xa3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3n, selection: 'safe' as const, safeAddress: version15SigningSafeAddress, chainId: testRpcNetwork.chainId }
		const version11Import: ExportedSettings = {
			name: 'InterceptorSettingsAndAddressBook',
			version: '1.1',
			exportedDate: '2026-05-21',
			settings: {
				activeSimulationAddress: 0xa4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4n,
				rpcNetwork: testRpcNetwork,
				useSignersAddressAsActiveAddress: false,
				websiteAccess: [],
				simulationMode: true,
				addressInfos: [],
				contacts: undefined,
				useTabsInsteadOfPopup: true,
			},
		}
		const version15Import: ExportedSettings = {
			name: 'InterceptorSettingsAndAddressBook',
			version: '1.5',
			exportedDate: '2026-05-21',
			settings: {
				activeSimulationAddress: version15SimulationAddress,
				activeSigningSafeAddress: version15SigningSafeAddress,
				signingAddressPreferences: [version15SigningPreference],
				rpcNetwork: testRpcNetwork,
				openedPage: { page: 'Settings' },
				useSignersAddressAsActiveAddress: false,
				websiteAccess: [],
				simulationMode: false,
				addressBookEntries: [{ type: 'safe', name: 'Version 1.5 signing Gnosis Safe', address: version15SigningSafeAddress, chainId: testRpcNetwork.chainId, entrySource: 'User', useAsActiveAddress: true, safeSignerAddresses: [version15SigningPreference.signerAddress] }],
				useTabsInsteadOfPopup: false,
				metamaskCompatibilityMode: false,
			},
		}
		const assertResetsSigningState = async () => {
			assert.deepEqual(await settings.getSigningAddressPreferences(), [])
			assert.equal((await settings.getSettings()).activeSigningSafeAddress, undefined)
			assert.equal(await settings.getGnosisSafeSessionCompatibilityMode(), false)
		}
		return [
			{ exportedSettings: buildVersion10Import(), assertImportedValues: async () => {
				await assertResetsSigningState()
				assert.equal((await settings.getSettings()).activeSimulationAddress, settings.defaultActiveAddresses[0]?.address)
				assert.equal(await settings.getMetamaskCompatibilityMode(), true, 'version 1.0 has no compatibility mode, so the stored one is kept')
			} },
			{ exportedSettings: version11Import, assertImportedValues: async () => {
				await assertResetsSigningState()
				assert.equal((await settings.getSettings()).activeSimulationAddress, settings.defaultActiveAddresses[0]?.address)
				assert.deepEqual((await settings.getSettings()).activeRpcNetwork, testRpcNetwork)
				assert.equal((await settings.getSettings()).simulationMode, true)
				assert.equal(await settings.getUseTabsInsteadOfPopup(), true)
				assert.equal(await settings.getMetamaskCompatibilityMode(), true, 'version 1.1 has no compatibility mode, so the stored one is kept')
			} },
			{ exportedSettings: buildVersion12Import(true, false), assertImportedValues: async () => {
				await assertResetsSigningState()
				assert.equal(await settings.getUseTabsInsteadOfPopup(), true)
				assert.equal(await settings.getMetamaskCompatibilityMode(), false)
			} },
			{ exportedSettings: buildVersion13Import(), assertImportedValues: async () => {
				await assertResetsSigningState()
				assert.deepEqual(await settings.getPage(), { page: 'Settings' })
				assert.equal(await settings.getMetamaskCompatibilityMode(), false)
			} },
			{ exportedSettings: buildVersion14Import(true, false, [{ website: { websiteOrigin: 'imported.example', icon: undefined, title: 'Imported' }, access: true }]), assertImportedValues: async () => {
				await assertResetsSigningState()
				assert.deepEqual((await settings.getWebsiteAccess()).map(({ website }) => website.websiteOrigin), ['imported.example'])
				assert.equal(await settings.getMetamaskCompatibilityMode(), false)
			} },
			{ exportedSettings: version15Import, assertImportedValues: async () => {
				const importedSettings = await settings.getSettings()
				assert.equal(importedSettings.activeSimulationAddress, version15SimulationAddress)
				assert.equal(importedSettings.activeSigningSafeAddress, version15SigningSafeAddress)
				assert.deepEqual(await settings.getSigningAddressPreferences(), [version15SigningPreference])
				assert.equal(await settings.getGnosisSafeSessionCompatibilityMode(), false, 'version 1.5 has no Gnosis Safe Apps compatibility, so it is reset')
				assert.equal(await settings.getMetamaskCompatibilityMode(), false)
				assert.deepEqual(await settings.getPage(), { page: 'Settings' })
			} },
			{ exportedSettings: { ...version15Import, version: '1.6', settings: { ...version15Import.settings, safeAppsCompatibilityMode: false } }, assertImportedValues: async () => {
				assert.deepEqual(await settings.getSigningAddressPreferences(), [version15SigningPreference])
				assert.equal(await settings.getGnosisSafeSessionCompatibilityMode(), false)
				assert.deepEqual(await settings.readRetiredHostingOriginsStorage(), preImportSafeAppsHostOrigins, 'version 1.6 has no hosting selection, so the stored one is kept')
				assert.equal(await settings.getMetamaskCompatibilityMode(), false)
			} },
			{ exportedSettings: await settings.exportSettingsAndAddressBook(), assertImportedValues: async () => {
				assert.deepEqual(await settings.getSigningAddressPreferences(), [])
				assert.equal(await settings.getGnosisSafeSessionCompatibilityMode(), false)
				assert.deepEqual(await settings.readRetiredHostingOriginsStorage(), preImportSafeAppsHostOrigins, 'A backup without retired list data preserves the existing legacy data')
				assert.equal(await settings.getMetamaskCompatibilityMode(), false)
			} },
		]
	}

	test('the per-version import fixtures cover every export version the import accepts', async () => {
		const acceptedVersions = ExportedSettings.alternatives.map((alternative) => alternative.fields.version.value)
		const fixtureVersions = (await buildImportOfEveryVersion()).map(({ exportedSettings }) => exportedSettings.version)
		assert.deepEqual([...fixtureVersions].sort(), [...acceptedVersions].sort())
	})

	test('every export version writes all of its storage changes in a single storage set', async () => {
		const { importSettingsAndAddressBook } = await settingsModulePromise
		for (const { exportedSettings, assertImportedValues } of await buildImportOfEveryVersion()) {
			browserMock.reset()
			await storePreImportSettings()
			browserMock.takeSetCalls()

			await importSettingsAndAddressBook(exportedSettings)

			assert.equal(browserMock.takeSetCalls().length, 1, `version ${ exportedSettings.version } import wrote storage more than once`)
			await assertImportedValues()
		}
	})

	test('a failed import storage write leaves storage unchanged for every export version', async () => {
		const { importSettingsAndAddressBook } = await settingsModulePromise
		for (const { exportedSettings, assertImportedValues } of await buildImportOfEveryVersion()) {
			browserMock.reset()
			await storePreImportSettings()
			const storageBeforeImport = await readWholeStorage()
			const writeFailure = new Error(`Import of version ${ exportedSettings.version } could not be stored`)
			browserMock.failNextWrite(writeFailure)

			await assert.rejects(importSettingsAndAddressBook(exportedSettings), writeFailure)

			assert.deepEqual(await readWholeStorage(), storageBeforeImport, `version ${ exportedSettings.version } import changed storage although its write failed`)
			await assert.rejects(assertImportedValues(), assert.AssertionError, `version ${ exportedSettings.version } fixture imports nothing that differs from the stored settings`)
		}
	})

	test('writers of website access, signing preferences and the address book that start during an import apply on top of the imported values', async () => {
		const importedSignerAddress = 0x9696969696969696969696969696969696969696n
		const laterSignerAddress = 0x9797979797979797979797979797979797979797n
		const laterContactAddress = 0x9898989898989898989898989898989898989898n
		const { getSigningAddressPreferences, getWebsiteAccess, importSettingsAndAddressBook, rememberSigningAddressPreference, updateWebsiteAccess } = await settingsModulePromise
		const { getUserAddressBookEntries, updateUserAddressBookEntries } = await storageVariablesModulePromise
		const currentVersionExport = (await buildImportOfEveryVersion()).at(-1)?.exportedSettings
		if (currentVersionExport?.version !== '1.7') throw new Error('Expected current settings export version')
		const exportedSettings: ExportedSettings = {
			...currentVersionExport,
			settings: {
				...currentVersionExport.settings,
				websiteAccess: [{ website: { websiteOrigin: 'imported.example', icon: undefined, title: 'Imported' }, access: true }],
				signingAddressPreferences: [{ signerAddress: importedSignerAddress, selection: 'signer', chainId: testRpcNetwork.chainId }],
				addressBookEntries: [{ type: 'contact', name: 'Imported contact', address: 0x9999999999999999999999999999999999999999n, entrySource: 'User', useAsActiveAddress: true }],
			},
		}
		const importWriteGate = browserMock.blockNextAddressBookWrite()
		const settingsImport = importSettingsAndAddressBook(exportedSettings)
		await importWriteGate.started

		const laterWebsiteAccessUpdate = updateWebsiteAccess((entries) => [...entries, { website: { websiteOrigin: 'later.example', icon: undefined, title: 'Later' }, access: false }])
		const laterPreferenceUpdate = rememberSigningAddressPreference({ signerAddress: laterSignerAddress, selection: 'signer', chainId: testRpcNetwork.chainId })
		const laterAddressBookUpdate = updateUserAddressBookEntries((entries) => [...entries, { type: 'contact', name: 'Later contact', address: laterContactAddress, entrySource: 'User', useAsActiveAddress: false }])
		importWriteGate.release()
		await Promise.all([settingsImport, laterWebsiteAccessUpdate, laterPreferenceUpdate, laterAddressBookUpdate])

		assert.deepEqual((await getWebsiteAccess()).map(({ website }) => website.websiteOrigin), ['imported.example', 'later.example'])
		assert.deepEqual((await getSigningAddressPreferences()).map(({ signerAddress }) => signerAddress), [importedSignerAddress, laterSignerAddress])
		assert.deepEqual((await getUserAddressBookEntries()).map(({ name }) => name), ['Imported contact', 'Later contact'])
	})

	test('an import queued behind an in-flight address book write replaces its stale value and later writers apply on top of the import', async () => {
		const laterSignerAddress = 0x9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9an
		const { getSigningAddressPreferences, getWebsiteAccess, importSettingsAndAddressBook, rememberSigningAddressPreference, updateWebsiteAccess } = await settingsModulePromise
		const { getUserAddressBookEntries, updateUserAddressBookEntries } = await storageVariablesModulePromise
		const version15Import = (await buildImportOfEveryVersion()).find(({ exportedSettings }) => exportedSettings.version === '1.5')
		if (version15Import === undefined) throw new Error('Expected a version 1.5 import fixture')
		const inFlightWriteGate = browserMock.blockNextAddressBookWrite()
		const inFlightAddressBookWrite = updateUserAddressBookEntries((entries) => [...entries, { type: 'contact', name: 'In-flight contact', address: 0x9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9bn, entrySource: 'User', useAsActiveAddress: false }])
		await inFlightWriteGate.started

		const settingsImport = importSettingsAndAddressBook(version15Import.exportedSettings)
		const laterWebsiteAccessUpdate = updateWebsiteAccess((entries) => [...entries, { website: { websiteOrigin: 'later.example', icon: undefined, title: 'Later' }, access: false }])
		const laterPreferenceUpdate = rememberSigningAddressPreference({ signerAddress: laterSignerAddress, selection: 'signer', chainId: testRpcNetwork.chainId })
		inFlightWriteGate.release()
		await Promise.all([inFlightAddressBookWrite, settingsImport, laterWebsiteAccessUpdate, laterPreferenceUpdate])

		assert.deepEqual((await getUserAddressBookEntries()).map(({ name }) => name), ['Version 1.5 signing Gnosis Safe'])
		assert.deepEqual((await getWebsiteAccess()).map(({ website }) => website.websiteOrigin), ['later.example'])
		assert.deepEqual((await getSigningAddressPreferences()).map(({ signerAddress }) => signerAddress), [0xa3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3n, laterSignerAddress])
	})

	test('website access, signing preference and address book writers share the one settings storage lock', async () => {
		const { getWebsiteAccess, getSigningAddressPreferences, rememberSigningAddressPreference, updateWebsiteAccess } = await settingsModulePromise
		const { updateUserAddressBookEntries } = await storageVariablesModulePromise
		const addressBookWriteGate = browserMock.blockNextAddressBookWrite()
		const addressBookWrite = updateUserAddressBookEntries((entries) => entries)
		await addressBookWriteGate.started

		const websiteAccessUpdate = updateWebsiteAccess(() => [{ website: { websiteOrigin: 'queued.example', icon: undefined, title: 'Queued' }, access: true }])
		const preferenceUpdate = rememberSigningAddressPreference(preImportSigningPreference)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.deepEqual(await getWebsiteAccess(), [], 'a website access update ran while an address book write held the lock')
		assert.deepEqual(await getSigningAddressPreferences(), [], 'a signing preference update ran while an address book write held the lock')
		addressBookWriteGate.release()
		await Promise.all([addressBookWrite, websiteAccessUpdate, preferenceUpdate])
		assert.deepEqual((await getWebsiteAccess()).map(({ website }) => website.websiteOrigin), ['queued.example'])
	})

	test('the settings storage lock is created in exactly one place', () => {
		assert.equal(fs.readFileSync(settingsStorageModulePaths.settingsStorageTransaction, 'utf8').match(/new Semaphore\(/g)?.length, 1)
		for (const path of [settingsStorageModulePaths.settings, settingsStorageModulePaths.storageVariables, settingsStorageModulePaths.settingsImport]) {
			assert.doesNotMatch(fs.readFileSync(path, 'utf8'), /(websiteAccess|signingAddressPreferences|userAddressBookEntries)\w*Semaphore/, `${ path } keeps its own lock for a settings storage writer`)
		}
	})

	const getKeysWrittenByEveryImport = async () => {
		const { importSettingsAndAddressBook } = await settingsModulePromise
		const writtenKeys = new Set<string>()
		for (const { exportedSettings } of await buildImportOfEveryVersion()) {
			browserMock.reset()
			await importSettingsAndAddressBook(exportedSettings)
			for (const items of browserMock.takeSetCalls()) for (const key of Object.keys(items)) writtenKeys.add(key)
		}
		return [...writtenKeys]
	}

	test('the settings import and the storage transaction name none of the storage keys the import writes', async () => {
		const writtenKeys = await getKeysWrittenByEveryImport()
		assert.notDeepEqual(writtenKeys, [])
		for (const path of [settingsStorageModulePaths.settingsImport, settingsStorageModulePaths.settingsStorageTransaction]) {
			const sourceFile = parseSourceFile(path)
			const namedKeys = [...getStringLiterals(sourceFile), ...getStorageItemObjectKeys(sourceFile)].filter((name) => writtenKeys.includes(name))
			assert.deepEqual(namedKeys, [], `${ path } names storage keys instead of composing their owners' writes`)
		}
	})

	test('every storage key the import writes has exactly one owner, and no other settings storage module names it', async () => {
		const writtenKeys = await getKeysWrittenByEveryImport()
		const modules = Object.values(settingsStorageModulePaths).map((path) => ({ path, sourceFile: parseSourceFile(path) }))
		for (const key of writtenKeys) {
			const owners = modules.filter(({ sourceFile }) => getKeysWrittenByStorageWriteFunctions(sourceFile).includes(key)).map(({ path }) => path)
			assert.equal(owners.length, 1, `${ key } is written by the …StorageWrite functions of ${ owners.length === 0 ? 'no module' : owners.join(' and ') }`)
			const modulesNamingKey = modules.filter(({ sourceFile }) => getStringLiterals(sourceFile).includes(key)).map(({ path }) => path)
			assert.deepEqual(modulesNamingKey.filter((path) => !owners.includes(path)), [], `${ key } is named outside its owner ${ owners.join('') }`)
		}
	})
})


test('all historical schemas normalize through their own fields and round-trip without borrowing newer capabilities', async () => {
	const { defaultActiveAddresses, defaultRpcs, exportSettingsAndAddressBook, getPage, getSettings, getGnosisSafeSessionCompatibilityMode, readRetiredHostingOriginsStorage, getMetamaskCompatibilityMode, importSettingsAndAddressBook, setPage, setMetamaskCompatibilityMode, setGnosisSafeSessionCompatibilityMode, seedRetiredHostingOriginsStorage } = await settingsModulePromise
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
	for (const { version, modern, page, compatibility } of [
		{ version: '1.0', modern: false, page: false, compatibility: false },
		{ version: '1.1', modern: false, page: false, compatibility: false },
		{ version: '1.2', modern: false, page: false, compatibility: false },
		{ version: '1.3', modern: false, page: true, compatibility: false },
		{ version: '1.4', modern: false, page: true, compatibility: false },
		{ version: '1.5', modern: true, page: true, compatibility: false },
		{ version: '1.6', modern: true, page: true, compatibility: true },
		{ version: '1.7', modern: true, page: true, compatibility: true },
	]) {
		browserMock.reset()
		await setPage({ page: 'Home' })
		await setMetamaskCompatibilityMode(true)
		await setGnosisSafeSessionCompatibilityMode(true)
		await seedRetiredHostingOriginsStorage(['https://previous.example'])
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
		assert.equal(await getGnosisSafeSessionCompatibilityMode(), compatibility)
		assert.deepEqual(await readRetiredHostingOriginsStorage(), ['https://previous.example'])
	}
})

test('new settings exports omit the retired manual-host field and still round-trip', async () => {
	browserMock.reset()
	const { exportSettingsAndAddressBook } = await settingsModulePromise
	const { CurrentExportedSettings } = await import('../../app/ts/types/exportedSettingsTypes.js')
	const exported = await exportSettingsAndAddressBook()
	assert.equal('safeAppsHostOrigins' in exported.settings, false)
	const parsed = ExportedSettings.parse(JSON.parse(JSON.stringify(serialize(CurrentExportedSettings, exported))))
	assert.equal('safeAppsHostOrigins' in parsed.settings, false)
})

test('imports discard retired hosting fields of any shape without replacing inert legacy storage', async () => {
	browserMock.reset()
	const { CurrentExportedSettings } = await import('../../app/ts/types/exportedSettingsTypes.js')
	const { exportSettingsAndAddressBook, importSettingsAndAddressBook } = await settingsModulePromise
	const exported = await exportSettingsAndAddressBook()
	if (exported.version !== '1.7') throw new Error('Expected current settings export version')
	const serialized = serialize(CurrentExportedSettings, exported)
	const existing = ['https://inert-existing.example']
	await browser.storage.local.set({ safeAppsHostOrigins: existing })
	browserMock.takeSetCalls()
	for (const legacyInput of [['https://historical.example'], 'not-a-list', { malformed: true }]) {
		const parsed = ExportedSettings.parse({ ...serialized, settings: { ...serialized.settings, safeAppsHostOrigins: legacyInput } })
		assert.equal('safeAppsHostOrigins' in parsed.settings, false)
		await importSettingsAndAddressBook(parsed)
		assert.deepEqual((await browser.storage.local.get('safeAppsHostOrigins')).safeAppsHostOrigins, existing)
		assert.equal('safeAppsHostOrigins' in (await exportSettingsAndAddressBook()).settings, false)
		assert.equal(browserMock.takeSetCalls().some((write) => 'safeAppsHostOrigins' in write), false)
	}
})
