import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { SimulationServicesOwner } from '../../app/ts/simulation/serviceLifecycle.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import { ExportedSettings } from '../../app/ts/types/exportedSettingsTypes.js'
import type { PopupMessageDispatcherContext } from '../../app/ts/background/popupMessageDispatcher.js'
import { type EthereumJsonRpcRequest, JsonRpcResponse } from '../../app/ts/types/JsonRpc-types.js'
import type { RpcEntry, RpcNetwork } from '../../app/ts/types/rpc.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { addressString, dataStringWith0xStart } from '../../app/ts/utils/bigint.js'
import { decodeFunctionDataStrict, encodeAbiValues, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { Multicall3ABI } from '../../app/ts/utils/constants.js'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'
import { isRecord } from '../../app/ts/utils/runtimeTypeGuards.js'
import { eth_getBlockByNumber_goerli_8443561_false, eth_getBlockByNumber_goerli_8443561_true, eth_simulateV1_dummy_call_result } from '../RPCResponses.js'
import { confirmedSignerOwnership, createDeferredSignal, createPort, installBrowserMock, loadModules, noopPublishRpcConnectionStatus, waitForPortMessageCount } from './backgroundEthAccountsTestHarness.js'
import { Transaction } from 'micro-eth-signer'
import { mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import type { PublishRpcConnectionStatus } from '../../app/ts/background/rpcSlowRequestTracking.js'

const networkA = {
	name: 'Network A',
	chainId: 1n,
	httpsRpc: 'https://network-a.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
} satisfies RpcEntry
const networkB = { ...networkA, name: 'Network B', chainId: 10n, httpsRpc: 'https://network-b.invalid' } satisfies RpcEntry
const networkAOnOtherEndpoint = { ...networkA, name: 'Network A on another endpoint', httpsRpc: 'https://network-a-other-endpoint.invalid' } satisfies RpcEntry
const firstAddress = 0x1111111111111111111111111111111111111111n
const secondAddress = 0x2222222222222222222222222222222222222222n
const websiteOrigin = 'https://example.test'
const rawTransactionSignerKey = '0x0000000000000000000000000000000000000000000000000000000000000001'
const AGGREGATE3_SELECTOR = '0x82ad56cb'
const website = { websiteOrigin, icon: undefined, title: undefined }

function parseRpcResult(data: string) {
	const response = JsonRpcResponse.parse(JSON.parse(data))
	if ('error' in response) throw new Error(`Ethereum Client Error: ${ response.error.message }`)
	return response.result
}

const simulateV1ResultTemplate = (() => {
	const result = parseRpcResult(eth_simulateV1_dummy_call_result)
	if (!Array.isArray(result) || !result.every(isRecord)) throw new Error('Expected the eth_simulateV1 fixture to list blocks')
	return result
})()

// Balance queries are batched through Multicall3, so their result must decode to one balance per query.
function createCallReturnData(call: { readonly input?: Uint8Array }) {
	if (call.input === undefined || !dataStringWith0xStart(call.input).startsWith(AGGREGATE3_SELECTOR)) return '0x'
	const decoded = decodeFunctionDataStrict(Multicall3ABI, dataStringWith0xStart(call.input))
	if (decoded.functionName !== 'aggregate3') throw new Error('Expected an aggregate3 call')
	return encodeFunctionReturn(Multicall3ABI, 'aggregate3', [decoded.args[0].map(() => ({ success: true, returnData: encodeAbiValues(['uint256'], [0n]) }))])
}

// One successful block per requested block, with one result per requested call, so the simulation input can have any shape.
function createSimulateV1Result(blockStateCalls: readonly { readonly calls?: readonly { readonly input?: Uint8Array }[] }[]) {
	const [templateBlock] = simulateV1ResultTemplate
	return blockStateCalls.map((block) => ({
		...templateBlock,
		transactions: [],
		calls: (block.calls ?? []).map((call) => ({ returnData: createCallReturnData(call), logs: [], gasUsed: '0x5208', status: '0x1' })),
	}))
}

type RequestInterceptor = (request: EthereumJsonRpcRequest, requestAbortController: AbortController | undefined) => Promise<void>

// Each network answers from fixtures and records its requests, so a test can tell which client served a dapp request. An interceptor can hold or fail a request before it is answered.
function createNetworkServices(rpcEntry: RpcEntry) {
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

type NetworkServices = ReturnType<typeof createNetworkServices>

// Like the production owner, a reset retires the installed client before it publishes services for the next endpoint.
function createRecordingServicesOwner(initialNetwork: RpcEntry) {
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

const getSimulateV1Requests = (services: NetworkServices) => services.requests.flatMap((request) => request.method === 'eth_simulateV1' ? [request] : [])

// The made-rich address is read from the settings snapshot, so it shows which settings built the simulation input.
function getRichAddressesInSimulateV1Request(services: NetworkServices) {
	const [request, ...unexpectedRequests] = getSimulateV1Requests(services)
	if (request === undefined || unexpectedRequests.length > 0) throw new Error(`Expected one eth_simulateV1 request, received ${ unexpectedRequests.length + (request === undefined ? 0 : 1) }`)
	return request.params[0].blockStateCalls.flatMap((block) => Object.keys(block.stateOverrides ?? {}))
}

// Lists the state-override addresses of each eth_simulateV1 request; the made-rich active address identifies the settings behind it.
const getOverriddenAddressesPerSimulateV1Request = (services: NetworkServices) => getSimulateV1Requests(services).map((request) => request.params[0].blockStateCalls.flatMap((block) => Object.keys(block.stateOverrides ?? {})))

// The recipient of every call each network was asked to simulate, so a test can tell whose stack built the input.
const getSimulatedCallRecipients = (services: NetworkServices) => getSimulateV1Requests(services).flatMap((request) => request.params[0].blockStateCalls.flatMap((block) => (block.calls ?? []).flatMap((call) => typeof call.to === 'bigint' ? [call.to] : [])))

// The recipients mark which network's stack a simulated transaction was added to.
const STACKED_ON_A_RECIPIENT = 0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0n
const STACKED_ON_B_RECIPIENT = 0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0n
const STACKED_LATER_RECIPIENT = 0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0n
// Serialized messages carry addresses as hex text, so search for the marker without its prefix.
const containsAddress = (value: unknown, address: bigint) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? addressString(item) : item).toLowerCase().includes(address.toString(16))

// A simulated transaction as it is stored on the simulation stack.
function createStackedTransaction(transactionIdentifier: bigint, chainId: bigint, recipient: bigint) {
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

// One approved website connection whose port records the chainChanged notifications it receives.
function createApprovedConnection(websiteSocketToString: (socket: { readonly tabId: number, readonly connectionName: bigint }) => string) {
	const socket = { tabId: 1, connectionName: 0n }
	const { port, messages } = createPort(socket.tabId)
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
	} }]])
	return { websiteTabConnections, getChainChangedResults: () => messages.filter((message) => message.method === 'chainChanged').map((message) => message.result) }
}

// From now on the popup answers whether a simulation consumer, such as the main popup, is open; an open one makes global refreshes visualise the stack.
function reportSimulationConsumer(isOpen: boolean) {
	const originalSendMessage = browser.runtime.sendMessage.bind(browser.runtime)
	Object.defineProperty(browser.runtime, 'sendMessage', {
		configurable: true,
		value: async (message: unknown) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_isSimulationVisualizerOpen'
			? { method: 'popup_isSimulationVisualizerOpen', data: { isOpen } }
			: await originalSendMessage(message),
	})
}

async function createApprovedSimulationDapp({ simulationConsumerOpen = false, signerConfirmed = false }: { readonly simulationConsumerOpen?: boolean, readonly signerConfirmed?: boolean } = {}) {
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

// Subscribes the dapp to newHeads and delivers blocks through the real new-block handler; publishRpcConnectionStatus is the handler's first suspension point.
async function subscribeDappToNewBlocks(dapp: Awaited<ReturnType<typeof createApprovedSimulationDapp>>, simulationServicesOwner: SimulationServicesOwner, publishRpcConnectionStatus: PublishRpcConnectionStatus = noopPublishRpcConnectionStatus) {
	const { createNewBlockAttemptCallback } = await import('../../app/ts/background/newBlockHandling.js')
	const { createEthereumSubscription } = await import('../../app/ts/simulation/services/EthereumSubscriptionService.js')
	await createEthereumSubscription({ method: 'eth_subscribe', params: ['newHeads'] }, dapp.socket)
	const handleNewBlock = createNewBlockAttemptCallback({ getSimulationServices: simulationServicesOwner.getCurrent, publishRpcConnectionStatus, websiteTabConnections: dapp.websiteTabConnections })
	return {
		deliverNewBlock: async ({ ethereum }: NetworkServices) => await handleNewBlock(await ethereum.getBlock(undefined), ethereum, true),
		getNewHeads: () => dapp.messages.filter((message) => message.method === 'newHeads'),
	}
}

// The switch to network B cleared the simulation stack; the user then adds a transaction to B's stack before the paused request resumes.
async function addTransactionToNetworkBStack(modules: { readonly getInterceptorTransactionStack: () => Promise<{ readonly operations: readonly unknown[] }>, readonly updateInterceptorTransactionStack: (update: (stack: never) => { readonly operations: readonly ReturnType<typeof createStackedTransaction>[] }) => Promise<unknown> }) {
	assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(2n, networkB.chainId, STACKED_ON_B_RECIPIENT)] }))
}

// The confirmation refreshes below read A's snapshot, whose stack holds a transaction, after a switch to B stored B's own visualisation.
async function prepareNetworkARefreshAfterNetworkBVisualisation({ owner, installed, getInstalled }: ReturnType<typeof createRecordingServicesOwner>) {
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

// Resolves once the background sends a runtime message that matches, without changing its delivery.
function whenRuntimeMessageSent(matches: (message: unknown) => boolean) {
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

// A refresh with invalidateOldState publishes the shared visualisation as invalid before it computes the new one.
const isInvalidatedSharedVisualisation = (message: unknown) => isRecord(message)
	&& message.method === 'popup_simulation_state_changed'
	&& isRecord(message.data)
	&& isRecord(message.data.visualizedSimulatorState)
	&& message.data.visualizedSimulatorState.simulationResultState === 'invalid'

// Only A's stack visualisation identifies the recipient stacked on A, so this request belongs to that refresh.
const isNetworkAStackRecipientLookup = (request: EthereumJsonRpcRequest) => request.method === 'eth_getCode' && request.params[0] === STACKED_ON_A_RECIPIENT

// The stack visualisations sent to the confirmation window after the given number of runtime messages.
async function getConfirmationDialogVisualisations(runtimeMessages: readonly unknown[], messagesBefore: number) {
	const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
	return runtimeMessages.slice(messagesBefore).flatMap((message) => {
		const parsed = MessageToPopup.safeParse(message)
		if (!parsed.success || parsed.value.method !== 'popup_update_confirm_transaction_dialog') return []
		return [parsed.value.data.visualizedSimulatorState]
	})
}

// Holds the first storage read issued after arm() until released, without changing what it returns.
function createStorageReadPause() {
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

// Holds the first storage read of the key until released.
function pauseNextStorageReadOf(key: string) {
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

const readsStorageKey = (keys: unknown, key: string) => keys === key || (Array.isArray(keys) && keys.includes(key))

// Resolves once the given number of storage reads of the key have returned, counting from now.
function whenStorageReadsReturned(key: string, count: number) {
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

// The next read of the stored visualisation queues a read of the Gnosis Safe stacks while it holds the large state semaphore, so that read runs next and holds the semaphore, blocked, until released; anything queued after the visualisation read waits behind it.
function queueBlockedLargeStateReadAfterNextVisualisationRead(getSafeTransactionStacks: () => Promise<unknown>) {
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

// Counts the writes of the stored popup visualisation from now on.
function countPopupVisualisationWrites() {
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

// The simulated visualisations broadcast to popups in the given runtime messages.
async function getBroadcastSimulatedVisualisations(runtimeMessages: readonly unknown[]) {
	const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
	return runtimeMessages.flatMap((message) => {
		const parsed = MessageToPopup.safeParse(message)
		if (!parsed.success || parsed.value.method !== 'popup_simulation_state_changed') return []
		const { simulationState } = parsed.value.data.visualizedSimulatorState
		return simulationState.kind === 'simulated' ? [simulationState.value] : []
	})
}

// Holds a network switch inside the transition lock right after it has persisted the new network.
function pauseAfterActiveNetworkWrite() {
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

// Exports the current settings and returns an import request that selects the given network, and optionally a mode.
async function createImportRequest(exportSettingsAndAddressBook: () => Promise<ExportedSettings>, rpcNetwork: RpcEntry, simulationMode?: boolean) {
	const exported = await exportSettingsAndAddressBook()
	if (exported.version !== '1.6') throw new Error('Expected the current export version')
	const settings = { ...exported.settings, rpcNetwork, ...(simulationMode === undefined ? {} : { simulationMode }) }
	return { method: 'popup_import_settings', data: { fileContents: JSON.stringify(serialize(ExportedSettings, { ...exported, settings })) } } as const
}

// Rejects the first settings read after the active network was written, once.
function failFirstSettingsReadAfterNetworkWrite(error: Error) {
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

// After a transition that committed B and then failed, and after its retry, settings, services, stack and website notifications all describe B exactly once.
async function assertCommittedNetworkBEffects(
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

// Rejects the next storage writes that contain the key, as many times as given.
function failStorageWrites(key: string, times: number, error: Error) {
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

const failNextStorageWrite = (key: string, error: Error) => failStorageWrites(key, 1, error)

// Rejects the first storage read after a write that contains the key, once.
function failFirstStorageReadAfterWrite(key: string, error: Error) {
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

describe('network transition snapshot', () => {
	test('a retired client stays asleep and publishes no connection status when something tries to wake it', async () => {
		installBrowserMock()
		const { makeSureInterceptorIsNotSleeping } = await import('../../app/ts/background/sleeping.js')
		const { setRpcConnectionStatus } = await import('../../app/ts/background/storageVariables.js')
		const retired = createNetworkServices(networkA)
		const installed = createNetworkServices(networkB)
		// A stored status, so a wake-up of a sleeping client publishes one.
		await setRpcConnectionStatus({ isConnected: true, lastConnnectionAttempt: new Date(), rpcNetwork: networkB, latestBlock: undefined, retrying: false })
		const publishedStatuses: unknown[] = []
		const recordPublishedStatus: typeof noopPublishRpcConnectionStatus = async (_method, status) => { publishedStatuses.push(status) }
		try {
			retired.ethereum.cleanup()
			retired.ethereum.setBlockPolling(true)
			assert.equal(retired.ethereum.isBlockPolling(), false)
			await makeSureInterceptorIsNotSleeping(retired.ethereum, recordPublishedStatus)
			assert.equal(retired.ethereum.isBlockPolling(), false)
			assert.deepEqual(retired.requests, [])
			assert.deepEqual(publishedStatuses, [])

			await makeSureInterceptorIsNotSleeping(installed.ethereum, recordPublishedStatus)
			assert.equal(installed.ethereum.isBlockPolling(), true)
			assert.equal(publishedStatuses.length, 1)
		} finally {
			retired.ethereum.cleanup()
			installed.ethereum.cleanup()
		}
	})

	test('a request admitted before a network switch keeps the services, settings and stack it was admitted with', async () => {
		const { modules, sendEthSimulateV1, switchToNetworkB, assertRequestSucceeded } = await createApprovedSimulationDapp()
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		const readPause = createStorageReadPause()
		// Pause the request at its first storage read after it captured its services, then let the switch complete.
		const capturingOwner: SimulationServicesOwner = {
			...owner,
			getCurrent: () => {
				readPause.arm()
				return owner.getCurrent()
			},
		}
		try {
			const request = sendEthSimulateV1(capturingOwner)
			await readPause.started
			await switchToNetworkB(owner)
			await addTransactionToNetworkBStack(modules)
			const [servicesA, servicesB] = installed
			if (servicesA === undefined || servicesB === undefined) throw new Error('Expected the switch to install network B services')
			assert.equal(getInstalled(), servicesB)
			readPause.release()
			await request

			assertRequestSucceeded()
			// The stacked transaction adds a nonce and base fee preparation simulation; every simulation used the admitted settings.
			for (const overriddenAddresses of getOverriddenAddressesPerSimulateV1Request(servicesA)) assert.deepEqual(overriddenAddresses, [addressString(firstAddress)])
			assert.ok(getSimulatedCallRecipients(servicesA).includes(STACKED_ON_A_RECIPIENT))
			assert.ok(!getSimulatedCallRecipients(servicesA).includes(STACKED_ON_B_RECIPIENT))
			assert.deepEqual(getSimulateV1Requests(servicesB), [])
			// The request wakes only the client it runs on, which the switch retired, so neither client polls; the installed client is woken by work on its own network.
			assert.equal(servicesA.ethereum.isBlockPolling(), false)
			assert.equal(servicesB.ethereum.isBlockPolling(), false)
		} finally {
			readPause.release()
			retireAll()
		}
	})

	test.each([
		['eth_sendTransaction', false],
		['eth_sendRawTransaction', false],
		['eth_sendTransaction', true],
		['eth_sendRawTransaction', true],
	] as const)('a %s admitted before a network switch is prepared, simulated and shown with the network and stack it was admitted on (confirmation window open: %p)', async (method, simulationConsumerOpen) => {
		const { modules, sendDappRequest, switchToNetworkB } = await createApprovedSimulationDapp({ simulationConsumerOpen })
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const readPause = createStorageReadPause()
		// Pause the request at its first storage read after it captured its services, then let the switch complete.
		const capturingOwner: SimulationServicesOwner = {
			...owner,
			getCurrent: () => {
				readPause.arm()
				return owner.getCurrent()
			},
		}
		const transaction = { from: addressString(firstAddress), to: addressString(secondAddress), value: '0x0', data: '0x' }
		const rawTransaction = Transaction.prepare({ type: 'eip1559', chainId: networkA.chainId, nonce: 0n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n, gasLimit: 21_000n, to: transaction.to, value: 0n, data: '0x', accessList: [] }, false).signBy(rawTransactionSignerKey).toHex()
		try {
			const request = sendDappRequest(capturingOwner, method === 'eth_sendTransaction' ? { method, params: [transaction] } : { method, params: [rawTransaction] })
			await readPause.started
			await switchToNetworkB(owner)
			await addTransactionToNetworkBStack(modules)
			const [servicesA, servicesB] = installed
			if (servicesA === undefined || servicesB === undefined) throw new Error('Expected the switch to install network B services')
			readPause.release()
			await request

			const [pending] = await modules.getPendingTransactionsAndMessages()
			if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected a simulated pending transaction')
			if (!pending.transactionToSimulate.success) throw new Error('Expected the transaction to be prepared')
			assert.equal(pending.transactionToSimulate.transaction.chainId, networkA.chainId)
			const confirmationSimulation = pending.popupVisualisation
			if (confirmationSimulation.statusCode !== 'success') throw new Error('Expected the confirmation simulation to succeed')
			assert.equal(confirmationSimulation.data.simulationState.rpcNetwork.chainId, networkA.chainId)
			const confirmationOverrides = confirmationSimulation.data.simulationState.simulationStateInput.flatMap((block) => Object.keys(block.stateOverrides))
			assert.ok(confirmationOverrides.includes(addressString(firstAddress)))
			assert.ok(!confirmationOverrides.includes(addressString(secondAddress)))
			const confirmationRecipients = confirmationSimulation.data.simulationState.simulationStateInput.flatMap((block) => block.transactions.map((stacked) => stacked.signedTransaction.to))
			assert.ok(confirmationRecipients.includes(STACKED_ON_A_RECIPIENT))
			assert.ok(!confirmationRecipients.includes(STACKED_ON_B_RECIPIENT))
			assert.ok(getSimulatedCallRecipients(servicesA).includes(STACKED_ON_A_RECIPIENT))
			assert.ok(!getSimulatedCallRecipients(servicesA).includes(STACKED_ON_B_RECIPIENT))
			// Gas estimation runs only for eth_sendTransaction, so it adds a simulation before the confirmation simulation.
			const simulationsOnA = getOverriddenAddressesPerSimulateV1Request(servicesA)
			assert.ok(simulationsOnA.length >= (method === 'eth_sendTransaction' ? 2 : 1))
			for (const overriddenAddresses of simulationsOnA) {
				assert.ok(overriddenAddresses.includes(addressString(firstAddress)))
				assert.ok(!overriddenAddresses.includes(addressString(secondAddress)))
			}
			if (simulationConsumerOpen) {
				// The open window also shows B's own stack after the switch, simulated on B's client with B's settings.
				for (const overriddenAddresses of getOverriddenAddressesPerSimulateV1Request(servicesB)) assert.ok(!overriddenAddresses.includes(addressString(firstAddress)))
				assert.ok(!getSimulatedCallRecipients(servicesB).includes(STACKED_ON_A_RECIPIENT))
			} else {
				assert.deepEqual(getSimulateV1Requests(servicesB), [])
			}
		} finally {
			readPause.release()
			retireAll()
		}
	})

	test.each(['2.0.0', '1.0.1'] as const)('a simulation stack request for version %s admitted before a network switch replies with the stack it was admitted with', async (version) => {
		const { modules, socket, websiteTabConnections, sendDappRequest, switchToNetworkB, getReply } = await createApprovedSimulationDapp()
		const { getUpdatedSimulationStackSnapshot } = await import('../../app/ts/background/simulationUpdating.js')
		const { resolveFetchSimulationStackRequest } = await import('../../app/ts/background/windows/fetchSimulationStack.js')
		// Sharing decisions are remembered per stack, so each version shares a different stack.
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(version === '2.0.0' ? 1n : 3n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const stackRequest = { method: 'interceptor_getSimulationStack', params: [version] }
		const dialogOpened = createDeferredSignal()
		const originalCreateWindow = browser.windows.create.bind(browser.windows)
		Object.defineProperty(browser.windows, 'create', {
			configurable: true,
			value: async (...args: Parameters<typeof originalCreateWindow>) => {
				dialogOpened.resolve()
				return await originalCreateWindow(...args)
			},
		})
		const readPause = createStorageReadPause()
		const capturingOwner: SimulationServicesOwner = {
			...owner,
			getCurrent: () => {
				readPause.arm()
				return owner.getCurrent()
			},
		}
		try {
			// The user shares this stack once, so a later request for the same stack is answered without a dialog.
			const firstRequest = sendDappRequest(owner, stackRequest, 1)
			await dialogOpened.promise
			const [servicesA] = installed
			if (servicesA === undefined) throw new Error('Missing network A services')
			await resolveFetchSimulationStackRequest(await getUpdatedSimulationStackSnapshot(true, (await modules.readNetworkSnapshot(owner)).simulation), websiteTabConnections, {
				method: 'popup_fetchSimulationStackRequestConfirmation',
				data: { accept: true, simulationStackVersion: version, uniqueRequestIdentifier: { requestId: 1, requestSocket: socket } },
			})
			await firstRequest

			const secondRequest = sendDappRequest(capturingOwner, stackRequest, 2)
			await readPause.started
			await switchToNetworkB(owner)
			await addTransactionToNetworkBStack(modules)
			readPause.release()
			await secondRequest

			const result = getReply('interceptor_getSimulationStack', 2)?.result
			const reply = JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? addressString(value) : value).toLowerCase()
			assert.ok(reply.includes(addressString(STACKED_ON_A_RECIPIENT).toLowerCase()))
			assert.ok(!reply.includes(addressString(STACKED_ON_B_RECIPIENT).toLowerCase()))
			if (version === '1.0.1') {
				// Version 1.0.x lists the funding of the made-rich address first; the switch made B's active address the rich one.
				const funding = isRecord(result) && Array.isArray(result.payload) ? result.payload[0] : undefined
				assert.ok(isRecord(funding) && typeof funding.to === 'string')
				assert.equal(BigInt(funding.to), firstAddress)
			}
		} finally {
			readPause.release()
			retireAll()
		}
	})

	test('a simulated transaction confirmed after a network switch is not added to the new network stack', async () => {
		const { modules, websiteTabConnections, sendDappRequest, switchToNetworkB, getReply } = await createApprovedSimulationDapp()
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const accept = (uniqueRequestIdentifier: { readonly requestId: number, readonly requestSocket: { readonly tabId: number, readonly connectionName: bigint } }) => modules.confirmDialog(owner, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } })
		try {
			await sendDappRequest(owner, { method: 'eth_sendTransaction', params: [{ from: addressString(firstAddress), to: addressString(secondAddress), value: '0x0', data: '0x' }] })
			const [pending] = await modules.getPendingTransactionsAndMessages()
			if (pending?.type !== 'Transaction') throw new Error('Expected a pending transaction')
			await switchToNetworkB(owner)
			await addTransactionToNetworkBStack(modules)

			await accept(pending.uniqueRequestIdentifier)
			const networkBStack = await modules.getInterceptorTransactionStack()
			assert.deepEqual(networkBStack.operations.map((operation) => operation.type === 'Transaction' ? operation.preSimulationTransaction.signedTransaction.to : undefined), [STACKED_ON_B_RECIPIENT])
			const [stillPending] = await modules.getPendingTransactionsAndMessages()
			assert.equal(stillPending?.approvalStatus.status, 'SignerError')
			assert.equal(getReply('eth_sendTransaction', 1), undefined)

			// Back on its own network, the same confirmation joins that network's stack and answers the website.
			await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, activeAddress: firstAddress, rpcNetwork: networkA, promptForAccessesIfNeeded: false })
			await accept(pending.uniqueRequestIdentifier)
			const networkAStack = await modules.getInterceptorTransactionStack()
			assert.deepEqual(networkAStack.operations.map((operation) => operation.type === 'Transaction' ? operation.preSimulationTransaction.transactionIdentifier : undefined), [pending.transactionIdentifier])
			assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
			assert.notEqual(getReply('eth_sendTransaction', 1)?.result, undefined)
		} finally {
			retireAll()
		}
	})

	test('a block refresh after a network switch keeps a simulation-mode confirmation on the network it was admitted on', async () => {
		const { modules, websiteTabConnections, sendDappRequest, switchToNetworkB, getReply } = await createApprovedSimulationDapp()
		const { owner, retireAll, getInstalled } = createRecordingServicesOwner(networkA)
		try {
			await sendDappRequest(owner, { method: 'eth_sendTransaction', params: [{ from: addressString(firstAddress), to: addressString(secondAddress), value: '0x0', data: '0x' }] })
			const [pending] = await modules.getPendingTransactionsAndMessages()
			if (pending?.type !== 'Transaction') throw new Error('Expected a pending transaction')
			await switchToNetworkB(owner)
			const servicesB = getInstalled()

			// The confirmation window refreshes on every new block of the active network.
			await modules.refreshPopupConfirmTransactionSimulation(await modules.readNetworkSnapshot(owner))
			assert.equal(getSimulateV1Requests(servicesB).length, 0)
			const [afterRefresh] = await modules.getPendingTransactionsAndMessages()
			if (afterRefresh?.type !== 'Transaction') throw new Error('Expected a pending transaction')
			assert.equal(afterRefresh.simulationChainId, networkA.chainId)
			assert.deepEqual(afterRefresh.transactionToSimulate, pending.transactionToSimulate)

			await modules.confirmDialog(owner, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: pending.uniqueRequestIdentifier } })
			assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
			const [stillPending] = await modules.getPendingTransactionsAndMessages()
			assert.equal(stillPending?.approvalStatus.status, 'SignerError')
			assert.equal(getReply('eth_sendTransaction', 1), undefined)
		} finally {
			retireAll()
		}
	})

	test('a confirmation metadata refresh shows the stack captured with its settings and services', async () => {
		const { modules, websiteTabConnections, sendDappRequest, switchToNetworkB } = await createApprovedSimulationDapp()
		const { dispatchPopupMessage } = await import('../../app/ts/background/popupMessageDispatcher.js')
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const readPause = createStorageReadPause()
		const capturingOwner: SimulationServicesOwner = {
			...owner,
			getCurrent: () => {
				readPause.arm()
				return owner.getCurrent()
			},
		}
		try {
			await sendDappRequest(owner, { method: 'eth_sendTransaction', params: [{ from: addressString(firstAddress), to: addressString(secondAddress), value: '0x0', data: '0x' }] })
			const context: PopupMessageDispatcherContext = {
				websiteTabConnections,
				simulationServicesOwner: capturingOwner,
				settings: await modules.getSettings(),
				publishRpcConnectionStatus: noopPublishRpcConnectionStatus,
				simulationAbortController: new AbortController(),
				confirmTransactionAbortController: new AbortController(),
				resetSimulationState: async () => undefined,
			}
			const refresh = dispatchPopupMessage(context, { method: 'popup_refreshConfirmTransactionMetadata' })
			await readPause.started
			await switchToNetworkB(owner)
			await addTransactionToNetworkBStack(modules)
			const [servicesA] = installed
			if (servicesA === undefined) throw new Error('Missing network A services')
			const simulationsBeforeRefresh = getSimulateV1Requests(servicesA).length
			readPause.release()
			await refresh

			assert.ok(getSimulateV1Requests(servicesA).length > simulationsBeforeRefresh)
			assert.ok(getSimulatedCallRecipients(servicesA).includes(STACKED_ON_A_RECIPIENT))
			assert.ok(!getSimulatedCallRecipients(servicesA).includes(STACKED_ON_B_RECIPIENT))
		} finally {
			readPause.release()
			retireAll()
		}
	})

	test.each(['the first storage read after the operation joins the stack', 'the terminal reply write'] as const)('an accepted transaction whose confirmation fails at %s is confirmed once by a retry, with the hash of the stacked transaction', async (failurePoint) => {
		const { modules, websiteTabConnections, sendDappRequest, getReply, getReplies, createPopupContext } = await createApprovedSimulationDapp()
		const { dispatchPopupMessage } = await import('../../app/ts/background/popupMessageDispatcher.js')
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const accept = async (uniqueRequestIdentifier: { readonly requestId: number, readonly requestSocket: { readonly tabId: number, readonly connectionName: bigint } }) => await modules.confirmDialog(owner, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } })
		try {
			await sendDappRequest(owner, { method: 'eth_sendTransaction', params: [{ from: addressString(firstAddress), to: addressString(secondAddress), value: '0x0', data: '0x' }] })
			const [pending] = await modules.getPendingTransactionsAndMessages()
			if (pending?.type !== 'Transaction') throw new Error('Expected a pending transaction')
			const failure = new Error(`Injected failure at ${ failurePoint }`)
			if (failurePoint === 'the terminal reply write') failNextStorageWrite('pendingTerminalReplies', failure)
			else failFirstStorageReadAfterWrite('interceptorTransactionStack', failure)
			// A failure after the append may or may not end this attempt; the retry must finish it either way.
			await accept(pending.uniqueRequestIdentifier).catch((error: unknown) => assert.equal(error, failure))
			// A refresh before the retry would otherwise re-prepare the transaction against a stack that already holds it.
			await dispatchPopupMessage(await createPopupContext(owner), { method: 'popup_refreshConfirmTransactionDialogSimulation' })
			await accept(pending.uniqueRequestIdentifier)

			const stackedCopies = (await modules.getInterceptorTransactionStack()).operations.flatMap((operation) => operation.type === 'Transaction' && operation.preSimulationTransaction.transactionIdentifier === pending.transactionIdentifier ? [operation.preSimulationTransaction] : [])
			assert.equal(stackedCopies.length, 1)
			assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
			assert.equal(getReplies('eth_sendTransaction', 1).length, 1)
			const repliedHash = getReply('eth_sendTransaction', 1)?.result
			if (typeof repliedHash !== 'string') throw new Error('Expected the transaction hash in the reply')
			assert.equal(BigInt(repliedHash), stackedCopies[0]?.signedTransaction.hash)
		} finally {
			retireAll()
		}
	})

	test('an accept that captured another network and finishes after switching back shows the stack only with the installed services', async () => {
		const { modules, websiteTabConnections, sendDappRequest, switchToNetworkB, getReply } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const readPause = createStorageReadPause()
		const capturingOwner: SimulationServicesOwner = {
			...owner,
			getCurrent: () => {
				readPause.arm()
				return owner.getCurrent()
			},
		}
		try {
			await sendDappRequest(owner, { method: 'eth_sendTransaction', params: [{ from: addressString(firstAddress), to: addressString(secondAddress), value: '0x0', data: '0x' }] })
			const [pending] = await modules.getPendingTransactionsAndMessages()
			if (pending?.type !== 'Transaction') throw new Error('Expected a pending transaction')
			await switchToNetworkB(owner)
			const servicesB = installed[1]
			if (servicesB === undefined) throw new Error('Expected the switch to install network B services')
			// The accept captures B's settings and services, then waits while the user switches back to A.
			const acceptance = modules.confirmDialog(capturingOwner, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: pending.uniqueRequestIdentifier } })
			await readPause.started
			await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, activeAddress: firstAddress, rpcNetwork: networkA, promptForAccessesIfNeeded: false })
			readPause.release()
			await acceptance

			assert.notEqual(getReply('eth_sendTransaction', 1)?.result, undefined)
			assert.ok(!getSimulatedCallRecipients(servicesB).includes(secondAddress))
			const [servicesA] = installed.slice(-1)
			if (servicesA === undefined) throw new Error('Missing reinstalled network A services')
			assert.ok(getSimulatedCallRecipients(servicesA).includes(secondAddress))
		} finally {
			readPause.release()
			retireAll()
		}
	})

	test('a confirmation refresh that finishes after another network published its visualisation shows its own network', async () => {
		const { modules, runtimeMessages, sendDappRequest, switchToNetworkB, createPopupContext } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { dispatchPopupMessage } = await import('../../app/ts/background/popupMessageDispatcher.js')
		const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const readPause = createStorageReadPause()
		const capturingOwner: SimulationServicesOwner = {
			...owner,
			getCurrent: () => {
				readPause.arm()
				return owner.getCurrent()
			},
		}
		const getConfirmationDialogVisualisationChains = () => runtimeMessages.flatMap((message) => {
			const parsed = MessageToPopup.safeParse(message)
			if (!parsed.success || parsed.value.method !== 'popup_update_confirm_transaction_dialog') return []
			const simulationState = parsed.value.data.visualizedSimulatorState.simulationState
			// The dialog message nests its visualisation in serialized form, so normalise the chain id.
			return [simulationState.kind === 'simulated' ? BigInt(simulationState.value.rpcNetwork.chainId) : undefined]
		})
		try {
			await sendDappRequest(owner, { method: 'eth_sendTransaction', params: [{ from: addressString(firstAddress), to: addressString(secondAddress), value: '0x0', data: '0x' }] })
			const refresh = dispatchPopupMessage(await createPopupContext(capturingOwner), { method: 'popup_refreshConfirmTransactionDialogSimulation' })
			await readPause.started
			// With the window open, the switch publishes B's visualisation just before the A refresh resumes.
			await switchToNetworkB(owner)
			const dialogUpdatesBeforeRefresh = getConfirmationDialogVisualisationChains().length
			readPause.release()
			await refresh

			assert.deepEqual(getConfirmationDialogVisualisationChains().slice(dialogUpdatesBeforeRefresh), [networkA.chainId])
		} finally {
			readPause.release()
			retireAll()
		}
	})

	test('a typed data message whose domain names another chain is accepted on the network it was admitted on', async () => {
		const { modules, websiteTabConnections, sendDappRequest, getReply } = await createApprovedSimulationDapp()
		await modules.setRpcList([networkA, networkB])
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const typedData = {
			types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Mail: [{ name: 'contents', type: 'string' }] },
			primaryType: 'Mail',
			domain: { name: 'Mail', chainId: Number(networkB.chainId) },
			message: { contents: 'Hello' },
		}
		try {
			await sendDappRequest(owner, { method: 'eth_signTypedData_v4', params: [addressString(firstAddress), JSON.stringify(typedData)] })
			const [pending] = await modules.getPendingTransactionsAndMessages()
			if (pending?.type !== 'SignableMessage' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected a simulated message')
			// The confirmation shows the domain's chain, while the request was admitted on A.
			assert.equal(pending.visualizedPersonalSignRequest.rpcNetwork.chainId, networkB.chainId)
			await modules.confirmDialog(owner, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: pending.uniqueRequestIdentifier } })

			assert.notEqual(getReply('eth_signTypedData_v4', 1)?.result, undefined)
			assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
			assert.deepEqual((await modules.getInterceptorTransactionStack()).operations.map((operation) => operation.type), ['Message'])
		} finally {
			retireAll()
		}
	})

	test('a signing-mode message refreshed after a network switch is described on the active chain and warns that it is for another chain', async () => {
		const { modules, runtimeMessages, sendDappRequest, socket } = await createApprovedSimulationDapp({ signerConfirmed: true })
		await modules.setRpcList([networkA, networkB])
		await modules.changeSimulationMode({ simulationMode: false, activeSigningAddress: firstAddress, rpcNetwork: networkA })
		await modules.setUseSignersAddressAsActiveAddress(true, firstAddress)
		await modules.updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [firstAddress], activeSigningAddress: firstAddress }))
		const { owner, retireAll, getInstalled } = createRecordingServicesOwner(networkA)
		const typedData = {
			types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Mail: [{ name: 'contents', type: 'string' }] },
			primaryType: 'Mail',
			domain: { name: 'Mail', chainId: Number(networkA.chainId) },
			message: { contents: 'Hello' },
		}
		const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
		try {
			await sendDappRequest(owner, { method: 'eth_signTypedData_v4', params: [addressString(firstAddress), JSON.stringify(typedData)] })
			const [pending] = await modules.getPendingTransactionsAndMessages()
			if (pending?.type !== 'SignableMessage' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected a simulated message')
			assert.equal(pending.simulationMode, false)
			assert.equal(pending.visualizedPersonalSignRequest.quarantine, false)

			// The wallet follows the switch, so it would sign while chain B is active.
			await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: false, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
			const servicesB = getInstalled()
			const messagesBefore = runtimeMessages.length
			await modules.refreshPopupConfirmTransactionMetadata(await modules.readNetworkSnapshot(owner), undefined)

			const refreshedMessages = runtimeMessages.slice(messagesBefore).flatMap((message) => {
				const parsed = MessageToPopup.safeParse(message)
				if (!parsed.success || parsed.value.method !== 'popup_update_confirm_transaction_dialog_pending_transactions') return []
				const [first] = parsed.value.data.pendingTransactionAndSignableMessages
				return first?.type === 'SignableMessage' && first.transactionOrMessageCreationStatus === 'Simulated' ? [first.visualizedPersonalSignRequest] : []
			})
			assert.equal(refreshedMessages.length, 1)
			assert.equal(refreshedMessages[0]?.quarantine, true)
			assert.match(refreshedMessages[0]?.quarantineReasons.join(' ') ?? '', /different chain/u)
		} finally {
			retireAll()
		}
	})

	test.each(['switch', 'import'] as const)('a signing-mode %s to another chain drops the simulation stack before simulation is enabled there', async (kind) => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		try {
			if (kind === 'switch') await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: false, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
			else await modules.importSettings(owner, new Map(), await createImportRequest(modules.exportSettingsAndAddressBook, networkB, false))
			await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, promptForAccessesIfNeeded: false })

			const snapshot = await modules.readNetworkSnapshot(owner)
			assert.equal(snapshot.settings.simulationMode, true)
			assert.equal(snapshot.settings.activeRpcNetwork.chainId, networkB.chainId)
			assert.deepEqual(snapshot.simulation.interceptorTransactionStack.operations, [])
			assert.ok(!containsAddress(snapshot.simulation.simulationStateInput, STACKED_ON_A_RECIPIENT))
		} finally {
			retireAll()
		}
	})

	test('a confirmation refresh shows the visualisation of its captured stack, and leaves the shared visualisation on a newer stack published meanwhile', async () => {
		const { modules, runtimeMessages, sendDappRequest, createPopupContext } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { dispatchPopupMessage } = await import('../../app/ts/background/popupMessageDispatcher.js')
		const { updatePopupVisualisationIfNeeded } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const readPause = createStorageReadPause()
		const capturingOwner: SimulationServicesOwner = {
			...owner,
			getCurrent: () => {
				readPause.arm()
				return owner.getCurrent()
			},
		}
		const getMessages = (method: string) => runtimeMessages.filter((message) => typeof message === 'object' && message !== null && 'method' in message && message.method === method)
		const getDialogUpdates = () => getMessages('popup_update_confirm_transaction_dialog')
		const getSharedVisualisationBroadcasts = () => getMessages('popup_simulation_state_changed')
		try {
			await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
			await sendDappRequest(owner, { method: 'eth_sendTransaction', params: [{ from: addressString(firstAddress), to: addressString(secondAddress), value: '0x0', data: '0x' }] })
			const [servicesA] = installed
			if (servicesA === undefined) throw new Error('Missing network A services')
			const refresh = dispatchPopupMessage(await createPopupContext(capturingOwner), { method: 'popup_refreshConfirmTransactionDialogSimulation' })
			await readPause.started
			// Another operation changes the same chain's stack and publishes its visualisation while the refresh waits.
			await modules.updateInterceptorTransactionStack((stack) => ({ operations: [...stack.operations, createStackedTransaction(5n, networkA.chainId, STACKED_LATER_RECIPIENT)] }))
			await updatePopupVisualisationIfNeeded(servicesA.ethereum, servicesA.tokenPriceService, { invalidateOldState: true })
			const newerVisualisation = await modules.getPopupVisualisationState()
			assert.ok(containsAddress(newerVisualisation, STACKED_LATER_RECIPIENT))
			const dialogUpdatesBeforeRefresh = getDialogUpdates().length
			const broadcastsBeforeRefresh = getSharedVisualisationBroadcasts().length
			readPause.release()
			await refresh

			const refreshUpdates = getDialogUpdates().slice(dialogUpdatesBeforeRefresh)
			assert.ok(refreshUpdates.length > 0)
			for (const update of refreshUpdates) {
				assert.ok(containsAddress(update, STACKED_ON_A_RECIPIENT))
				assert.ok(!containsAddress(update, STACKED_LATER_RECIPIENT))
			}
			// The confirmation's older stack neither replaces nor is broadcast as the shared visualisation.
			assert.deepEqual(await modules.getPopupVisualisationState(), newerVisualisation)
			assert.deepEqual(getSharedVisualisationBroadcasts().slice(broadcastsBeforeRefresh), [])
		} finally {
			readPause.release()
			retireAll()
		}
	})

	test.each(['dialog simulation', 'metadata'] as const)('a confirmation %s refresh whose visualisation fails to fetch shows no visualisation instead of the one another network stored', async (path) => {
		const recordingOwner = createRecordingServicesOwner(networkA)
		try {
			const { runtimeMessages, servicesA, refreshConfirmation } = await prepareNetworkARefreshAfterNetworkBVisualisation(recordingOwner)
			servicesA.interceptRequests(async (request) => {
				if (isNetworkAStackRecipientLookup(request)) throw new Error('Failed to fetch')
			})
			const messagesBeforeRefresh = runtimeMessages.length
			await refreshConfirmation[path]()

			const visualisations = await getConfirmationDialogVisualisations(runtimeMessages, messagesBeforeRefresh)
			assert.equal(visualisations.length, 1)
			for (const visualisation of visualisations) {
				assert.ok(!containsAddress(visualisation, STACKED_ON_B_RECIPIENT))
				assert.deepEqual([visualisation.simulationUpdatingState, visualisation.simulationResultState], ['failed', 'invalid'])
			}
		} finally {
			recordingOwner.retireAll()
		}
	})

	test('a confirmation dialog simulation refresh with no simulation consumer open computes the visualisation of its own snapshot', async () => {
		const recordingOwner = createRecordingServicesOwner(networkA)
		try {
			const { runtimeMessages, servicesA, refreshConfirmation } = await prepareNetworkARefreshAfterNetworkBVisualisation(recordingOwner)
			// Only the confirmation window is open, and it does not answer the probe for the main popup.
			reportSimulationConsumer(false)
			const simulationsOnA = getSimulateV1Requests(servicesA).length
			const messagesBeforeRefresh = runtimeMessages.length
			await refreshConfirmation['dialog simulation']()

			assert.ok(getSimulateV1Requests(servicesA).length > simulationsOnA)
			const visualisations = await getConfirmationDialogVisualisations(runtimeMessages, messagesBeforeRefresh)
			assert.equal(visualisations.length, 1)
			for (const visualisation of visualisations) {
				assert.ok(!containsAddress(visualisation, STACKED_ON_B_RECIPIENT))
				assert.ok(containsAddress(visualisation, STACKED_ON_A_RECIPIENT))
			}
		} finally {
			recordingOwner.retireAll()
		}
	})

	test('a confirmation metadata refresh that another network refresh supersedes while it computes still shows its own visualisation', async () => {
		const recordingOwner = createRecordingServicesOwner(networkA)
		try {
			const { runtimeMessages, servicesA, refreshConfirmation, refreshNetworkB } = await prepareNetworkARefreshAfterNetworkBVisualisation(recordingOwner)
			const lookupStarted = createDeferredSignal()
			const releaseLookup = createDeferredSignal()
			servicesA.interceptRequests(async (request) => {
				if (!isNetworkAStackRecipientLookup(request)) return
				lookupStarted.resolve()
				await releaseLookup.promise
			})
			const invalidationPublished = whenRuntimeMessageSent(isInvalidatedSharedVisualisation)
			const messagesBeforeRefresh = runtimeMessages.length
			const refresh = refreshConfirmation.metadata()
			await lookupStarted.promise
			// B's refresh invalidates the shared visualisation under a newer id in the serialized section, so it does so once A's computation has finished.
			const superseding = refreshNetworkB()
			releaseLookup.resolve()
			await Promise.all([refresh, superseding, invalidationPublished])

			const visualisations = await getConfirmationDialogVisualisations(runtimeMessages, messagesBeforeRefresh)
			assert.equal(visualisations.length, 1)
			for (const visualisation of visualisations) {
				assert.ok(!containsAddress(visualisation, STACKED_ON_B_RECIPIENT))
				assert.ok(containsAddress(visualisation, STACKED_ON_A_RECIPIENT))
			}
		} finally {
			recordingOwner.retireAll()
		}
	})

	test('a confirmation metadata refresh shows its own visualisation even when another network publishes one before the refresh returns', async () => {
		const recordingOwner = createRecordingServicesOwner(networkA)
		try {
			const { runtimeMessages, refreshConfirmation, refreshNetworkB } = await prepareNetworkARefreshAfterNetworkBVisualisation(recordingOwner)
			const { computeSnapshotVisualisation } = await import('../../app/ts/background/popupVisualisationUpdater.js')
			const messagesBeforeRefresh = runtimeMessages.length
			await refreshConfirmation.metadata({
				compute: async (...parameters: Parameters<typeof computeSnapshotVisualisation>) => {
					const visualisation = await computeSnapshotVisualisation(...parameters)
					// The metadata refresh cannot be cancelled, so B's refresh runs once A's has computed and before A's caller has returned.
					await refreshNetworkB()
					return visualisation
				},
			})

			const visualisations = await getConfirmationDialogVisualisations(runtimeMessages, messagesBeforeRefresh)
			assert.equal(visualisations.length, 1)
			for (const visualisation of visualisations) {
				assert.ok(!containsAddress(visualisation, STACKED_ON_B_RECIPIENT))
				assert.ok(containsAddress(visualisation, STACKED_ON_A_RECIPIENT))
			}
		} finally {
			recordingOwner.retireAll()
		}
	})

	test.each(['simulated', 'failed to simulate'] as const)('a stack visualisation of A that is %s and finishes after a switch to B describes its messages and transactions on A', async (outcome) => {
		const { modules, websiteTabConnections, sendDappRequest, switchToNetworkB } = await createApprovedSimulationDapp()
		const { getUpdatedSimulationState, visualizeSimulatorState } = await import('../../app/ts/background/simulationUpdating.js')
		await modules.setRpcList([networkA, networkB])
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		// On A the typed data domain names the active chain, so the message needs no chain quarantine there.
		const typedData = {
			types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Mail: [{ name: 'contents', type: 'string' }] },
			primaryType: 'Mail',
			domain: { name: 'Mail', chainId: Number(networkA.chainId) },
			message: { contents: 'Hello' },
		}
		try {
			const [servicesA] = installed
			if (servicesA === undefined) throw new Error('Missing network A services')
			await sendDappRequest(owner, { method: 'eth_signTypedData_v4', params: [addressString(firstAddress), JSON.stringify(typedData)] }, 1)
			await sendDappRequest(owner, { method: 'personal_sign', params: ['0x68656c6c6f', addressString(firstAddress)] }, 2)
			for (const pending of await modules.getPendingTransactionsAndMessages()) {
				await modules.confirmDialog(owner, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: pending.uniqueRequestIdentifier } })
			}
			await modules.updateInterceptorTransactionStack((stack) => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT), ...stack.operations] }))
			const { simulation } = await modules.readNetworkSnapshot(owner)
			if (outcome === 'failed to simulate') servicesA.interceptRequests(async (request) => {
				if (request.method === 'eth_simulateV1') throw new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Injected simulation failure' } })
			})
			const simulationState = await getUpdatedSimulationState(simulation)
			if (simulationState.kind !== 'simulated') throw new Error('Expected A to be simulated')
			assert.equal(simulationState.value.success, outcome === 'simulated')
			await switchToNetworkB(owner)
			const visualised = await visualizeSimulatorState(simulationState.value, servicesA.ethereum, servicesA.tokenPriceService, undefined)

			const visualizedBlocks = visualised.visualizedSimulationState.visualizedBlocks
			const messages = visualizedBlocks.flatMap((block) => block.visualizedPersonalSignRequests)
			assert.deepEqual(messages.map((message) => [message.method, message.rpcNetwork.chainId, message.quarantine]), [['eth_signTypedData_v4', networkA.chainId, false], ['personal_sign', networkA.chainId, false]])
			const transactions = visualizedBlocks.flatMap((block) => block.simulatedAndVisualizedTransactions)
			assert.deepEqual(transactions.map((transaction) => transaction.transaction.rpcNetwork.chainId), [networkA.chainId])
		} finally {
			retireAll()
		}
	})

	test.each(['transaction', 'message'] as const)('a confirmation metadata refresh after a switch does not enrich the pending %s of the previous network', async (kind) => {
		const { modules, runtimeMessages, sendDappRequest, switchToNetworkB, createPopupContext } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { dispatchPopupMessage } = await import('../../app/ts/background/popupMessageDispatcher.js')
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		try {
			if (kind === 'transaction') await sendDappRequest(owner, { method: 'eth_sendTransaction', params: [{ from: addressString(firstAddress), to: addressString(secondAddress), value: '0x0', data: '0x' }] })
			else await sendDappRequest(owner, { method: 'personal_sign', params: ['0x68656c6c6f', addressString(firstAddress)] })
			await switchToNetworkB(owner)
			const servicesB = installed[1]
			if (servicesB === undefined) throw new Error('Expected the switch to install network B services')
			const pendingBeforeRefresh = await modules.getPendingTransactionsAndMessages()
			const [pending] = pendingBeforeRefresh
			if (pending?.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected a request simulated on A')
			if (pending.type === 'Transaction') {
				if (pending.popupVisualisation.statusCode !== 'success') throw new Error('Expected a successful simulation on A')
				assert.equal(pending.popupVisualisation.data.simulationState.rpcNetwork.chainId, networkA.chainId)
			} else {
				assert.equal(pending.simulationChainId, networkA.chainId)
			}
			const requestsBeforeRefresh = servicesB.requests.length
			const messagesBeforeRefresh = runtimeMessages.length
			await dispatchPopupMessage(await createPopupContext(owner), { method: 'popup_refreshConfirmTransactionMetadata' })

			// B's services looked nothing up for A's request, and nothing mixing the two networks was stored or sent.
			assert.deepEqual(servicesB.requests.slice(requestsBeforeRefresh).filter((request) => request.method === 'eth_getCode'), [])
			assert.deepEqual(await modules.getPendingTransactionsAndMessages(), pendingBeforeRefresh)
			assert.ok(!runtimeMessages.slice(messagesBeforeRefresh).some((message) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_update_confirm_transaction_dialog_pending_transactions'))
		} finally {
			retireAll()
		}
	})

	test('a popup refresh that still holds the previous network services neither simulates the new network stack on them nor replaces its visualisation', async () => {
		const { modules, switchToNetworkB } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { updatePopupVisualisationIfNeeded } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		try {
			const [servicesA] = installed
			if (servicesA === undefined) throw new Error('Missing network A services')
			await switchToNetworkB(owner)
			await addTransactionToNetworkBStack(modules)
			const servicesB = installed[1]
			if (servicesB === undefined) throw new Error('Expected the switch to install network B services')
			await updatePopupVisualisationIfNeeded(servicesB.ethereum, servicesB.tokenPriceService, { invalidateOldState: true })
			const visualisationOfB = await modules.getPopupVisualisationState()
			const simulationsOnA = getSimulateV1Requests(servicesA).length

			// A popup handler captured A's services just before the switch and refreshes with the settings stored now.
			await updatePopupVisualisationIfNeeded(servicesA.ethereum, servicesA.tokenPriceService, { invalidateOldState: true })

			assert.equal(getSimulateV1Requests(servicesA).length, simulationsOnA)
			assert.deepEqual(await modules.getPopupVisualisationState(), visualisationOfB)
		} finally {
			retireAll()
		}
	})

	test('a confirmation window opened after a switch bootstraps without the previous network visualisation', async () => {
		const { modules, sendDappRequest, switchToNetworkB, createPopupContext } = await createApprovedSimulationDapp()
		const { dispatchPopupMessage } = await import('../../app/ts/background/popupMessageDispatcher.js')
		const { updatePopupVisualisationState } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		try {
			const [servicesA] = installed
			if (servicesA === undefined) throw new Error('Missing network A services')
			// A's visualisation is cached, and with no consumer open the switch leaves it in place.
			await updatePopupVisualisationState(servicesA.ethereum, servicesA.tokenPriceService, undefined, true)
			assert.ok(containsAddress(await modules.getPopupVisualisationState(), STACKED_ON_A_RECIPIENT))
			await switchToNetworkB(owner)
			assert.ok(containsAddress(await modules.getPopupVisualisationState(), STACKED_ON_A_RECIPIENT))
			await sendDappRequest(owner, { method: 'eth_sendTransaction', params: [{ from: addressString(secondAddress), to: addressString(firstAddress), value: '0x0', data: '0x' }] })

			const reply = await dispatchPopupMessage(await createPopupContext(owner), { method: 'popup_readyAndListening', data: { page: 'confirmTransaction' } })
			if (reply === undefined || !('method' in reply) || reply.method !== 'popup_readyAndListening') throw new Error('Expected a confirmation bootstrap')
			const visualisation = reply.data.confirmTransactionBootstrap?.visualizedSimulatorState
			assert.ok(!containsAddress(visualisation, STACKED_ON_A_RECIPIENT))
			// The switch cleared the stack, so B's own visualisation is its defined empty state.
			if (visualisation?.simulationState.kind !== 'simulated') throw new Error('Expected B to be simulated')
			assert.equal(visualisation.simulationState.value.rpcNetwork.chainId, networkB.chainId)
		} finally {
			retireAll()
		}
	})

	test.each(['switch', 'import'] as const)('a %s whose stack clearing write fails once still clears the stack before the lock is released', async (kind) => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const { websiteTabConnections, getChainChangedResults } = createApprovedConnection(modules.websiteSocketToString)
		const importRequest = await createImportRequest(modules.exportSettingsAndAddressBook, networkB)
		const commitNetworkB = async () => kind === 'switch'
			? await modules.changeActiveAddressAndChain(owner, websiteTabConnections, { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
			: await modules.importSettings(owner, websiteTabConnections, importRequest)
		try {
			const failure = new Error('Injected stack clearing failure')
			failStorageWrites('interceptorTransactionStack', 1, failure)
			await assert.rejects(commitNetworkB(), (error) => error === failure)
			await assertCommittedNetworkBEffects(modules, owner, getChainChangedResults, 0)

			await commitNetworkB()
			await assertCommittedNetworkBEffects(modules, owner, getChainChangedResults, 0)
		} finally {
			retireAll()
		}
	})

	test.each([2, 3])('a switch whose stack clearing write fails %d times is completed by a later snapshot read before it admits the new network', async (failures) => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const { websiteTabConnections, getChainChangedResults } = createApprovedConnection(modules.websiteSocketToString)
		try {
			const failure = new Error('Injected stack clearing failure')
			failStorageWrites('interceptorTransactionStack', failures, failure)
			await assert.rejects(modules.changeActiveAddressAndChain(owner, websiteTabConnections, { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false }), (error) => error === failure)
			// The in-lock retry failed too: A's stack is still stored and websites have not been told about B yet.
			assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 1)
			assert.deepEqual(getChainChangedResults(), [])
			// While the repair keeps failing, the uncleared stack of A is not admitted as B's: the read still serves B's settings and services, and its simulation names the unfinished network change rather than reporting the bare write failure as its own.
			if (failures === 3) {
				const network = await modules.readNetworkSnapshot(owner)
				const { settings, simulation } = network
				const services = network.services
				assert.equal(settings.activeRpcNetwork.chainId, networkB.chainId)
				assert.equal(services.ethereum.getRpcEntry().chainId, networkB.chainId)
				assert.equal(simulation.kind, 'unavailable')
				assert.ok(simulation.kind === 'unavailable' && simulation.error instanceof Error && simulation.error.message.startsWith('An earlier network change committed its settings but could not finish applying them') && simulation.error.message.endsWith(failure.message))
			}
			await assertCommittedNetworkBEffects(modules, owner, getChainChangedResults, 0)
		} finally {
			retireAll()
		}
	})

	test('a chain switch tells websites after it installed the services and cleared the stack, and before it releases the lock', async () => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const recording = createRecordingServicesOwner(networkA)
		const events: string[] = []
		const owner: SimulationServicesOwner = { getCurrent: recording.owner.getCurrent, reset: (rpcNetwork) => { events.push('services installed'); return recording.owner.reset(rpcNetwork) } }
		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const websiteTabConnections = new Map([[socket.tabId, { connections: { [modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true } } }]])
		let readAfterTheLock: Promise<void> | undefined
		const postMessage = port.postMessage.bind(port)
		port.postMessage = (message) => {
			if (message.method === 'chainChanged' || message.method === 'accountsChanged') events.push(`website: ${ message.method }`)
			// This read queues on the lock while the notifications run, so it finishes only once the transition released it.
			readAfterTheLock ??= modules.readNetworkSnapshot(owner).then(() => { events.push('lock released') })
			postMessage(message)
		}
		const originalSet = browser.storage.local.set.bind(browser.storage.local)
		Object.defineProperty(browser.storage.local, 'set', { configurable: true, value: async (items: Record<string, unknown>) => {
			await originalSet(items)
			if ('interceptorTransactionStack' in items) events.push('stack cleared')
		} })
		try {
			await modules.changeActiveAddressAndChain(owner, websiteTabConnections, { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
			await readAfterTheLock
			assert.deepEqual(events, ['services installed', 'stack cleared', 'website: chainChanged', 'website: accountsChanged', 'lock released'])
		} finally {
			Object.defineProperty(browser.storage.local, 'set', { configurable: true, value: originalSet })
			recording.retireAll()
		}
	})

	test('a repair applies the network change effects in the order of a first application', async () => {
		const { getCommittedNetworkChangeGeneration } = await import('../../app/ts/background/networkChangeGeneration.js')
		// Records each effect once it took place: the generation advance is seen at the next recorded step, the others as they happen.
		const recordNetworkChange = async (installationFailuresBeforeSuccess: number) => {
			installBrowserMock()
			const modules = await loadModules()
			await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
			await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
			await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
			const recording = createRecordingServicesOwner(networkA)
			const events: string[] = []
			const generationBefore = getCommittedNetworkChangeGeneration()
			const record = (event: string) => {
				if (!events.includes('snapshots retired') && getCommittedNetworkChangeGeneration() > generationBefore) events.push('snapshots retired')
				events.push(event)
			}
			let remainingInstallationFailures = installationFailuresBeforeSuccess
			const owner: SimulationServicesOwner = {
				getCurrent: recording.owner.getCurrent,
				reset: (rpcNetwork) => {
					if (remainingInstallationFailures > 0) {
						remainingInstallationFailures -= 1
						record('installation failed')
						throw new Error('Injected installation failure')
					}
					record('services installed')
					return recording.owner.reset(rpcNetwork)
				},
			}
			const socket = { tabId: 1, connectionName: 0n }
			const { port } = createPort(socket.tabId)
			const websiteTabConnections = new Map([[socket.tabId, { connections: { [modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true } } }]])
			const postMessage = port.postMessage.bind(port)
			port.postMessage = (message) => {
				if (message.method === 'chainChanged') record('websites told the chain')
				postMessage(message)
			}
			const originalSet = browser.storage.local.set.bind(browser.storage.local)
			Object.defineProperty(browser.storage.local, 'set', { configurable: true, value: async (items: Record<string, unknown>) => {
				await originalSet(items)
				if ('interceptorTransactionStack' in items) record('stack cleared')
			} })
			const originalSendMessage = browser.runtime.sendMessage.bind(browser.runtime)
			Object.defineProperty(browser.runtime, 'sendMessage', { configurable: true, value: async (message: unknown) => {
				if (typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_chain_update') record('popups told the chain')
				return await originalSendMessage(message)
			} })
			try {
				const change = modules.changeActiveAddressAndChain(owner, websiteTabConnections, { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
				if (installationFailuresBeforeSuccess === 0) await change
				else await assert.rejects(change, /Injected installation failure/u)
				// The next lock holder repairs what the failed transition left.
				await modules.readNetworkSnapshot(owner)
			} finally {
				Object.defineProperty(browser.storage.local, 'set', { configurable: true, value: originalSet })
				Object.defineProperty(browser.runtime, 'sendMessage', { configurable: true, value: originalSendMessage })
				recording.retireAll()
			}
			return events.filter((event) => event !== 'installation failed')
		}

		const firstApplication = await recordNetworkChange(0)
		// The transition retries once inside the lock, so two failures leave the change to the repair of the next read.
		const repaired = await recordNetworkChange(2)
		assert.deepEqual(firstApplication, ['snapshots retired', 'services installed', 'stack cleared', 'websites told the chain', 'popups told the chain'])
		assert.deepEqual(repaired, firstApplication)
	})

	test('a website notification that throws leaves the change unfinished, and its repair delivers the chain once', async () => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connection = { port, socket, websiteOrigin, approved: true, wantsToConnect: true }
		const brokenConnections: Record<string, typeof connection | undefined> = { broken: undefined, [modules.websiteSocketToString(socket)]: connection }
		const websiteTabConnections = new Map([[socket.tabId, { connections: brokenConnections }]])
		try {
			await assert.rejects(modules.changeActiveAddressAndChain(owner, websiteTabConnections, { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false }), /missing connection/u)
			const unfinished = await modules.readNetworkSnapshot(owner)
			assert.deepEqual(unfinished.settings.activeRpcNetwork, networkB)
			assert.equal(unfinished.simulation.kind, 'unavailable')
			assert.deepEqual(messages.filter((message) => message.method === 'chainChanged'), [])

			delete brokenConnections.broken
			assert.equal((await modules.readNetworkSnapshot(owner)).simulation.kind, 'loaded')
			assert.deepEqual(messages.filter((message) => message.method === 'chainChanged').map((message) => message.result), ['0xa'])
			// The repair owes only the change's own effects; the account notification belongs to the transition that failed.
			assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged'), [])
		} finally {
			retireAll()
		}
	})

	test('a network switch releases the transition lock before its popup simulation runs, so requests do not wait for that simulation', async () => {
		const { modules, switchToNetworkB } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const recording = createRecordingServicesOwner(networkA)
		const simulationStarted = createDeferredSignal()
		const releaseSimulation = createDeferredSignal()
		// Services installed by the switch hold their first simulation until the test releases it.
		const owner: SimulationServicesOwner = {
			getCurrent: recording.owner.getCurrent,
			reset: (rpcNetwork) => {
				const services = recording.owner.reset(rpcNetwork)
				recording.getInstalled().interceptRequests(async (request) => {
					if (request.method !== 'eth_simulateV1') return
					simulationStarted.resolve()
					await releaseSimulation.promise
				})
				return services
			},
		}
		let deadline: ReturnType<typeof setTimeout> | undefined
		try {
			const switching = switchToNetworkB(owner)
			await simulationStarted.promise
			const snapshot = await Promise.race([
				modules.readNetworkSnapshot(owner),
				new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('The snapshot read waited for the popup simulation')), 1000) }),
			])
			assert.equal(snapshot.settings.activeRpcNetwork.chainId, networkB.chainId)
			releaseSimulation.resolve()
			await switching
		} finally {
			clearTimeout(deadline)
			releaseSimulation.resolve()
			recording.retireAll()
		}
	})

	test('a home data refresh that a network switch interrupts sends a home page of the new network only, built and woken on its client', async () => {
		const { modules, runtimeMessages, websiteTabConnections } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { refreshHomeData } = await import('../../app/ts/background/popupMessageHandlers.js')
		const { updateTransactionState } = await import('../../app/ts/background/storageVariables.js')
		const { createSafeTx } = await import('../../app/ts/safe/safeCore.js')
		const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
		// A Safe stack on A's chain: a home page built with A's client reports it as exportable, one built with B's does not.
		await updateTransactionState((previousState) => ({
			...previousState,
			safeTransactionStacks: [{
				chainId: networkA.chainId,
				safeAddress: firstAddress,
				safeVersion: '1.4.1',
				baseNonce: 0n,
				threshold: 1n,
				transactions: [{
					safeTx: createSafeTx(networkA.chainId, firstAddress, { to: secondAddress, value: 0n, input: new Uint8Array() }, 0n),
					safeTxHash: 0n,
					created: new Date('2024-01-01T00:00:00.000Z'),
					websiteOrigin,
					transactionIdentifier: 1n,
					signatures: [],
				}],
			}],
		}))
		const { owner, installed, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		const [servicesA] = installed
		if (servicesA === undefined) throw new Error('Missing network A services')
		const requestOnAStarted = createDeferredSignal()
		const releaseRequestOnA = createDeferredSignal()
		servicesA.interceptRequests(async () => {
			servicesA.interceptRequests(undefined)
			requestOnAStarted.resolve()
			await releaseRequestOnA.promise
		})
		let deadline: ReturnType<typeof setTimeout> | undefined
		try {
			const messagesBefore = runtimeMessages.length
			const refresh = refreshHomeData(owner, websiteTabConnections, false, noopPublishRpcConnectionStatus)
			await Promise.race([
				requestOnAStarted.promise,
				new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('The refresh sent no request to network A')), 1000) }),
			])
			// The switch commits B and announces its chain while A's request is held; its own popup refresh then queues behind the held refresh.
			const chainAnnounced = whenRuntimeMessageSent((message) => isRecord(message) && message.method === 'popup_chain_update')
			const switching = modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
			await chainAnnounced
			// B's stack gains a transaction before A's refresh resumes, so a refresh that publishes for A afterwards would show B's stack or a stale network.
			await addTransactionToNetworkBStack(modules)
			const messagesBeforeResume = runtimeMessages.length
			releaseRequestOnA.resolve()
			await Promise.all([switching, refresh])
			assert.equal(getSimulatedCallRecipients(servicesA).includes(STACKED_ON_B_RECIPIENT), false)
			for (const visualisation of await getBroadcastSimulatedVisualisations(runtimeMessages.slice(messagesBeforeResume))) assert.equal(visualisation.rpcNetwork.chainId, networkB.chainId)

			const homePages = runtimeMessages.slice(messagesBefore).flatMap((message) => {
				const parsed = MessageToPopup.safeParse(message)
				return parsed.success && parsed.value.method === 'popup_UpdateHomePage' ? [parsed.value.data] : []
			})
			assert.ok(homePages.length > 0)
			for (const homePage of homePages) {
				assert.equal(homePage.settings.activeRpcNetwork.chainId, networkB.chainId)
				assert.equal(homePage.hasSafeTransactionsToExport, false)
			}
			assert.deepEqual(getInstalled().ethereum.getRpcEntry(), networkB)
			assert.equal(getInstalled().ethereum.isBlockPolling(), true)
			assert.equal(servicesA.ethereum.isBlockPolling(), false)
		} finally {
			clearTimeout(deadline)
			releaseRequestOnA.resolve()
			retireAll()
		}
	})

	test('a home data refresh that a same-network stack change interrupts leaves the shared visualisation on the changed stack', async () => {
		const { modules, runtimeMessages, websiteTabConnections, sendDappRequest } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { refreshHomeData } = await import('../../app/ts/background/popupMessageHandlers.js')
		const { updatePopupVisualisationIfNeeded } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const [servicesA] = installed
		if (servicesA === undefined) throw new Error('Missing network A services')
		// The stored visualisation simulates the stack, so the refresh's metadata update looks up its addresses.
		await updatePopupVisualisationIfNeeded(servicesA.ethereum, servicesA.tokenPriceService, { invalidateOldState: true })
		await sendDappRequest(owner, { method: 'eth_sendTransaction', params: [{ from: addressString(firstAddress), to: addressString(secondAddress), value: '0x0', data: '0x' }] })
		const [pending] = await modules.getPendingTransactionsAndMessages()
		if (pending?.type !== 'Transaction') throw new Error('Expected a pending transaction')
		const countStackedTransactions = (visualisation: { readonly simulationStateInput: readonly { readonly transactions: readonly unknown[] }[] }) => visualisation.simulationStateInput.reduce((count, block) => count + block.transactions.length, 0)
		const acceptSimulationStarted = createDeferredSignal()
		let addressBookRead: ReturnType<typeof pauseNextStorageReadOf> | undefined
		let deadline: ReturnType<typeof setTimeout> | undefined
		try {
			// The refresh reads its snapshot of the one-transaction stack, then pauses in its metadata update while it looks up the stored visualisation's addresses.
			addressBookRead = pauseNextStorageReadOf('userAddressBookEntriesV3')
			const refresh = refreshHomeData(owner, websiteTabConnections, false, noopPublishRpcConnectionStatus)
			await Promise.race([
				addressBookRead.started,
				new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('The metadata update read no address book entries')), 1000) }),
			])
			// Accepting the request appends it to the same network's stack, then refreshes the shared visualisation from that stack; no network change commits, so the generation stays the same.
			const acceptRefreshProbed = whenRuntimeMessageSent((message) => isRecord(message) && message.method === 'popup_isSimulationVisualizerOpen')
			const acceptance = modules.confirmDialog(owner, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: pending.uniqueRequestIdentifier } })
			await acceptRefreshProbed
			assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 2)
			servicesA.interceptRequests(async (request) => {
				if (request.method !== 'eth_simulateV1') return
				servicesA.interceptRequests(undefined)
				acceptSimulationStarted.resolve()
			})
			await acceptSimulationStarted.promise
			const messagesBeforeResume = runtimeMessages.length
			addressBookRead.release()
			await Promise.all([refresh, acceptance])

			const stored = await modules.getPopupVisualisationState()
			if (stored.simulationState.kind !== 'simulated') throw new Error('Expected a simulated shared visualisation')
			assert.equal(countStackedTransactions(stored.simulationState.value), 2)
			const lastBroadcast = (await getBroadcastSimulatedVisualisations(runtimeMessages.slice(messagesBeforeResume))).at(-1)
			if (lastBroadcast === undefined) throw new Error('Expected a broadcast shared visualisation')
			assert.equal(countStackedTransactions(lastBroadcast), 2)
		} finally {
			clearTimeout(deadline)
			addressBookRead?.release()
			retireAll()
		}
	})

	test('a shared visualisation refresh that a switch to another network and back interrupts neither simulates nor publishes for the replaced client', async () => {
		const { modules, runtimeMessages } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { updatePopupVisualisationIfNeeded } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const [servicesA] = installed
		if (servicesA === undefined) throw new Error('Missing network A services')
		const requestOnAStarted = createDeferredSignal()
		const releaseRequestOnA = createDeferredSignal()
		servicesA.interceptRequests(async () => {
			servicesA.interceptRequests(undefined)
			requestOnAStarted.resolve()
			await releaseRequestOnA.promise
		})
		try {
			// Like a block update, the refresh reads its own snapshot of A, then waits for A's client.
			const refresh = updatePopupVisualisationIfNeeded(servicesA.ethereum, servicesA.tokenPriceService)
			await requestOnAStarted.promise
			// The switches' own refreshes skip the closed popup, so only the interrupted refresh could publish afterwards.
			reportSimulationConsumer(false)
			const switchToNetwork = async (rpcNetwork: RpcEntry) => await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork, promptForAccessesIfNeeded: false })
			await switchToNetwork(networkB)
			await addTransactionToNetworkBStack(modules)
			// Returning to A's endpoint installs another client and clears B's stack; the endpoint alone no longer tells the snapshots apart.
			await switchToNetwork(networkA)
			const messagesBeforeResume = runtimeMessages.length
			const storedBeforeResume = await modules.getPopupVisualisationState()
			releaseRequestOnA.resolve()
			await refresh

			assert.equal(getSimulatedCallRecipients(servicesA).includes(STACKED_ON_B_RECIPIENT), false)
			assert.deepEqual(await getBroadcastSimulatedVisualisations(runtimeMessages.slice(messagesBeforeResume)), [])
			assert.deepEqual(await modules.getPopupVisualisationState(), storedBeforeResume)
		} finally {
			releaseRequestOnA.resolve()
			retireAll()
		}
	})

	test('an invalidating refresh that a switch interrupts before it invalidates leaves the new network completed visualisation untouched', async () => {
		const { modules, runtimeMessages, switchToNetworkB } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { updatePopupVisualisationIfNeeded } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		const [servicesA] = installed
		if (servicesA === undefined) throw new Error('Missing network A services')
		const requestOnAStarted = createDeferredSignal()
		const releaseRequestOnA = createDeferredSignal()
		try {
			await updatePopupVisualisationIfNeeded(servicesA.ethereum, servicesA.tokenPriceService, { invalidateOldState: true })
			// The next refresh of A pauses on A's client while it compares the stored result with the latest block, before it cancels or invalidates anything.
			servicesA.interceptRequests(async (request) => {
				if (request.method !== 'eth_blockNumber') return
				servicesA.interceptRequests(undefined)
				requestOnAStarted.resolve()
				await releaseRequestOnA.promise
			})
			const refresh = updatePopupVisualisationIfNeeded(servicesA.ethereum, servicesA.tokenPriceService, { invalidateOldState: true, skipIfUnchanged: true })
			await requestOnAStarted.promise
			await switchToNetworkB(owner)
			const servicesB = getInstalled()
			await updatePopupVisualisationIfNeeded(servicesB.ethereum, servicesB.tokenPriceService, { invalidateOldState: true })
			const completedOnB = await modules.getPopupVisualisationState()
			assert.equal(completedOnB.simulationUpdatingState, 'done')
			const messagesBeforeResume = runtimeMessages.length
			releaseRequestOnA.resolve()
			await refresh

			assert.deepEqual(await modules.getPopupVisualisationState(), completedOnB)
			const stateChanges = runtimeMessages.slice(messagesBeforeResume).filter((message) => {
				const parsed = MessageToPopup.safeParse(message)
				return parsed.success && parsed.value.method === 'popup_simulation_state_changed'
			})
			assert.deepEqual(stateChanges, [])
		} finally {
			releaseRequestOnA.resolve()
			retireAll()
		}
	})

	test('a metadata refresh with the previous network client leaves a visualisation of the new network untouched', async () => {
		const { modules, switchToNetworkB } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { updatePopupVisualisationIfNeeded } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		const { updateSimulationMetadata } = await import('../../app/ts/background/simulationUpdating.js')
		const { owner, installed, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		const [servicesA] = installed
		if (servicesA === undefined) throw new Error('Missing network A services')
		try {
			await switchToNetworkB(owner)
			await addTransactionToNetworkBStack(modules)
			const servicesB = getInstalled()
			await updatePopupVisualisationIfNeeded(servicesB.ethereum, servicesB.tokenPriceService, { invalidateOldState: true })
			const visualisationOfB = await modules.getPopupVisualisationState()
			if (visualisationOfB.simulationState.kind !== 'simulated') throw new Error('Expected a simulated visualisation of B')
			const requestsToABefore = servicesA.requests.length
			// A current snapshot, so only the stored visualisation's network tells this client apart.
			const { simulation } = await modules.readNetworkSnapshot(owner)

			await updateSimulationMetadata(simulation, undefined)

			assert.equal(servicesA.requests.length, requestsToABefore)
			assert.deepEqual(await modules.getPopupVisualisationState(), visualisationOfB)
		} finally {
			retireAll()
		}
	})

	test.each(['to B', 'to B and back to A'] as const)('a metadata refresh of A that a switch %s interrupts writes nothing to the stored visualisation', async (switches) => {
		const { modules } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { updatePopupVisualisationIfNeeded } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		const { updateSimulationMetadata } = await import('../../app/ts/background/simulationUpdating.js')
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const [servicesA] = installed
		if (servicesA === undefined) throw new Error('Missing network A services')
		let addressBookRead: ReturnType<typeof pauseNextStorageReadOf> | undefined
		let deadline: ReturnType<typeof setTimeout> | undefined
		try {
			await updatePopupVisualisationIfNeeded(servicesA.ethereum, servicesA.tokenPriceService, { invalidateOldState: true })
			const { simulation } = await modules.readNetworkSnapshot(owner)
			// The metadata refresh pauses while it looks up its addresses in the address book.
			addressBookRead = pauseNextStorageReadOf('userAddressBookEntriesV3')
			const metadata = updateSimulationMetadata(simulation, undefined)
			await Promise.race([
				addressBookRead.started,
				new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('The metadata refresh read no address book entries')), 1000) }),
			])
			// With the popup closed the switches write no visualisation of their own, so any write after A resumes would be A's.
			reportSimulationConsumer(false)
			const switchToNetwork = async (rpcNetwork: RpcEntry) => await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork, promptForAccessesIfNeeded: false })
			await switchToNetwork(networkB)
			if (switches === 'to B and back to A') await switchToNetwork(networkA)
			const getWrites = countPopupVisualisationWrites()
			addressBookRead.release()
			await metadata

			assert.equal(getWrites(), 0)
		} finally {
			clearTimeout(deadline)
			addressBookRead?.release()
			retireAll()
		}
	})

	test('a home data refresh that sees a signer-only network between two selections of A, which keep A\'s client, sends only a home page of A', async () => {
		const { modules, runtimeMessages, websiteTabConnections } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { refreshHomeData } = await import('../../app/ts/background/popupMessageHandlers.js')
		const { setFixedMakeMeRichList } = await import('../../app/ts/background/settings.js')
		const { setRpcConnectionStatus } = await import('../../app/ts/background/storageVariables.js')
		const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
		const signerOnlyB: RpcNetwork = { chainId: networkB.chainId, httpsRpc: undefined, name: 'Signer-only B', currencyName: 'Ether?', currencyTicker: 'ETH?', primary: false, minimized: true }
		// The home page identifies this rich address with the client, so building it sends a request that the test can hold.
		await setFixedMakeMeRichList([{ address: 0x3333333333333333333333333333333333333333n, makingRich: true, type: 'UserAdded' }])
		await setRpcConnectionStatus({ isConnected: false, lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'), latestBlock: undefined, rpcNetwork: networkA, retrying: false })
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const [servicesA] = installed
		if (servicesA === undefined) throw new Error('Missing network A services')
		// A signer-only network is selected in signing mode.
		const switchToNetwork = async (rpcNetwork: RpcNetwork) => await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: rpcNetwork.httpsRpc !== undefined, rpcNetwork, promptForAccessesIfNeeded: false })
		let switchedToB = false
		// Waking A's client publishes its connection status after the refresh checked its network, and before the home page reads the settings.
		const publishRpcConnectionStatus = async () => {
			if (switchedToB) return
			switchedToB = true
			await switchToNetwork(signerOnlyB)
			// The home page has read B's settings once it identifies the rich address with A's client, which B kept; selecting A again keeps that client too.
			servicesA.interceptRequests(async (request) => {
				if (request.method === 'eth_getBlockByNumber' || request.method === 'eth_blockNumber') return
				servicesA.interceptRequests(undefined)
				await switchToNetwork(networkA)
			})
		}
		try {
			const messagesBefore = runtimeMessages.length
			await refreshHomeData(owner, websiteTabConnections, false, publishRpcConnectionStatus)

			assert.equal(switchedToB, true)
			assert.equal(installed.length, 1)
			const homePages = runtimeMessages.slice(messagesBefore).flatMap((message) => {
				const parsed = MessageToPopup.safeParse(message)
				return parsed.success && parsed.value.method === 'popup_UpdateHomePage' ? [parsed.value.data] : []
			})
			assert.ok(homePages.length > 0)
			for (const homePage of homePages) assert.equal(homePage.settings.activeRpcNetwork.chainId, networkA.chainId)
		} finally {
			retireAll()
		}
	})

	test.each(['to B', 'to B and back to A'] as const)('an invalidating refresh of A that waits for a metadata write while a switch %s commits writes and broadcasts nothing', async (switches) => {
		const { modules, runtimeMessages } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { updatePopupVisualisationForSnapshot, updatePopupVisualisationIfNeeded } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		const { updateSimulationMetadata } = await import('../../app/ts/background/simulationUpdating.js')
		const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const [servicesA] = installed
		if (servicesA === undefined) throw new Error('Missing network A services')
		let addressBookRead: ReturnType<typeof pauseNextStorageReadOf> | undefined
		try {
			await updatePopupVisualisationIfNeeded(servicesA.ethereum, servicesA.tokenPriceService, { invalidateOldState: true })
			const { simulation } = await modules.readNetworkSnapshot(owner)
			// The metadata refresh holds the stored visualisation's update while it looks up its addresses.
			addressBookRead = pauseNextStorageReadOf('userAddressBookEntriesV3')
			const metadata = updateSimulationMetadata(simulation, undefined)
			await addressBookRead.started
			// A's invalidating refresh passes its network checks and reads the stored visualisation twice, first to compare and then inside its serialized section; from there it queues its invalidation behind the held update without touching storage again.
			const refreshReadStoredVisualisation = whenStorageReadsReturned('popupVisualisation', 2)
			const refresh = updatePopupVisualisationForSnapshot(simulation, { invalidateOldState: true })
			await refreshReadStoredVisualisation
			reportSimulationConsumer(false)
			const switchToNetwork = async (rpcNetwork: RpcEntry) => await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork, promptForAccessesIfNeeded: false })
			await switchToNetwork(networkB)
			if (switches === 'to B and back to A') await switchToNetwork(networkA)
			const getWrites = countPopupVisualisationWrites()
			const messagesBeforeRelease = runtimeMessages.length
			addressBookRead.release()
			await Promise.all([metadata, refresh])

			assert.equal(getWrites(), 0)
			const stateChanges = runtimeMessages.slice(messagesBeforeRelease).filter((message) => {
				const parsed = MessageToPopup.safeParse(message)
				return parsed.success && parsed.value.method === 'popup_simulation_state_changed'
			})
			assert.deepEqual(stateChanges, [])
		} finally {
			addressBookRead?.release()
			retireAll()
		}
	})

	test.each(['to B', 'to signer-only B and back to A'] as const)('a cached home data request that a switch %s interrupts sends only a home page of the active network', async (switches) => {
		const { modules, runtimeMessages, createPopupContext } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { dispatchPopupMessage } = await import('../../app/ts/background/popupMessageDispatcher.js')
		const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
		const signerOnlyB: RpcNetwork = { chainId: networkB.chainId, httpsRpc: undefined, name: 'Signer-only B', currencyName: 'Ether?', currencyTicker: 'ETH?', primary: false, minimized: true }
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		// A signer-only network is selected in signing mode.
		const switchToNetwork = async (rpcNetwork: RpcNetwork) => await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: rpcNetwork.httpsRpc !== undefined, rpcNetwork, promptForAccessesIfNeeded: false })
		const finalNetwork = switches === 'to B' ? networkB : networkA
		// The home page reads the settings, then the current tab; refreshing the tab's signer accounts makes its last read a settings re-read. Without that refresh it keeps the settings read before the switch to B; with it, it reads signer-only B's settings before A is selected again.
		const refreshSignerAccounts = switches !== 'to B'
		const originalGet = browser.storage.local.get.bind(browser.storage.local)
		let step: 'waitingForCurrentTab' | 'switching' | 'waitingForSettingsReRead' | 'done' = 'waitingForCurrentTab'
		Object.defineProperty(browser.storage.local, 'get', {
			configurable: true,
			value: async (keys: Parameters<typeof originalGet>[0]) => {
				if (step === 'waitingForCurrentTab' && (keys === 'currentTabId' || (Array.isArray(keys) && keys.includes('currentTabId')))) {
					step = 'switching'
					await switchToNetwork(switches === 'to B' ? networkB : signerOnlyB)
					step = switches === 'to B' ? 'done' : 'waitingForSettingsReRead'
					return await originalGet(keys)
				}
				const result = await originalGet(keys)
				if (step === 'waitingForSettingsReRead' && Array.isArray(keys) && keys.includes('activeRpcNetwork')) {
					step = 'done'
					// The page has read signer-only B's settings; selecting A again keeps A's client.
					await switchToNetwork(networkA)
				}
				return result
			},
		})
		try {
			const messagesBefore = runtimeMessages.length
			await dispatchPopupMessage(await createPopupContext(owner), { method: 'popup_requestNewHomeData', data: { refreshSignerAccounts, includeWebsiteAccessAddressMetadata: false } })

			assert.equal(step, 'done')
			assert.deepEqual((await modules.getSettings()).activeRpcNetwork, finalNetwork)
			const homePages = runtimeMessages.slice(messagesBefore).flatMap((message) => {
				const parsed = MessageToPopup.safeParse(message)
				return parsed.success && parsed.value.method === 'popup_UpdateHomePage' ? [parsed.value.data] : []
			})
			assert.ok(homePages.length > 0)
			for (const homePage of homePages) assert.equal(homePage.settings.activeRpcNetwork.chainId, finalNetwork.chainId)
		} finally {
			retireAll()
		}
	})

	test.each(['visualisation store', 'metadata update'] as const)('a %s whose write waits behind a large state read while an endpoint switch commits writes and broadcasts nothing', async (path) => {
		const { modules, runtimeMessages } = await createApprovedSimulationDapp()
		const { getCommittedNetworkChangeGeneration } = await import('../../app/ts/background/networkChangeGeneration.js')
		const { getSafeTransactionStacks, setPopupVisualisationState, updatePopupVisualisationWithCallBack } = await import('../../app/ts/background/storageVariables.js')
		const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
		const networkAOnAnotherEndpoint = { ...networkA, name: 'Network A on another endpoint', httpsRpc: 'https://network-a-other.invalid' }
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const storedBefore = await modules.getPopupVisualisationState()
		const generationBefore = getCommittedNetworkChangeGeneration()
		// The check runs right before the write is queued for the large state semaphore, so its first call shows that the write has reached that wait.
		const writeQueued = createDeferredSignal()
		const isCurrent = () => {
			writeQueued.resolve()
			return getCommittedNetworkChangeGeneration() === generationBefore
		}
		const competingRead = queueBlockedLargeStateReadAfterNextVisualisationRead(getSafeTransactionStacks)
		try {
			const write = path === 'visualisation store'
				? setPopupVisualisationState({ ...storedBefore, simulationId: storedBefore.simulationId + 1, simulationResultState: 'invalid', simulationUpdatingState: 'updating' }, isCurrent)
				: updatePopupVisualisationWithCallBack(async (oldResults) => ({ ...oldResults, simulationId: oldResults.simulationId + 1 }), isCurrent)
			await competingRead.blocked
			await writeQueued.promise
			// A same-chain endpoint change in signing mode needs no large state, so it commits while the write waits.
			await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: false, rpcNetwork: networkAOnAnotherEndpoint, promptForAccessesIfNeeded: false })
			assert.equal(getCommittedNetworkChangeGeneration(), generationBefore + 1)
			const getWrites = countPopupVisualisationWrites()
			const messagesBeforeRelease = runtimeMessages.length
			competingRead.release()
			const result = await write
			await competingRead.finished()

			assert.equal(getWrites(), 0)
			assert.deepEqual(result, { status: 'obsolete', results: storedBefore })
			assert.deepEqual(await modules.getPopupVisualisationState(), storedBefore)
			const stateChanges = runtimeMessages.slice(messagesBeforeRelease).filter((message) => {
				const parsed = MessageToPopup.safeParse(message)
				return parsed.success && parsed.value.method === 'popup_simulation_state_changed'
			})
			assert.deepEqual(stateChanges, [])
		} finally {
			competingRead.release()
			retireAll()
		}
	})

	test('a popup refresh queued on returning to A through a signer-only network runs and publishes instead of joining the obsolete refresh of A', async () => {
		const { modules, runtimeMessages } = await createApprovedSimulationDapp()
		const { queuePopupSimulationRefresh } = await import('../../app/ts/background/popupSimulationRefreshQueue.js')
		const { getCommittedNetworkChangeGeneration } = await import('../../app/ts/background/networkChangeGeneration.js')
		const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
		const signerOnlyB: RpcNetwork = { chainId: networkB.chainId, httpsRpc: undefined, name: 'Signer-only B', currencyName: 'Ether?', currencyTicker: 'ETH?', primary: false, minimized: true }
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const [servicesA] = installed
		if (servicesA === undefined) throw new Error('Missing network A services')
		// A fresh cached head gives both refreshes of A a comparable revision; the queue reads it when it computes one.
		const head = await servicesA.ethereum.getBlock(undefined)
		const transitionRefreshQueued = createDeferredSignal()
		let nextHeadReadIsTransitionRefresh = false
		servicesA.ethereum.getCachedBlock = () => {
			if (nextHeadReadIsTransitionRefresh) {
				nextHeadReadIsTransitionRefresh = false
				transitionRefreshQueued.resolve()
			}
			return { ...head, timestamp: new Date() }
		}
		// The popup answers the first visibility probe only once the test releases it.
		const firstProbeSent = createDeferredSignal()
		const releaseFirstProbe = createDeferredSignal()
		let probes = 0
		const originalSendMessage = browser.runtime.sendMessage.bind(browser.runtime)
		Object.defineProperty(browser.runtime, 'sendMessage', {
			configurable: true,
			value: async (message: unknown) => {
				if (!isRecord(message) || message.method !== 'popup_isSimulationVisualizerOpen') return await originalSendMessage(message)
				probes += 1
				if (probes === 1) {
					firstProbeSent.resolve()
					await releaseFirstProbe.promise
				}
				return { method: 'popup_isSimulationVisualizerOpen', data: { isOpen: true } }
			},
		})
		// A signer-only network is selected in signing mode; neither switch replaces A's client.
		const switchToNetwork = async (rpcNetwork: RpcNetwork) => await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: rpcNetwork.httpsRpc !== undefined, rpcNetwork, promptForAccessesIfNeeded: false })
		try {
			const generationBefore = getCommittedNetworkChangeGeneration()
			const network = await modules.readNetworkSnapshot(owner)
			const { simulation } = network
			const services = network.services
			const obsoleteRefresh = queuePopupSimulationRefresh(simulation)
			await firstProbeSent.promise
			await switchToNetwork(signerOnlyB)
			nextHeadReadIsTransitionRefresh = true
			const returnToA = switchToNetwork(networkA)
			// The head read happens while the return to A queues its refresh, which joins or follows the held one in the same call.
			await transitionRefreshQueued.promise
			assert.equal(getCommittedNetworkChangeGeneration(), generationBefore + 2)
			const storedBeforeRelease = await modules.getPopupVisualisationState()
			const messagesBeforeRelease = runtimeMessages.length
			releaseFirstProbe.resolve()
			await Promise.all([obsoleteRefresh, returnToA])

			assert.equal(installed.length, 1)
			assert.equal(probes, 2)
			assert.ok((await modules.getPopupVisualisationState()).simulationId > storedBeforeRelease.simulationId)
			const stateChanges = runtimeMessages.slice(messagesBeforeRelease).filter((message) => {
				const parsed = MessageToPopup.safeParse(message)
				return parsed.success && parsed.value.method === 'popup_simulation_state_changed'
			})
			assert.ok(stateChanges.length > 0)
		} finally {
			releaseFirstProbe.resolve()
			retireAll()
		}
	})

	test('a refresh whose input is unchanged still runs when a discarded refresh left the stored result updating', async () => {
		const { modules } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { updatePopupVisualisationForSnapshot } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		try {
			// With an empty stack only the made-rich address is simulated, so the stored input matches the snapshot's and the fingerprints agree.
			const network = await modules.readNetworkSnapshot(owner)
			const { simulation } = network
			const services = network.services
			await updatePopupVisualisationForSnapshot(simulation, { invalidateOldState: true })
			const completed = await modules.getPopupVisualisationState()
			assert.equal(completed.simulationState.kind, 'simulated')
			// Like a refresh that stored its updating state and was then discarded because its network was replaced, with the same input.
			const { setPopupVisualisationState } = await import('../../app/ts/background/storageVariables.js')
			const { alwaysWrite } = await import('../../app/ts/utils/largeStateStore.js')
			await setPopupVisualisationState({ ...completed, simulationId: completed.simulationId + 1, simulationUpdatingState: 'updating' }, alwaysWrite)

			await updatePopupVisualisationForSnapshot(simulation, { skipIfUnchanged: true })

			const refreshed = await modules.getPopupVisualisationState()
			assert.equal(refreshed.simulationUpdatingState, 'done')
			assert.ok(refreshed.simulationId > completed.simulationId + 1)
		} finally {
			retireAll()
		}
	})

	test.each(['the selection and then the list, as the editor does', 'only the list'] as const)('a currency edit of the active RPC that saves %s reaches the installed client without replacing it or retiring its snapshots', async (saved) => {
		installBrowserMock()
		const modules = await loadModules()
		const { getUpdatedSimulationState, getSimulationProviderForSnapshot } = await import('../../app/ts/background/simulationUpdating.js')
		const { setNewRpcList } = await import('../../app/ts/background/popupMessageHandlers/settings.js')
		const { setRpcList } = await import('../../app/ts/background/storageVariables.js')
		await setRpcList([{ ...networkA, primary: true }])
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: { ...networkA, primary: true } })
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const { websiteTabConnections } = createApprovedConnection(modules.websiteSocketToString)
		try {
			const before = await modules.readNetworkSnapshot(owner)
			const client = before.services.ethereum
			const editedNetwork = { ...networkA, primary: true, currencyName: 'Edited ether', currencyTicker: 'EDIT' }

			if (saved !== 'only the list') await modules.changeActiveAddressAndChain(owner, websiteTabConnections, { simulationMode: true, rpcNetwork: editedNetwork, promptForAccessesIfNeeded: false })
			await setNewRpcList(owner, websiteTabConnections, { method: 'popup_set_rpc_list', data: [{ ...editedNetwork, primary: true }] })

			const after = await modules.readNetworkSnapshot(owner)
			assert.equal(after.services.ethereum, client)
			assert.equal(client.getRpcEntry().currencyName, 'Edited ether')
			assert.equal(client.getRpcEntry().currencyTicker, 'EDIT')
			assert.equal(after.settings.activeRpcNetwork.currencyTicker, 'EDIT')
			if (after.simulation.kind !== 'loaded' || before.simulation.kind !== 'loaded') throw new Error('Expected loaded simulations')
			assert.equal(after.simulation.networkChangeGeneration, before.simulation.networkChangeGeneration)
			assert.equal(after.simulation.interceptorTransactionStack.operations.length, 1)
			// The snapshot read before the edit still matches the client, so work in flight is not refused.
			assert.equal(getSimulationProviderForSnapshot(before.simulation), client)
			assert.equal(getSimulationProviderForSnapshot(after.simulation), client)
			const simulated = await getUpdatedSimulationState(after.simulation)
			if (simulated.kind !== 'simulated') throw new Error('Expected a simulation')
			assert.equal(simulated.value.rpcNetwork.currencyTicker, 'EDIT')
		} finally {
			retireAll()
		}
	})

	test('a Gnosis Safe confirmation re-read continues its request only if no network change committed since, even one back to the same endpoint', async () => {
		installBrowserMock()
		const modules = await loadModules()
		const { continuesStackContext } = await import('../../app/ts/background/windows/confirmTransaction.js')
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		try {
			const requestNetwork = await modules.readNetworkSnapshot(owner)
			assert.equal(continuesStackContext(requestNetwork, await modules.readNetworkSnapshot(owner)), true)

			await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
			await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork: networkA, promptForAccessesIfNeeded: false })
			const afterReturningToA = await modules.readNetworkSnapshot(owner)
			assert.deepEqual(afterReturningToA.settings.activeRpcNetwork, requestNetwork.settings.activeRpcNetwork)
			assert.equal(continuesStackContext(requestNetwork, afterReturningToA), false)
		} finally {
			retireAll()
		}
	})

	test('a request that arrives during a network switch waits for it and uses the new network', async () => {
		const { sendEthSimulateV1, switchToNetworkB, assertRequestSucceeded } = await createApprovedSimulationDapp()
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const pausedSwitch = pauseAfterActiveNetworkWrite()
		try {
			const networkSwitch = switchToNetworkB(owner)
			await pausedSwitch.written
			const request = sendEthSimulateV1(owner)
			// Mock storage settles in microtasks, so one macrotask turn lets the request run until it waits for the switch.
			await new Promise((resolve) => setTimeout(resolve, 0))
			const [servicesA] = installed
			if (servicesA === undefined) throw new Error('Missing network A services')
			assert.deepEqual(servicesA.requests, [])
			assert.equal(installed.length, 1)

			pausedSwitch.release()
			await Promise.all([networkSwitch, request])
			const servicesB = installed[1]
			if (servicesB === undefined) throw new Error('Expected the switch to install network B services')
			assertRequestSucceeded()
			assert.deepEqual(getRichAddressesInSimulateV1Request(servicesB), [addressString(secondAddress)])
			assert.deepEqual(getSimulateV1Requests(servicesA), [])
		} finally {
			pausedSwitch.release()
			retireAll()
		}
	})

	test('a popup refresh that arrives during a network switch waits for it and reads one settings and services pair', async () => {
		installBrowserMock()
		const { changeActiveAddressAndChain, changeSimulationMode, getSettings } = await loadModules()
		const { popupSnapshotMessageHandler } = await import('../../app/ts/background/popupMessageHandlerRegistry.js')
		await changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const observedPairs: { readonly settingsChainId: bigint, readonly servicesChainId: bigint }[] = []
		const handler = popupSnapshotMessageHandler('popup_requestSimulationMetadata', async (context) => {
			observedPairs.push({ settingsChainId: context.network.settings.activeRpcNetwork.chainId, servicesChainId: context.network.services.ethereum.getChainId() })
		})
		const context: PopupMessageDispatcherContext = {
			websiteTabConnections: new Map(),
			simulationServicesOwner: owner,
			settings: await getSettings(),
			publishRpcConnectionStatus: noopPublishRpcConnectionStatus,
			simulationAbortController: new AbortController(),
			confirmTransactionAbortController: new AbortController(),
			resetSimulationState: async () => undefined,
		}
		const pausedSwitch = pauseAfterActiveNetworkWrite()
		try {
			const networkSwitch = changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
			await pausedSwitch.written
			const refresh = handler(context, { method: 'popup_requestSimulationMetadata' })
			// Mock storage settles in microtasks, so one macrotask turn lets the refresh run until it waits for the switch.
			await new Promise((resolve) => setTimeout(resolve, 0))
			assert.deepEqual(observedPairs, [])
			pausedSwitch.release()
			await Promise.all([networkSwitch, refresh])
			assert.deepEqual(observedPairs, [{ settingsChainId: networkB.chainId, servicesChainId: networkB.chainId }])
		} finally {
			pausedSwitch.release()
			retireAll()
		}
	})

	test('an RPC list update with stale popup settings selects the new primary of the chain that is active when it runs, in settings and services', async () => {
		installBrowserMock()
		const modules = await loadModules()
		const { settingsPopupMessageHandlers } = await import('../../app/ts/background/popupMessageHandlerRegistries/settings.js')
		const { updatePopupVisualisationIfNeeded } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		const { owner, installed, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		try {
			const context: PopupMessageDispatcherContext = {
				websiteTabConnections: new Map(),
				simulationServicesOwner: owner,
				settings: await modules.getSettings(),
				publishRpcConnectionStatus: noopPublishRpcConnectionStatus,
				simulationAbortController: new AbortController(),
				confirmTransactionAbortController: new AbortController(),
				resetSimulationState: async () => undefined,
			}
			await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
			const replacedServicesOfB = getInstalled()
			const replacementPrimaryForB = { ...networkB, name: 'Network B replacement', httpsRpc: 'https://network-b-replacement.invalid' }
			await settingsPopupMessageHandlers.popup_set_rpc_list(context, { method: 'popup_set_rpc_list', data: [networkA, replacementPrimaryForB, { ...networkB, primary: false }] })

			assert.equal(context.settings.activeRpcNetwork.chainId, networkA.chainId)
			assert.deepEqual((await modules.getSettings()).activeRpcNetwork, replacementPrimaryForB)
			assert.deepEqual(getInstalled().ethereum.getRpcEntry(), replacementPrimaryForB)
			assert.equal(installed.length, 3)

			// Settings and services agree on the replacement, so a refresh visualises B's stack on it.
			reportSimulationConsumer(true)
			await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(2n, networkB.chainId, STACKED_ON_B_RECIPIENT)] }))
			const replacementServices = getInstalled()
			await updatePopupVisualisationIfNeeded(replacementServices.ethereum, replacementServices.tokenPriceService, { invalidateOldState: true })
			const visualisation = await modules.getPopupVisualisationState()
			if (visualisation.simulationState.kind !== 'simulated') throw new Error('Expected a simulated visualisation')
			assert.deepEqual(visualisation.simulationState.value.rpcNetwork, replacementPrimaryForB)
			assert.ok(containsAddress(visualisation, STACKED_ON_B_RECIPIENT))
			assert.ok(getSimulatedCallRecipients(replacementServices).includes(STACKED_ON_B_RECIPIENT))

			// A refresh that still holds the replaced services does nothing.
			const simulationsOnReplacedServices = getSimulateV1Requests(replacedServicesOfB).length
			await updatePopupVisualisationIfNeeded(replacedServicesOfB.ethereum, replacedServicesOfB.tokenPriceService, { invalidateOldState: true })
			assert.equal(getSimulateV1Requests(replacedServicesOfB).length, simulationsOnReplacedServices)
			assert.deepEqual(await modules.getPopupVisualisationState(), visualisation)
		} finally {
			retireAll()
		}
	})

	test('importing settings with a different active network installs services for that network', async () => {
		installBrowserMock()
		const { changeSimulationMode, exportSettingsAndAddressBook, getSettings, importSettings } = await loadModules()
		await changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		const { owner, installed, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		try {
			const reply = await importSettings(owner, new Map(), await createImportRequest(exportSettingsAndAddressBook, networkB))

			assert.equal(reply.data.success, true)
			assert.deepEqual((await getSettings()).activeRpcNetwork, networkB)
			assert.deepEqual(getInstalled().ethereum.getRpcEntry(), networkB)
			assert.equal(installed.length, 2)
			assert.equal(installed[0]?.ethereum.isBlockPolling(), false)
		} finally {
			retireAll()
		}
	})

	test.each(['switch', 'settings import'] as const)('a %s that commits another chain installs its services and clears the stack before websites and popups hear of the chain', async (kind) => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const recording = createRecordingServicesOwner(networkA)
		const importRequest = await createImportRequest(modules.exportSettingsAndAddressBook, networkB)
		const events: string[] = []
		const owner: SimulationServicesOwner = {
			getCurrent: recording.owner.getCurrent,
			reset: (rpcNetwork) => {
				events.push('installServices')
				return recording.owner.reset(rpcNetwork)
			},
		}
		const originalSet = browser.storage.local.set.bind(browser.storage.local)
		Object.defineProperty(browser.storage.local, 'set', {
			configurable: true,
			value: async (items: Record<string, unknown>) => {
				await originalSet(items)
				if ('interceptorTransactionStack' in items) events.push('clearStack')
			},
		})
		const originalSendMessage = browser.runtime.sendMessage.bind(browser.runtime)
		Object.defineProperty(browser.runtime, 'sendMessage', {
			configurable: true,
			value: async (message: unknown) => {
				if (isRecord(message) && message.method === 'popup_chain_update') events.push('popup_chain_update')
				return await originalSendMessage(message)
			},
		})
		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId, (message) => { if (message.method === 'chainChanged') events.push('chainChanged') })
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		try {
			if (kind === 'switch') await modules.changeActiveAddressAndChain(owner, websiteTabConnections, { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
			else await modules.importSettings(owner, websiteTabConnections, importRequest)
			assert.deepEqual(events, ['installServices', 'clearStack', 'chainChanged', 'popup_chain_update'])
			assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
		} finally {
			recording.retireAll()
		}
	})

	test('a settings import that fails after storing its network still completes that network change, and so does its retry', async () => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const { websiteTabConnections, getChainChangedResults } = createApprovedConnection(modules.websiteSocketToString)
		try {
			const importRequest = await createImportRequest(modules.exportSettingsAndAddressBook, networkB)
			// The import writes this preference after it has stored the imported network.
			const failure = new Error('Injected signer preference write failure')
			failNextStorageWrite('useSignersAddressAsActiveAddress', failure)
			await assert.rejects(modules.importSettings(owner, websiteTabConnections, importRequest), failure)
			const afterFailure = await assertCommittedNetworkBEffects(modules, owner, getChainChangedResults, 0)

			assert.equal((await modules.importSettings(owner, websiteTabConnections, importRequest)).data.success, true)
			const afterRetry = await assertCommittedNetworkBEffects(modules, owner, getChainChangedResults, 0)
			assert.equal(afterRetry.services, afterFailure.services)
			assert.equal(installed.length, 2)
		} finally {
			retireAll()
		}
	})

	test('a settings import whose first settings read afterwards fails still completes its network change', async () => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const { websiteTabConnections, getChainChangedResults } = createApprovedConnection(modules.websiteSocketToString)
		try {
			const importRequest = await createImportRequest(modules.exportSettingsAndAddressBook, networkB)
			const failure = new Error('Injected settings read failure')
			failFirstSettingsReadAfterNetworkWrite(failure)
			await assert.rejects(modules.importSettings(owner, websiteTabConnections, importRequest), (error) => error === failure)
			await assertCommittedNetworkBEffects(modules, owner, getChainChangedResults, 0)
			assert.equal(installed.length, 2)
		} finally {
			retireAll()
		}
	})

	test('a simulation-mode import keeps the simulation stack on the same chain and clears it for another chain', async () => {
		installBrowserMock()
		const { changeSimulationMode, exportSettingsAndAddressBook, getInterceptorTransactionStack, importSettings, updateInterceptorTransactionStack } = await loadModules()
		await changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		await updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		try {
			await importSettings(owner, new Map(), await createImportRequest(exportSettingsAndAddressBook, networkA))
			assert.equal((await getInterceptorTransactionStack()).operations.length, 1)

			await importSettings(owner, new Map(), await createImportRequest(exportSettingsAndAddressBook, networkB))
			assert.deepEqual((await getInterceptorTransactionStack()).operations, [])
		} finally {
			retireAll()
		}
	})

	test('an import that changes the chain sends chainChanged to approved websites, and a same-chain import does not', async () => {
		installBrowserMock()
		const { changeSimulationMode, exportSettingsAndAddressBook, importSettings, updateWebsiteAccess, websiteSocketToString } = await loadModules()
		await changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const { websiteTabConnections, getChainChangedResults } = createApprovedConnection(websiteSocketToString)
		try {
			await importSettings(owner, websiteTabConnections, await createImportRequest(exportSettingsAndAddressBook, networkA))
			assert.deepEqual(getChainChangedResults(), [])

			await importSettings(owner, websiteTabConnections, await createImportRequest(exportSettingsAndAddressBook, networkB))
			assert.deepEqual(getChainChangedResults(), ['0xa'])
		} finally {
			retireAll()
		}
	})

	test('a signing-mode network switch whose signing preference write fails still completes that network change, and so does its retry', async () => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: false, rpcNetwork: networkA })
		await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const { websiteTabConnections, getChainChangedResults } = createApprovedConnection(modules.websiteSocketToString)
		const switchSignerToNetworkB = async () => await modules.activateAddressSelection(owner, websiteTabConnections, { type: 'signer', address: firstAddress }, {
			simulationMode: false,
			signerAddress: firstAddress,
			rpcNetwork: networkB,
			promptForAccessesIfNeeded: false,
		})
		try {
			// The switch remembers the signing preference after it has stored the new network and installed its services, before it notifies websites.
			const failure = new Error('Injected signing preference write failure')
			failNextStorageWrite('signingAddressPreferences', failure)
			await assert.rejects(switchSignerToNetworkB(), (error) => error === failure)
			// The simulation stack carries no chain, so even a signing-mode chain change drops it.
			const afterFailure = await assertCommittedNetworkBEffects(modules, owner, getChainChangedResults, 0)

			await switchSignerToNetworkB()
			const afterRetry = await assertCommittedNetworkBEffects(modules, owner, getChainChangedResults, 0)
			assert.equal(afterRetry.services, afterFailure.services)
			assert.equal(installed.length, 2)
		} finally {
			retireAll()
		}
	})

	test('a simulation-mode network switch whose first settings read after the switch fails still completes that network change, and so does its retry', async () => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const { websiteTabConnections, getChainChangedResults } = createApprovedConnection(modules.websiteSocketToString)
		const switchToNetworkB = async () => await modules.changeActiveAddressAndChain(owner, websiteTabConnections, { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
		try {
			const failure = new Error('Injected settings read failure')
			failFirstSettingsReadAfterNetworkWrite(failure)
			await assert.rejects(switchToNetworkB(), (error) => error === failure)
			const afterFailure = await assertCommittedNetworkBEffects(modules, owner, getChainChangedResults, 0)

			await switchToNetworkB()
			const afterRetry = await assertCommittedNetworkBEffects(modules, owner, getChainChangedResults, 0)
			assert.equal(afterRetry.services, afterFailure.services)
			assert.equal(installed.length, 2)
		} finally {
			retireAll()
		}
	})

	test('a read for services of another network has no stack to simulate, and a read for the active network simulates on its own client', async () => {
		const { modules } = await createApprovedSimulationDapp()
		const { getSimulationProviderForSnapshot, getUpdatedSimulationState, requireSimulationSnapshot } = await import('../../app/ts/background/simulationUpdating.js')
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		const otherChainServices = createNetworkServices(networkB)
		const otherEndpointServices = createNetworkServices(networkAOnOtherEndpoint)
		try {
			for (const services of [otherChainServices, otherEndpointServices]) {
				const { simulation } = await modules.readNetworkSnapshotForServices(services)
				assert.equal(simulation.kind, 'replaced')
				assert.throws(() => requireSimulationSnapshot(simulation), /no longer serve the active network/u)
				assert.deepEqual(services.requests, [])
			}
			const ownServices = getInstalled()
			const snapshot = requireSimulationSnapshot((await modules.readNetworkSnapshot(owner)).simulation)
			assert.equal(getSimulationProviderForSnapshot(snapshot), ownServices.ethereum)
			assert.equal((await getUpdatedSimulationState(snapshot)).kind, 'simulated')
			assert.ok(getSimulatedCallRecipients(ownServices).includes(STACKED_ON_A_RECIPIENT))
		} finally {
			retireAll()
			otherChainServices.ethereum.cleanup()
			otherEndpointServices.ethereum.cleanup()
		}
	})

	test('a block of a client that a network switch replaces while the handler is suspended simulates nothing and publishes no newHeads, and the next block of the installed client carries on', async () => {
		const dapp = await createApprovedSimulationDapp()
		const { modules, switchToNetworkB } = dapp
		const { owner, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		const statusPublishStarted = createDeferredSignal()
		const statusPublishRelease = createDeferredSignal()
		const { deliverNewBlock, getNewHeads } = await subscribeDappToNewBlocks(dapp, owner, async () => {
			statusPublishStarted.resolve()
			await statusPublishRelease.promise
		})
		const servicesA = getInstalled()
		try {
			const blockOfReplacedClient = deliverNewBlock(servicesA)
			await statusPublishStarted.promise
			await switchToNetworkB(owner)
			await addTransactionToNetworkBStack(modules)
			statusPublishRelease.resolve()
			await blockOfReplacedClient

			assert.deepEqual(getSimulateV1Requests(servicesA), [])
			assert.deepEqual(getNewHeads(), [])

			const servicesB = getInstalled()
			assert.notEqual(servicesB, servicesA)
			await deliverNewBlock(servicesB)
			assert.ok(getSimulatedCallRecipients(servicesB).includes(STACKED_ON_B_RECIPIENT))
			// The live block, then the simulated block of B's stack on top of it.
			assert.equal(getNewHeads().length, 2)
			assert.deepEqual(getSimulateV1Requests(servicesA), [])
			assert.equal(await modules.getLatestUnexpectedError(), undefined)
		} finally {
			statusPublishRelease.resolve()
			retireAll()
		}
	})

	test('a block that reads the stack while an endpoint change is in flight simulates nothing on the client that change replaces', async () => {
		const dapp = await createApprovedSimulationDapp()
		const { modules, messages } = dapp
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		const { deliverNewBlock, getNewHeads } = await subscribeDappToNewBlocks(dapp, owner)
		const settingsWritten = createDeferredSignal()
		const transitionRelease = createDeferredSignal()
		const servicesA = getInstalled()
		try {
			// Holds the transition after its settings write, so the handler finds the change committed but its client not yet replaced, and its stack read waits for the lock.
			const endpointChange = modules.runSettingsTransition(owner, new Map(), {
				writeSettings: async () => {
					await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkAOnOtherEndpoint })
					settingsWritten.resolve()
					await transitionRelease.promise
					return 'committed'
				},
			})
			await settingsWritten.promise
			const blockOfReplacedClient = deliverNewBlock(servicesA)
			// The live block goes out first: the client is still installed, so websites have not been told of any change yet.
			await waitForPortMessageCount(messages, 'newHeads', 1, 5_000)
			assert.equal(servicesA.ethereum.isRetired(), false)
			transitionRelease.resolve()
			await endpointChange
			await blockOfReplacedClient

			assert.equal(servicesA.ethereum.isRetired(), true)
			assert.deepEqual(getSimulateV1Requests(servicesA), [])
			assert.equal(getNewHeads().length, 1)
			assert.equal(await modules.getLatestUnexpectedError(), undefined)
		} finally {
			transitionRelease.resolve()
			retireAll()
		}
	})

	test('simulated blocks that were computed on a client a network switch retires meanwhile are not published', async () => {
		const dapp = await createApprovedSimulationDapp()
		const { modules, switchToNetworkB } = dapp
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		const { deliverNewBlock, getNewHeads } = await subscribeDappToNewBlocks(dapp, owner)
		const simulationStarted = createDeferredSignal()
		const simulationRelease = createDeferredSignal()
		const servicesA = getInstalled()
		servicesA.interceptRequests(async (request) => {
			if (request.method !== 'eth_simulateV1') return
			simulationStarted.resolve()
			await simulationRelease.promise
		})
		try {
			const blockOfReplacedClient = deliverNewBlock(servicesA)
			await simulationStarted.promise
			await switchToNetworkB(owner)
			simulationRelease.resolve()
			await blockOfReplacedClient

			// The simulation paired A's client with A's stack; only its result arrived after the switch.
			assert.ok(getSimulatedCallRecipients(servicesA).includes(STACKED_ON_A_RECIPIENT))
			assert.equal(servicesA.ethereum.isRetired(), true)
			assert.equal(getNewHeads().length, 1)
			assert.equal(await modules.getLatestUnexpectedError(), undefined)
		} finally {
			simulationRelease.resolve()
			retireAll()
		}
	})
})
