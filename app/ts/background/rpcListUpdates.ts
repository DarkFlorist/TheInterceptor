import type { RpcEntries, RpcNetwork } from '../types/rpc.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { promoteRpcAsPrimary, setRpcList } from './storageVariables.js'

// Every RPC list write goes through here, because open pages take their RPC list only from popup_update_rpc_list (useRpcConnectionsList).
export async function setRpcListAndNotifyPages(rpcEntries: RpcEntries) {
	await setRpcList(rpcEntries)
	await sendPopupMessageToOpenWindows({ method: 'popup_update_rpc_list', data: rpcEntries })
}

export async function promoteRpcAsPrimaryAndNotifyPages(rpcNetwork: RpcNetwork) {
	const { changed, rpcEntries } = await promoteRpcAsPrimary(rpcNetwork)
	if (changed) await sendPopupMessageToOpenWindows({ method: 'popup_update_rpc_list', data: rpcEntries })
}
