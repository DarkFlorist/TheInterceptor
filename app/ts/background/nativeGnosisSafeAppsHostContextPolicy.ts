import { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { AddressBookEntries } from '../types/addressBookTypes.js'
import { automaticGnosisSafeAppsHostingSettingsKeys } from '../types/contentScriptSettings.js'

function websitePermissionContext(value: unknown) {
	const parsed = WebsiteAccessArray.safeParse(value)
	if (!parsed.success) return undefined
	return parsed.value.map(({ website, addressAccess, access, interceptorDisabled, declarativeNetRequestBlockMode }) => ({
		websiteOrigin: website.websiteOrigin,
		access,
		interceptorDisabled,
		declarativeNetRequestBlockMode,
		addressAccess: addressAccess?.map((entry) => ({ address: entry.address.toString(16), access: entry.access })).sort((first, second) => first.address.localeCompare(second.address)),
	})).sort((first, second) => first.websiteOrigin.localeCompare(second.websiteOrigin))
}

function safeWalletContext(value: unknown) {
	const parsed = AddressBookEntries.safeParse(value)
	if (!parsed.success) return undefined
	return parsed.value.filter((entry) => entry.type === 'safe').map((entry) => ({
		address: entry.address.toString(16),
		chainId: entry.chainId.toString(16),
		useAsActiveAddress: entry.useAsActiveAddress,
		askForAddressAccess: entry.askForAddressAccess,
		declarativeNetRequestBlockMode: entry.declarativeNetRequestBlockMode,
		safeSignerAddresses: entry.safeSignerAddresses?.map((address) => address.toString(16)).sort(),
		safeSimulationSignerAddress: entry.safeSimulationSignerAddress?.toString(16),
		safeVersion: entry.safeVersion,
	})).sort((first, second) => `${ first.chainId }:${ first.address }`.localeCompare(`${ second.chainId }:${ second.address }`))
}

// Website and address metadata are refreshed during normal requests. Only permission or Gnosis Safe wallet fields may interrupt the app's wallet context.
export function nativeGnosisSafeAppsStorageChangeAffectsContext(key: string, change: browser.storage.StorageChange) {
	const project = key === 'websiteAccess' ? websitePermissionContext : key === 'userAddressBookEntriesV3' ? safeWalletContext : undefined
	if (project === undefined) return true
	const before = project(change.oldValue)
	const after = project(change.newValue)
	// Unknown/corrupt persisted data fails closed rather than retaining a grant-derived metadata snapshot.
	return before === undefined || after === undefined || JSON.stringify(before) !== JSON.stringify(after)
}


export function getNativeGnosisSafeAppsContextChanges(changes: Record<string, browser.storage.StorageChange>, area: string) {
	if (area !== 'local') return []
	return [...automaticGnosisSafeAppsHostingSettingsKeys, 'signingAddressPreferences'].filter((key) => {
		const change = changes[key]
		return change !== undefined && nativeGnosisSafeAppsStorageChangeAffectsContext(key, change)
	})
}
