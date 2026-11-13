import { DEFAULT_RPCS } from '../config/defaults.js'
import type { RpcNetwork } from '../types/rpc.js'
import { browserStorageLocalGet, browserStorageLocalSafeParse } from './storageUtils.js'
import { hasOwnKey } from './typescript.js'

// Settings that page contexts, such as the popup or a content script, may use, so this module lives outside the background-only app/ts/background. Unlike settings.ts and activeNetworkStorage.ts in the background, which pages never reach, nothing here writes the active network, so a page's own copy of this module cannot change it behind the background's back.

export const getUseTabsInsteadOfPopup = async() => (await browserStorageLocalGet('useTabsInsteadOfPopup'))?.useTabsInsteadOfPopup ?? false

// The one read of the stored active network, shared by the background and the page contexts. A missing or corrupt stored value reads as the default network. No read writes: the background repairs a corrupt value once at startup through repairCorruptActiveNetwork in activeNetworkStorage.ts, its only writer of the network.
export function getActiveRpcNetworkFromItems(storedItems: Readonly<Record<string, unknown>>): RpcNetwork {
	const defaultRpcNetwork = DEFAULT_RPCS[0]
	if (defaultRpcNetwork === undefined) throw new Error('default rpc was missing')
	return parseStoredActiveRpcNetwork(storedItems) ?? defaultRpcNetwork
}

// The stored active network, or undefined if none is stored or the stored value is corrupt.
export function parseStoredActiveRpcNetwork(storedItems: Readonly<Record<string, unknown>>) {
	const { activeRpcNetwork } = storedItems
	return browserStorageLocalSafeParse(hasOwnKey(storedItems, 'activeRpcNetwork') ? { activeRpcNetwork } : {})?.activeRpcNetwork
}

export const getActiveRpcNetwork = async (): Promise<RpcNetwork> => getActiveRpcNetworkFromItems(await browser.storage.local.get(['activeRpcNetwork']))
