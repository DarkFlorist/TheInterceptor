import { DEFAULT_RPCS } from '../config/defaults.js'
import type { BlockExplorer, RpcNetwork } from '../types/rpc.js'
import { browserStorageLocalGet, browserStorageLocalSafeParse } from '../utils/storageUtils.js'

// Settings that page contexts, such as the popup or a content script, may use. Unlike settings.ts and activeNetworkStorage.ts, which pages never reach, nothing here writes the active network, so a page's own copy of this module cannot change it behind the background's back.

export const networkPriceSources = {
	uniswapV2Like: [
		{ factory: 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6fn, initCodeHash: '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f' }, // Uniswap V2
	],
	uniswapV3Like: [
		{ factory: 0x1F98431c8aD98523631AE4a59f267346ea31F984n, initCodeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54' } // Uniswap V3
	]
} as const

export const getDefaultBlockExplorer = (): BlockExplorer => ({ apiUrl: 'https://api.etherscan.io/v2/api', apiKey: 'PSW8C433Q667DVEX5BCRMGNAH9FSGFZ7Q8' })

export const getUseTabsInsteadOfPopup = async() => (await browserStorageLocalGet('useTabsInsteadOfPopup'))?.useTabsInsteadOfPopup ?? false

// The page contexts' read of the active network: a corrupt stored value is read as the default network but left for the background's getActiveRpcNetworkOrRepairFromItems in activeNetworkStorage.ts to repair, because only the background writes the active network.
export async function getActiveRpcNetworkWithoutRepair(): Promise<RpcNetwork> {
	const defaultRpcNetwork = DEFAULT_RPCS[0]
	if (defaultRpcNetwork === undefined) throw new Error('default rpc was missing')
	return browserStorageLocalSafeParse(await browser.storage.local.get('activeRpcNetwork'))?.activeRpcNetwork ?? defaultRpcNetwork
}
