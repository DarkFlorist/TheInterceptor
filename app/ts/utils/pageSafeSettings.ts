import { DEFAULT_RPCS } from '../config/defaults.js'
import type { RpcNetwork } from '../types/rpc.js'
import { browserStorageLocalGet, browserStorageLocalSafeParse } from './storageUtils.js'

// Settings that page contexts, such as the popup or a content script, may use, so this module lives outside the background-only app/ts/background. Unlike settings.ts and activeNetworkStorage.ts in the background, which pages never reach, nothing here writes the active network, so a page's own copy of this module cannot change it behind the background's back.

export const getUseTabsInsteadOfPopup = async() => (await browserStorageLocalGet('useTabsInsteadOfPopup'))?.useTabsInsteadOfPopup ?? false

// The page contexts' read of the active network: a corrupt stored value is read as the default network but left for the background's getActiveRpcNetworkOrRepairFromItems in activeNetworkStorage.ts to repair, because only the background writes the active network.
export async function getActiveRpcNetworkWithoutRepair(): Promise<RpcNetwork> {
	const defaultRpcNetwork = DEFAULT_RPCS[0]
	if (defaultRpcNetwork === undefined) throw new Error('default rpc was missing')
	return browserStorageLocalSafeParse(await browser.storage.local.get('activeRpcNetwork'))?.activeRpcNetwork ?? defaultRpcNetwork
}
