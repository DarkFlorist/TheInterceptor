import { RpcNetwork } from '../types/rpc.js'

export type RpcNetworkChange = {
	readonly chainChanged: boolean
	readonly endpointChanged: boolean
	readonly selectionChanged: boolean
}

export const getRpcNetworkSelectionKey = (network: RpcNetwork) => JSON.stringify(RpcNetwork.serialize(network))

// List preferences can change independently of the active selection; they do not identify a different RPC entry.
export const getRpcEntryIdentityKey = (network: RpcNetwork) => getRpcNetworkSelectionKey(network.httpsRpc === undefined ? network : { ...network, primary: false, minimized: false })

// Chain changes require wallet approval; endpoint changes replace services; metadata changes only update the selection.
export function getRpcNetworkChange(previous: RpcNetwork | undefined, next: RpcNetwork): RpcNetworkChange {
	const chainChanged = previous?.chainId !== next.chainId
	return {
		chainChanged,
		endpointChanged: chainChanged || previous?.httpsRpc !== next.httpsRpc,
		selectionChanged: previous === undefined || getRpcNetworkSelectionKey(previous) !== getRpcNetworkSelectionKey(next),
	}
}
