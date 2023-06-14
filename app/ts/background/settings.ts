import {  MOCK_PRIVATE_KEYS_ADDRESS } from '../utils/constants.js'
import { LegacyWebsiteAccessArray, Page, Settings, WebsiteAccessArray, WebsiteAccessArrayWithLegacy } from '../utils/interceptor-messages.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalGet, browserStorageLocalSet, browserStorageLocalSetKeys, browserStorageLocalSingleGetWithDefault } from '../utils/storageUtils.js'
import { AddressInfoArray, ContactEntries } from '../utils/user-interface-types.js'
import { OptionalEthereumAddress } from '../utils/visualizer-types.js'
import { EthereumAddress, EthereumAddressOrMissing, EthereumQuantity } from '../utils/wire-types.js'
import * as funtypes from 'funtypes'

export const defaultAddresses = [
	{
		name: 'vitalik.eth',
		address: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
		askForAddressAccess: false,
	},
	{
		name: 'Public private key',
		address: MOCK_PRIVATE_KEYS_ADDRESS,
		askForAddressAccess: false,
	}
]

function parseAccessWithLegacySupport(data: unknown): WebsiteAccessArray {
	const parsed = WebsiteAccessArrayWithLegacy.parse(data)
	if (parsed.length === 0) return []
	if ('origin' in parsed[0]) {
		const legacy = LegacyWebsiteAccessArray.parse(data)
		return legacy.map((x) => ({
			access: x.access,
			addressAccess: x.addressAccess,
			website: {
				websiteOrigin: x.origin,
				icon: x.originIcon,
				title: undefined,
			},
		}))
	}
	return WebsiteAccessArray.parse(data)
}

export async function getSettings() : Promise<Settings> {
	const results = await browserStorageLocalGet([
		'activeSigningAddress',
		'activeSimulationAddress',
		'addressInfos',
		'page',
		'useSignersAddressAsActiveAddress',
		'websiteAccess',
		'activeChain',
		'simulationMode',
		'contacts',
	])
	const useSignersAddressAsActiveAddress = results.useSignersAddressAsActiveAddress !== undefined ? funtypes.Boolean.parse(results.useSignersAddressAsActiveAddress) : false
	return {
		activeSimulationAddress: results.activeSimulationAddress !== undefined ? EthereumAddressOrMissing.parse(results.activeSimulationAddress) : defaultAddresses[0].address,
		activeSigningAddress: results.activeSigningAddress === undefined ? undefined : EthereumAddressOrMissing.parse(results.activeSigningAddress),
		page: results.page !== undefined ? Page.parse(results.page) : 'Home',
		useSignersAddressAsActiveAddress: useSignersAddressAsActiveAddress,
		websiteAccess: results.websiteAccess !== undefined ? parseAccessWithLegacySupport(results.websiteAccess) : [],
		activeChain: results.activeChain !== undefined ? EthereumQuantity.parse(results.activeChain) : 1n,
		simulationMode: results.simulationMode !== undefined ? funtypes.Boolean.parse(results.simulationMode) : true,
		userAddressBook: {
			addressInfos: results.addressInfos !== undefined ? AddressInfoArray.parse(results.addressInfos): defaultAddresses,
			contacts: ContactEntries.parse(results.contacts !== undefined ? results.contacts : []),
		}
	}
}

export async function setPage(page: Page) {
	return await browserStorageLocalSet('page', page)
}

export async function setMakeMeRich(makeMeRich: boolean) {
	return await browserStorageLocalSet('makeMeRich', makeMeRich)
}
export async function getMakeMeRich() {
	return funtypes.Boolean.parse(await browserStorageLocalSingleGetWithDefault('makeMeRich', false))
}
export async function setUseSignersAddressAsActiveAddress(useSignersAddressAsActiveAddress: boolean) {
	return await browserStorageLocalSet('useSignersAddressAsActiveAddress', useSignersAddressAsActiveAddress)
}

export async function changeSimulationMode(changes: { simulationMode: boolean, activeChain?: EthereumQuantity, activeSimulationAddress?: EthereumAddress | undefined, activeSigningAddress?: EthereumAddress | undefined }) {
	return await browserStorageLocalSetKeys({
		simulationMode: changes.simulationMode,
		...changes.activeChain ? { activeChain: EthereumQuantity.serialize(changes.activeChain) as string }: {},
		...'activeSimulationAddress' in changes ? { activeSimulationAddress: EthereumAddressOrMissing.serialize(changes.activeSimulationAddress) as string }: {},
		...'activeSigningAddress' in changes ? { activeSigningAddress: EthereumAddressOrMissing.serialize(changes.activeSigningAddress) as string }: {},
	})
}

const websiteAccessSemaphore = new Semaphore(1)
export async function updateWebsiteAccess(updateFunc: (prevState: WebsiteAccessArray) => WebsiteAccessArray) {
	await websiteAccessSemaphore.execute(async () => {
		const websiteAccess = WebsiteAccessArray.parse(await browserStorageLocalSingleGetWithDefault('websiteAccess', []))
		return await browserStorageLocalSet('websiteAccess', WebsiteAccessArray.serialize(updateFunc(websiteAccess)) as string)
	})
}

const addressInfosSemaphore = new Semaphore(1)
export async function updateAddressInfos(updateFunc: (prevState: AddressInfoArray) => AddressInfoArray) {
	await addressInfosSemaphore.execute(async () => {
		const addressInfos = AddressInfoArray.parse(await browserStorageLocalSingleGetWithDefault('addressInfos', AddressInfoArray.serialize(defaultAddresses)))
		return await browserStorageLocalSet('addressInfos', AddressInfoArray.serialize(updateFunc(addressInfos)) as string)
	})
}

const contactsSemaphore = new Semaphore(1)
export async function updateContacts(updateFunc: (prevState: ContactEntries) => ContactEntries) {
	await contactsSemaphore.execute(async () => {
		const contacts = ContactEntries.parse(await browserStorageLocalSingleGetWithDefault('contacts', []))
		return await browserStorageLocalSet('contacts', ContactEntries.serialize(updateFunc(contacts)) as string)
	})
}

export async function getUseTabsInsteadOfPopup() {
	return funtypes.Boolean.parse(await browserStorageLocalSingleGetWithDefault('useTabsInsteadOfPopup', false))
}

export async function setUseTabsInsteadOfPopup(useTabsInsteadOfPopup: boolean) {
	return await browserStorageLocalSet('useTabsInsteadOfPopup', funtypes.Boolean.serialize(useTabsInsteadOfPopup) as string)
}

export type ExportedSettings = funtypes.Static<typeof ExportedSettings>
export const ExportedSettings = funtypes.ReadonlyObject({
	name: funtypes.Literal('InterceptorSettingsAndAddressBook'),
	version: funtypes.Literal('1.0'),
	exportedDate: funtypes.String,
	settings: funtypes.ReadonlyObject({
		activeSimulationAddress: OptionalEthereumAddress,
		activeSigningAddress: OptionalEthereumAddress,
		activeChain: EthereumQuantity,
		page: Page,
		useSignersAddressAsActiveAddress: funtypes.Boolean,
		websiteAccess: WebsiteAccessArray,
		simulationMode: funtypes.Boolean,
		addressInfos: AddressInfoArray,
		contacts: funtypes.Union(funtypes.Undefined, ContactEntries),
		useTabsInsteadOfPopup: funtypes.Boolean,
	})
})

export async function exportSettingsAndAddressBook() {
	const results = {
		name: 'InterceptorSettingsAndAddressBook' as const,
		version: '1.0' as const,
		exportedDate: (new Date).toISOString().split('T')[0],
		settings: await browserStorageLocalGet([
			'activeSigningAddress',
			'activeSimulationAddress',
			'addressInfos',
			'page',
			'useSignersAddressAsActiveAddress',
			'websiteAccess',
			'activeChain',
			'simulationMode',
			'contacts',
			'useTabsInsteadOfPopup',
		])
	}
	return ExportedSettings.parse(results)
}

export async function importSettingsAndAddressBook(exportedSetings: ExportedSettings) {
	await changeSimulationMode({
		simulationMode: exportedSetings.settings.simulationMode,
		activeChain: exportedSetings.settings.activeChain,
		activeSimulationAddress: exportedSetings.settings.activeSimulationAddress,
		activeSigningAddress: exportedSetings.settings.activeSigningAddress,
	})
	await setPage(exportedSetings.settings.page)
	await updateAddressInfos(() => exportedSetings.settings.addressInfos)
	await setUseSignersAddressAsActiveAddress(exportedSetings.settings.useSignersAddressAsActiveAddress)
	await updateWebsiteAccess(() => exportedSetings.settings.websiteAccess)
	await updateContacts(() => exportedSetings.settings.contacts === undefined ? [] : exportedSetings.settings.contacts)
	await setUseTabsInsteadOfPopup(exportedSetings.settings.useTabsInsteadOfPopup)
}
