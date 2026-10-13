import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { IEthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import { EthereumJsonRpcRequest, JsonRpcResponse } from '../../app/ts/types/JsonRpc-types.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { eth_getBlockByNumber_goerli_8443561_true, eth_simulateV1_dummy_call_result } from '../RPCResponses.js'
import { createPort, createRestoringBrowserMockInstaller, createTestSimulationServicesOwner, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'
import { readProperty } from '../harness/assertions.js'

const installBrowserMock = createRestoringBrowserMockInstaller()

function parseRpcResult(data: string): unknown {
	const response = JsonRpcResponse.parse(JSON.parse(data))
	if ('error' in response) throw Error(`Ethereum Client Error: ${ response.error.message }`)
	return response.result
}

async function loadModules() {
	return {
		...await import('../../app/ts/background/background.js'),
		...await import('../../app/ts/background/backgroundUtils.js'),
		...await import('../../app/ts/background/settings.js'),
	}
}

// Answers eth_getBlockByNumber with a Goerli block fixture and eth_simulateV1 with ethSimulateV1Result, and records every request the background forwards to the RPC.
function createRecordingRequestHandler(rpcEntry: RpcEntry, ethSimulateV1Result: unknown = parseRpcResult(eth_simulateV1_dummy_call_result)) {
	const forwardedRequests: EthereumJsonRpcRequest[] = []
	const requestHandler = {
		rpcUrl: rpcEntry.httpsRpc,
		clearCache: () => undefined,
		getChainId: async () => rpcEntry.chainId,
		jsonRpcRequest: async (rpcRequest: EthereumJsonRpcRequest) => {
			forwardedRequests.push(rpcRequest)
			switch (rpcRequest.method) {
				case 'eth_getBlockByNumber': return parseRpcResult(eth_getBlockByNumber_goerli_8443561_true)
				case 'eth_simulateV1': return ethSimulateV1Result
				default: throw new Error(`unsupported method ${ rpcRequest.method }`)
			}
		},
	} satisfies IEthereumJSONRpcRequestHandler
	return { requestHandler, forwardedRequests }
}

function createEthereum(rpcEntry: RpcEntry, ethSimulateV1Result?: unknown) {
	const { requestHandler, forwardedRequests } = createRecordingRequestHandler(rpcEntry, ethSimulateV1Result)
	const ethereum = new Proxy(
		new EthereumClientService(
			requestHandler,
			async () => undefined,
			async () => undefined,
			rpcEntry,
		),
		{
			get(target, property, receiver) {
				if (property === 'isBlockPolling') return () => true
				if (property === 'setBlockPolling') return (_enabled: boolean) => undefined
				return Reflect.get(target, property, receiver)
			},
		},
	)
	const tokenPriceService = new TokenPriceService(ethereum, 60_000)
	return {
		forwardedRequests,
		simulationServicesOwner: createTestSimulationServicesOwner({ ethereum, tokenPriceService }, (() => ({ ethereum, tokenPriceService }))),
	}
}

async function createApprovedDappHarness(ethSimulateV1Result?: unknown) {
	installBrowserMock()
	const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, updateWebsiteAccess, defaultRpcs } = await loadModules()
	const websiteOrigin = 'https://example.test'
	const website = { websiteOrigin, icon: undefined, title: undefined }
	const activeAddress = 0x1111111111111111111111111111111111111111n
	const rpcEntry = defaultRpcs[0]
	if (rpcEntry === undefined) throw new Error('missing default rpc')
	await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, activeSigningAddress: undefined, rpcNetwork: rpcEntry })
	await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

	const socket = { tabId: 1, connectionName: 0n }
	const { port, messages } = createPort(socket.tabId)
	const connectionKey = websiteSocketToString(socket)
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
	} }]])
	const { forwardedRequests, simulationServicesOwner } = createEthereum(rpcEntry, ethSimulateV1Result)
	return { handleInterceptedRequest, websiteOrigin, website, socket, port, messages, websiteTabConnections, forwardedRequests, simulationServicesOwner }
}

describe('background eth_simulateV1', () => {
	test('replies to approved dapp eth_simulateV1 requests', async () => {
		const { handleInterceptedRequest, websiteOrigin, website, socket, port, messages, websiteTabConnections, forwardedRequests, simulationServicesOwner } = await createApprovedDappHarness()
		const parentBlockHash = '0x000000000000000000000000000000000000000000000000000000000000abcd'

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 42, requestSocket: socket },
			method: 'eth_simulateV1',
			params: [{
				blockStateCalls: [{
					calls: [{
						type: '0x0',
						from: '0x1111111111111111111111111111111111111111',
						nonce: '0x0',
						gasPrice: '0x1',
						gas: '0x5208',
						to: '0x2222222222222222222222222222222222222222',
						value: '0x0',
						data: '0x1234',
						chainId: '0x1',
						v: '0x1b',
						r: '0x1',
						s: '0x2',
					}],
				}],
			}, parentBlockHash],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const reply = messages.find((message) => message.method === 'eth_simulateV1' && message.requestId === 42)
		const forwardedRequest = forwardedRequests.at(-1)
		if (forwardedRequest?.method !== 'eth_simulateV1') throw new Error('expected eth_simulateV1 to be forwarded')
		const forwardedCall = forwardedRequest.params[0].blockStateCalls[0]?.calls[0]
		if (forwardedCall === undefined) throw new Error('missing forwarded eth_simulateV1 call')
		assert.equal(forwardedCall.gasPrice, 1n)
		assert.deepEqual(Array.from(forwardedCall.data ?? []), [0x12, 0x34])
		assert.equal(forwardedRequest.params[0].traceTransfers, undefined)
		assert.equal(forwardedRequest.params[0].validation, undefined)
		assert.equal(forwardedRequest.params[1], parentBlockHash)
		const serializedForwardedRequest = serialize<EthereumJsonRpcRequest, typeof EthereumJsonRpcRequest>(EthereumJsonRpcRequest, forwardedRequest)
		if (serializedForwardedRequest.method !== 'eth_simulateV1') throw new Error('expected serialized eth_simulateV1 request')
		assert.equal(serializedForwardedRequest.params[1], parentBlockHash)
		assert.equal(reply?.error, undefined)
		assert.equal(Array.isArray(reply?.result), true)
	})

	test('preserves blob transaction fields in dapp eth_simulateV1 requests', async () => {
		const { handleInterceptedRequest, websiteOrigin, website, socket, port, messages, websiteTabConnections, forwardedRequests, simulationServicesOwner } = await createApprovedDappHarness()
		const blobVersionedHash = '0x01'.padEnd(66, '0')

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 44, requestSocket: socket },
			method: 'eth_simulateV1',
			params: [{
				blockStateCalls: [{
					calls: [{
						type: '0x3',
						from: '0x1111111111111111111111111111111111111111',
						nonce: '0x0',
						maxFeePerGas: '0x2',
						maxPriorityFeePerGas: '0x1',
						maxFeePerBlobGas: '0x3',
						gas: '0x5208',
						to: '0x2222222222222222222222222222222222222222',
						value: '0x0',
						input: '0x',
						chainId: '0x1',
						accessList: [],
						blobVersionedHashes: [blobVersionedHash],
						blobs: ['0x1234'],
					}],
				}],
			}, '0x1'],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const reply = messages.find((message) => message.method === 'eth_simulateV1' && message.requestId === 44)
		const forwardedRequest = forwardedRequests.at(-1)
		if (forwardedRequest?.method !== 'eth_simulateV1') throw new Error('expected eth_simulateV1 to be forwarded')
		const forwardedCall = forwardedRequest.params[0].blockStateCalls[0]?.calls[0]
		if (forwardedCall === undefined) throw new Error('missing forwarded eth_simulateV1 call')
		assert.equal(forwardedCall.maxFeePerBlobGas, 3n)
		assert.deepEqual(forwardedCall.blobVersionedHashes, [BigInt(blobVersionedHash)])
		assert.deepEqual((forwardedCall.blobs ?? []).map((blob) => Array.from(blob)), [[0x12, 0x34]])
		const serializedForwardedRequest = serialize<EthereumJsonRpcRequest, typeof EthereumJsonRpcRequest>(EthereumJsonRpcRequest, forwardedRequest)
		if (serializedForwardedRequest.method !== 'eth_simulateV1') throw new Error('expected serialized eth_simulateV1 request')
		const serializedCall = serializedForwardedRequest.params[0].blockStateCalls[0]?.calls[0]
		if (serializedCall === undefined) throw new Error('missing serialized eth_simulateV1 call')
		assert.equal(serializedCall.maxFeePerBlobGas, '0x3')
		assert.deepEqual(serializedCall.blobVersionedHashes, [blobVersionedHash])
		assert.deepEqual(serializedCall.blobs, ['0x1234'])
		assert.equal(reply?.error, undefined)
		assert.equal(Array.isArray(reply?.result), true)
	})

	test('accepts one-parameter eth_simulateV1 requests and preserves blobBaseFee', async () => {
		const { handleInterceptedRequest, websiteOrigin, website, socket, port, messages, websiteTabConnections, forwardedRequests, simulationServicesOwner } = await createApprovedDappHarness()

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 43, requestSocket: socket },
			method: 'eth_simulateV1',
			params: [{
				blockStateCalls: [{
					blockOverrides: { blobBaseFee: '0x7' },
					calls: [{
						type: '0x2',
						from: '0x1111111111111111111111111111111111111111',
						nonce: '0x0',
						maxFeePerGas: '0x1',
						maxPriorityFeePerGas: '0x1',
						gas: '0x5208',
						to: '0x2222222222222222222222222222222222222222',
						value: '0x0',
						input: '0x',
						chainId: '0x1',
						accessList: [],
					}],
				}],
			}],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const reply = messages.find((message) => message.method === 'eth_simulateV1' && message.requestId === 43)
		const forwardedRequest = forwardedRequests.at(-1)
		if (forwardedRequest?.method !== 'eth_simulateV1') throw new Error('expected eth_simulateV1 to be forwarded')
		const forwardedBlock = forwardedRequest.params[0].blockStateCalls.at(-1)
		if (forwardedBlock === undefined) throw new Error('missing forwarded eth_simulateV1 block')
		assert.equal(forwardedBlock.blockOverrides?.blobBaseFee, 7n)
		assert.equal(forwardedRequest.params.length, 1)
		const serializedForwardedRequest = serialize<EthereumJsonRpcRequest, typeof EthereumJsonRpcRequest>(EthereumJsonRpcRequest, forwardedRequest)
		if (serializedForwardedRequest.method !== 'eth_simulateV1') throw new Error('expected serialized eth_simulateV1 request')
		assert.equal(serializedForwardedRequest.params.length, 1)
		const serializedBlock = serializedForwardedRequest.params[0].blockStateCalls.at(-1)
		if (serializedBlock === undefined) throw new Error('missing serialized eth_simulateV1 block')
		assert.equal(serializedBlock.blockOverrides?.blobBaseFee, '0x7')
		assert.equal(reply?.error, undefined)
		assert.equal(Array.isArray(reply?.result), true)
	})

	test('preserves current eth_simulateV1 result fields in dapp replies', async () => {
		const result = parseRpcResult(eth_simulateV1_dummy_call_result)
		if (!Array.isArray(result)) throw new Error('expected eth_simulateV1 fixture array')
		const block: unknown = result[0]
		if (typeof block !== 'object' || block === null) throw new Error('missing eth_simulateV1 fixture block')
		const calls = readProperty(block, 'calls')
		const call: unknown = Array.isArray(calls) ? calls[0] : undefined
		if (typeof call !== 'object' || call === null) throw new Error('missing eth_simulateV1 fixture call')
		const logs = readProperty(call, 'logs')
		const log: unknown = Array.isArray(logs) ? logs[0] : undefined
		if (typeof log !== 'object' || log === null) throw new Error('missing eth_simulateV1 fixture log')
		const ethSimulateV1Result = [{
			...block,
			blockAccessListHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
			requestsHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
			clientBlockExtension: { keep: true },
			calls: [{
				...call,
				maxUsedGas: '0x5300',
				clientCallExtension: 'keep-call-extension',
				logs: [{
					...log,
					blockTimestamp: '0x675964eb',
					removed: false,
				}],
			}],
		}]
		const { handleInterceptedRequest, websiteOrigin, website, socket, port, messages, websiteTabConnections, simulationServicesOwner } = await createApprovedDappHarness(ethSimulateV1Result)

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 45, requestSocket: socket },
			method: 'eth_simulateV1',
			params: [{
				blockStateCalls: [{
					calls: [{
						type: '0x2',
						from: '0x1111111111111111111111111111111111111111',
						nonce: '0x0',
						maxFeePerGas: '0x1',
						maxPriorityFeePerGas: '0x1',
						gas: '0x5208',
						to: '0x2222222222222222222222222222222222222222',
						value: '0x0',
						input: '0x',
						chainId: '0x1',
						accessList: [],
					}],
				}],
			}, '0x1'],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const reply = messages.find((message) => message.method === 'eth_simulateV1' && message.requestId === 45)
		const replyBlocks = reply?.result
		if (!Array.isArray(replyBlocks)) throw new Error('expected eth_simulateV1 result reply')
		const replyBlock: unknown = replyBlocks[0]
		if (typeof replyBlock !== 'object' || replyBlock === null) throw new Error('missing reply block')
		assert.equal(readProperty(replyBlock, 'blockAccessListHash'), '0x1111111111111111111111111111111111111111111111111111111111111111')
		assert.equal(readProperty(replyBlock, 'requestsHash'), '0x2222222222222222222222222222222222222222222222222222222222222222')
		assert.deepEqual(readProperty(replyBlock, 'clientBlockExtension'), { keep: true })
		const replyCalls = readProperty(replyBlock, 'calls')
		const replyCall: unknown = Array.isArray(replyCalls) ? replyCalls[0] : undefined
		if (typeof replyCall !== 'object' || replyCall === null) throw new Error('missing reply call')
		assert.equal(readProperty(replyCall, 'maxUsedGas'), '0x5300')
		assert.equal(readProperty(replyCall, 'clientCallExtension'), 'keep-call-extension')
		const replyLogs = readProperty(replyCall, 'logs')
		const replyLog: unknown = Array.isArray(replyLogs) ? replyLogs[0] : undefined
		if (typeof replyLog !== 'object' || replyLog === null) throw new Error('missing reply log')
		assert.equal(readProperty(replyLog, 'blockTimestamp'), '0x675964eb')
		assert.equal(readProperty(replyLog, 'removed'), false)
		assert.equal(reply?.error, undefined)
	})
})
