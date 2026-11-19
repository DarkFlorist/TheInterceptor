import type { Page } from '../types/exportedSettingsTypes.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { BlockTimeManipulation } from '../types/visualizer-types.js'
import { DEFAULT_ACTIVE_ADDRESSES, DEFAULT_BLOCK_MANIPULATION, DEFAULT_RPCS } from '../config/defaults.js'
import { type RichListElement, type StartupStorageValues, browserStorageLocalSafeParse, getStartupStorageValueOrDefault } from '../utils/storageUtils.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { hasOwnKey } from '../utils/typescript.js'
import { sanitizeWebsiteAccess } from '../utils/websiteIcons.js'

// Reading the settings from extension storage. Each value is read through one typed table entry that names its storage key and parses it, so every read fetches exactly the keys it parses. This module imports no other background module, so storageVariables.ts can read a settings snapshot inside its own locks.

type StoredItems = Readonly<Record<string, unknown>>

// One stored value: its storage key and its default. The key names its own storage codec (StartupStorageValues), so a read validates only that value instead of the whole storage schema.
export type StoredSetting<Key extends keyof StartupStorageValues> = {
	readonly storageKey: Key
	readonly defaultValue: StartupStorageValues[Key]
}

// The stored value, or its default when it is missing. A corrupt value is replaced by the default in storage (getStartupStorageValueOrDefault).
export async function readStoredSetting<Key extends keyof StartupStorageValues>(storedItems: StoredItems, setting: StoredSetting<Key>): Promise<StartupStorageValues[Key]> {
	return await getStartupStorageValueOrDefault(storedItems, setting.storageKey, setting.defaultValue)
}

export const readStoredSettingFromStorage = async <Key extends keyof StartupStorageValues>(setting: StoredSetting<Key>) => await readStoredSetting(await browser.storage.local.get(setting.storageKey), setting)

const defaultPage: Page = { page: 'Home' }
const defaultSimulationMode = true

export const WEBSITE_ACCESS_SETTING: StoredSetting<'websiteAccess'> = { storageKey: 'websiteAccess', defaultValue: [] }
export const MAKE_CURRENT_ADDRESS_RICH_SETTING: StoredSetting<'makeCurrentAddressRich'> = { storageKey: 'makeCurrentAddressRich', defaultValue: false }
export const FIXED_ADDRESS_RICH_LIST_SETTING: StoredSetting<'fixedAddressRichList'> = { storageKey: 'fixedAddressRichList', defaultValue: [] }

// Where a field of a settings read comes from: its storage key and how it is read from the stored items.
type StoredField<Value> = { readonly storageKey: string, readonly read: (storedItems: StoredItems) => Promise<Value> }

const fromStoredSetting = <Key extends keyof StartupStorageValues>(setting: StoredSetting<Key>, normalize: (value: StartupStorageValues[Key]) => StartupStorageValues[Key] = (value) => value): StoredField<StartupStorageValues[Key]> => ({
	storageKey: setting.storageKey,
	read: async (storedItems) => normalize(await readStoredSetting(storedItems, setting)),
})

// The storage key and parser of every Settings field. The table is typed by Settings, so a new field does not compile until it has an entry, and every settings read fetches the keys listed here.
export const SETTINGS_FIELDS: { readonly [Field in keyof Settings]: StoredField<Settings[Field]> } = {
	// A stored but missing address means no active address, so the address options keep their decoded undefined whenever their key is stored, and fall back to the default only when it is not.
	activeSimulationAddress: fromStoredSetting({ storageKey: 'independentActiveSimulationAddress', defaultValue: DEFAULT_ACTIVE_ADDRESSES[0]?.address }),
	activeSigningSafeAddress: fromStoredSetting({ storageKey: 'activeSigningSafeAddress', defaultValue: undefined }),
	openedPage: fromStoredSetting({ storageKey: 'openedPageV2', defaultValue: defaultPage }),
	useSignersAddressAsActiveAddress: fromStoredSetting({ storageKey: 'useSignersAddressAsActiveAddress', defaultValue: false }),
	websiteAccess: fromStoredSetting(WEBSITE_ACCESS_SETTING, sanitizeWebsiteAccess),
	simulationMode: fromStoredSetting({ storageKey: 'simulationMode', defaultValue: defaultSimulationMode }),
	activeRpcNetwork: fromStoredSetting({ storageKey: 'activeRpcNetwork', defaultValue: DEFAULT_RPCS[0] }),
}

const SETTINGS_STORAGE_KEYS = Object.values(SETTINGS_FIELDS).map((field) => field.storageKey)

async function getSettingsFromStoredItems(storedItems: StoredItems): Promise<Settings> {
	if (DEFAULT_RPCS[0] === undefined || DEFAULT_ACTIVE_ADDRESSES[0] === undefined) throw new Error('default rpc or default address was missing')
	const read = <Field extends keyof Settings>(field: Field) => silenceChromeUnCaughtPromise(SETTINGS_FIELDS[field].read(storedItems))
	const [activeSimulationAddress, activeSigningSafeAddress, openedPage, useSignersAddressAsActiveAddress, websiteAccess, activeRpcNetwork, simulationMode] = await Promise.all([
		read('activeSimulationAddress'),
		read('activeSigningSafeAddress'),
		read('openedPage'),
		read('useSignersAddressAsActiveAddress'),
		read('websiteAccess'),
		read('activeRpcNetwork'),
		read('simulationMode'),
	])
	return { activeSimulationAddress, activeSigningSafeAddress, openedPage, useSignersAddressAsActiveAddress, websiteAccess, activeRpcNetwork, simulationMode }
}

export async function getSettings(): Promise<Settings> {
	return await getSettingsFromStoredItems(await silenceChromeUnCaughtPromise(browser.storage.local.get(SETTINGS_STORAGE_KEYS)))
}

// An invalid stored block time manipulation is an error rather than reset to the default, as the simulation it describes cannot be reproduced without it.
export function getPreSimulationBlockTimeManipulationFromStoredItems(storedItems: StoredItems) {
	if (!hasOwnKey(storedItems, 'preSimulationBlockTimeManipulation')) return DEFAULT_BLOCK_MANIPULATION
	const { preSimulationBlockTimeManipulation } = storedItems
	const parsedItems = browserStorageLocalSafeParse({ preSimulationBlockTimeManipulation })
	if (parsedItems === undefined) throw new Error('The stored pre-simulation block time manipulation is invalid.')
	return parsedItems.preSimulationBlockTimeManipulation ?? DEFAULT_BLOCK_MANIPULATION
}

// The settings besides Settings that a simulation's input depends on.
type SimulationInputSettings = {
	readonly preSimulationBlockTimeManipulation: BlockTimeManipulation
	readonly makeCurrentAddressRich: boolean
	readonly fixedAddressRichList: readonly RichListElement[]
}

export const SIMULATION_INPUT_FIELDS: { readonly [Field in keyof SimulationInputSettings]: StoredField<SimulationInputSettings[Field]> } = {
	preSimulationBlockTimeManipulation: { storageKey: 'preSimulationBlockTimeManipulation', read: async (storedItems) => getPreSimulationBlockTimeManipulationFromStoredItems(storedItems) },
	makeCurrentAddressRich: fromStoredSetting(MAKE_CURRENT_ADDRESS_RICH_SETTING),
	fixedAddressRichList: fromStoredSetting(FIXED_ADDRESS_RICH_LIST_SETTING),
}

const SIMULATION_SETTINGS_SNAPSHOT_STORAGE_KEYS = [...SETTINGS_STORAGE_KEYS, ...Object.values(SIMULATION_INPUT_FIELDS).map((field) => field.storageKey)]

export type SimulationSettingsSnapshot = Awaited<ReturnType<typeof getSimulationSettingsSnapshot>>

// The settings, pre-simulation block time manipulation and make-me-rich settings, read in one storage call, so they form one consistent snapshot: a change saved during the read is either entirely in it or entirely after it.
export async function getSimulationSettingsSnapshot() {
	const storedItems = await silenceChromeUnCaughtPromise(browser.storage.local.get(SIMULATION_SETTINGS_SNAPSHOT_STORAGE_KEYS))
	const [settings, preSimulationBlockTimeManipulation, makeCurrentAddressRich, fixedAddressRichList] = await Promise.all([
		getSettingsFromStoredItems(storedItems),
		SIMULATION_INPUT_FIELDS.preSimulationBlockTimeManipulation.read(storedItems),
		SIMULATION_INPUT_FIELDS.makeCurrentAddressRich.read(storedItems),
		SIMULATION_INPUT_FIELDS.fixedAddressRichList.read(storedItems),
	])
	return { settings, preSimulationBlockTimeManipulation, makeCurrentAddressRich, fixedAddressRichList }
}
