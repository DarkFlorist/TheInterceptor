import { AddressBookEntry, LegacyErc20TokenEntry, type AddressBookEntries, type ChainIdWithUniversal } from '../types/addressBookTypes.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalGet, browserStorageLocalSet, browserStorageLocalSafeParseGet } from '../utils/storageUtils.js'
import { DEFAULT_ACTIVE_ADDRESSES } from '../config/defaults.js'
import { isValidErc20Decimals } from '../utils/erc20.js'
import { getAddressBookEntriesForChainIdMorePreciseFirst } from '../utils/addressBook.js'

export function repairLegacyAddressBookEntry(rawEntry: unknown): AddressBookEntry | undefined {
	const parsedEntry = AddressBookEntry.safeParse(rawEntry)
	if (parsedEntry.success) return parsedEntry.value
	const legacyErc20Entry = LegacyErc20TokenEntry.safeParse(rawEntry)
	if (!legacyErc20Entry.success || isValidErc20Decimals(legacyErc20Entry.value.decimals)) return undefined
	const { decimals: _decimals, symbol: _symbol, type: _type, ...contractFields } = legacyErc20Entry.value
	return { ...contractFields, type: 'contract' }
}

export function repairLegacyAddressBookEntries(rawEntries: unknown): AddressBookEntries | undefined {
	if (!Array.isArray(rawEntries)) return undefined
	const repairedEntries = rawEntries.map(repairLegacyAddressBookEntry)
	if (repairedEntries.some((entry) => entry === undefined)) return undefined
	return repairedEntries.filter((entry): entry is AddressBookEntry => entry !== undefined)
}

export async function getUserAddressBookEntries(): Promise<AddressBookEntries> {
	const { userAddressBookEntriesV3: rawEntries } = await browser.storage.local.get('userAddressBookEntriesV3')
	const parsedEntries = await browserStorageLocalSafeParseGet('userAddressBookEntriesV3')
	if (parsedEntries?.userAddressBookEntriesV3 !== undefined) return parsedEntries.userAddressBookEntriesV3
	if (rawEntries === undefined) return DEFAULT_ACTIVE_ADDRESSES
	const repairedEntries = repairLegacyAddressBookEntries(rawEntries)
	if (repairedEntries !== undefined) {
		await browserStorageLocalSet({ userAddressBookEntriesV3: repairedEntries })
		return repairedEntries
	}
	console.warn('userAddressBookEntriesV3 was corrupt:')
	console.warn(rawEntries)
	await browserStorageLocalSet({ userAddressBookEntriesV3: DEFAULT_ACTIVE_ADDRESSES })
	return DEFAULT_ACTIVE_ADDRESSES
}
export const getUserAddressBookEntriesForChainId = async (chainId: ChainIdWithUniversal) => (await getUserAddressBookEntries()).filter((entry) => entry.chainId === chainId || (entry.chainId === undefined && chainId === 1n) || entry.chainId === 'AllChains')
export const getUserAddressBookEntriesForChainIdMorePreciseFirst = async (chainId: ChainIdWithUniversal) => getAddressBookEntriesForChainIdMorePreciseFirst(await getUserAddressBookEntries(), chainId)

const userAddressBookEntriesSemaphore = new Semaphore(1)
export const withAddressBookStore = <T>(operation: () => Promise<T>) => userAddressBookEntriesSemaphore.execute(operation)

/** Address-book-only writes. Callers removing addresses or introducing Safe classifications must use signingAddressBookCoordinator. */
export async function updateUserAddressBookEntries(updateFunc: (prevState: AddressBookEntries) => AddressBookEntries) {
	await userAddressBookEntriesSemaphore.execute(async () => {
		await browserStorageLocalSet({ userAddressBookEntriesV3: updateFunc(await getUserAddressBookEntries()) })
	})
}

export async function updateUserAddressBookEntriesV2Old(updateFunc: (prevState: AddressBookEntries) => AddressBookEntries) {
	await userAddressBookEntriesSemaphore.execute(async () => {
		const entries = (await browserStorageLocalGet('userAddressBookEntriesV2')).userAddressBookEntriesV2 ?? DEFAULT_ACTIVE_ADDRESSES
		return await browserStorageLocalSet({ userAddressBookEntriesV2: updateFunc(entries) })
	})
}

