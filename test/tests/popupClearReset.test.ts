import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import * as funtypes from 'funtypes'
import type { CompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'
import { CompleteVisualizedSimulation as CompleteVisualizedSimulationCodec, toResolvedSimulationState } from '../../app/ts/types/visualizer-types.js'
import { serialize, type EthereumBlockHeader } from '../../app/ts/types/wire-types.js'
import type { RpcEntry, RpcNetwork } from '../../app/ts/types/rpc.js'
import { createSafeTx } from '../../app/ts/safe/safeCore.js'
import { mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import type { PreSimulationTransaction } from '../../app/ts/types/visualizer-types.js'
import { MessageToPopup } from '../../app/ts/types/interceptor-messages.js'
import { installBrowserMock } from '../harness/browserMock.js'
import { createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'
import { importAllPopupMessageHandlers } from './popupMessageHandlerModules.js'
import { getMessageMethod, hasMessageMethod } from './runtimeMessageMatchers.js'
import { createStubEthereumClient } from './stubEthereumClient.js'
import { overrideProperty } from './typedPropertyOverride.js'

const PopupSimulationChangedMessage = funtypes.ReadonlyObject({
	role: funtypes.Literal('all'),
	method: funtypes.Literal('popup_simulation_state_changed'),
	data: funtypes.ReadonlyObject({
		visualizedSimulatorState: CompleteVisualizedSimulationCodec,
	}),
}).asReadonly()

// Answers the popup's "is a popup open" probes; every other runtime message gets no reply.
function replyToPopupOpenQueries(isPopupOpen: boolean) {
	return async (message: unknown) => {
		const method = getMessageMethod(message)
		if (method === 'popup_isSimulationVisualizerOpen' || method === 'popup_isMainPopupWindowOpen') return { method, data: { isOpen: isPopupOpen } }
		return undefined
	}
}

// The app modules are imported after the browser globals exist, as in the extension; each test then installs its own mock with empty storage.
installBrowserMock({ handlers: { runtimeMessage: replyToPopupOpenQueries(true) } })
const installBrowserMockForTest = createPerTestBrowserMockInstaller()
const installPopupBrowserMock = ({ isPopupOpen = true }: { readonly isPopupOpen?: boolean } = {}) => installBrowserMockForTest({ handlers: { runtimeMessage: replyToPopupOpenQueries(isPopupOpen) } })

async function loadModules() {
	const popupVisualisationUpdater = await import('../../app/ts/background/popupVisualisationUpdater.js')
	const popupSimulationFingerprint = await import('../../app/ts/background/popupSimulationFingerprint.js')
	const popupMessageHandlers = await importAllPopupMessageHandlers()
	const storageUtils = await import('../../app/ts/utils/storageUtils.js')
	const settings = await import('../../app/ts/background/settings.js')
	const background = await import('../../app/ts/background/background.js')
	const activeSettings = await import('../../app/ts/background/activeSettings.js')
	const walletSwitch = await import('../../app/ts/background/walletSwitch.js')
	const popupMessageRouting = await import('../../app/ts/background/popupMessageRouting.js')
	const storageVariables = await import('../../app/ts/background/storageVariables.js')
	const simulationUpdating = await import('../../app/ts/background/simulationUpdating.js')
	const simulationMode = await import('../../app/ts/simulation/services/SimulationModeEthereumClientService.js')
	const defaults = await import('../../app/ts/config/defaults.js')
	return {
		...popupVisualisationUpdater,
		...popupSimulationFingerprint,
		...popupMessageHandlers,
		...storageUtils,
		...settings,
		...background,
		...activeSettings,
		...walletSwitch,
		...popupMessageRouting,
		updateTransactionState: storageVariables.updateTransactionState,
		getSafeTransactionStacks: storageVariables.getSafeTransactionStacks,
		...simulationUpdating,
		...simulationMode,
		...defaults,
	}
}

const modulesPromise = loadModules()
type TestModules = Awaited<ReturnType<typeof loadModules>>

function buildStalePopupVisualisationState(
	rpcNetwork: TestModules['defaultRpcs'][number],
	defaultBlockManipulation: TestModules['DEFAULT_BLOCK_MANIPULATION'],
) {
	const simulationState = {
		success: true as const,
		simulationStateInput: [{
			stateOverrides: {},
			transactions: [],
			signedMessages: [],
			blockTimeManipulation: defaultBlockManipulation,
			simulateWithZeroBaseFee: false,
		}],
		simulatedBlocks: [{
			simulatedTransactions: [],
			signedMessages: [],
			stateOverrides: {},
			blockTimestamp: new Date('2024-01-01T00:00:12.000Z'),
			blockTimeManipulation: defaultBlockManipulation,
			blockBaseFeePerGas: 1n,
		}],
		blockNumber: 123n,
		blockTimestamp: new Date('2024-01-01T00:00:00.000Z'),
		baseFeePerGas: 1n,
		simulationConductedTimestamp: new Date('2024-01-01T00:00:00.000Z'),
		rpcNetwork,
	}

	return {
		addressBookEntries: [],
		tokenPriceEstimates: [],
		tokenPriceQuoteToken: undefined,
		namedTokenIds: [],
		simulationState: toResolvedSimulationState(simulationState),
		simulationUpdatingState: 'done' as const,
		simulationResultState: 'done' as const,
		simulationId: 7,
		visualizedSimulationState: {
			success: true as const,
			visualizedBlocks: [{
				simulatedAndVisualizedTransactions: [],
				visualizedPersonalSignRequests: [],
				blockTimeManipulation: defaultBlockManipulation,
			}],
		},
		numberOfAddressesMadeRich: 0,
	}
}

const fixedBlock: NonNullable<EthereumBlockHeader> = {
	difficulty: 0n,
	extraData: new Uint8Array(),
	gasLimit: 30_000_000n,
	gasUsed: 0n,
	hash: 0x7bn,
	logsBloom: 0n,
	miner: 0n,
	mixHash: 0n,
	nonce: 0n,
	number: 123n,
	parentHash: 0n,
	receiptsRoot: 0n,
	sha3Uncles: 0n,
	stateRoot: 0n,
	timestamp: new Date('2024-01-01T00:00:00.000Z'),
	size: 0n,
	uncles: [],
	baseFeePerGas: 1n,
	transactionsRoot: 0n,
	transactions: [],
}

// A real EthereumClientService that never reaches a node: every block read sees fixedBlock through the block cache, block polling only toggles a flag, and other RPC requests reject. blockReads counts the cache lookups behind getBlock, getBlockNumber and direct getCachedBlock calls.
function createFixedBlockEthereumClient(rpcEntry: RpcEntry) {
	const ethereum = createStubEthereumClient(undefined, rpcEntry)
	const blockReads = { count: 0 }
	ethereum.getCachedBlock = () => {
		blockReads.count += 1
		return fixedBlock
	}
	let blockPolling = false
	overrideProperty(ethereum, 'isBlockPolling', () => blockPolling)
	overrideProperty(ethereum, 'setBlockPolling', (enabled) => { blockPolling = enabled })
	return { ethereum, blockReads }
}

function getSimulationStateChangedMessages(messages: readonly unknown[]) {
	return messages.filter((message) => hasMessageMethod(message, 'popup_simulation_state_changed'))
}

function getExpectedPopupSimulationChangedMessage(popupVisualisation: CompleteVisualizedSimulation) {
	return serialize(PopupSimulationChangedMessage, {
		role: 'all',
		method: 'popup_simulation_state_changed',
		data: { visualizedSimulatorState: popupVisualisation },
	} as const)
}

function assertDefinedEmptyPopupVisualisation(popupVisualisation: CompleteVisualizedSimulation) {
	assert.equal(popupVisualisation.simulationUpdatingState, 'done')
	assert.equal(popupVisualisation.simulationResultState, 'done')
	assert.ok(popupVisualisation.simulationState.kind === 'simulated')
	assert.equal(popupVisualisation.simulationState.value.success, true)
	assert.deepEqual(popupVisualisation.simulationState.value.simulationStateInput, [])
	assert.deepEqual(popupVisualisation.visualizedSimulationState, {
		success: true,
		visualizedBlocks: [],
	})
}

const {
	updatePopupVisualisationIfNeeded,
	browserStorageLocalGet,
	browserStorageLocalSet,
	changeActiveRpc,
	defaultActiveAddresses,
	defaultRpcs,
	resetSimulationStateFromConfig,
	updateTransactionState,
	getSafeTransactionStacks,
	DEFAULT_BLOCK_MANIPULATION,
} = await modulesPromise

function getTestDefaults() {
	const firstActiveAddress = defaultActiveAddresses[0]?.address
	const firstRpcNetwork = defaultRpcs[0]
	if (firstActiveAddress === undefined || firstRpcNetwork === undefined) throw new Error('test defaults are missing')
	return { activeAddress: firstActiveAddress, rpcNetwork: firstRpcNetwork }
}
const { activeAddress, rpcNetwork } = getTestDefaults()
const sameChainRpcNetwork: RpcNetwork = {
	...rpcNetwork,
	name: 'Alternative Ethereum Mainnet',
	httpsRpc: 'https://mainnet.example.com',
	primary: false,
}
const otherChainRpcNetwork: RpcNetwork = {
	...rpcNetwork,
	name: 'Test Chain',
	chainId: 2n,
	httpsRpc: 'https://chain.example.com',
	primary: false,
}

function createResetTestTransaction(transactionIdentifier: bigint, requiredChainId: bigint, safeAddress?: bigint): PreSimulationTransaction {
	const recipient = 0x2000000000000000000000000000000000000002n
	const transaction = {
		from: activeAddress,
		to: recipient,
		value: 0n,
		input: new Uint8Array(),
	}
	const safeTx = safeAddress === undefined ? undefined : createSafeTx(requiredChainId, safeAddress, transaction, transactionIdentifier)
	return {
		signedTransaction: mockSignTransaction({
			type: '1559',
			...transaction,
			nonce: transactionIdentifier,
			gas: 21_000n,
			chainId: requiredChainId,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
		}),
		website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
		created: new Date('2024-01-01T00:00:00.000Z'),
		originalRequestParameters: { method: 'eth_sendTransaction', params: [transaction] },
		transactionIdentifier,
		simulationOptions: { requiredChainId, simulateWithZeroBaseFee: safeAddress !== undefined },
		...(safeTx === undefined ? {} : {
			safeTransaction: {
				safeTx,
				safeTxHash: transactionIdentifier,
				created: new Date('2024-01-01T00:00:00.000Z'),
				websiteOrigin: 'https://example.com',
				transactionIdentifier,
				signatures: [],
			},
		}),
	}
}

const stalePopupVisualisation = buildStalePopupVisualisationState(rpcNetwork, DEFAULT_BLOCK_MANIPULATION)
const { ethereum: fakeEthereum, blockReads } = createFixedBlockEthereumClient(rpcNetwork)
const fakeTokenPriceService = new TokenPriceService(fakeEthereum, 0)

describe('popup clear reset', () => {
	for (const captured of [false, true]) test(`signer-only snapshots publish passthrough without reading the previous provider (captured=${ captured })`, async () => {
		installPopupBrowserMock()
		const signerOnly: RpcNetwork = { chainId: 99999n, httpsRpc: undefined, name: 'Signer only', currencyName: 'Ether?', currencyTicker: 'ETH?', primary: false, minimized: true }
		await browserStorageLocalSet({ activeRpcNetwork: signerOnly, independentActiveSimulationAddress: activeAddress, popupVisualisation: stalePopupVisualisation, interceptorTransactionStack: { operations: [] } })
		const { captureSimulationSnapshot, getUpdatedSimulationState } = await import('../../app/ts/background/simulationUpdating.js')
		const snapshot = captured ? await captureSimulationSnapshot() : undefined
		if (captured) await browserStorageLocalSet({ activeRpcNetwork: rpcNetwork })
		const blockReadsBefore = blockReads.count
		const result = await updatePopupVisualisationIfNeeded(fakeEthereum, fakeTokenPriceService, { skipIfUnchanged: true, snapshot })
		if (snapshot !== undefined) assert.equal((await getUpdatedSimulationState(fakeEthereum, snapshot)).kind, 'passthrough')
		assert.equal(blockReads.count - blockReadsBefore, 0)
		assert.equal(result.simulationState.kind, 'passthrough')
		assert.equal(result.simulationUpdatingState, 'done')
		assert.equal(result.simulationResultState, 'done')
	})

	for (const nextSimulationMode of [true, false]) test(`capture keeps the original rich address and stack mode during a settings change (nextSimulationMode=${ nextSimulationMode })`, async () => {
		const browserMock = installPopupBrowserMock()
		await browserStorageLocalSet({ activeRpcNetwork: rpcNetwork, independentActiveSimulationAddress: activeAddress, simulationMode: true, makeCurrentAddressRich: true, interceptorTransactionStack: { operations: [] } })
		const { captureSimulationSnapshot } = await import('../../app/ts/background/simulationUpdating.js')
		const originalGet = browserMock.browser.storage.local.get
		let changed = false
		browserMock.browser.storage.local.get = async keys => {
			const result = await originalGet(keys)
			if (!changed && Array.isArray(keys) && keys.includes('activeRpcNetwork')) {
				changed = true
				// Initial settings reads have captured their values; rich-address resolution has not started yet.
				await browserStorageLocalSet({ independentActiveSimulationAddress: activeAddress + 1n, simulationMode: nextSimulationMode })
			}
			return result
		}
		try {
			const snapshot = await captureSimulationSnapshot()
			assert.equal(changed, true)
			assert.deepEqual(snapshot.activeStackContext, { simulationMode: true })
			assert.equal(snapshot.numberOfAddressesMadeRich, 1)
			assert.deepEqual(snapshot.simulationStateInput.flatMap(block => Object.keys(block.stateOverrides)), [`0x${ activeAddress.toString(16).padStart(40, '0') }`])
		} finally {
			browserMock.browser.storage.local.get = originalGet
		}
	})

	test('complete visualization requests do not join a held interactive queue entry', async () => {
		const browserMock = installPopupBrowserMock()
		await browserStorageLocalSet({ activeRpcNetwork: rpcNetwork, independentActiveSimulationAddress: activeAddress, popupVisualisation: stalePopupVisualisation, interceptorTransactionStack: { operations: [] } })
		const { queuePopupSimulationRefresh } = await import('../../app/ts/background/popupSimulationRefreshQueue.js')
		const { requestCompleteVisualizedSimulation } = await import('../../app/ts/background/popupMessageHandlers/simulation.js')
		const started = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const replyToPopupQueries = browserMock.handlers.runtimeMessage
		let held = false
		browserMock.handlers.runtimeMessage = async (message) => {
			if (hasMessageMethod(message, 'popup_isSimulationVisualizerOpen') && !held) {
				held = true
				started.resolve()
				await release.promise
			}
			return await replyToPopupQueries(message)
		}
		const queued = queuePopupSimulationRefresh({ ethereum: fakeEthereum, tokenPriceService: fakeTokenPriceService, invalidateOldState: true })
		let timeout: ReturnType<typeof setTimeout> | undefined
		try {
			await started.promise
			const result = await Promise.race([
				requestCompleteVisualizedSimulation(fakeEthereum, fakeTokenPriceService),
				new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Complete visualization request joined the held queue')), 1000) }),
			])
			assert.equal(result.visualizedSimulatorState.simulationUpdatingState, 'done')
			assert.equal(result.visualizedSimulatorState.simulationResultState, 'done')
		} finally {
			clearTimeout(timeout)
			release.resolve()
			await queued
		}
	})

	test('keeps the cached popup timestamp when refresh finds no simulation change', async () => {
		const browserMock = installPopupBrowserMock()
		await browserStorageLocalSet({
			independentActiveSimulationAddress: activeAddress,
			interceptorTransactionStack: { operations: [] },
		})
		const modules = await modulesPromise
		const currentSimulationInput = await modules.getCurrentSimulationInput()
		assert.ok(stalePopupVisualisation.simulationState.kind === 'simulated')
		const matchingPopupVisualisation = {
			...stalePopupVisualisation,
			simulationState: {
				kind: 'simulated' as const,
				value: {
					...stalePopupVisualisation.simulationState.value,
					simulationStateInput: currentSimulationInput,
				},
			},
		}
		await browserStorageLocalSet({ popupVisualisation: matchingPopupVisualisation })
		const storedPopupVisualisation = (await browserStorageLocalGet('popupVisualisation')).popupVisualisation
		assert.ok(storedPopupVisualisation)
		const storedSimulationState = storedPopupVisualisation.simulationState
		assert.ok(storedSimulationState.kind === 'simulated')
		assert.equal(
			modules.getPopupVisualisationFingerprint(currentSimulationInput, rpcNetwork, 123n),
			modules.getPopupVisualisationFingerprint(storedSimulationState.value.simulationStateInput, storedSimulationState.value.rpcNetwork, storedSimulationState.value.blockNumber),
		)
		const popupVisualisation = await updatePopupVisualisationIfNeeded(fakeEthereum, fakeTokenPriceService, { skipIfUnchanged: true })
		assert.equal(popupVisualisation.simulationId, matchingPopupVisualisation.simulationId)
		assert.ok(popupVisualisation.simulationState.kind === 'simulated')
		assert.equal(popupVisualisation.simulationState.value.simulationConductedTimestamp.getTime(), matchingPopupVisualisation.simulationState.value.simulationConductedTimestamp.getTime())
		assert.equal(getSimulationStateChangedMessages(browserMock.calls.runtimeSendMessage).length, 0)
	})

	test('renders the captured refresh input and rich count after live settings change', async () => {
		installPopupBrowserMock()
		await browserStorageLocalSet({ independentActiveSimulationAddress: activeAddress, makeCurrentAddressRich: false, interceptorTransactionStack: { operations: [] } })
		const modules = await modulesPromise
		const { captureSimulationSnapshot } = await import('../../app/ts/background/simulationUpdating.js')
		const snapshot = await captureSimulationSnapshot()
		await browserStorageLocalSet({ makeCurrentAddressRich: true })
		assert.notDeepEqual(await modules.getCurrentSimulationInput(), snapshot.simulationStateInput)
		const result = await updatePopupVisualisationIfNeeded(fakeEthereum, fakeTokenPriceService, { snapshot })
		assert.equal(result.numberOfAddressesMadeRich, 0)
		assert.equal(result.simulationState.kind, 'simulated')
		if (result.simulationState.kind !== 'simulated') throw new Error('Expected a simulated snapshot')
		assert.deepEqual(result.simulationState.value.simulationStateInput, snapshot.simulationStateInput)
	})

	test('updates the cached popup active address without restamping the simulation', async () => {
		const browserMock = installPopupBrowserMock()
		const nextActiveAddress = defaultActiveAddresses.find((entry) => entry.address !== activeAddress)?.address
		if (nextActiveAddress === undefined) throw new Error('test defaults are missing a second active address')
		await browserStorageLocalSet({
			independentActiveSimulationAddress: nextActiveAddress,
			simulationMode: true,
			currentTabId: -1,
			interceptorTransactionStack: { operations: [] },
		})
		await browserMock.browser.storage.local.set({
			'tabState_-1': {
				tabId: -1,
				website: undefined,
				signerConnected: false,
				signerName: 'NoSignerDetected',
				signerAccounts: [],
				signerAccountError: undefined,
				signerChain: undefined,
				tabIconDetails: { icon: '../img/head.png', iconReason: 'The website has not requested to connect to The Interceptor.' },
				activeSigningAddress: undefined,
			},
		})
		const modules = await modulesPromise
		const currentSimulationInput = await modules.getCurrentSimulationInput()
		const matchingPopupVisualisation = {
			...stalePopupVisualisation,
			simulationState: {
				...stalePopupVisualisation.simulationState,
				simulationStateInput: currentSimulationInput,
			},
		}
		await browserStorageLocalSet({ popupVisualisation: matchingPopupVisualisation })

		const { refreshHomeData } = modules
		await refreshHomeData(fakeEthereum, fakeTokenPriceService, new Map(), true, 1, async () => undefined, false)

		const popupVisualisation = (await browserStorageLocalGet('popupVisualisation')).popupVisualisation
		assert.ok(popupVisualisation)
		assert.equal('activeAddress' in popupVisualisation, false)
		assert.ok(popupVisualisation.simulationState.kind === 'simulated')
		assert.ok(matchingPopupVisualisation.simulationState.kind === 'simulated')
		assert.equal(popupVisualisation.simulationState.value.simulationConductedTimestamp.getTime(), matchingPopupVisualisation.simulationState.value.simulationConductedTimestamp.getTime())

		const homePageMessage = browserMock.calls.runtimeSendMessage.flatMap((message) => {
			const parsed = MessageToPopup.safeParse(message)
			return parsed.success && parsed.value.method === 'popup_UpdateHomePage' ? [parsed.value] : []
		})[0]
		assert.ok(homePageMessage)
		assert.equal(homePageMessage.data.settings.activeSimulationAddress, nextActiveAddress)
	})

	test('publish an empty popup visualisation even when previous state was done', async () => {
		const browserMock = installPopupBrowserMock()
		await browserStorageLocalSet({
			independentActiveSimulationAddress: activeAddress,
			popupVisualisation: stalePopupVisualisation,
			interceptorTransactionStack: { operations: [] },
		})

		await updatePopupVisualisationIfNeeded(fakeEthereum, fakeTokenPriceService)

		const popupVisualisation = (await browserStorageLocalGet('popupVisualisation')).popupVisualisation
		assert.ok(popupVisualisation)
		assert.equal(popupVisualisation.simulationId, stalePopupVisualisation.simulationId + 1)
		assertDefinedEmptyPopupVisualisation(popupVisualisation)

		const changedMessages = getSimulationStateChangedMessages(browserMock.calls.runtimeSendMessage)
		assert.equal(changedMessages.length > 0, true)
		assert.deepEqual(changedMessages.at(-1), getExpectedPopupSimulationChangedMessage(popupVisualisation))
	})

	test('clears simulation-mode operations while preserving Safe stacks', async () => {
		const browserMock = installPopupBrowserMock()
		await updateTransactionState(() => ({
			interceptorTransactionStack: { operations: [{ type: 'TimeManipulation', blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION }] },
			safeTransactionStacks: [{
				chainId: 1n,
				safeAddress: 0x1234n,
				safeVersion: '1.4.1',
				baseNonce: 0n,
				threshold: 1n,
				transactions: [],
			}],
		}))
		await browserStorageLocalSet({
			independentActiveSimulationAddress: activeAddress,
			popupVisualisation: stalePopupVisualisation,
		})

		await resetSimulationStateFromConfig(createTestSimulationServicesOwner({ ethereum: fakeEthereum, tokenPriceService: fakeTokenPriceService }))

		const interceptorTransactionStack = (await browserStorageLocalGet('interceptorTransactionStack')).interceptorTransactionStack
		const popupVisualisation = (await browserStorageLocalGet('popupVisualisation')).popupVisualisation
		assert.deepEqual(interceptorTransactionStack, { operations: [] })
		assert.equal((await getSafeTransactionStacks()).length, 1)
		assert.ok(popupVisualisation)
		assertDefinedEmptyPopupVisualisation(popupVisualisation)

		const changedMessages = getSimulationStateChangedMessages(browserMock.calls.runtimeSendMessage)
		assert.equal(changedMessages.some(message => {
			const parsed = PopupSimulationChangedMessage.safeParse(message)
			return parsed.success && parsed.value.data.visualizedSimulatorState.simulationResultState === 'invalid'
		}), true, 'Reset must invalidate the old visualization before publishing the cleared stack')
		assert.deepEqual(changedMessages.at(-1), getExpectedPopupSimulationChangedMessage(popupVisualisation))
	})

	test('clears only the active Safe stack in signing mode', async () => {
		installPopupBrowserMock()
		const activeSafeAddress = 0x3000000000000000000000000000000000000003n
		const otherSafeAddress = 0x4000000000000000000000000000000000000004n
		const activeChainId = rpcNetwork.chainId
		const anotherChainId = activeChainId + 1n
		const ordinaryTransaction = createResetTestTransaction(1n, activeChainId)
		const activeSafeTransaction = createResetTestTransaction(2n, activeChainId, activeSafeAddress)
		const otherSafeTransaction = createResetTestTransaction(3n, activeChainId, otherSafeAddress)
		const otherChainTransaction = createResetTestTransaction(4n, anotherChainId, activeSafeAddress)
		await updateTransactionState(() => ({
			interceptorTransactionStack: { operations: [
				{ type: 'Transaction', preSimulationTransaction: ordinaryTransaction },
				{ type: 'Transaction', preSimulationTransaction: activeSafeTransaction },
				{ type: 'Transaction', preSimulationTransaction: otherSafeTransaction },
				{ type: 'Transaction', preSimulationTransaction: otherChainTransaction },
			] },
			safeTransactionStacks: [
				{ chainId: activeChainId, safeAddress: activeSafeAddress, safeVersion: '1.4.1', baseNonce: 0n, threshold: 1n, transactions: [] },
				{ chainId: activeChainId, safeAddress: otherSafeAddress, safeVersion: '1.4.1', baseNonce: 0n, threshold: 1n, transactions: [] },
				{ chainId: anotherChainId, safeAddress: activeSafeAddress, safeVersion: '1.4.1', baseNonce: 0n, threshold: 1n, transactions: [] },
			],
		}))
		await browserStorageLocalSet({
			simulationMode: false,
			activeSigningSafeAddress: activeSafeAddress,
			activeRpcNetwork: rpcNetwork,
			popupVisualisation: stalePopupVisualisation,
		})

		await resetSimulationStateFromConfig(createTestSimulationServicesOwner({ ethereum: fakeEthereum, tokenPriceService: fakeTokenPriceService }))

		const storedStack = (await browserStorageLocalGet('interceptorTransactionStack')).interceptorTransactionStack
		assert.ok(storedStack !== undefined)
		assert.deepEqual(storedStack.operations.map((operation) => operation.type === 'Transaction' ? operation.preSimulationTransaction.transactionIdentifier : operation.type), [1n, 3n, 4n])
		assert.deepEqual((await getSafeTransactionStacks()).map((stack) => [stack.chainId, stack.safeAddress]), [
			[activeChainId, otherSafeAddress],
			[anotherChainId, activeSafeAddress],
		])
	})

	test('preserves the interceptor stack when changing rpc within the same chain', async () => {
		const browserMock = installPopupBrowserMock({ isPopupOpen: false })
		const resets: RpcNetwork[] = []
		const simulationServicesOwner = createTestSimulationServicesOwner({ ethereum: fakeEthereum, tokenPriceService: fakeTokenPriceService }, (nextRpcEntry: RpcNetwork) => {
			resets.push(nextRpcEntry)
			return { ethereum: fakeEthereum, tokenPriceService: fakeTokenPriceService }
		})
		const interceptorTransactionStack = { operations: [{ type: 'TimeManipulation', blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION }] as const }
		await browserStorageLocalSet({
			independentActiveSimulationAddress: activeAddress,
			activeRpcNetwork: rpcNetwork,
			simulationMode: true,
			popupVisualisation: stalePopupVisualisation,
			interceptorTransactionStack,
		})

		await changeActiveRpc(simulationServicesOwner, new Map(), sameChainRpcNetwork, { source: 'dapp', simulationMode: true, signerTabId: undefined })

		const modules = await modulesPromise
		const updatedSettings = await modules.getSettings()
		const storedInterceptorTransactionStack = (await browserStorageLocalGet('interceptorTransactionStack')).interceptorTransactionStack
		const popupVisualisation = (await browserStorageLocalGet('popupVisualisation')).popupVisualisation
		assert.deepEqual(updatedSettings.activeRpcNetwork, sameChainRpcNetwork)
		assert.deepEqual(storedInterceptorTransactionStack, interceptorTransactionStack)
		assert.deepEqual(popupVisualisation, stalePopupVisualisation)
		assert.deepEqual(resets, [sameChainRpcNetwork])
		assert.equal(getSimulationStateChangedMessages(browserMock.calls.runtimeSendMessage).length, 0)
	})

	test('clears the interceptor stack when changing rpc to another chain', async () => {
		const browserMock = installPopupBrowserMock()
		const resets: RpcNetwork[] = []
		const simulationServicesOwner = createTestSimulationServicesOwner({ ethereum: fakeEthereum, tokenPriceService: fakeTokenPriceService }, (nextRpcEntry: RpcNetwork) => {
			resets.push(nextRpcEntry)
			return { ethereum: fakeEthereum, tokenPriceService: fakeTokenPriceService }
		})
		await browserStorageLocalSet({
			independentActiveSimulationAddress: activeAddress,
			activeRpcNetwork: rpcNetwork,
			simulationMode: true,
			popupVisualisation: stalePopupVisualisation,
			interceptorTransactionStack: { operations: [{ type: 'TimeManipulation', blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION }] },
		})

		await changeActiveRpc(simulationServicesOwner, new Map(), otherChainRpcNetwork, { source: 'dapp', simulationMode: true, signerTabId: undefined })

		const modules = await modulesPromise
		const updatedSettings = await modules.getSettings()
		const interceptorTransactionStack = (await browserStorageLocalGet('interceptorTransactionStack')).interceptorTransactionStack
		const popupVisualisation = (await browserStorageLocalGet('popupVisualisation')).popupVisualisation
		assert.deepEqual(updatedSettings.activeRpcNetwork, otherChainRpcNetwork)
		assert.deepEqual(interceptorTransactionStack, { operations: [] })
		assert.ok(popupVisualisation)
		assertDefinedEmptyPopupVisualisation(popupVisualisation)
		assert.deepEqual(resets, [otherChainRpcNetwork])

		const changedMessages = getSimulationStateChangedMessages(browserMock.calls.runtimeSendMessage)
		assert.equal(changedMessages.length > 0, true)
		assert.deepEqual(changedMessages.at(-1), getExpectedPopupSimulationChangedMessage(popupVisualisation))
	})

	test('return the complete visualized simulation reply through the background popup handler', async () => {
		installPopupBrowserMock()
		await browserStorageLocalSet({
			independentActiveSimulationAddress: activeAddress,
			popupVisualisation: stalePopupVisualisation,
			interceptorTransactionStack: { operations: [] },
		})

		const modules = await modulesPromise
		const reply = await modules.popupMessageHandler(
			new Map(),
			createTestSimulationServicesOwner({ ethereum: fakeEthereum, tokenPriceService: fakeTokenPriceService }),
			{ method: 'popup_requestCompleteVisualizedSimulation' },
			await modules.getSettings(),
			async () => undefined,
		)

		assert.ok(reply !== undefined && reply !== null && typeof reply === 'object' && 'method' in reply && reply.method === 'popup_requestCompleteVisualizedSimulation')
		assert.ok('visualizedSimulatorState' in reply)
		const visualizedSimulatorState = reply.visualizedSimulatorState
		assert.ok(visualizedSimulatorState !== undefined && visualizedSimulatorState !== null && typeof visualizedSimulatorState === 'object')
		assert.ok('simulationId' in visualizedSimulatorState && 'simulationResultState' in visualizedSimulatorState && 'simulationState' in visualizedSimulatorState)
		assert.equal(visualizedSimulatorState.simulationId, stalePopupVisualisation.simulationId + 1)
		assert.equal(visualizedSimulatorState.simulationResultState, stalePopupVisualisation.simulationResultState)
		const simulationState = visualizedSimulatorState.simulationState
		assert.ok(simulationState !== undefined && simulationState !== null && typeof simulationState === 'object' && 'kind' in simulationState && 'value' in simulationState)
		assert.equal(simulationState.kind, 'simulated')
		const simulationResult = simulationState.value
		assert.ok(typeof simulationResult === 'object' && simulationResult !== null && 'blockNumber' in simulationResult)
		assert.equal(simulationResult.blockNumber, '0x7b')
	})
})
