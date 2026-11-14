import { DEFAULT_RPCS } from '../config/defaults.js'
import type { RpcEntries, RpcNetwork } from '../types/rpc.js'
import { getChainName } from '../utils/constants.js'
import { getRpcEntryIdentityKey } from '../utils/rpcNetworkChange.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalGet, browserStorageLocalSet } from '../utils/storageUtils.js'
import { createStoredValueRepository, reportCorruptStoredValue } from '../utils/storedValue.js'
import { modifyObject } from '../utils/typescript.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'

// This module owns the stored RPC list. Its raw writers stay private so every write is paired with the popup_update_rpc_list broadcast that open pages (useRpcConnectionsList) rely on.
const rpcListRepository = createStoredValueRepository<RpcEntries>({
	read: async () => (await browserStorageLocalGet('rpcEntries')).rpcEntries,
	write: async (rpcEntries) => { await browserStorageLocalSet({ rpcEntries }) },
	getDefault: () => DEFAULT_RPCS,
	recover: reportCorruptStoredValue('Rpc entries'),
})

// Writes with their broadcast, and request reads with their broadcast, run one at a time, so pages receive lists in write order and a request reply is never older than an already broadcast write.
const rpcListBroadcastSemaphore = new Semaphore(1)

const broadcastRpcListChange = async (rpcEntries: RpcEntries) => await sendPopupMessageToOpenWindows({ method: 'popup_update_rpc_list', data: rpcEntries })

export const getRpcList = rpcListRepository.get

export async function setRpcListAndNotifyPages(rpcEntries: RpcEntries) {
	await rpcListBroadcastSemaphore.execute(async () => {
		await rpcListRepository.set(rpcEntries)
		await broadcastRpcListChange(rpcEntries)
	})
}

export async function promoteRpcAsPrimaryAndNotifyPages(rpcNetwork: RpcNetwork) {
	await rpcListBroadcastSemaphore.execute(async () => {
		const { previous, current } = await rpcListRepository.update((rpcs) => {
			const selectedIndex = rpcs.findIndex((rpc) => getRpcEntryIdentityKey(rpc) === getRpcEntryIdentityKey(rpcNetwork))
			if (selectedIndex === -1) return rpcs
			return rpcs.map((rpc, index) => rpc.chainId === rpcNetwork.chainId ? modifyObject(rpc, { primary: index === selectedIndex }) : rpc)
		})
		const changed = current.some((rpc, index) => rpc.primary !== previous[index]?.primary)
		if (changed) await broadcastRpcListChange(current)
	})
}

// Answers popup_requestRpcList with a broadcast rather than a direct reply, so the requesting page reads the list through the same ordered channel as later writes. The answer is popup_requestRpcListReply, not popup_update_rpc_list: the list did not change, so change listeners such as Home's live data must not refetch.
export async function broadcastCurrentRpcList() {
	await rpcListBroadcastSemaphore.execute(async () => await sendPopupMessageToOpenWindows({ method: 'popup_requestRpcListReply', data: await getRpcList() }))
}

export const getPrimaryRpcForChain = async (chainId: bigint) => {
	const rpcs = await getRpcList()
	const primary = rpcs.find((rpc) => rpc.chainId === chainId && rpc.primary)
	if (primary) return primary

	// no primary was found, try to find what ever we have for that chain id
	const nonPrimary = rpcs.find((rpc) => rpc.chainId === chainId)
	if (nonPrimary) return nonPrimary
	return undefined
}

export const getRpcNetworkForChain = async (chainId: bigint): Promise<RpcNetwork> => {
	const rpc = await getPrimaryRpcForChain(chainId)
	if (rpc !== undefined) return rpc
	return {
		chainId: chainId,
		currencyName: 'Ether?',
		currencyTicker: 'ETH?',
		name: getChainName(chainId),
		httpsRpc: undefined,
		primary: false,
		minimized: true,
	}
}
