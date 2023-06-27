type StorageKey = 'activeSigningAddress'
	| 'activeSimulationAddress'
	| 'addressInfos'
	| 'page'
	| 'useSignersAddressAsActiveAddress'
	| 'websiteAccess'
	| 'activeChain'
	| 'simulationMode'
	| 'pendingInterceptorAccessRequests'
	| 'contacts'
	| 'makeMeRich'
	| 'addressbookTabId'
	| 'transactionsPendingForUserConfirmation'
	| 'ChainChangeConfirmationPromise'
	| 'PersonalSignPromise'
	| 'InterceptorAccessRequestPromise'
	| 'simulationResults'
	| 'signerName'
	| 'currentTabId'
	| `tabState_${ number }`
	| 'isConnectedToNode'
	| 'ethereumSubscriptions'
	| 'useTabsInsteadOfPopup'
	| 'RPCEntries'

export async function browserStorageLocalGet(keys: StorageKey | StorageKey[]) {
	return await browser.storage.local.get(keys) as Promise<Partial<Record<StorageKey, JSONEncodeable>>>
}

type JSONEncodeable = string | number | boolean | { [x: string]: JSONEncodeable } | ReadonlyArray<JSONEncodeable>

export async function browserStorageLocalSet(key: StorageKey, value: JSONEncodeable) {
	return await browser.storage.local.set({ [key]: value })
}
export async function browserStorageLocalSetKeys(items: Partial<Record<StorageKey, JSONEncodeable>>) {
	return await browser.storage.local.set({ ...items })
}

export async function browserStorageLocalSingleGetWithDefault(key: StorageKey, valueIfMissing: unknown) {
	const value = await browser.storage.local.get(key) as Partial<Record<StorageKey, unknown>>
	if (value[key] === undefined) return valueIfMissing
	return value[key]
}
