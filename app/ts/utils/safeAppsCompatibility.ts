import type { RpcNetwork } from '../types/rpc.js'

export type SafeAppsChainInfo = {
	readonly chainId: string
	readonly name: string
	readonly currencyName: string
	readonly currencyTicker: string
	readonly currencyLogoUri?: string
	readonly blockExplorerApiUrl?: string
}

export function getSafeAppsChainInfo(rpcNetwork: RpcNetwork): SafeAppsChainInfo {
	return {
		chainId: rpcNetwork.chainId.toString(),
		name: rpcNetwork.name,
		currencyName: rpcNetwork.currencyName,
		currencyTicker: rpcNetwork.currencyTicker,
		...('currencyLogoUri' in rpcNetwork && rpcNetwork.currencyLogoUri !== undefined ? { currencyLogoUri: rpcNetwork.currencyLogoUri } : {}),
		...(!('blockExplorer' in rpcNetwork) || rpcNetwork.blockExplorer === undefined ? {} : { blockExplorerApiUrl: rpcNetwork.blockExplorer.apiUrl }),
	}
}
