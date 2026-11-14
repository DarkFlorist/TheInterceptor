import { DEFAULT_RPCS } from '../config/defaults.js'
import type { RpcEntries, RpcNetwork } from '../types/rpc.js'
import { getChainName } from '../utils/constants.js'
import { browserStorageLocalGet, browserStorageLocalSet } from '../utils/storageUtils.js'
import { createStoredValueRepository, reportCorruptStoredValue } from '../utils/storedValue.js'

// The stored RPC list and read-only lookups over it. This module imports no popup messaging, so code that only needs a configured RPC does not depend on the broadcast layer. Writes go through rpcListStorageWriter, which only background/rpcList.ts uses so that every write is paired with the popup_update_rpc_list broadcast open pages rely on (test/tests/rpcListModuleBoundaries.test.ts enforces this).
const rpcListRepository = createStoredValueRepository<RpcEntries>({
	read: async () => (await browserStorageLocalGet('rpcEntries')).rpcEntries,
	write: async (rpcEntries) => { await browserStorageLocalSet({ rpcEntries }) },
	getDefault: () => DEFAULT_RPCS,
	recover: reportCorruptStoredValue('Rpc entries'),
})

export const rpcListStorageWriter = { set: rpcListRepository.set, update: rpcListRepository.update }

export const getRpcList = rpcListRepository.get

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
