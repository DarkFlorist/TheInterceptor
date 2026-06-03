import type { AddressBookEntries } from '../types/addressBookTypes.js'
import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { getActiveAddressEntry } from './metadataUtils.js'
import { getSettings } from './settings.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { searchWebsiteAccess } from './websiteAccessSearch.js'

export async function getAddressMetadataForAccess(websiteAccess: WebsiteAccessArray): Promise<AddressBookEntries> {
	const addresses = websiteAccess.flatMap((x) => (x.addressAccess === undefined ? [] : x.addressAccess.map((addr) => addr.address)))
	const addressSet = new Set(addresses)
	return await Promise.all(Array.from(addressSet).map((x) => getActiveAddressEntry(x)))
}

export async function buildWebsiteAccessPopupDataFromWebsiteAccess(websiteAccess: WebsiteAccessArray, query: string) {
	const filteredWebsiteAccess = searchWebsiteAccess(query, websiteAccess)
	const addressAccessMetadata = await getAddressMetadataForAccess(filteredWebsiteAccess)
	return { websiteAccess: filteredWebsiteAccess, addressAccessMetadata }
}

export async function buildWebsiteAccessPopupData(query: string) {
	const settings = await getSettings()
	return await buildWebsiteAccessPopupDataFromWebsiteAccess(settings.websiteAccess, query)
}

export async function sendWebsiteAccessChangedFromWebsiteAccess(websiteAccess: WebsiteAccessArray) {
	await sendPopupMessageToOpenWindows({
		method: 'popup_websiteAccess_changed',
		data: await buildWebsiteAccessPopupDataFromWebsiteAccess(websiteAccess, ''),
	})
}
