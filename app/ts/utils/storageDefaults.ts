import type { Settings } from '../types/interceptor-messages.js'
import type { Page } from '../types/exportedSettingsTypes.js'
import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import type { RpcNetwork } from '../types/rpc.js'
import type { SigningAddressPreferences } from '../types/signerTypes.js'
import { type RichListElement, browserStorageLocalSafeParse, browserStorageLocalSet } from './storageUtils.js'
import { hasOwnKey } from './typescript.js'

type StartupStorageDefaults = {
	independentActiveSimulationAddress: Settings['activeSimulationAddress']
	activeSigningSafeAddress: Settings['activeSigningSafeAddress']
	openedPageV2: Page
	useSignersAddressAsActiveAddress: boolean
	websiteAccess: WebsiteAccessArray
	simulationMode: boolean
	activeRpcNetwork: RpcNetwork
	makeCurrentAddressRich: boolean
	fixedAddressRichList: readonly RichListElement[]
	signingAddressPreferences: SigningAddressPreferences
}

// Only use this after schema parsing: presence then guarantees the field's validated storage type, including explicit undefined for clearable addresses.
function hasParsedStorageKey<Key extends keyof StartupStorageDefaults>(value: Readonly<Partial<StartupStorageDefaults>>, key: Key): value is Pick<StartupStorageDefaults, Key> {
	return key in value
}

export async function getParsedStorageValueOrDefaultFromItems<Key extends keyof StartupStorageDefaults>(storedItems: Readonly<Record<string, unknown>>, key: Key, defaultValue: StartupStorageDefaults[Key]): Promise<StartupStorageDefaults[Key]> {
	const rawValue = storedItems[key]
	const storedItem = hasOwnKey(storedItems, key) ? { [key]: rawValue } : {}
	const parsedValue: Readonly<Partial<StartupStorageDefaults>> | undefined = browserStorageLocalSafeParse(storedItem)
	if (parsedValue !== undefined && hasParsedStorageKey(parsedValue, key)) return parsedValue[key]
	if (rawValue === undefined) return defaultValue
	console.warn(`${ key } was corrupt:`)
	console.warn(rawValue)
	const reset: Partial<StartupStorageDefaults> = {}
	reset[key] = defaultValue
	await browserStorageLocalSet(reset)
	return defaultValue
}

export async function getParsedStorageValueOrDefault<Key extends keyof StartupStorageDefaults>(key: Key, defaultValue: StartupStorageDefaults[Key]): Promise<StartupStorageDefaults[Key]> {
	return await getParsedStorageValueOrDefaultFromItems(await browser.storage.local.get(key), key, defaultValue)
}
