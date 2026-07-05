import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { createRpcConnectionStatusPublisher, slowRpcRequestKey, type DefinedRpcConnectionStatus, type RpcStatusEthereumClient } from '../../app/ts/background/rpcSlowRequestTracking.js'
import type { SlowRpcRequest } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import type { RpcConnectionStatus } from '../../app/ts/types/user-interface-types.js'

const rpcNetwork = {
	name: 'Test Chain',
	chainId: 1337n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	currencyLogoUri: undefined,
	primary: true,
	minimized: true,
}

const baseRpcConnectionStatus: DefinedRpcConnectionStatus = {
	isConnected: true,
	lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'),
	latestBlock: undefined,
	rpcNetwork,
	retrying: true,
}

function makeSlowRpcRequest(requestId: number, method: string, startedAt: string): SlowRpcRequest {
	return {
		requestId,
		rpcUrl: rpcNetwork.httpsRpc,
		method,
		startedAt: new Date(startedAt),
	}
}

function createDeferred() {
	let resolvePromise: (() => void) | undefined
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve
	})
	return {
		promise,
		resolve() {
			if (resolvePromise === undefined) throw new Error('Deferred promise was not initialized')
			resolvePromise()
		},
	}
}

function createFakeEthereumClient(): RpcStatusEthereumClient {
	return {
		getRpcEntry: () => rpcNetwork,
		getCachedBlock: () => undefined,
		isBlockPolling: () => true,
	}
}

describe('rpc slow request tracking', () => {
	test('serializes slow request publications so a settled request clears the final status', async () => {
		const slowRpcRequests = new Map<string, SlowRpcRequest>()
		const request = makeSlowRpcRequest(1, 'eth_call', '2024-01-01T00:00:01.000Z')
		slowRpcRequests.set(slowRpcRequestKey(request), request)
		let currentStatus: RpcConnectionStatus = baseRpcConnectionStatus
		const published: DefinedRpcConnectionStatus[] = []
		const firstPublishStarted = createDeferred()
		const releaseFirstPublish = createDeferred()
		let publishCalls = 0
		const publisher = createRpcConnectionStatusPublisher({
			getEthereumClientService: createFakeEthereumClient,
			getRpcConnectionStatus: async () => currentStatus,
			publishRpcConnectionStatus: async (_method, rpcConnectionStatus) => {
				publishCalls += 1
				if (publishCalls === 1) {
					firstPublishStarted.resolve()
					await releaseFirstPublish.promise
				}
				published.push(rpcConnectionStatus)
				currentStatus = rpcConnectionStatus
			},
			slowRpcRequests,
		})

		const slowPublish = publisher.publishSlowRpcRequestStatus()
		await firstPublishStarted.promise
		slowRpcRequests.delete(slowRpcRequestKey(request))
		const clearPublish = publisher.publishSlowRpcRequestStatus()
		releaseFirstPublish.resolve()
		await Promise.all([slowPublish, clearPublish])

		assert.equal(published.length, 2)
		assert.equal(published[0]?.slowRequest?.method, 'eth_call')
		assert.equal(published[1]?.slowRequest, undefined)
		assert.equal(currentStatus?.slowRequest, undefined)
	})

	test('keeps the next slow request visible when the oldest request settles', async () => {
		const slowRpcRequests = new Map<string, SlowRpcRequest>()
		const olderRequest = makeSlowRpcRequest(1, 'eth_call', '2024-01-01T00:00:01.000Z')
		const newerRequest = makeSlowRpcRequest(2, 'eth_getLogs', '2024-01-01T00:00:02.000Z')
		slowRpcRequests.set(slowRpcRequestKey(olderRequest), olderRequest)
		slowRpcRequests.set(slowRpcRequestKey(newerRequest), newerRequest)
		let currentStatus: RpcConnectionStatus = baseRpcConnectionStatus
		const published: DefinedRpcConnectionStatus[] = []
		const publisher = createRpcConnectionStatusPublisher({
			getEthereumClientService: createFakeEthereumClient,
			getRpcConnectionStatus: async () => currentStatus,
			publishRpcConnectionStatus: async (_method, rpcConnectionStatus) => {
				published.push(rpcConnectionStatus)
				currentStatus = rpcConnectionStatus
			},
			slowRpcRequests,
		})

		await publisher.publishSlowRpcRequestStatus()
		slowRpcRequests.delete(slowRpcRequestKey(olderRequest))
		await publisher.publishSlowRpcRequestStatus()

		assert.equal(published[0]?.slowRequest?.method, 'eth_call')
		assert.equal(published[1]?.slowRequest?.method, 'eth_getLogs')
		assert.equal(currentStatus?.slowRequest?.method, 'eth_getLogs')
	})

	test('serializes slow and block status publications so newer network fields win', async () => {
		const slowRpcRequests = new Map<string, SlowRpcRequest>()
		const request = makeSlowRpcRequest(1, 'eth_call', '2024-01-01T00:00:01.000Z')
		slowRpcRequests.set(slowRpcRequestKey(request), request)
		let currentStatus: RpcConnectionStatus = baseRpcConnectionStatus
		const published: DefinedRpcConnectionStatus[] = []
		const firstPublishStarted = createDeferred()
		const releaseFirstPublish = createDeferred()
		let publishCalls = 0
		const publisher = createRpcConnectionStatusPublisher({
			getEthereumClientService: createFakeEthereumClient,
			getRpcConnectionStatus: async () => currentStatus,
			publishRpcConnectionStatus: async (_method, rpcConnectionStatus) => {
				publishCalls += 1
				if (publishCalls === 1) {
					firstPublishStarted.resolve()
					await releaseFirstPublish.promise
				}
				published.push(rpcConnectionStatus)
				currentStatus = rpcConnectionStatus
			},
			slowRpcRequests,
		})

		const slowPublish = publisher.publishSlowRpcRequestStatus()
		await firstPublishStarted.promise
		const failedBlockStatus: DefinedRpcConnectionStatus = {
			...baseRpcConnectionStatus,
			isConnected: false,
			lastConnnectionAttempt: new Date('2024-01-01T00:00:03.000Z'),
			retrying: false,
		}
		const failedBlockPublish = publisher.publishRpcConnectionStatus('popup_failed_to_get_block', failedBlockStatus)
		releaseFirstPublish.resolve()
		await Promise.all([slowPublish, failedBlockPublish])

		assert.equal(published.length, 2)
		assert.equal(published[0]?.isConnected, true)
		assert.equal(published[1]?.isConnected, false)
		assert.equal(published[1]?.retrying, false)
		assert.equal(published[1]?.lastConnnectionAttempt.toISOString(), '2024-01-01T00:00:03.000Z')
		assert.equal(published[1]?.slowRequest?.method, 'eth_call')
		assert.equal(currentStatus?.isConnected, false)
		assert.equal(currentStatus?.retrying, false)
		assert.equal(currentStatus?.slowRequest?.method, 'eth_call')
	})

	test('removes stale slow request metadata from retry-state publications after a request settles', async () => {
		const request = makeSlowRpcRequest(1, 'eth_call', '2024-01-01T00:00:01.000Z')
		const slowRpcRequests = new Map<string, SlowRpcRequest>()
		let currentStatus: RpcConnectionStatus = {
			...baseRpcConnectionStatus,
			slowRequest: {
				method: request.method,
				startedAt: request.startedAt,
			},
		}
		const published: DefinedRpcConnectionStatus[] = []
		const publisher = createRpcConnectionStatusPublisher({
			getEthereumClientService: createFakeEthereumClient,
			getRpcConnectionStatus: async () => currentStatus,
			publishRpcConnectionStatus: async (_method, rpcConnectionStatus) => {
				published.push(rpcConnectionStatus)
				currentStatus = rpcConnectionStatus
			},
			slowRpcRequests,
		})

		await publisher.publishRpcConnectionStatus('popup_failed_to_get_block', {
			...baseRpcConnectionStatus,
			retrying: false,
			slowRequest: {
				method: request.method,
				startedAt: request.startedAt,
			},
		})

		assert.equal(published[0]?.retrying, false)
		assert.equal(published[0]?.slowRequest, undefined)
		assert.equal(currentStatus?.slowRequest, undefined)
	})
})
