import type { SlowRpcRequest } from '../simulation/services/EthereumJSONRpcRequestHandler.js'
import type { RpcEntry } from '../types/rpc.js'
import type { RpcConnectionStatus } from '../types/user-interface-types.js'
import type { EthereumBlockHeader } from '../types/wire-types.js'
import { Semaphore } from '../utils/semaphore.js'

export type DefinedRpcConnectionStatus = Exclude<RpcConnectionStatus, undefined>
export type RpcConnectionStatusChangeMethod = 'popup_new_block_arrived' | 'popup_failed_to_get_block' | 'popup_rpc_connection_status_changed'
export type PublishRpcConnectionStatus = (method: RpcConnectionStatusChangeMethod, rpcConnectionStatus: DefinedRpcConnectionStatus) => Promise<void>

export type RpcStatusEthereumClient = {
	getRpcEntry: () => RpcEntry
	getCachedBlock: () => EthereumBlockHeader | undefined
	isBlockPolling: () => boolean
}

export type RpcConnectionStatusPublisherConfig = {
	getEthereumClientService: () => RpcStatusEthereumClient
	getRpcConnectionStatus: () => Promise<RpcConnectionStatus>
	publishRpcConnectionStatus: PublishRpcConnectionStatus
	slowRpcRequests: Map<string, SlowRpcRequest>
}

export const slowRpcRequestKey = (request: SlowRpcRequest) => `${ request.rpcUrl }-${ request.requestId }-${ request.startedAt.toISOString() }`

export function getCurrentSlowRpcRequest(slowRpcRequests: ReadonlyMap<string, SlowRpcRequest>, rpcUrl: string) {
	return Array.from(slowRpcRequests.values())
		.filter((request) => request.rpcUrl === rpcUrl)
		.sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime())[0]
}

export function withCurrentSlowRpcRequest(status: DefinedRpcConnectionStatus, slowRequest: SlowRpcRequest | undefined): DefinedRpcConnectionStatus {
	if (slowRequest === undefined) {
		const { slowRequest: _slowRequest, ...statusWithoutSlowRequest } = status
		return statusWithoutSlowRequest
	}
	return {
		...status,
		slowRequest: {
			method: slowRequest.method,
			startedAt: slowRequest.startedAt,
		},
	}
}

export function getCurrentRpcConnectionStatus(ethereumClientService: RpcStatusEthereumClient, previousStatus: RpcConnectionStatus): DefinedRpcConnectionStatus {
	const rpcEntry = ethereumClientService.getRpcEntry()
	if (previousStatus !== undefined && previousStatus.rpcNetwork.httpsRpc === rpcEntry.httpsRpc) return previousStatus
	return {
		isConnected: true,
		lastConnnectionAttempt: new Date(),
		latestBlock: ethereumClientService.getCachedBlock(),
		rpcNetwork: rpcEntry,
		retrying: ethereumClientService.isBlockPolling(),
	}
}

function getCurrentSlowRpcRequestForStatus(slowRpcRequests: ReadonlyMap<string, SlowRpcRequest>, rpcConnectionStatus: DefinedRpcConnectionStatus) {
	const rpcUrl = rpcConnectionStatus.rpcNetwork.httpsRpc
	if (rpcUrl === undefined) return undefined
	return getCurrentSlowRpcRequest(slowRpcRequests, rpcUrl)
}

export function createRpcConnectionStatusPublisher(config: RpcConnectionStatusPublisherConfig) {
	const publishSemaphore = new Semaphore(1)
	return {
		publishRpcConnectionStatus: async (method: RpcConnectionStatusChangeMethod, rpcConnectionStatus: DefinedRpcConnectionStatus) => {
			await publishSemaphore.execute(async () => {
				await config.publishRpcConnectionStatus(
					method,
					withCurrentSlowRpcRequest(rpcConnectionStatus, getCurrentSlowRpcRequestForStatus(config.slowRpcRequests, rpcConnectionStatus)),
				)
			})
		},
		publishSlowRpcRequestStatus: async () => {
			await publishSemaphore.execute(async () => {
				const ethereumClientService = config.getEthereumClientService()
				const rpcEntry = ethereumClientService.getRpcEntry()
				const slowRequest = getCurrentSlowRpcRequest(config.slowRpcRequests, rpcEntry.httpsRpc)
				const rpcConnectionStatus = withCurrentSlowRpcRequest(
					getCurrentRpcConnectionStatus(ethereumClientService, await config.getRpcConnectionStatus()),
					slowRequest,
				)
				await config.publishRpcConnectionStatus('popup_rpc_connection_status_changed', rpcConnectionStatus)
			})
		},
	}
}
