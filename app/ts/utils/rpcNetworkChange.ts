import { RpcNetwork } from '../types/rpc.js'

export type RpcNetworkChange = {
	readonly chainChanged: boolean
	readonly endpointChanged: boolean
	readonly selectionChanged: boolean
}

// Chain changes require wallet approval; endpoint changes replace services; metadata changes only update the selection.
export function getRpcNetworkChange(previous: RpcNetwork | undefined, next: RpcNetwork): RpcNetworkChange {
	const chainChanged = previous?.chainId !== next.chainId
	return {
		chainChanged,
		endpointChanged: chainChanged || previous?.httpsRpc !== next.httpsRpc,
		selectionChanged: previous === undefined || JSON.stringify(RpcNetwork.serialize(previous)) !== JSON.stringify(RpcNetwork.serialize(next)),
	}
}
