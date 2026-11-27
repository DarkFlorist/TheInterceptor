import { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { AddressBookEntries } from '../types/addressBookTypes.js'
import { automaticGnosisSafeAppsHostingSettingsKeys } from '../types/contentScriptSettings.js'

function websitePermissionContext(value: unknown) {
	const parsed = WebsiteAccessArray.safeParse(value)
	if (!parsed.success) return undefined
	return parsed.value.map(({ website: { icon: _icon, title: _title, ...website }, addressAccess, ...permission }) => ({
		...permission,
		website,
		addressAccess: addressAccess?.map((entry) => ({ ...entry, address: entry.address.toString(16) })).sort((first, second) => first.address.localeCompare(second.address)),
	})).sort((first, second) => first.website.websiteOrigin.localeCompare(second.website.websiteOrigin))
}

function safeWalletContext(value: unknown) {
	const parsed = AddressBookEntries.safeParse(value)
	if (!parsed.success) return undefined
	return parsed.value.filter((entry) => entry.type === 'safe').map(({ name: _name, logoUri: _logo, abi: _abi, entrySource: _source, ...permission }) => ({
		...permission,
		address: permission.address.toString(16),
		chainId: permission.chainId.toString(16),
		safeSignerAddresses: permission.safeSignerAddresses?.map((address) => address.toString(16)).sort(),
		safeSimulationSignerAddress: permission.safeSimulationSignerAddress?.toString(16),
	})).sort((first, second) => `${ first.chainId }:${ first.address }`.localeCompare(`${ second.chainId }:${ second.address }`))
}

// Canonical comparison ignores object insertion order and supports future bigint permission fields.
function normalizeContext(value: unknown): unknown {
	if (typeof value === 'bigint') return value.toString(16)
	if (Array.isArray(value)) return value.map(normalizeContext)
	if (typeof value !== 'object' || !value) return value
	return Object.fromEntries(Object.entries(value).sort(([first], [second]) => first.localeCompare(second)).map(([key, entry]) => [key, normalizeContext(entry)]))
}

// Rest projections deliberately include every canonical permission field, including future additions. Only explicit cosmetic metadata is omitted. Website and address metadata are refreshed during normal requests. Only permission or Gnosis Safe wallet fields may interrupt the app's wallet context.
export function nativeGnosisSafeAppsStorageChangeAffectsContext(key: string, change: browser.storage.StorageChange) {
	const project = key === 'websiteAccess' ? websitePermissionContext : key === 'userAddressBookEntriesV3' ? safeWalletContext : undefined
	if (project === undefined) return JSON.stringify(change.oldValue) !== JSON.stringify(change.newValue)
	const before = project(change.oldValue)
	const after = project(change.newValue)
	// Unknown/corrupt persisted data fails closed rather than retaining a grant-derived metadata snapshot.
	return before === undefined || after === undefined || JSON.stringify(normalizeContext(before)) !== JSON.stringify(normalizeContext(after))
}


export function getNativeGnosisSafeAppsContextChanges(changes: Record<string, browser.storage.StorageChange>, area: string) {
	if (area !== 'local') return []
	return automaticGnosisSafeAppsHostingSettingsKeys.filter((key) => {
		const change = changes[key]
		return change !== undefined && nativeGnosisSafeAppsStorageChangeAffectsContext(key, change)
	})
}
