import type { EthereumJsonRpcRequest } from '../../types/JsonRpc-types.js'
import { bytes32String } from '../../utils/bigint.js'
import type { IEthereumJSONRpcRequestHandler } from './EthereumJSONRpcRequestHandler.js'

type PinnedBlock = { readonly number: bigint, readonly hash: bigint }

/**
 * Points a state read that names the latest block, the pinned block's number or no block at the pinned block's hash instead (EIP-1898; go-ethereum and anvil take a hash wherever they take a block, eth_simulateV1 included). A reorganisation that replaces the block at that height then cannot change what the read sees: the node answers from the pinned block or fails.
 * eth_getLogs and eth_getBlockByNumber name heights only, so a client pinned to a block confirms with isPinnedBlockCanonical that the height still holds it.
 */
export const pinRequestToBlockHash = (request: EthereumJsonRpcRequest, block: PinnedBlock): EthereumJsonRpcRequest => {
	const isPinnedTag = (tag: unknown) => tag === undefined || tag === 'latest' || tag === block.number
	switch (request.method) {
		case 'eth_call': {
			const [transaction, tag] = request.params
			return isPinnedTag(tag) ? { ...request, params: [transaction, block.hash] } : request
		}
		case 'eth_getCode': return isPinnedTag(request.params[1]) ? { ...request, params: [request.params[0], block.hash] } : request
		case 'eth_getBalance': return isPinnedTag(request.params[1]) ? { ...request, params: [request.params[0], block.hash] } : request
		case 'eth_getTransactionCount': return isPinnedTag(request.params[1]) ? { ...request, params: [request.params[0], block.hash] } : request
		case 'eth_getStorageAt': return isPinnedTag(request.params[2]) ? { ...request, params: [request.params[0], request.params[1], block.hash] } : request
		case 'eth_simulateV1': {
			const [query, tag] = request.params
			return isPinnedTag(tag) ? { ...request, params: [query, bytes32String(block.hash)] } : request
		}
		default: return request
	}
}

export const createBlockPinnedRequestHandler = (requestHandler: IEthereumJSONRpcRequestHandler, block: PinnedBlock): IEthereumJSONRpcRequestHandler => ({
	rpcUrl: requestHandler.rpcUrl,
	clearCache: requestHandler.clearCache,
	getChainId: requestHandler.getChainId,
	jsonRpcRequest: async (request, requestAbortController) => await requestHandler.jsonRpcRequest(pinRequestToBlockHash(request, block), requestAbortController),
})
