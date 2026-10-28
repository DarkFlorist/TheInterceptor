import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { IEthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import { EIP712Message } from '../../app/ts/types/eip721.js'
import type { PendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import type { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import type { SignMessageParams } from '../../app/ts/types/jsonRpc-signing-types.js'
import { SafeTx as SafeTxRuntype } from '../../app/ts/types/personal-message-definitions.js'
import type { SafeTx, VisualizedPersonalSignRequestSafeTx } from '../../app/ts/types/personal-message-definitions.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import { EthereumBlockHeader, EthereumQuantity } from '../../app/ts/types/wire-types.js'
import { stringifyJSONWithBigInts } from '../../app/ts/utils/bigint.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'
import { isObjectWithOptionalProperties } from '../harness/assertions.js'
import { hasMessageMethod } from './runtimeMessageMatchers.js'

const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value)

type PopupPendingMessageField = 'type' | 'transactionOrMessageCreationStatus' | 'approvalStatus' | 'uniqueRequestIdentifier' | 'website' | 'originalRequestParameters' | 'visualizedPersonalSignRequest'
type PopupVisualizedSignRequestField = 'type' | 'signerName' | 'activeAddress' | 'website'

const installBrowserMock = createPerTestBrowserMockInstaller()

// The confirmation flow asks whether the main popup is open; every other runtime message goes unanswered.
const installConfirmationBrowserMock = () => installBrowserMock({
	handlers: {
		runtimeMessage: (message) => hasMessageMethod(message, 'popup_isMainPopupWindowOpen')
			? { method: 'popup_isMainPopupWindowOpen', data: { isOpen: false } }
			: undefined,
	},
})

async function loadModules() {
	const popupMessageHandlers = await import('../../app/ts/background/popupMessageHandlers/confirmation.js')
	const confirmTransaction = await import('../../app/ts/background/windows/confirmTransaction.js')
	const ethereumClientService = await import('../../app/ts/simulation/services/EthereumClientService.js')
	const priceEstimator = await import('../../app/ts/simulation/services/priceEstimator.js')
	const settings = await import('../../app/ts/background/settings.js')
	const storageUtils = await import('../../app/ts/utils/storageUtils.js')
	const storageVariables = await import('../../app/ts/background/storageVariables.js')
	const popupVisualisationUpdater = await import('../../app/ts/background/popupVisualisationUpdater.js')

	return {
		refreshPopupConfirmTransactionMetadata: popupMessageHandlers.refreshPopupConfirmTransactionMetadata,
		updateConfirmTransactionView: confirmTransaction.updateConfirmTransactionView,
		EthereumClientService: ethereumClientService.EthereumClientService,
		TokenPriceService: priceEstimator.TokenPriceService,
		defaultActiveAddresses: settings.defaultActiveAddresses,
		browserStorageLocalSet: storageUtils.browserStorageLocalSet,
		browserStorageLocalSet2: storageUtils.browserStorageLocalSet2,
		getPopupVisualisationState: storageVariables.getPopupVisualisationState,
		refreshPopupVisualisationForOpenConsumer: popupVisualisationUpdater.refreshPopupVisualisationForOpenConsumer,
	}
}

const modulesPromise = loadModules()
type TestModules = Awaited<ReturnType<typeof loadModules>>

const fakeRpcNetwork: RpcEntry = {
	name: 'Test Chain',
	chainId: 1337n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	currencyLogoUri: undefined,
	primary: true,
	minimized: true,
}

function createFakeRequestHandler(respond: (rpcRequest: EthereumJsonRpcRequest) => Promise<unknown>): IEthereumJSONRpcRequestHandler {
	return {
		rpcUrl: fakeRpcNetwork.httpsRpc,
		clearCache() { return undefined },
		async getChainId() { return fakeRpcNetwork.chainId },
		jsonRpcRequest: respond,
	}
}

function makeFakeBlock(number: bigint) {
	return {
		author: 0n,
		difficulty: 0n,
		extraData: new Uint8Array(),
		gasLimit: 30_000_000n,
		gasUsed: 21_000n,
		hash: 0x1234n + number,
		logsBloom: 0n,
		miner: 0n,
		mixHash: 0n,
		nonce: 0n,
		number,
		parentHash: 0x1n,
		receiptsRoot: 0n,
		sha3Uncles: 0n,
		stateRoot: 0n,
		timestamp: new Date('2024-01-01T00:00:00.000Z'),
		size: 0n,
		totalDifficulty: 0n,
		uncles: [],
		baseFeePerGas: 1n,
		transactionsRoot: 0n,
		transactions: [],
		withdrawals: [],
		withdrawalsRoot: 0n,
	}
}

// Answers the block queries a confirmation refresh makes with a fixed fake block and rejects every other RPC method.
function createFakeBlockRequestHandler(fakeBlock: ReturnType<typeof makeFakeBlock>) {
	return createFakeRequestHandler(async (rpcRequest) => {
		switch (rpcRequest.method) {
			case 'eth_getBlockByNumber':
				return EthereumBlockHeader.serialize(fakeBlock)
			case 'eth_blockNumber':
				return EthereumQuantity.serialize(fakeBlock.number)
			default:
				throw new Error(`Unexpected RPC method: ${ rpcRequest.method }`)
		}
	})
}

function assertWireSafe(value: unknown, seen = new Set<unknown>()) {
	if (typeof value === 'bigint') throw new Error('Found bigint in serialized payload')
	if (typeof value === 'function') throw new Error('Found function in serialized payload')
	if (typeof value === 'symbol') throw new Error('Found symbol in serialized payload')
	if (value instanceof Date) throw new Error('Found Date in serialized payload')
	if (value instanceof Uint8Array) throw new Error('Found Uint8Array in serialized payload')
	if (typeof value !== 'object' || value === null) return
	if (seen.has(value)) return
	seen.add(value)
	// Object.values lists array elements as well as object properties.
	for (const nestedValue of Object.values(value)) assertWireSafe(nestedValue, seen)
}

function getPendingTransactionsUpdateMessage(sentMessages: readonly unknown[]) {
	const message = sentMessages.find((entry) => hasMessageMethod(entry, 'popup_update_confirm_transaction_dialog_pending_transactions'))
	if (!isObjectWithOptionalProperties<'role' | 'data'>(message)) throw new Error('Expected confirm transaction update message')
	const { data } = message
	if (!isObjectWithOptionalProperties<'pendingTransactionAndSignableMessages'>(data)) throw new Error('Expected confirm transaction message data')
	assert.equal(message.role, 'confirmTransaction')
	return { message, data }
}

function getPendingTransactionsUpdate(sentMessages: readonly unknown[]) {
	const pendingTransactions = getPendingTransactionsUpdateMessage(sentMessages).data.pendingTransactionAndSignableMessages
	if (!isUnknownArray(pendingTransactions)) throw new Error('Expected pendingTransactionAndSignableMessages array')
	return pendingTransactions
}

function getFirstSignablePendingMessage(sentMessages: readonly unknown[]) {
	const pendingTransactions = getPendingTransactionsUpdate(sentMessages)
	const firstPendingMessage = pendingTransactions[0]
	if (!isObjectWithOptionalProperties<PopupPendingMessageField>(firstPendingMessage)) throw new Error('Expected first pending message object')
	assert.equal(firstPendingMessage.type, 'SignableMessage')
	return firstPendingMessage
}

function createSafeTxMessage(rpcNetwork: RpcEntry, activeAddress: AddressBookEntry, recipient: AddressBookEntry): SafeTx {
	return {
		types: {
			SafeTx: [
				{ name: 'to', type: 'address' },
				{ name: 'value', type: 'uint256' },
				{ name: 'data', type: 'bytes' },
				{ name: 'operation', type: 'uint8' },
				{ name: 'safeTxGas', type: 'uint256' },
				{ name: 'baseGas', type: 'uint256' },
				{ name: 'gasPrice', type: 'uint256' },
				{ name: 'gasToken', type: 'address' },
				{ name: 'refundReceiver', type: 'address' },
				{ name: 'nonce', type: 'uint256' },
			],
			EIP712Domain: [
				{ name: 'chainId', type: 'uint256' },
				{ name: 'verifyingContract', type: 'address' },
			],
		},
		primaryType: 'SafeTx',
		domain: {
			chainId: rpcNetwork.chainId,
			verifyingContract: activeAddress.address,
		},
		message: {
			to: recipient.address,
			value: 0n,
			data: new Uint8Array(),
			operation: 0n,
			safeTxGas: 0n,
			baseGas: 0n,
			gasPrice: 0n,
			gasToken: 0n,
			refundReceiver: 0n,
			nonce: 0n,
		},
	}
}

function createVisualizedSafeTxMessage(rpcNetwork: RpcEntry, activeAddress: AddressBookEntry, recipient: AddressBookEntry): VisualizedPersonalSignRequestSafeTx {
	const safeTxMessage = createSafeTxMessage(rpcNetwork, activeAddress, recipient)
	const zeroAddressEntry: AddressBookEntry = {
		address: 0n,
		name: '0x0 Address',
		type: 'contact',
		entrySource: 'Interceptor',
		chainId: rpcNetwork.chainId,
	}

	return {
		activeAddress,
		rpcNetwork,
		simulationMode: true,
		signerName: 'NoSignerDetected',
		quarantineReasons: [],
		quarantine: false,
		account: activeAddress,
		website: { websiteOrigin: 'https://safe.example', icon: undefined, title: undefined },
		created: new Date('2024-01-01T00:00:01.000Z'),
		rawMessage: stringifyJSONWithBigInts(safeTxMessage),
		stringifiedMessage: stringifyJSONWithBigInts(safeTxMessage),
		messageIdentifier: 2n,
		method: 'eth_signTypedData_v4',
		type: 'SafeTx',
		message: safeTxMessage,
		parsedMessageDataAddressBookEntries: [],
		parsedMessageData: { type: 'NonParsed', input: new Uint8Array() },
		gasToken: zeroAddressEntry,
		to: recipient,
		refundReceiver: zeroAddressEntry,
		verifyingContract: activeAddress,
		messageHash: '0x1',
		domainHash: '0x2',
		safeTxHash: '0x3',
	}
}

function createPendingSafeTxMessage(modules: TestModules, rpcNetwork: RpcEntry): PendingTransactionOrSignableMessage {
	const activeAddress = modules.defaultActiveAddresses[0]
	const recipient = modules.defaultActiveAddresses[1]
	if (activeAddress === undefined || recipient === undefined) throw new Error('Missing default active addresses for test')

	const visualizedPersonalSignRequest = createVisualizedSafeTxMessage(rpcNetwork, activeAddress, recipient)
	// Parsed from JSON like a dapp's eth_signTypedData_v4 request, so the typed data holds serialized values.
	const originalRequestParameters: SignMessageParams = {
		method: 'eth_signTypedData_v4',
		params: [activeAddress.address, EIP712Message.parse(JSON.stringify(SafeTxRuntype.serialize(visualizedPersonalSignRequest.message)))],
	}

	return {
		type: 'SignableMessage',
		popupOrTabId: { type: 'popup', id: 1 },
		originalRequestParameters,
		simulationMode: true,
		uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } },
		signedMessageTransaction: {
			website: visualizedPersonalSignRequest.website,
			created: visualizedPersonalSignRequest.created,
			activeAddress: activeAddress.address,
			fakeSignedFor: activeAddress.address,
			originalRequestParameters,
			request: {
				method: 'eth_signTypedData_v4',
				params: [{ unsafeBigInt: 123n, unsafeBytes: new Uint8Array([1, 2, 3]) }, new Date('2024-01-01T00:00:02.000Z')],
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } },
			},
			simulationMode: true,
			messageIdentifier: visualizedPersonalSignRequest.messageIdentifier,
		},
		created: visualizedPersonalSignRequest.created,
		website: visualizedPersonalSignRequest.website,
		activeAddress: activeAddress.address,
		approvalStatus: { status: 'WaitingForUser' },
		transactionOrMessageCreationStatus: 'Simulated',
		visualizedPersonalSignRequest,
	}
}

function assertPopupPendingSafeTxShape(sentMessages: readonly unknown[]) {
	assertWireSafe(getPendingTransactionsUpdateMessage(sentMessages).message)
	const firstPendingMessage = getFirstSignablePendingMessage(sentMessages)
	assert.equal('signedMessageTransaction' in firstPendingMessage, false)
	assert.equal(firstPendingMessage.transactionOrMessageCreationStatus, 'Simulated')
	assert.equal(firstPendingMessage.approvalStatus !== undefined, true)
	assert.equal(firstPendingMessage.uniqueRequestIdentifier !== undefined, true)
	assert.equal(firstPendingMessage.website !== undefined, true)
	assert.equal(firstPendingMessage.originalRequestParameters !== undefined, true)

	const visualizedPersonalSignRequest = firstPendingMessage.visualizedPersonalSignRequest
	if (!isObjectWithOptionalProperties<PopupVisualizedSignRequestField>(visualizedPersonalSignRequest)) throw new Error('Expected visualized personal sign request')
	assert.equal('request' in visualizedPersonalSignRequest, false)
	assert.equal(visualizedPersonalSignRequest.type, 'SafeTx')
	assert.equal(visualizedPersonalSignRequest.signerName, 'NoSignerDetected')
	assert.equal(visualizedPersonalSignRequest.activeAddress !== undefined, true)
	assert.equal(visualizedPersonalSignRequest.website !== undefined, true)
}

describe('SafeTx confirm transaction metadata', () => {
	test('uses the stored visualisation when a confirmation refresh fails unexpectedly', async () => {
		installConfirmationBrowserMock()
		const modules = await modulesPromise
		const ethereum = new modules.EthereumClientService(
			createFakeRequestHandler(async () => { throw new Error('RPC should not be called') }),
			async () => undefined,
			async () => undefined,
			fakeRpcNetwork,
		)
		const tokenPriceService = new modules.TokenPriceService(ethereum, 0)
		const storedVisualisation = await modules.getPopupVisualisationState()
		const refreshError = new Error('Unexpected visualizer failure')
		let reportedError: unknown

		const result = await modules.refreshPopupVisualisationForOpenConsumer(ethereum, tokenPriceService, {
			async update() { throw refreshError },
			async getStored() { return storedVisualisation },
			async reportError(error) {
				reportedError = error
				return undefined
			},
		})

		assert.equal(result, storedVisualisation)
		assert.equal(reportedError, refreshError)
	})

	test('still updates confirmation metadata when visualisation refresh falls back', async () => {
		const browserMock = installConfirmationBrowserMock()
		const modules = await modulesPromise
		const ethereum = new modules.EthereumClientService(createFakeBlockRequestHandler(makeFakeBlock(122n)), async () => undefined, async () => undefined, fakeRpcNetwork)
		const tokenPriceService = new modules.TokenPriceService(ethereum, 0)
		await modules.browserStorageLocalSet({
			simulationMode: true,
			activeRpcNetwork: fakeRpcNetwork,
			userAddressBookEntriesV3: modules.defaultActiveAddresses,
		})
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [createPendingSafeTxMessage(modules, fakeRpcNetwork)] })
		const storedVisualisation = { ...await modules.getPopupVisualisationState(), simulationId: 77 }
		const refreshError = new Error('Unexpected visualizer failure')
		let reportedError: unknown
		let reportCalls = 0

		await modules.refreshPopupConfirmTransactionMetadata(ethereum, tokenPriceService, undefined, {
			visualisation: {
				async update() { throw refreshError },
				async getStored() { return storedVisualisation },
				async reportError(error) {
					reportCalls += 1
					reportedError = error
					return undefined
				},
			},
		})

		const dialogUpdate = browserMock.calls.runtimeSendMessage.find((message) => hasMessageMethod(message, 'popup_update_confirm_transaction_dialog'))
		if (!isObjectWithOptionalProperties<'data'>(dialogUpdate) || !isObjectWithOptionalProperties<'visualizedSimulatorState'>(dialogUpdate.data)) throw new Error('Missing confirm transaction dialog update')
		const visualizedSimulatorState = dialogUpdate.data.visualizedSimulatorState
		if (!isObjectWithOptionalProperties<'simulationId'>(visualizedSimulatorState)) throw new Error('Missing stored visualisation in confirm transaction dialog update')
		assert.equal(visualizedSimulatorState.simulationId, 77)
		assert.equal(reportedError, refreshError)
		assert.equal(reportCalls, 1)
	})

	test('refresh confirm metadata sends popup-safe SafeTx payload', async () => {
		const browserMock = installConfirmationBrowserMock()
		const modules = await modulesPromise
		const ethereum = new modules.EthereumClientService(createFakeBlockRequestHandler(makeFakeBlock(123n)), async () => undefined, async () => undefined, fakeRpcNetwork)
		const tokenPriceService = new modules.TokenPriceService(ethereum, 0)
		await modules.browserStorageLocalSet({
			simulationMode: true,
			activeRpcNetwork: fakeRpcNetwork,
			userAddressBookEntriesV3: modules.defaultActiveAddresses,
		})
		await modules.browserStorageLocalSet2({
			pendingTransactionsAndMessages: [createPendingSafeTxMessage(modules, fakeRpcNetwork)],
		})

		await modules.refreshPopupConfirmTransactionMetadata(ethereum, tokenPriceService, undefined)

		assertPopupPendingSafeTxShape(browserMock.calls.runtimeSendMessage)
		assert.equal((await modules.getPopupVisualisationState()).simulationId, 1)
		assert.equal(browserMock.calls.runtimeSendMessage.some((message) => hasMessageMethod(message, 'popup_isSimulationVisualizerOpen')), false)
	})

	test('initial confirm render sends popup-safe SafeTx payload', async () => {
		const browserMock = installConfirmationBrowserMock()
		const modules = await modulesPromise
		const ethereum = new modules.EthereumClientService(createFakeBlockRequestHandler(makeFakeBlock(456n)), async () => undefined, async () => undefined, fakeRpcNetwork)
		const tokenPriceService = new modules.TokenPriceService(ethereum, 0)
		await modules.browserStorageLocalSet({
			simulationMode: true,
			activeRpcNetwork: fakeRpcNetwork,
			userAddressBookEntriesV3: modules.defaultActiveAddresses,
		})
		await modules.browserStorageLocalSet2({
			pendingTransactionsAndMessages: [createPendingSafeTxMessage(modules, fakeRpcNetwork)],
		})

		await modules.updateConfirmTransactionView(ethereum, tokenPriceService)

		assertPopupPendingSafeTxShape(browserMock.calls.runtimeSendMessage)
	})
})
