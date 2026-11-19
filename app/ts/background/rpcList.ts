import type { RpcEntries, RpcNetwork } from '../types/rpc.js'
import { getRpcEntryIdentityKey } from '../utils/rpcNetworkChange.js'
import { Semaphore } from '../utils/semaphore.js'
import { modifyObject } from '../utils/typescript.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { getRpcList, rpcListStorageWriter } from './rpcListStorage.js'

// RPC list writes paired with the broadcasts open pages (useRpcConnectionsList) rely on. Read-only lookups live in rpcListStorage.ts, which has no messaging dependency.

// Writes with their broadcast, and request reads with their broadcast, run one at a time, so pages receive lists in write order and a request reply is never older than an already broadcast write.
const rpcListBroadcastSemaphore = new Semaphore(1)

const broadcastRpcListChange = async (rpcEntries: RpcEntries) => await sendPopupMessageToOpenWindows({ method: 'popup_update_rpc_list', data: rpcEntries })

export async function setRpcListAndNotifyPages(rpcEntries: RpcEntries) {
	await rpcListBroadcastSemaphore.execute(async () => {
		await rpcListStorageWriter.set(rpcEntries)
		await broadcastRpcListChange(rpcEntries)
	})
}

export async function promoteRpcAsPrimaryAndNotifyPages(rpcNetwork: RpcNetwork) {
	await rpcListBroadcastSemaphore.execute(async () => {
		const { previous, current } = await rpcListStorageWriter.update((rpcs) => {
			const selectedIndex = rpcs.findIndex((rpc) => getRpcEntryIdentityKey(rpc) === getRpcEntryIdentityKey(rpcNetwork))
			if (selectedIndex === -1) return rpcs
			return rpcs.map((rpc, index) => rpc.chainId === rpcNetwork.chainId ? modifyObject(rpc, { primary: index === selectedIndex }) : rpc)
		})
		const changed = current.some((rpc, index) => rpc.primary !== previous[index]?.primary)
		if (changed) await broadcastRpcListChange(current)
	})
}

// Answers popup_requestRpcList with a broadcast rather than a direct reply, so the requesting page reads the list through the same ordered channel as later writes. The answer is popup_requestRpcListReply, not popup_update_rpc_list, because the list did not change, and it carries the request's requestId so only the requesting page applies it.
export async function broadcastRpcListRequestReply(requestId: string) {
	await rpcListBroadcastSemaphore.execute(async () => await sendPopupMessageToOpenWindows({ method: 'popup_requestRpcListReply', data: { requestId, rpcEntries: await getRpcList() } }))
}
