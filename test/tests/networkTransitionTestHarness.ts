import * as assert from 'node:assert'
import type { PopupMessageDispatcherContext } from '../../app/ts/background/popupMessageDispatcher.js'
import { getReviewedResultId } from '../../app/ts/background/reviewedResult.js'
import type { PublishRpcConnectionStatus } from '../../app/ts/background/rpcSlowRequestTracking.js'
import { getPendingTransactionsAndMessages } from '../../app/ts/background/storageVariables.js'
import type { SimulationServicesOwner } from '../../app/ts/simulation/serviceLifecycle.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import { mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { ExportedSettings } from '../../app/ts/types/exportedSettingsTypes.js'
import type { ImportSimulationStack } from '../../app/ts/types/interceptor-messages.js'
import { type EthereumJsonRpcRequest, JsonRpcResponse } from '../../app/ts/types/JsonRpc-types.js'
import type { RpcEntry, RpcNetwork } from '../../app/ts/types/rpc.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { decodeFunctionDataStrict, encodeAbiValues, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { addressString, dataStringWith0xStart } from '../../app/ts/utils/bigint.js'
import { Multicall3ABI } from '../../app/ts/utils/constants.js'
import { doesUniqueRequestIdentifiersMatch, type UniqueRequestIdentifier } from '../../app/ts/utils/requests.js'
import { isRecord } from '../../app/ts/utils/runtimeTypeGuards.js'
import { eth_getBlockByNumber_goerli_8443561_false, eth_getBlockByNumber_goerli_8443561_true, eth_simulateV1_dummy_call_result } from '../RPCResponses.js'
import { confirmedSignerOwnership, createDeferredSignal, createPort, installBrowserMock, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'

export const networkA = {
	name: 'Network A',
	chainId: 1n,
	httpsRpc: 'https://network-a.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
} satisfies RpcEntry

export const networkB = { ...networkA, name: 'Network B', chainId: 10n, httpsRpc: 'https://network-b.invalid' } satisfies RpcEntry

export const signerOnlyB: RpcNetwork = { chainId: networkB.chainId, httpsRpc: undefined, name: 'Signer-only B', currencyName: 'Ether?', currencyTicker: 'ETH?', primary: false, minimized: true }

export const networkAOnOtherEndpoint = { ...networkA, name: 'Network A on another endpoint', httpsRpc: 'https://network-a-other-endpoint.invalid' } satisfies RpcEntry

export const firstAddress = 0x1111111111111111111111111111111111111111n

export const secondAddress = 0x2222222222222222222222222222222222222222n

export const websiteOrigin = 'https://example.test'

export const rawTransactionSignerKey = '0x0000000000000000000000000000000000000000000000000000000000000001'

export const AGGREGATE3_SELECTOR = '0x82ad56cb'

export const website = { websiteOrigin, icon: undefined, title: undefined }

export const stackImportRequest = {
	method: 'popup_importSimulationStack',
	data: {
		name: 'Interceptor Simulation Export', version: '1.0.0',
		eth_simulateV1: { method: 'eth_simulateV1', params: [{ blockStateCalls: [], traceTransfers: true, validation: true }, 'latest'] },
		interceptorSimulateStack: { operations: [{ type: 'TimeManipulation', blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 77n, deltaUnit: 'Seconds' } }] },
	},
} satisfies ImportSimulationStack

export function parseRpcResult(data: string) {
	const response = JsonRpcResponse.parse(JSON.parse(data))
	if ('error' in response) throw new Error(`Ethereum Client Error: ${ response.error.message }`)
	return response.result
}

export const simulateV1ResultTemplate = (() => {
	const result = parseRpcResult(eth_simulateV1_dummy_call_result)
	if (!Array.isArray(result) || !result.every(isRecord)) throw new Error('Expected the eth_simulateV1 fixture to list blocks')
	return result
})()

export function createCallReturnData(call: { readonly input?: Uint8Array }) {
	if (call.input === undefined || !dataStringWith0xStart(call.input).startsWith(AGGREGATE3_SELECTOR)) return '0x'
	const decoded = decodeFunctionDataStrict(Multicall3ABI, dataStringWith0xStart(call.input))
	if (decoded.functionName !== 'aggregate3') throw new Error('Expected an aggregate3 call')
	return encodeFunctionReturn(Multicall3ABI, 'aggregate3', [decoded.args[0].map(() => ({ success: true, returnData: encodeAbiValues(['uint256'], [0n]) }))])
}

export function createSimulateV1Result(blockStateCalls: readonly { readonly calls?: readonly { readonly input?: Uint8Array }[] }[]) {
	const [templateBlock] = simulateV1ResultTemplate
	return blockStateCalls.map((block) => ({
		...templateBlock,
		transactions: [],
		calls: (block.calls ?? []).map((call) => ({ returnData: createCallReturnData(call), logs: [], gasUsed: '0x5208', status: '0x1' })),
	}))
}

export type RequestInterceptor = (request: EthereumJsonRpcRequest, requestAbortController: AbortController | undefined) => Promise<void>

export function createNetworkServices(rpcEntry: RpcEntry) {
	const requests: EthereumJsonRpcRequest[] = []
	let interceptRequest: RequestInterceptor | undefined
	const ethereum = new EthereumClientService({
		rpcUrl: rpcEntry.httpsRpc,
		clearCache: () => undefined,
		jsonRpcRequest: async (request: EthereumJsonRpcRequest, requestAbortController?: AbortController) => {
			requests.push(request)
			await interceptRequest?.(request, requestAbortController)
			switch (request.method) {
				case 'eth_getBlockByNumber': return parseRpcResult(request.params[1] === false ? eth_getBlockByNumber_goerli_8443561_false : eth_getBlockByNumber_goerli_8443561_true)
				case 'eth_simulateV1': return createSimulateV1Result(request.params[0].blockStateCalls)
				case 'eth_estimateGas': return '0x5208'
				case 'eth_blockNumber': return '0x80d6a9'
				case 'eth_getTransactionCount': return '0x0'
				case 'eth_getBalance': return '0xde0b6b3a7640000'
				case 'eth_getCode': return '0x'
				case 'eth_call': return '0x'
				default: throw new Error(`Unexpected ${ request.method } request to ${ rpcEntry.name }`)
			}
		},
	}, async () => undefined, async () => undefined, rpcEntry)
	return { ethereum, tokenPriceService: new TokenPriceService(ethereum, 60_000), requests, interceptRequests: (interceptor: RequestInterceptor | undefined) => { interceptRequest = interceptor } }
}

export type NetworkServices = ReturnType<typeof createNetworkServices>

export function createRecordingServicesOwner(initialNetwork: RpcEntry) {
	const installed: NetworkServices[] = [createNetworkServices(initialNetwork)]
	const getInstalled = () => {
		const services = installed.at(-1)
		if (services === undefined) throw new Error('No services are installed')
		return services
	}
	const owner: SimulationServicesOwner = {
		getCurrent: getInstalled,
		reset: (rpcNetwork) => {
			getInstalled().ethereum.cleanup()
			installed.push(createNetworkServices(rpcNetwork))
			return getInstalled()
		},
	}
	return { owner, installed, getInstalled, retireAll: () => { for (const services of installed) services.ethereum.cleanup() } }
}

export const getSimulateV1Requests = (services: NetworkServices) => services.requests.flatMap((request) => request.method === 'eth_simulateV1' ? [request] : [])

export function getRichAddressesInSimulateV1Request(services: NetworkServices) {
	const [request, ...unexpectedRequests] = getSimulateV1Requests(services)
	if (request === undefined || unexpectedRequests.length > 0) throw new Error(`Expected one eth_simulateV1 request, received ${ unexpectedRequests.length + (request === undefined ? 0 : 1) }`)
	return request.params[0].blockStateCalls.flatMap((block) => Object.keys(block.stateOverrides ?? {}))
}

export const getOverriddenAddressesPerSimulateV1Request = (services: NetworkServices) => getSimulateV1Requests(services).map((request) => request.params[0].blockStateCalls.flatMap((block) => Object.keys(block.stateOverrides ?? {})))

export const getSimulatedCallRecipients = (services: NetworkServices) => getSimulateV1Requests(services).flatMap((request) => request.params[0].blockStateCalls.flatMap((block) => (block.calls ?? []).flatMap((call) => typeof call.to === 'bigint' ? [call.to] : [])))

export const STACKED_ON_A_RECIPIENT = 0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0n

export const STACKED_ON_B_RECIPIENT = 0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0n

export const STACKED_LATER_RECIPIENT = 0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0n

export const containsAddress = (value: unknown, address: bigint) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? addressString(item) : item).toLowerCase().includes(address.toString(16))

export function createStackedTransaction(transactionIdentifier: bigint, chainId: bigint, recipient: bigint) {
	return {
		type: 'Transaction' as const,
		preSimulationTransaction: {
			signedTransaction: mockSignTransaction({ type: '1559', from: firstAddress, nonce: transactionIdentifier - 1n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, gas: 21_000n, to: recipient, value: 0n, input: new Uint8Array(), chainId, accessList: [] }),
			website,
			created: new Date('2024-01-01T00:00:00.000Z'),
			originalRequestParameters: { method: 'eth_sendTransaction' as const, params: [{}] },
			transactionIdentifier,
		},
	}
}

export function createApprovedConnection(websiteSocketToString: (socket: { readonly tabId: number, readonly connectionName: bigint }) => string) {
	const socket = { tabId: 1, connectionName: 0n }
	const { port, messages } = createPort(socket.tabId)
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
	} }]])
	return { websiteTabConnections, getChainChangedResults: () => messages.filter((message) => message.method === 'chainChanged').map((message) => message.result) }
}

export function reportSimulationConsumer(isOpen: boolean) {
	const originalSendMessage = browser.runtime.sendMessage.bind(browser.runtime)
	Object.defineProperty(browser.runtime, 'sendMessage', {
		configurable: true,
		value: async (message: unknown) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_isSimulationVisualizerOpen'
			? { method: 'popup_isSimulationVisualizerOpen', data: { isOpen } }
			: await originalSendMessage(message),
	})
}

export async function createApprovedSimulationDapp({ simulationConsumerOpen = false, signerConfirmed = false }: { readonly simulationConsumerOpen?: boolean, readonly signerConfirmed?: boolean } = {}) {
	const { runtimeMessages } = installBrowserMock()
	if (simulationConsumerOpen) reportSimulationConsumer(true)
	const modules = await loadModules()
	await modules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: firstAddress, activeSigningAddress: undefined, rpcNetwork: networkA })
	await modules.setMakeCurrentAddressRich(true)
	await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
	const socket = { tabId: 1, connectionName: 0n }
	const { port, messages } = createPort(socket.tabId)
	const websiteTabConnections = new Map([[socket.tabId, { ...signerConfirmed ? confirmedSignerOwnership(socket) : {}, connections: {
		[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
	} }]])
	const sendDappRequest = async (simulationServicesOwner: SimulationServicesOwner, request: { readonly method: string, readonly params: readonly unknown[] }, requestId = 1) => await modules.handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
		interceptorRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId, requestSocket: socket },
		...request,
	}, websiteTabConnections, noopPublishRpcConnectionStatus)
	const sendEthSimulateV1 = async (simulationServicesOwner: SimulationServicesOwner) => await sendDappRequest(simulationServicesOwner, {
		method: 'eth_simulateV1',
		params: [{ blockStateCalls: [{ calls: [{ from: addressString(firstAddress), to: addressString(secondAddress), data: '0x1234' }] }] }, 'latest'],
	})
	const switchToNetworkB = async (simulationServicesOwner: SimulationServicesOwner) => await modules.changeActiveAddressAndChain(simulationServicesOwner, new Map(), {
		simulationMode: true,
		activeAddress: secondAddress,
		rpcNetwork: networkB,
		promptForAccessesIfNeeded: false,
	})
	const assertRequestSucceeded = () => {
		const reply = messages.find((message) => message.method === 'eth_simulateV1')
		assert.notEqual(reply?.result, undefined)
		assert.equal(reply?.error, undefined)
	}
	const getReplies = (method: string, requestId: number) => messages.filter((message) => message.method === method && message.requestId === requestId)
	const getReply = (method: string, requestId: number) => getReplies(method, requestId)[0]
	const createPopupContext = async (simulationServicesOwner: SimulationServicesOwner): Promise<PopupMessageDispatcherContext> => ({
		websiteTabConnections,
		simulationServicesOwner,
		settings: await modules.getSettings(),
		publishRpcConnectionStatus: noopPublishRpcConnectionStatus,
		simulationAbortController: new AbortController(),
		confirmTransactionAbortController: new AbortController(),
		resetSimulationState: async () => undefined,
	})
	return { modules, socket, messages, websiteTabConnections, runtimeMessages, sendDappRequest, sendEthSimulateV1, switchToNetworkB, assertRequestSucceeded, getReply, getReplies, createPopupContext }
}

export async function subscribeDappToNewBlocks(dapp: Awaited<ReturnType<typeof createApprovedSimulationDapp>>, simulationServicesOwner: SimulationServicesOwner, publishRpcConnectionStatus: PublishRpcConnectionStatus = noopPublishRpcConnectionStatus) {
	const { createNewBlockAttemptCallback } = await import('../../app/ts/background/newBlockHandling.js')
	const { createEthereumSubscription } = await import('../../app/ts/simulation/services/EthereumSubscriptionService.js')
	await createEthereumSubscription({ method: 'eth_subscribe', params: ['newHeads'] }, dapp.socket)
	const handleNewBlock = createNewBlockAttemptCallback({ getSimulationServices: simulationServicesOwner.getCurrent, publishRpcConnectionStatus, websiteTabConnections: dapp.websiteTabConnections })
	return {
		deliverNewBlock: async ({ ethereum }: NetworkServices) => await handleNewBlock(await ethereum.getBlock(undefined), ethereum, true),
		getNewHeads: () => dapp.messages.filter((message) => message.method === 'newHeads'),
	}
}

export async function addTransactionToNetworkBStack(modules: { readonly getInterceptorTransactionStack: () => Promise<{ readonly operations: readonly unknown[] }>, readonly updateInterceptorTransactionStack: (update: (stack: never) => { readonly operations: readonly ReturnType<typeof createStackedTransaction>[] }) => Promise<unknown> }) {
	assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(2n, networkB.chainId, STACKED_ON_B_RECIPIENT)] }))
}

export async function prepareNetworkARefreshAfterNetworkBVisualisation({ owner, installed, getInstalled }: ReturnType<typeof createRecordingServicesOwner>) {
	const dapp = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
	const { modules, sendDappRequest, switchToNetworkB } = dapp
	const { updatePopupVisualisationIfNeeded, computeConfirmationVisualisation } = await import('../../app/ts/background/popupVisualisationUpdater.js')
	const { updateConfirmTransactionView } = await import('../../app/ts/background/windows/confirmTransaction.js')
	const [servicesA] = installed
	if (servicesA === undefined) throw new Error('Missing network A services')
	await sendDappRequest(owner, { method: 'eth_sendTransaction', params: [{ from: addressString(firstAddress), to: addressString(secondAddress), value: '0x0', data: '0x' }] })
	await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
	const networkAtRequest = await modules.readNetworkSnapshot(owner)
	await switchToNetworkB(owner)
	await addTransactionToNetworkBStack(modules)
	const servicesB = getInstalled()
	const refreshNetworkB = async () => await updatePopupVisualisationIfNeeded(servicesB.ethereum, servicesB.tokenPriceService, { invalidateOldState: true })
	await refreshNetworkB()
	assert.ok(containsAddress(await modules.getPopupVisualisationState(), STACKED_ON_B_RECIPIENT))
	const refreshConfirmation = {
		'dialog simulation': async () => await updateConfirmTransactionView(networkAtRequest),
		metadata: async (visualisation?: Parameters<typeof computeConfirmationVisualisation>[1]) => await modules.refreshPopupConfirmTransactionMetadata(networkAtRequest, undefined, { visualisation }),
	}
	return { ...dapp, servicesA, refreshConfirmation, refreshNetworkB }
}

export function whenRuntimeMessageSent(matches: (message: unknown) => boolean) {
	const sent = createDeferredSignal()
	const originalSendMessage = browser.runtime.sendMessage.bind(browser.runtime)
	Object.defineProperty(browser.runtime, 'sendMessage', {
		configurable: true,
		value: async (message: unknown) => {
			if (matches(message)) sent.resolve()
			return await originalSendMessage(message)
		},
	})
	return sent.promise
}

export const isInvalidatedSharedVisualisation = (message: unknown) => isRecord(message)
	&& message.method === 'popup_simulation_state_changed'
	&& isRecord(message.data)
	&& isRecord(message.data.visualizedSimulatorState)
	&& message.data.visualizedSimulatorState.simulationResultState === 'invalid'

export const isNetworkAStackRecipientLookup = (request: EthereumJsonRpcRequest) => request.method === 'eth_getCode' && request.params[0] === STACKED_ON_A_RECIPIENT

export async function getConfirmationDialogVisualisations(runtimeMessages: readonly unknown[], messagesBefore: number) {
	const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
	return runtimeMessages.slice(messagesBefore).flatMap((message) => {
		const parsed = MessageToPopup.safeParse(message)
		if (!parsed.success || parsed.value.method !== 'popup_update_confirm_transaction_dialog') return []
		return [parsed.value.data.visualizedSimulatorState]
	})
}

export function createStorageReadPause() {
	const started = createDeferredSignal()
	const release = createDeferredSignal()
	const originalGet = browser.storage.local.get.bind(browser.storage.local)
	let state: 'idle' | 'armed' | 'used' = 'idle'
	Object.defineProperty(browser.storage.local, 'get', {
		configurable: true,
		value: async (keys: Parameters<typeof originalGet>[0]) => {
			if (state === 'armed') {
				state = 'used'
				started.resolve()
				await release.promise
			}
			return await originalGet(keys)
		},
	})
	return { arm: () => { if (state === 'idle') state = 'armed' }, started: started.promise, release: release.resolve }
}

export function pauseNextStorageReadOf(key: string) {
	const started = createDeferredSignal()
	const release = createDeferredSignal()
	const originalGet = browser.storage.local.get.bind(browser.storage.local)
	let used = false
	Object.defineProperty(browser.storage.local, 'get', {
		configurable: true,
		value: async (keys: Parameters<typeof originalGet>[0]) => {
			const readsKey = keys === key || (Array.isArray(keys) && keys.includes(key))
			if (!used && readsKey) {
				used = true
				started.resolve()
				await release.promise
			}
			return await originalGet(keys)
		},
	})
	return { started: started.promise, release: release.resolve }
}

export const readsStorageKey = (keys: unknown, key: string) => keys === key || (Array.isArray(keys) && keys.includes(key))

export function whenStorageReadsReturned(key: string, count: number) {
	const returned = createDeferredSignal()
	const originalGet = browser.storage.local.get.bind(browser.storage.local)
	let reads = 0
	Object.defineProperty(browser.storage.local, 'get', {
		configurable: true,
		value: async (keys: Parameters<typeof originalGet>[0]) => {
			const result = await originalGet(keys)
			if (readsStorageKey(keys, key)) {
				reads += 1
				if (reads === count) returned.resolve()
			}
			return result
		},
	})
	return returned.promise
}

export function queueBlockedLargeStateReadAfterNextVisualisationRead(getSafeTransactionStacks: () => Promise<unknown>) {
	const blocked = createDeferredSignal()
	const release = createDeferredSignal()
	const originalGet = browser.storage.local.get.bind(browser.storage.local)
	let state: 'waitingForVisualisationRead' | 'waitingForCompetingRead' | 'used' = 'waitingForVisualisationRead'
	let competingRead: Promise<unknown> | undefined
	Object.defineProperty(browser.storage.local, 'get', {
		configurable: true,
		value: async (keys: Parameters<typeof originalGet>[0]) => {
			if (state === 'waitingForVisualisationRead' && readsStorageKey(keys, 'popupVisualisation')) {
				state = 'waitingForCompetingRead'
				competingRead = getSafeTransactionStacks()
			} else if (state === 'waitingForCompetingRead' && readsStorageKey(keys, 'safeTransactionStacks')) {
				state = 'used'
				blocked.resolve()
				await release.promise
			}
			return await originalGet(keys)
		},
	})
	return { blocked: blocked.promise, release: release.resolve, finished: async () => await competingRead }
}

export function countPopupVisualisationWrites() {
	const originalSet = browser.storage.local.set.bind(browser.storage.local)
	let writes = 0
	Object.defineProperty(browser.storage.local, 'set', {
		configurable: true,
		value: async (items: Record<string, unknown>) => {
			if ('popupVisualisation' in items) writes += 1
			await originalSet(items)
		},
	})
	return () => writes
}

export async function getBroadcastSimulatedVisualisations(runtimeMessages: readonly unknown[]) {
	const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
	return runtimeMessages.flatMap((message) => {
		const parsed = MessageToPopup.safeParse(message)
		if (!parsed.success || parsed.value.method !== 'popup_simulation_state_changed') return []
		const { simulationState } = parsed.value.data.visualizedSimulatorState
		return simulationState.kind === 'simulated' ? [simulationState.value] : []
	})
}

export function pauseAfterActiveNetworkWrite() {
	const written = createDeferredSignal()
	const release = createDeferredSignal()
	const originalSet = browser.storage.local.set.bind(browser.storage.local)
	let armed = true
	Object.defineProperty(browser.storage.local, 'set', {
		configurable: true,
		value: async (items: Record<string, unknown>) => {
			await originalSet(items)
			if (!armed || !('activeRpcNetwork' in items)) return
			armed = false
			written.resolve()
			await release.promise
		},
	})
	return { written: written.promise, release: release.resolve }
}

export async function createImportRequest(exportSettingsAndAddressBook: () => Promise<ExportedSettings>, rpcNetwork: RpcEntry, simulationMode?: boolean) {
	const exported = await exportSettingsAndAddressBook()
	if (exported.version !== '1.6') throw new Error('Expected the current export version')
	const settings = { ...exported.settings, rpcNetwork, ...(simulationMode === undefined ? {} : { simulationMode }) }
	return { method: 'popup_import_settings', data: { fileContents: JSON.stringify(serialize(ExportedSettings, { ...exported, settings })) } } as const
}

export function failFirstSettingsReadAfterNetworkWrite(error: Error) {
	const originalGet = browser.storage.local.get.bind(browser.storage.local)
	const originalSet = browser.storage.local.set.bind(browser.storage.local)
	let state: 'waitingForNetworkWrite' | 'armed' | 'used' = 'waitingForNetworkWrite'
	Object.defineProperty(browser.storage.local, 'set', {
		configurable: true,
		value: async (items: Record<string, unknown>) => {
			await originalSet(items)
			if (state === 'waitingForNetworkWrite' && 'activeRpcNetwork' in items) state = 'armed'
		},
	})
	Object.defineProperty(browser.storage.local, 'get', {
		configurable: true,
		value: async (keys: Parameters<typeof originalGet>[0]) => {
			if (state === 'armed' && Array.isArray(keys) && keys.includes('activeRpcNetwork')) {
				state = 'used'
				throw error
			}
			return await originalGet(keys)
		},
	})
}

export async function assertCommittedNetworkBEffects(
	modules: { readonly readNetworkSnapshot: (owner: SimulationServicesOwner) => Promise<{ readonly settings: { readonly activeRpcNetwork: unknown }, readonly services: { readonly ethereum: EthereumClientService } }>, readonly getInterceptorTransactionStack: () => Promise<{ readonly operations: readonly unknown[] }> },
	owner: SimulationServicesOwner,
	getChainChangedResults: () => readonly unknown[],
	expectedStackLength: number,
) {
	const snapshot = await modules.readNetworkSnapshot(owner)
	assert.deepEqual(snapshot.settings.activeRpcNetwork, networkB)
	assert.deepEqual(snapshot.services.ethereum.getRpcEntry(), networkB)
	assert.equal((await modules.getInterceptorTransactionStack()).operations.length, expectedStackLength)
	assert.deepEqual(getChainChangedResults(), ['0xa'])
	return snapshot
}

export function failStorageWrites(key: string, times: number, error: Error) {
	const originalSet = browser.storage.local.set.bind(browser.storage.local)
	let remainingFailures = times
	Object.defineProperty(browser.storage.local, 'set', {
		configurable: true,
		value: async (items: Record<string, unknown>) => {
			if (remainingFailures > 0 && key in items) {
				remainingFailures -= 1
				throw error
			}
			await originalSet(items)
		},
	})
}

export const failNextStorageWrite = (key: string, error: Error) => failStorageWrites(key, 1, error)

export function failFirstStorageReadAfterWrite(key: string, error: Error) {
	const originalGet = browser.storage.local.get.bind(browser.storage.local)
	const originalSet = browser.storage.local.set.bind(browser.storage.local)
	let state: 'waitingForWrite' | 'armed' | 'used' = 'waitingForWrite'
	Object.defineProperty(browser.storage.local, 'set', {
		configurable: true,
		value: async (items: Record<string, unknown>) => {
			await originalSet(items)
			if (state === 'waitingForWrite' && key in items) state = 'armed'
		},
	})
	Object.defineProperty(browser.storage.local, 'get', {
		configurable: true,
		value: async (keys: Parameters<typeof originalGet>[0]) => {
			if (state === 'armed') {
				state = 'used'
				throw error
			}
			return await originalGet(keys)
		},
	})
}

export async function createAcceptConfirmation(uniqueRequestIdentifier: UniqueRequestIdentifier) {
	const pending = (await getPendingTransactionsAndMessages()).find((entry) => doesUniqueRequestIdentifiersMatch(entry.uniqueRequestIdentifier, uniqueRequestIdentifier))
	if (pending === undefined) throw new Error('Expected a stored request to accept')
	return { method: 'popup_confirmDialog' as const, data: { action: 'accept' as const, uniqueRequestIdentifier, reviewedResultId: getReviewedResultId(pending), forceSend: true } }
}
