import { createDeferredValue, createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import { createSimulationServicesOwner } from '../../app/ts/simulation/serviceLifecycle.js'
import * as assert from 'assert'
import { test } from 'bun:test'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { getLatestUnexpectedError, getPendingAccessRequests, setLatestUnexpectedError } from '../../app/ts/background/storageVariables.js'
import { getRequiredSettings } from './requiredSettings.js'
import { activeAddress, addressString, browserMock, createSafeAddressBookEntry, createSafeTx, createWebsitePort, EIP712Message, ethereum, fakeRequestHandler, fakeRpcNetwork, fakeSafeContract, getSafeTxHash, isRecord, modules, oldTimestamp, pendingTransaction, privateKeyToAccount, recipientAddress, SAFE_EXECUTION_ABI, safeTestOwnerAccount, safeTestOwnerAddress, safeTxToTypedDataJson, signedTransaction, simulator, uniqueRequestIdentifier, withSilencedConsole } from './confirmTransactionTestHarness.js'

test('refreshing confirm transaction updates the persisted simulation timestamp', async () => {
	browserMock.sentMessages.length = 0
	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	const [pendingTransaction] = await modules.getPendingTransactionsAndMessages()
	if (pendingTransaction === undefined || pendingTransaction.type !== 'Transaction') throw new Error('missing refreshed pending transaction')
	if (pendingTransaction.popupVisualisation.statusCode !== 'success') throw new Error('unexpected popup visualisation state')
	const refreshedTimestamp = pendingTransaction.popupVisualisation.data.simulationState.simulationConductedTimestamp
	assert.ok(refreshedTimestamp.getTime() > oldTimestamp.getTime())
	assert.equal(browserMock.sentMessages.some((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions'), true)
})
test('accepts a signer reply from the current approved child-frame port', async () => {
	const topSocket = { tabId: 1, connectionName: 40n }
	const childSocket = { tabId: 1, connectionName: 41n }
	const childRequestIdentifier = { requestId: 77, requestSocket: childSocket }
	const topMessages: unknown[] = []
	const childMessages: unknown[] = []
	const topPort = createWebsitePort(topSocket, 0, topMessages)
	const childPort = createWebsitePort(childSocket, 2, childMessages)
	const websiteOrigin = 'https://example.com'
	const websiteTabConnections = new Map([[topSocket.tabId, {
		signerStateOwner: {
			connectionName: topSocket.connectionName,
			confirmed: true,
			generation: 3,
			providerGeneration: 8,
		},
		connections: {
			[modules.websiteSocketToString(topSocket)]: { port: topPort, socket: topSocket, websiteOrigin, approved: true, wantsToConnect: true },
			[modules.websiteSocketToString(childSocket)]: { port: childPort, socket: childSocket, websiteOrigin, approved: true, wantsToConnect: true },
		},
	}]])
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			uniqueRequestIdentifier: childRequestIdentifier,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
		}],
	})

	await modules.signerReply(createTestSimulationServicesOwner({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService }), websiteTabConnections, childPort, {
		method: 'signer_reply',
		params: [{
			success: true,
			signerProviderGeneration: 12,
			forwardRequest: {
				type: 'forwardToSigner',
				replyWithSignersReply: true,
				method: pendingTransaction.originalRequestParameters.method,
				params: pendingTransaction.originalRequestParameters.params,
				requestId: childRequestIdentifier.requestId,
			},
			reply: modules.EthereumBytes32.serialize(signedTransaction.hash),
		}],
		interceptorRequest: true,
		interceptorInternalRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 78, requestSocket: childSocket },
	}, 'hasAccess', activeAddress)

	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.equal(topMessages.length, 0)
	const childReply = childMessages.find((message) => isRecord(message) && message.method === 'eth_sendTransaction' && message.requestId === childRequestIdentifier.requestId)
	if (!isRecord(childReply)) throw new Error('Missing child-frame signer reply')
	assert.equal(childReply.result, modules.EthereumBytes32.serialize(signedTransaction.hash))
})

test('settles a direct signing reply while RPC services are unavailable', async () => {
	const socket = { tabId: 1, connectionName: 42n }
	const requestIdentifier = { requestId: 78, requestSocket: socket }
	const messages: unknown[] = []
	const port = createWebsitePort(socket, 0, messages)
	const websiteTabConnections = new Map([[socket.tabId, {
		signerStateOwner: {
			connectionName: socket.connectionName,
			confirmed: true,
			generation: 3,
			providerGeneration: 8,
		},
		connections: {
			[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true },
		},
	}]])
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			uniqueRequestIdentifier: requestIdentifier,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
		}],
	})
	const owner = createTestSimulationServicesOwner({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService })
	owner.clear()

	await modules.signerReply(owner, websiteTabConnections, port, {
		method: 'signer_reply',
		params: [{
			success: true,
			signerProviderGeneration: 8,
			forwardRequest: {
				type: 'forwardToSigner',
				replyWithSignersReply: true,
				method: pendingTransaction.originalRequestParameters.method,
				params: pendingTransaction.originalRequestParameters.params,
				requestId: requestIdentifier.requestId,
			},
			reply: modules.EthereumBytes32.serialize(signedTransaction.hash),
		}],
		interceptorRequest: true,
		interceptorInternalRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 79, requestSocket: socket },
	}, 'hasAccess', activeAddress)

	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	const dappReply = messages.find((message) => isRecord(message) && message.method === 'eth_sendTransaction' && message.requestId === requestIdentifier.requestId)
	if (!isRecord(dappReply)) throw new Error('Missing signer reply while services were unavailable')
	assert.equal(dappReply.result, modules.EthereumBytes32.serialize(signedTransaction.hash))
})

test('replays a Safe signature deferred while only the RPC configuration was unreadable once retrying recovers it', async () => {
	const { retryRpcConfiguration } = await import('../../app/ts/background/popupMessageHandlers/settings.js')
	const socket = { tabId: 1, connectionName: 47n }
	const requestIdentifier = { requestId: 88, requestSocket: socket }
	const messages: unknown[] = []
	const port = createWebsitePort(socket, 0, messages)
	const websiteTabConnections = new Map([[socket.tabId, {
		signerStateOwner: { connectionName: socket.connectionName, confirmed: true, generation: 3, providerGeneration: 8 },
		connections: {
			[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true },
		},
	}]])
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, { to: recipientAddress, value: 0n, input: new Uint8Array() }, 0n)
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	fakeSafeContract.nonce = 0n
	fakeSafeContract.threshold = 2n
	fakeSafeContract.owners = [safeTestOwnerAddress]
	const signature = await safeTestOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			uniqueRequestIdentifier: requestIdentifier,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
			signerRequestChainId: fakeRpcNetwork.chainId,
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: safeTestOwnerAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [safeTestOwnerAddress], threshold: 2n },
				safeTxHash,
				safeTx,
			},
		}],
	})
	// The owner keeps its installed services for the whole outage; only reading the RPC configuration fails.
	let deferredReplay: Promise<void> | undefined
	const simulationServicesOwner = createSimulationServicesOwner(fakeRpcNetwork, async () => undefined, async () => undefined, {}, () => {
		deferredReplay = modules.resolveDeferredSafeSignerReplies({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService }, websiteTabConnections)
	})
	let rpcConfigurationReadable = false
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!rpcConfigurationReadable && Array.isArray(keys) && keys.includes('rpcEntries')) throw new Error('Storage read failed')
		return readStoredItems()
	})

	await modules.signerReply(simulationServicesOwner, websiteTabConnections, port, {
		method: 'signer_reply',
		params: [{
			success: true,
			signerProviderGeneration: 8,
			forwardRequest: {
				type: 'forwardToSigner',
				replyWithSignersReply: true,
				method: 'eth_signTypedData_v4',
				params: [recipientAddress, EIP712Message.parse(safeTxToTypedDataJson(safeTx))],
				requestId: requestIdentifier.requestId,
			},
			reply: signature,
		}],
		interceptorRequest: true,
		interceptorInternalRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 89, requestSocket: socket },
	}, 'hasAccess', activeAddress)
	assert.notEqual(simulationServicesOwner.getCurrent(), undefined)
	// The website has its proposal hash right away; the signed proposal waits in the outbox, not in the pending queue.
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual((await modules.getPendingSafeProposalStores()).map((entry) => entry.signerReply), [signature])
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])

	rpcConfigurationReadable = true
	await retryRpcConfiguration(simulationServicesOwner, async () => undefined)
	await deferredReplay

	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getPendingSafeProposalStores(), [])
	const [persistedStack] = await modules.getSafeTransactionStacks()
	assert.deepEqual(persistedStack?.transactions[0]?.signatures, [{ signer: safeTestOwnerAddress, signature }])
	assert.equal(messages.filter((message) => isRecord(message) && message.method === 'eth_sendTransaction' && message.requestId === requestIdentifier.requestId && message.result === modules.EthereumBytes32.serialize(safeTxHash)).length, 1)
	simulationServicesOwner.clear()
})

// Runs `interleaved` once, the first time the signer reply reads the pending requests (after it captured its services, before it writes its deferral).
function runOnceWhenTheSignerReplyReadsItsRequest(interleaved: () => Promise<void>) {
	let ran = false
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!ran && Array.isArray(keys) && keys.includes('pendingTransactionsAndMessages')) {
			ran = true
			await interleaved()
		}
		return readStoredItems()
	})
}

const otherChainRpc = { ...fakeRpcNetwork, name: 'Other chain', chainId: fakeRpcNetwork.chainId + 1n }
// Services for another chain answered by the same fake RPC, so that chain's Safe state would validate a chain-A signature.
const createOtherChainSimulator = () => {
	const otherChainEthereum = new modules.EthereumClientService(fakeRequestHandler, async () => undefined, async () => undefined, otherChainRpc)
	return { ethereum: otherChainEthereum, tokenPriceService: new modules.TokenPriceService(otherChainEthereum, 60_000) }
}

// Defers a signed Safe proposal for chain A (fakeRpcNetwork) while RPC services are unavailable; the website receives its proposal hash right away. `whileReplyIsResolved` runs once the signer reply has captured its services and before its deferral is written.
async function deferSafeProposalSignatureOnChainA(owner: Parameters<typeof modules.signerReply>[0], requestId: number, connectionName: bigint, whileReplyIsResolved?: (websiteTabConnections: Parameters<typeof modules.resolveDeferredSafeSignerReplies>[1]) => Promise<void>, expectedReplyFailure?: RegExp) {
	const socket = { tabId: 1, connectionName }
	const requestIdentifier = { requestId, requestSocket: socket }
	const messages: unknown[] = []
	const port = createWebsitePort(socket, 0, messages)
	const websiteTabConnections = new Map([[socket.tabId, {
		signerStateOwner: { connectionName: socket.connectionName, confirmed: true, generation: 3, providerGeneration: 8 },
		connections: {
			[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true },
		},
	}]])
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, { to: recipientAddress, value: 0n, input: new Uint8Array() }, 0n)
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	fakeSafeContract.nonce = 0n
	fakeSafeContract.threshold = 2n
	fakeSafeContract.owners = [safeTestOwnerAddress]
	const signature = await safeTestOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			uniqueRequestIdentifier: requestIdentifier,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
			signerRequestChainId: fakeRpcNetwork.chainId,
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: safeTestOwnerAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [safeTestOwnerAddress], threshold: 2n },
				safeTxHash,
				safeTx,
			},
		}],
	})
	if (whileReplyIsResolved !== undefined) runOnceWhenTheSignerReplyReadsItsRequest(async () => await whileReplyIsResolved(websiteTabConnections))
	const signerReply = modules.signerReply(owner, websiteTabConnections, port, {
		method: 'signer_reply',
		params: [{
			success: true,
			signerProviderGeneration: 8,
			forwardRequest: {
				type: 'forwardToSigner',
				replyWithSignersReply: true,
				method: 'eth_signTypedData_v4',
				params: [recipientAddress, EIP712Message.parse(safeTxToTypedDataJson(safeTx))],
				requestId,
			},
			reply: signature,
		}],
		interceptorRequest: true,
		interceptorInternalRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: requestId + 1000, requestSocket: socket },
	}, 'hasAccess', activeAddress)
	if (expectedReplyFailure === undefined) await signerReply
	else await assert.rejects(signerReply, expectedReplyFailure)
	browserMock.setStorageGetHandler(undefined)
	const dappReplies = () => messages.filter((message) => isRecord(message) && message.method === 'eth_sendTransaction' && message.requestId === requestId)
	assert.equal(dappReplies().length, 1)
	// The request is settled like any completed request; the signed proposal waits in the outbox for chain A's services.
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	if (whileReplyIsResolved !== undefined) return { requestIdentifier, websiteTabConnections, safeTxHash, signature, dappReplies, messages }
	assert.deepEqual((await modules.getPendingSafeProposalStores()).map((entry) => ({ chainId: entry.chainId, signerReply: entry.signerReply })), [{ chainId: fakeRpcNetwork.chainId, signerReply: signature }])
	return { requestIdentifier, websiteTabConnections, safeTxHash, signature, dappReplies, messages }
}

const assertStoredOnChainAOnce = async (deferred: { readonly safeTxHash: bigint, readonly signature: string, readonly dappReplies: () => unknown[] }) => {
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getPendingSafeProposalStores(), [])
	const stacks = await modules.getSafeTransactionStacks()
	assert.deepEqual(stacks.map((stack) => stack.chainId), [fakeRpcNetwork.chainId])
	assert.deepEqual(stacks[0]?.transactions.map((transaction) => ({ safeTxHash: transaction.safeTxHash, signatures: transaction.signatures })), [{ safeTxHash: deferred.safeTxHash, signatures: [{ signer: safeTestOwnerAddress, signature: deferred.signature }] }])
	assert.equal(deferred.dappReplies().length, 1)
}

// A signature deferred on chain A is bound to that chain: services installed for chain B neither store it in B's Safe stack nor drop it as invalid.
test('keeps an outbox Safe proposal for its own chain until services for that chain are installed', async () => {
	const owner = createTestSimulationServicesOwner({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService })
	owner.clear()
	const deferred = await deferSafeProposalSignatureOnChainA(owner, 86, 47n)
	const outboxOnChainA = await modules.getPendingSafeProposalStores()

	await modules.resolveDeferredSafeSignerReplies(createOtherChainSimulator(), deferred.websiteTabConnections)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
	assert.deepEqual(await modules.getPendingSafeProposalStores(), outboxOnChainA)

	await modules.resolveDeferredSafeSignerReplies(simulator, deferred.websiteTabConnections)
	await assertStoredOnChainAOnce(deferred)
})

// Services recovered for chain B before chain A's proposal signature arrives must not validate or store it: it goes to chain A's outbox with its hash reply, as when no services are available.
test('keeps a proposal signature for its own chain when services for another chain arrive first', async () => {
	const otherChainOwner = createTestSimulationServicesOwner(createOtherChainSimulator())
	const deferred = await deferSafeProposalSignatureOnChainA(otherChainOwner, 106, 57n)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])

	await modules.resolveDeferredSafeSignerReplies(simulator, deferred.websiteTabConnections)
	await assertStoredOnChainAOnce(deferred)
})

// The signature of a proposal prepared on chain A is valid only for chain A's EIP-712 domain: approving it after services moved to chain B is refused, and a valid signature delivered anyway reaches neither chain B's stack nor the outbox.
test('refuses a proposal prepared for another chain than the services approving it', async () => {
	const otherChainSimulator = createOtherChainSimulator()
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({ ...state, signerAccounts: [safeTestOwnerAddress], activeSigningAddress: safeTestOwnerAddress }))
	// The Safe exists with the same owners and nonce on both chains.
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeSimulationSignerAddress: activeAddress }), createSafeAddressBookEntry({ chainId: otherChainRpc.chainId, safeSimulationSignerAddress: activeAddress })])
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, postedMessages)
	const websiteTabConnections = new Map([[socket.tabId, { connections: { [modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true } } }]])
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, { to: recipientAddress, value: 0n, input: new Uint8Array() }, 0n)
	fakeSafeContract.nonce = 0n
	fakeSafeContract.threshold = 2n
	fakeSafeContract.owners = [safeTestOwnerAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{
		...pendingTransaction,
		simulationMode: false,
		safeTransaction: { safeAddress: activeAddress, safeSignerAddress: safeTestOwnerAddress, safeVersion: '1.4.1', threshold: 2n, reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [safeTestOwnerAddress], threshold: 2n }, safeTxHash: BigInt(getSafeTxHash(safeTx)), safeTx },
	}] })

	assert.equal(await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(otherChainSimulator.ethereum, otherChainSimulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } })), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [refused] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refused?.approvalStatus.status, 'SignerError')
	assert.equal(refused?.signerRequestChainId, undefined)

	// A valid chain-A signature delivered with chain-B services, through the signer reply or straight to validation.
	const signature = await safeTestOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	await modules.signerReply(createTestSimulationServicesOwner(otherChainSimulator), websiteTabConnections, port, {
		method: 'signer_reply',
		params: [{ success: true, signerProviderGeneration: 0, forwardRequest: { type: 'forwardToSigner', replyWithSignersReply: true, method: 'eth_signTypedData_v4', params: [safeTestOwnerAddress, EIP712Message.parse(safeTxToTypedDataJson(safeTx))], requestId: uniqueRequestIdentifier.requestId }, reply: signature }],
		interceptorRequest: true,
		interceptorInternalRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: uniqueRequestIdentifier.requestId + 1000, requestSocket: socket },
	}, 'hasAccess', activeAddress)
	await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(otherChainSimulator.ethereum, otherChainSimulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'signerIncluded', signerReply: signature, uniqueRequestIdentifier } }))

	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
	assert.deepEqual(await modules.getPendingSafeProposalStores(), [])
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'result' && message.requestId === uniqueRequestIdentifier.requestId && 'result' in message), false)
})

// Recovery on the signature's own chain can finish its replay scan after the reply captured its (missing) services and before the outbox entry is written; the reply then replays the entry itself, once.
test('stores a proposal signature once when matching recovery finished its scan before the outbox entry was written', async () => {
	const owner = createTestSimulationServicesOwner(simulator, () => simulator)
	owner.clear()
	const deferred = await deferSafeProposalSignatureOnChainA(owner, 108, 59n, async (websiteTabConnections) => {
		owner.recover(fakeRpcNetwork)
		await modules.resolveDeferredSafeSignerReplies(simulator, websiteTabConnections)
	})
	await assertStoredOnChainAOnce(deferred)
})

// The reply's delivery bookkeeping fails after the outbox entry was written; the entry is still replayed by the reply itself.
test('stores a proposal signature once when its reply bookkeeping fails after matching recovery finished its scan', async () => {
	const owner = createTestSimulationServicesOwner(simulator, () => simulator)
	owner.clear()
	let failTerminalReplyCleanup = true
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if (failTerminalReplyCleanup && Object.keys(items).join() === 'pendingTerminalReplies') {
			failTerminalReplyCleanup = false
			throw new Error('Terminal reply cleanup unavailable.')
		}
		writeStoredItems()
	})
	try {
		const deferred = await deferSafeProposalSignatureOnChainA(owner, 110, 60n, async (websiteTabConnections) => {
			owner.recover(fakeRpcNetwork)
			await modules.resolveDeferredSafeSignerReplies(simulator, websiteTabConnections)
		}, /Terminal reply cleanup unavailable/u)
		assert.equal(failTerminalReplyCleanup, false)
		await assertStoredOnChainAOnce(deferred)
	} finally {
		browserMock.setStorageSetHandler(undefined)
	}
})

// The reply's delivery bookkeeping fails and the replay that follows fails too: the delivery error still reaches the caller and the replay error is reported.
test('keeps both errors observable when the replay after a failed proposal reply bookkeeping fails as well', async () => {
	const owner = createTestSimulationServicesOwner(simulator, () => simulator)
	owner.clear()
	await setLatestUnexpectedError(undefined)
	let failTerminalReplyCleanup = true
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if (failTerminalReplyCleanup && Object.keys(items).join() === 'pendingTerminalReplies') {
			failTerminalReplyCleanup = false
			throw new Error('Terminal reply cleanup unavailable.')
		}
		writeStoredItems()
	})
	try {
		await withSilencedConsole(async () => await deferSafeProposalSignatureOnChainA(owner, 112, 61n, async (websiteTabConnections) => {
			owner.recover(fakeRpcNetwork)
			await modules.resolveDeferredSafeSignerReplies(simulator, websiteTabConnections)
			// Once the reply's cleanup has failed, the outbox cannot be read for the replay.
			browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
				if (!failTerminalReplyCleanup && Array.isArray(keys) && keys.includes('pendingSafeProposalStores')) throw new Error('Outbox unavailable for the replay.')
				return readStoredItems()
			})
		}, /Terminal reply cleanup unavailable/u))
		assert.match((await getLatestUnexpectedError())?.data.message ?? '', /Outbox unavailable for the replay/u)
	} finally {
		browserMock.setStorageSetHandler(undefined)
		browserMock.setStorageGetHandler(undefined)
	}
})

test('replays a deferred Safe signature when a normal network switch returns to its chain', async () => {
	const { changeActiveAddressAndChain } = await import('../../app/ts/background/activeSettings.js')
	const otherChainSimulator = createOtherChainSimulator()
	const replays: Promise<void>[] = []
	let websiteTabConnectionsForReplay: Parameters<typeof modules.resolveDeferredSafeSignerReplies>[1] = new Map()
	// Background startup replays with the owner's current services whenever they are installed; the installed services talk to the network, so the replay answers with fake-RPC services for the same chain.
	const owner = createSimulationServicesOwner(undefined, async () => undefined, async () => undefined, {}, () => {
		const services = owner.getCurrent()?.ethereum.getChainId() === fakeRpcNetwork.chainId ? simulator : otherChainSimulator
		replays.push(modules.resolveDeferredSafeSignerReplies(services, websiteTabConnectionsForReplay))
	})
	try {
		const deferred = await deferSafeProposalSignatureOnChainA(owner, 90, 49n)
		websiteTabConnectionsForReplay = deferred.websiteTabConnections
		const { setRpcConfiguration } = await import('../../app/ts/background/rpcConfigurationStorage.js')
		await setRpcConfiguration([fakeRpcNetwork, otherChainRpc], otherChainRpc)
		owner.recover(otherChainRpc)
		await Promise.all(replays)
		await modules.onCloseWindowOrTab(pendingTransaction.popupOrTabId, otherChainSimulator.ethereum, otherChainSimulator.tokenPriceService, deferred.websiteTabConnections)
		assert.deepEqual(await modules.getSafeTransactionStacks(), [])
		assert.equal((await modules.getPendingSafeProposalStores()).length, 1)

		await withSilencedConsole(async () => await changeActiveAddressAndChain(owner, deferred.websiteTabConnections, { simulationMode: false, rpcNetwork: fakeRpcNetwork }))
		await Promise.all(replays)

		await assertStoredOnChainAOnce(deferred)
	} finally {
		owner.clear()
	}
})

// The website already has the proposal hash, so a signature that no longer validates on its own chain is dropped with a visible failure and the website is never sent a second, contradicting reply.
test.each(['missing-window recovery', 'Reject'] as const)('drops an outbox Safe proposal that fails validation on its chain without a second website reply (%s)', async (laterAction) => {
	const owner = createTestSimulationServicesOwner({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService })
	owner.clear()
	const deferred = await deferSafeProposalSignatureOnChainA(owner, laterAction === 'Reject' ? 96 : 98, laterAction === 'Reject' ? 53n : 54n)
	await setLatestUnexpectedError(undefined)
	// The Safe executed another transaction meanwhile, so the signed nonce is no longer the next one.
	fakeSafeContract.nonce = 1n
	try {
		await withSilencedConsole(async () => await modules.resolveDeferredSafeSignerReplies(simulator, deferred.websiteTabConnections))
		if (laterAction === 'Reject') {
			await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, deferred.websiteTabConnections, {
				method: 'popup_confirmDialog',
				data: { uniqueRequestIdentifier: deferred.requestIdentifier, action: 'reject' },
			})
		} else {
			await modules.resolvePendingRequestsForMissingConfirmationWindows(simulator.ethereum, simulator.tokenPriceService, deferred.websiteTabConnections)
		}
	} finally {
		fakeSafeContract.nonce = 0n
	}

	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getPendingSafeProposalStores(), [])
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
	assert.equal(deferred.dappReplies().length, 1)
	assert.equal(deferred.messages.some((message) => isRecord(message) && message.requestId === deferred.requestIdentifier.requestId && 'error' in message), false)
	assert.match((await getLatestUnexpectedError())?.data.message ?? '', /could not be added to the Safe stack/u)
})

// The outbox entry is outside the pending queue, so it never owns the confirmation window of later requests.
test('closing a later request\'s confirmation window settles it while a Safe proposal waits in the outbox', async () => {
	const owner = createTestSimulationServicesOwner({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService })
	owner.clear()
	const deferred = await deferSafeProposalSignatureOnChainA(owner, 100, 55n)
	const laterWindow = { type: 'popup' as const, id: 77 }
	const laterRequests = [101, 102].map((requestId) => ({ ...pendingTransaction, uniqueRequestIdentifier: { requestId, requestSocket: deferred.requestIdentifier.requestSocket }, popupOrTabId: laterWindow }))
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [...await modules.getPendingTransactionsAndMessages(), ...laterRequests] })
	const otherChainSimulator = createOtherChainSimulator()

	await modules.onCloseWindowOrTab(laterWindow, otherChainSimulator.ethereum, otherChainSimulator.tokenPriceService, deferred.websiteTabConnections)

	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	for (const requestId of [101, 102]) assert.equal(deferred.messages.some((message) => isRecord(message) && message.requestId === requestId && 'error' in message), true, `request ${ requestId } is answered`)
	assert.equal((await modules.getPendingSafeProposalStores()).length, 1)
	assert.equal(deferred.dappReplies().length, 1)
})

// Earlier builds kept an acknowledged proposal pending; without its signing chain it cannot be stored, and re-signing through the completed request is impossible, so it is dropped visibly.
test('drops an earlier build\'s acknowledged Safe proposal without a recorded chain with a visible failure', async () => {
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, { to: recipientAddress, value: 0n, input: new Uint8Array() }, 0n)
	const requestIdentifier = { requestId: 104, requestSocket: { tabId: 1, connectionName: 56n } }
	const postedMessages: unknown[] = []
	const port = createWebsitePort(requestIdentifier.requestSocket, 0, postedMessages)
	const websiteTabConnections = new Map([[1, { connections: { [modules.websiteSocketToString(requestIdentifier.requestSocket)]: { port, socket: requestIdentifier.requestSocket, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true } } }]])
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			uniqueRequestIdentifier: requestIdentifier,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
			deferredSafeSignerReply: { signerReply: '0x1234', terminalReplyQueued: true },
			safeTransaction: { safeAddress: activeAddress, safeSignerAddress: safeTestOwnerAddress, safeVersion: '1.4.1', threshold: 2n, reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [safeTestOwnerAddress], threshold: 2n }, safeTxHash: BigInt(getSafeTxHash(safeTx)), safeTx },
		}],
	})
	await setLatestUnexpectedError(undefined)

	await withSilencedConsole(async () => await modules.resolveDeferredSafeSignerReplies(simulator, websiteTabConnections))

	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getPendingSafeProposalStores(), [])
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
	assert.deepEqual(postedMessages, [])
	assert.match((await getLatestUnexpectedError())?.data.message ?? '', /could not be added to the Safe stack/u)
})

test('fails a deferred Safe signature stored without its chain closed without touching other requests', async () => {
	const signedOther = { ...pendingTransaction, uniqueRequestIdentifier: { requestId: 95, requestSocket: { tabId: 1, connectionName: 52n } } }
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [
			{ ...pendingTransaction, uniqueRequestIdentifier: { requestId: 94, requestSocket: { tabId: 1, connectionName: 51n } }, simulationMode: false, approvalStatus: { status: 'WaitingForSigner' }, deferredSafeSignerReply: { signerReply: '0x1234', terminalReplyQueued: false } },
			signedOther,
		],
	})
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 2)

	await modules.resolveDeferredSafeSignerReplies(simulator, new Map())

	const [unbound, other] = await modules.getPendingTransactionsAndMessages()
	assert.equal(unbound?.deferredSafeSignerReply, undefined)
	assert.equal(unbound?.approvalStatus.status, 'SignerError')
	assert.deepEqual(other, signedOther)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
})

test('does not defer a Safe signature whose signing network was not recorded', async () => {
	const socket = { tabId: 1, connectionName: 48n }
	const requestIdentifier = { requestId: 88, requestSocket: socket }
	const messages: unknown[] = []
	const port = createWebsitePort(socket, 0, messages)
	const websiteTabConnections = new Map([[socket.tabId, {
		signerStateOwner: { connectionName: socket.connectionName, confirmed: true, generation: 3, providerGeneration: 8 },
		connections: {
			[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true },
		},
	}]])
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, { to: recipientAddress, value: 0n, input: new Uint8Array() }, 0n)
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	const signature = await safeTestOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	// Forwarded before the signing network was recorded (for example by an earlier version).
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			uniqueRequestIdentifier: requestIdentifier,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: safeTestOwnerAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [safeTestOwnerAddress], threshold: 2n },
				safeTxHash,
				safeTx,
			},
		}],
	})
	const owner = createTestSimulationServicesOwner({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService })
	owner.clear()
	await modules.signerReply(owner, websiteTabConnections, port, {
		method: 'signer_reply',
		params: [{
			success: true,
			signerProviderGeneration: 8,
			forwardRequest: {
				type: 'forwardToSigner',
				replyWithSignersReply: true,
				method: 'eth_signTypedData_v4',
				params: [recipientAddress, EIP712Message.parse(safeTxToTypedDataJson(safeTx))],
				requestId: requestIdentifier.requestId,
			},
			reply: signature,
		}],
		interceptorRequest: true,
		interceptorInternalRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 89, requestSocket: socket },
	}, 'hasAccess', activeAddress)

	const [pending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pending?.deferredSafeSignerReply, undefined)
	assert.equal(pending?.approvalStatus.status, 'SignerError')
	assert.equal(messages.some((message) => isRecord(message) && message.method === 'eth_sendTransaction' && message.requestId === requestIdentifier.requestId), false)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
})

test('atomically queues a Safe proposal result with its outbox entry before delivery', async () => {
	const socket = { tabId: 1, connectionName: 46n }
	const requestIdentifier = { requestId: 86, requestSocket: socket }
	const messages: unknown[] = []
	const port = createWebsitePort(socket, 0, messages)
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true },
		},
	}]])
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, { to: recipientAddress, value: 0n, input: new Uint8Array() }, 0n)
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	fakeSafeContract.nonce = 0n
	fakeSafeContract.threshold = 2n
	fakeSafeContract.owners = [safeTestOwnerAddress]
	const signature = await safeTestOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	const signedProposal = {
		...pendingTransaction,
		uniqueRequestIdentifier: requestIdentifier,
		simulationMode: false,
		approvalStatus: { status: 'WaitingForSigner' as const },
		safeTransaction: {
			safeAddress: activeAddress,
			safeSignerAddress: safeTestOwnerAddress,
			safeVersion: '1.4.1',
			threshold: 2n,
			reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [safeTestOwnerAddress], threshold: 2n },
			safeTxHash,
			safeTx,
		},
	}
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [signedProposal] })
	const terminalReply = { ...signedProposal.originalRequestParameters, type: 'result' as const, result: safeTxHash, uniqueRequestIdentifier: requestIdentifier }
	const createStore = (proposal: typeof signedProposal | Awaited<ReturnType<typeof modules.getPendingTransactionsAndMessages>>[number]) => ({ chainId: fakeRpcNetwork.chainId, signerReply: signature, proposal })
	let failAtomicWrite = true
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if (failAtomicWrite && 'pendingTransactionsAndMessages' in items && 'pendingTerminalReplies' in items && 'pendingSafeProposalStores' in items) {
			failAtomicWrite = false
			throw new Error('Atomic terminal state write unavailable.')
		}
		writeStoredItems()
	})
	await assert.rejects(modules.queueSafeProposalReplyAndMoveToOutbox(requestIdentifier, createStore, terminalReply), /Atomic terminal state write unavailable/u)
	browserMock.setStorageSetHandler(undefined)
	// Nothing was written: the request is still pending, and neither its reply nor its outbox entry exists.
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	assert.deepEqual(await modules.getPendingSafeProposalStores(), [])
	assert.equal(await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket), 0)

	await modules.queueSafeProposalReplyAndMoveToOutbox(requestIdentifier, createStore, terminalReply)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.equal((await modules.getPendingSafeProposalStores()).length, 1)
	assert.equal(await modules.attemptQueuedTerminalReplyDelivery(websiteTabConnections, terminalReply), true)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])

	await modules.resolveDeferredSafeSignerReplies(simulator, websiteTabConnections)

	assert.deepEqual(await modules.getPendingSafeProposalStores(), [])
	assert.equal(messages.filter((message) => isRecord(message) && message.method === 'eth_sendTransaction' && message.requestId === requestIdentifier.requestId).length, 1)
	const [persistedStack] = await modules.getSafeTransactionStacks()
	assert.deepEqual(persistedStack?.transactions[0]?.signatures, [{ signer: safeTestOwnerAddress, signature }])
})

test('persists a replaced-connection signer error without refreshing over corrupt RPC configuration', async () => {
	const socket = { tabId: 1, connectionName: 44n }
	const requestIdentifier = { requestId: 82, requestSocket: socket }
	const messages: unknown[] = []
	const port = createWebsitePort(socket, 0, messages)
	const websiteTabConnections = new Map([[socket.tabId, {
		signerStateOwner: {
			connectionName: socket.connectionName,
			confirmed: true,
			generation: 3,
			providerGeneration: 8,
		},
		connections: {},
	}]])
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			uniqueRequestIdentifier: requestIdentifier,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
		}],
	})
	browserMock.storageState.rpcEntries = 'not-an-rpc-list'
	let blockNumberRequests = 0
	const originalGetBlockNumber = simulator.ethereum.getBlockNumber
	Object.defineProperty(simulator.ethereum, 'getBlockNumber', {
		configurable: true,
		value: async () => { blockNumberRequests += 1; return 123n },
	})
	try {
		await withSilencedConsole(async () => await modules.signerReply(
			createTestSimulationServicesOwner({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService }),
			websiteTabConnections,
			port,
			{
				method: 'signer_reply',
				params: [{
					success: true,
					signerProviderGeneration: 8,
					forwardRequest: {
						type: 'forwardToSigner',
						replyWithSignersReply: true,
						method: pendingTransaction.originalRequestParameters.method,
						params: pendingTransaction.originalRequestParameters.params,
						requestId: requestIdentifier.requestId,
					},
					reply: modules.EthereumBytes32.serialize(signedTransaction.hash),
				}],
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 83, requestSocket: socket },
			},
			'hasAccess',
			activeAddress,
		))
	} finally {
		Object.defineProperty(simulator.ethereum, 'getBlockNumber', { configurable: true, value: originalGetBlockNumber })
	}

	const [pending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pending?.approvalStatus.status, 'SignerError')
	assert.equal(blockNumberRequests, 0)
})

test('keeps an unavailable-service signer result queued when pending removal fails', async () => {
	const socket = { tabId: 1, connectionName: 43n }
	const requestIdentifier = { requestId: 80, requestSocket: socket }
	const messages: unknown[] = []
	const port = createWebsitePort(socket, 0, messages)
	const websiteTabConnections = new Map([[socket.tabId, {
		signerStateOwner: {
			connectionName: socket.connectionName,
			confirmed: true,
			generation: 3,
			providerGeneration: 8,
		},
		connections: {
			[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true },
		},
	}]])
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			uniqueRequestIdentifier: requestIdentifier,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
		}],
	})
	const owner = createTestSimulationServicesOwner({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService })
	owner.clear()
	let removalAttempts = 0
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if ('pendingTransactionsAndMessages' in items && Array.isArray(items.pendingTransactionsAndMessages) && items.pendingTransactionsAndMessages.length === 0) {
			removalAttempts += 1
			throw new Error('Pending request removal failed')
		}
		writeStoredItems()
	})

	await assert.rejects(modules.signerReply(owner, websiteTabConnections, port, {
		method: 'signer_reply',
		params: [{
			success: true,
			signerProviderGeneration: 8,
			forwardRequest: {
				type: 'forwardToSigner',
				replyWithSignersReply: true,
				method: pendingTransaction.originalRequestParameters.method,
				params: pendingTransaction.originalRequestParameters.params,
				requestId: requestIdentifier.requestId,
			},
			reply: modules.EthereumBytes32.serialize(signedTransaction.hash),
		}],
		interceptorRequest: true,
		interceptorInternalRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 81, requestSocket: socket },
	}, 'hasAccess', activeAddress), /Pending request removal failed/)

	assert.equal(removalAttempts, 1)
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
	assert.equal((await modules.getPendingTerminalReplies()).length, 1)
	assert.equal(messages.some((message) => isRecord(message) && message.method === 'eth_sendTransaction' && message.requestId === requestIdentifier.requestId), false)
})

test('preserves a MetaMask keyring scan error on a retryable Safe signature', async () => {
	const socket = uniqueRequestIdentifier.requestSocket
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	const messages: unknown[] = []
	const port = createWebsitePort(socket, 0, messages)
	const websiteOrigin = 'https://example.com'
	const websiteTabConnections = new Map([[socket.tabId, {
		signerStateOwner: {
			connectionName: socket.connectionName,
			confirmed: true,
			generation: 3,
			providerGeneration: 8,
		},
		connections: {
			[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		},
	}]])
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
			signerRequestChainId: fakeRpcNetwork.chainId,
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: recipientAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				reviewedSafeState: {
					version: '1.4.1',
					nonce: 0n,
					owners: [recipientAddress],
					threshold: 2n,
				},
				safeTxHash,
				safeTx,
			},
		}],
	})

	await modules.signerReply(createTestSimulationServicesOwner({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService }), websiteTabConnections, port, {
		method: 'signer_reply',
		params: [{
			success: false,
			signerProviderGeneration: 8,
			forwardRequest: {
				type: 'forwardToSigner',
				replyWithSignersReply: true,
				method: 'eth_signTypedData_v4',
				params: [recipientAddress, EIP712Message.parse(safeTxToTypedDataJson(safeTx))],
				requestId: uniqueRequestIdentifier.requestId,
			},
			error: {
				code: -32603,
				message: 'Keyring Controller signTypedMessage: Error: Scan cancelled',
			},
		}],
		interceptorRequest: true,
		interceptorInternalRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 79, requestSocket: socket },
	}, 'hasAccess', activeAddress)

	const [retryableTransaction] = await modules.getPendingTransactionsAndMessages()
	assert.deepEqual(retryableTransaction?.approvalStatus, {
		status: 'SignerError',
		code: -32603,
		message: 'Keyring Controller signTypedMessage: Error: Scan cancelled',
	})
	assert.equal(retryableTransaction?.safeTransaction?.safeTxHash, safeTxHash)
})

test('forwards a Safe transaction to the wallet-selected Safe owner as EIP-712 typed data', async () => {
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [recipientAddress],
		activeSigningAddress: recipientAddress,
	}))
	const safeAddressBookEntry = createSafeAddressBookEntry({
		safeSimulationSignerAddress: 0x2222222222222222222222222222222222222222n,
	})
	await modules.updateUserAddressBookEntries(() => [safeAddressBookEntry])
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, postedMessages)
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: recipientAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				reviewedSafeState: {
					version: '1.4.1',
					nonce: 0n,
					owners: [],
					threshold: 2n,
				},
				safeTxHash: BigInt(getSafeTxHash(safeTx)),
				safeTx,
			},
		}],
	})

	await modules.updateUserAddressBookEntries(() => [{ ...safeAddressBookEntry, safeSimulationSignerAddress: activeAddress }])
	fakeSafeContract.owners = [0x1111111111111111111111111111111111111111n]
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	}), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [changedOwnersProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(changedOwnersProposal?.approvalStatus.status, 'SignerError')
	if (changedOwnersProposal?.approvalStatus.status !== 'SignerError') throw new Error('Missing changed-owner Gnosis Safe proposal error')
	assert.match(changedOwnersProposal.approvalStatus.message, /owner set changed/u)

	fakeSafeContract.owners = []
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForUser' as const },
	}))
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	}), true)

	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing Safe signer request')
	assert.equal(signerRequest.method, 'eth_signTypedData_v4')
	assert.equal(signerRequest.params[0], addressString(recipientAddress))
	assert.equal(typeof signerRequest.params[1], 'string')
	const typedData = JSON.parse(String(signerRequest.params[1]))
	assert.equal(typedData.primaryType, 'SafeTx')
	assert.equal(typedData.domain.chainId, fakeRpcNetwork.chainId.toString())
	assert.equal(typedData.message.to.toLowerCase(), `0x${ recipientAddress.toString(16).padStart(40, '0') }`)
})

test.each(['other chain first', 'matching recovery during the reply', 'deferral during a window-close rejection'] as const)('routes a Safe co-signing request through the wallet-selected owner (%s)', async (signerReplyServices) => {
	const ownerAccount = privateKeyToAccount('0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd')
	const safeSignerAddress = BigInt(ownerAccount.address)
	const alternateOwnerAccount = privateKeyToAccount('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef')
	const alternateOwnerAddress = BigInt(alternateOwnerAccount.address)
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(safeTx))
	fakeSafeContract.owners = [safeSignerAddress, alternateOwnerAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSimulationSignerAddress: recipientAddress,
		safeVersion: '1.4.1',
	})])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress, recipientAddress],
		activeSigningAddress: safeSignerAddress,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	let accountReply: Promise<unknown> | undefined
	let websiteTabConnections: Map<number, {
		signerStateOwner: {
			connectionName: bigint
			confirmed: boolean
			generation: number
			providerGeneration: number
		}
		connections: Record<string, {
			port: browser.runtime.Port
			socket: typeof socket
			websiteOrigin: string
			approved: boolean
			wantsToConnect: boolean
		}>
	}>
	let port: browser.runtime.Port
	port = createWebsitePort(socket, 0, postedMessages, (message) => {
		if (!isRecord(message) || message.method !== 'request_signer_to_eth_accounts') return
		accountReply = modules.ethAccountsReply(
			createTestSimulationServicesOwner({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService }),
			websiteTabConnections,
			port,
			{
				method: 'eth_accounts_reply',
				params: [{
					signerProviderGeneration: 1,
					type: 'success',
					accounts: [addressString(safeSignerAddress)],
					requestAccounts: false,
				}],
			},
			'hasAccess',
			activeAddress,
		)
	})
	websiteTabConnections = new Map([[socket.tabId, {
		signerStateOwner: {
			connectionName: socket.connectionName,
			confirmed: true,
			generation: 1,
			providerGeneration: 1,
		},
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://sealwort.example',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	const signRequest = {
		method: 'eth_signTypedData_v4' as const,
		params: [activeAddress, EIP712Message.parse(safeTxToTypedDataJson(safeTx))] as const,
	}
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		...signRequest,
	}
	const website = { websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' }

	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		{ kind: 'message', parameters: signRequest },
		false,
		activeAddress,
		website,
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [reviewedCoSignRequest] = await modules.getPendingTransactionsAndMessages()
	assert.notEqual(reviewedCoSignRequest?.type === 'SignableMessage' ? reviewedCoSignRequest.safeMessageCoSignSnapshot : undefined, undefined)
	if (reviewedCoSignRequest?.type !== 'SignableMessage') throw new Error('Missing reviewed Safe co-signing request')
	fakeSafeContract.safeOwnerLookupFailure = 'unexpected'
	try {
		await assert.rejects(
			modules.resolveSafeConfirmation(simulator.ethereum, reviewedCoSignRequest, 'accept'),
			/Unexpected Safe owner decoder failure/u,
		)
		await assert.rejects(
			modules.resolveSafeSignerReply(simulator.ethereum, reviewedCoSignRequest, '0x1234'),
			/Unexpected Safe owner decoder failure/u,
		)
	} finally {
		fakeSafeContract.safeOwnerLookupFailure = undefined
	}
	fakeSafeContract.safeOwnerLookupFailure = 'expected'
	try {
		const expectedFailure = await modules.resolveSafeConfirmation(simulator.ethereum, reviewedCoSignRequest, 'accept')
		assert.equal(expectedFailure.status, 'blocked')
		assert.match(expectedFailure.status === 'blocked' ? expectedFailure.approvalStatus.message : '', /Safe owner lookup unavailable/u)
	} finally {
		fakeSafeContract.safeOwnerLookupFailure = undefined
	}
	await modules.updateTabState(socket.tabId, (state) => ({
		...state,
		signerAccounts: [alternateOwnerAddress],
		activeSigningAddress: alternateOwnerAddress,
	}))
	fakeSafeContract.safeOwnerLookupFailure = 'unexpected'
	try {
		await assert.rejects(
			modules.resolveSafeConfirmation(
				simulator.ethereum,
				reviewedCoSignRequest,
				'accept',
				{ selectedSigner: alternateOwnerAddress, verificationError: undefined },
			),
			/Unexpected Safe owner decoder failure/u,
		)
	} finally {
		fakeSafeContract.safeOwnerLookupFailure = undefined
	}
	const [unchangedCoSignRequest] = await modules.getPendingTransactionsAndMessages()
	assert.equal(unchangedCoSignRequest?.approvalStatus.status, 'WaitingForUser')
	await modules.refreshPendingSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, socket.tabId)
	const [refreshedCoSignRequest] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedCoSignRequest?.type === 'SignableMessage' ? refreshedCoSignRequest.safeMessageCoSignSnapshot?.safeSignerAddress : undefined, alternateOwnerAddress)
	assert.equal(refreshedCoSignRequest?.approvalStatus.status, 'WaitingForUser')
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	}), true)

	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing Safe co-signer request')
	assert.equal(signerRequest.method, 'eth_signTypedData_v4')
	assert.equal(signerRequest.params[0], addressString(alternateOwnerAddress))
	assert.equal(JSON.parse(String(signerRequest.params[1])).domain.verifyingContract.toLowerCase(), addressString(activeAddress).toLowerCase())

	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		deferredSafeSignerReply: { signerReply: '0x1234', terminalReplyQueued: false, chainId: fakeRpcNetwork.chainId },
	}))
	await modules.resolveDeferredSafeSignerReplies({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService }, websiteTabConnections)
	const [invalidDeferredCoSignRequest] = await modules.getPendingTransactionsAndMessages()
	assert.equal(invalidDeferredCoSignRequest?.approvalStatus.status, 'SignerError')
	assert.equal(invalidDeferredCoSignRequest?.deferredSafeSignerReply, undefined)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'result' && message.requestId === uniqueRequestIdentifier.requestId), false)

	const signature = await alternateOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	await modules.updateUserAddressBookEntries((entries) => entries.map((entry) =>
		entry.type === 'safe' && entry.address === activeAddress
			? { ...entry, safeSimulationSignerAddress: 0x2222222222222222222222222222222222222222n }
			: entry
	))
	const isCoSignatureReply = (message: unknown) => isRecord(message) && message.type === 'result' && message.requestId === uniqueRequestIdentifier.requestId
	const signerCodeReadsBeforeReply = fakeSafeContract.requestedCodeAddresses.filter((address) => address === alternateOwnerAddress).length
	// Either services for another chain arrive before the co-signature (it is deferred for its own chain and replayed by a later recovery), or recovery on its own chain finishes its replay scan between the reply capturing its missing services and writing the deferral (the reply replays it itself).
	const replyOwner = signerReplyServices === 'other chain first' ? createTestSimulationServicesOwner(createOtherChainSimulator()) : createTestSimulationServicesOwner(simulator, () => simulator)
	let windowCloseSettlement: Promise<unknown> | undefined
	let pausedCodeRead: { readonly mockRestore: () => void } | undefined
	let codeReads = 0
	if (signerReplyServices === 'matching recovery during the reply') {
		replyOwner.clear()
		// The deferred request leaves its window empty, so the window is closed, and the browser's close event settles the request concurrently with the reply's own replay.
		const coSignatureWindow = (await modules.getPendingTransactionsAndMessages())[0]?.popupOrTabId
		if (coSignatureWindow === undefined) throw new Error('Missing co-signature window')
		browserMock.setLiveWindowIds([coSignatureWindow.id])
		browserMock.setWindowRemoveHandler(async (windowId) => {
			windowCloseSettlement = modules.onCloseWindowOrTab({ type: 'popup', id: windowId }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
		})
		// The close event validates first and pauses there until the reply's replay has answered the website (or it is clear the replay waits for it); the replay starts only once that validation began.
		const closeValidationStarted = createDeferredValue<void>()
		const waitFor = async (condition: () => boolean, milliseconds: number) => {
			const deadline = Date.now() + milliseconds
			while (Date.now() < deadline && !condition()) await new Promise((resolve) => setTimeout(resolve, 5))
		}
		let recovered = false
		let delayedInstalledServicesRead = false
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			if (Array.isArray(keys) && !recovered && keys.includes('pendingTransactionsAndMessages')) {
				// Recovery on the signature's chain finishes its scan before the deferral is written.
				recovered = true
				replyOwner.recover(fakeRpcNetwork)
				await modules.resolveDeferredSafeSignerReplies(simulator, websiteTabConnections)
			} else if (Array.isArray(keys) && recovered && !delayedInstalledServicesRead && windowCloseSettlement !== undefined && keys.length === 2 && keys.includes('rpcEntries')) {
				// The reply reads the installed services for its replay.
				delayedInstalledServicesRead = true
				await Promise.race([closeValidationStarted.promise, new Promise((resolve) => setTimeout(resolve, 200))])
			}
			return readStoredItems()
		})
		const { spyOn } = await import('bun:test')
		const readCode = simulator.ethereum.getCode.bind(simulator.ethereum)
		pausedCodeRead = spyOn(simulator.ethereum, 'getCode').mockImplementation(async (...args: Parameters<typeof readCode>) => {
			codeReads += 1
			if (codeReads === 1) {
				closeValidationStarted.resolve(undefined)
				await waitFor(() => postedMessages.some(isCoSignatureReply), 200)
			}
			return await readCode(...args)
		})
	}
	const deliverCoSignature = async () => await modules.signerReply(replyOwner, websiteTabConnections, port, {
		method: 'signer_reply',
		params: [{
			success: true,
			signerProviderGeneration: 1,
			forwardRequest: { type: 'forwardToSigner', replyWithSignersReply: true, method: 'eth_signTypedData_v4', params: [alternateOwnerAddress, EIP712Message.parse(safeTxToTypedDataJson(safeTx))], requestId: uniqueRequestIdentifier.requestId },
			reply: signature,
		}],
		interceptorRequest: true,
		interceptorInternalRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: uniqueRequestIdentifier.requestId + 1000, requestSocket: socket },
	}, 'hasAccess', activeAddress)
	if (signerReplyServices === 'deferral during a window-close rejection') {
		// The window closes while services are unavailable; the no-response path finds no deferred signature and decides to reject, and the signer's reply is deferred before that rejection is written.
		replyOwner.clear()
		const coSignatureWindow = (await modules.getPendingTransactionsAndMessages())[0]?.popupOrTabId
		if (coSignatureWindow === undefined) throw new Error('Missing co-signature window')
		let pendingReads = 0
		let deferral: Promise<unknown> | undefined
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			// The third read is the rejection's re-read after the serialized inspection (the close event's own read and the inspection come first).
			if (deferral === undefined && Array.isArray(keys) && keys.includes('pendingTransactionsAndMessages') && ++pendingReads === 3) {
				deferral = deliverCoSignature()
				await deferral
			}
			return readStoredItems()
		})
		await modules.onCloseWindowOrTab(coSignatureWindow, undefined, undefined, websiteTabConnections)
		browserMock.setStorageGetHandler(undefined)
		assert.notEqual(deferral, undefined)
		assert.equal(postedMessages.some(isCoSignatureReply), false)
		assert.deepEqual((await modules.getPendingTransactionsAndMessages())[0]?.deferredSafeSignerReply, { signerReply: signature, chainId: fakeRpcNetwork.chainId })
		// Services for the signature's chain return and settle it once.
		await modules.resolveDeferredSafeSignerReplies(simulator, websiteTabConnections)
	} else {
		await deliverCoSignature()
	}
	browserMock.setStorageGetHandler(undefined)
	await windowCloseSettlement
	pausedCodeRead?.mockRestore()
	if (signerReplyServices === 'matching recovery during the reply') {
		assert.notEqual(windowCloseSettlement, undefined)
		// One validation (the Safe's and the co-signer's code): the close event and the replay never both settle the signature.
		assert.equal(codeReads, 2)
	}
	if (signerReplyServices === 'other chain first') {
		assert.deepEqual((await modules.getPendingTransactionsAndMessages())[0]?.deferredSafeSignerReply, { signerReply: signature, chainId: fakeRpcNetwork.chainId })
		assert.equal(postedMessages.some(isCoSignatureReply), false)
		await modules.resolveDeferredSafeSignerReplies(simulator, websiteTabConnections)
	}
	assert.equal(postedMessages.filter(isCoSignatureReply).length, 1)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	const dappReply = postedMessages.find((message) =>
		isRecord(message) && message.type === 'result' && message.method === 'eth_signTypedData_v4' && message.requestId === uniqueRequestIdentifier.requestId
	)
	if (!isRecord(dappReply)) throw new Error('Missing Safe co-signature reply')
	assert.equal(dappReply.result, signature)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
	const signerCodeReadsAfterReply = fakeSafeContract.requestedCodeAddresses.filter((address) => address === alternateOwnerAddress).length
	assert.equal(signerCodeReadsAfterReply - signerCodeReadsBeforeReply, 1)
})

test('returns a Safe signer error when the wallet-selected co-signer is not a current owner', async () => {
	const safeSignerAddress = recipientAddress
	const currentOwner = safeTestOwnerAddress
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeSafeContract.owners = [currentOwner]
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSignerAddresses: [safeSignerAddress],
		safeVersion: '1.4.1',
	})])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress],
		activeSigningAddress: safeSignerAddress,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const port = createWebsitePort(uniqueRequestIdentifier.requestSocket, 0, [])
	const websiteTabConnections = new Map([[uniqueRequestIdentifier.requestSocket.tabId, {
		connections: {
			[modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)]: {
				port,
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://sealwort.example',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	const signRequest = {
		method: 'eth_signTypedData_v4' as const,
		params: [activeAddress, EIP712Message.parse(safeTxToTypedDataJson(safeTx))] as const,
	}
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		...signRequest,
	}

	const reply = await modules.openConfirmTransactionDialogForMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		{ kind: 'message', parameters: signRequest },
		false,
		activeAddress,
		{ websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' },
		websiteTabConnections,
	)

	assert.equal(reply.type, 'result')
	if (reply.type !== 'result' || !('error' in reply)) throw new Error('Missing Safe signer selection error')
	assert.equal(reply.error.code, -32010)
	assert.match(reply.error.message, /is not an owner of Gnosis Safe/u)
})

test('treats a missing Safe version as an expected co-signing validation failure', async () => {
	fakeSafeContract.owners = [recipientAddress]
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeVersion: undefined })])
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const signRequest = {
		method: 'eth_signTypedData_v4' as const,
		params: [activeAddress, EIP712Message.parse(safeTxToTypedDataJson(safeTx))] as const,
	}
	const { createSafeMessageCoSignSnapshot, isSafeSignerSelectionFailure } = await import('../../app/ts/background/safeConfirmationResolver.js')
	await assert.rejects(
		createSafeMessageCoSignSnapshot(simulator.ethereum, activeAddress, recipientAddress, signRequest, safeTx),
		(error: unknown) => isSafeSignerSelectionFailure(error) && error instanceof Error && /Re-save the active Gnosis Safe/u.test(error.message),
	)
})

test('rejects non-v4 Safe co-signing as a handled signer-selection failure', async () => {
	fakeSafeContract.owners = [recipientAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [recipientAddress],
		activeSigningAddress: recipientAddress,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const signRequest = {
		method: 'eth_signTypedData_v3' as const,
		params: [activeAddress, EIP712Message.parse(safeTxToTypedDataJson(safeTx))] as const,
	}
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		...signRequest,
	}
	const unexpectedErrorBeforeRequest = await getLatestUnexpectedError()

	const reply = await modules.openConfirmTransactionDialogForMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		{ kind: 'message', parameters: signRequest },
		false,
		activeAddress,
		{ websiteOrigin: 'https://safe-v3.example', icon: undefined, title: 'Safe v3' },
		new Map(),
	)
	assert.equal(reply.type, 'result')
	if (reply.type !== 'result' || !('error' in reply)) throw new Error('Missing handled non-v4 Safe co-signing error')
	assert.equal(reply.error.code, -32010)
	assert.match(reply.error.message, /requires eth_signTypedData_v4/u)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await getLatestUnexpectedError(), unexpectedErrorBeforeRequest)
})

test('shows Safe transaction context failures in the co-signing dialog without reporting them as unexpected', async () => {
	fakeSafeContract.owners = [recipientAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [recipientAddress],
		activeSigningAddress: recipientAddress,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const safeTx = createSafeTx(fakeRpcNetwork.chainId + 1n, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const signRequest = {
		method: 'eth_signTypedData_v4' as const,
		params: [activeAddress, EIP712Message.parse(safeTxToTypedDataJson(safeTx))] as const,
	}
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		...signRequest,
	}
	const unexpectedErrorBeforeRequest = await getLatestUnexpectedError()

	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		{ kind: 'message', parameters: signRequest },
		false,
		activeAddress,
		{ websiteOrigin: 'https://safe-context.example', icon: undefined, title: 'Safe context' },
		new Map(),
	), { type: 'doNotReply' })
	const [pendingMessage] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingMessage?.approvalStatus.status, 'SignerError')
	if (pendingMessage?.approvalStatus.status !== 'SignerError') throw new Error('Missing Safe context validation error')
	assert.match(pendingMessage.approvalStatus.message, /chain ID does not match/u)
	assert.deepEqual(await getLatestUnexpectedError(), unexpectedErrorBeforeRequest)
})

test('shows a Safe signing-account mismatch in the confirmation dialog without reporting an unexpected error', async () => {
	const walletOwner = safeTestOwnerAddress
	const mismatchedRequestedAccount = recipientAddress
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeSafeContract.owners = [walletOwner]
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(safeTx))
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const walletOwnerEntry = {
		type: 'contact' as const,
		name: 'Known Safe owner',
		address: walletOwner,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User' as const,
	}
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSignerAddresses: [walletOwner],
		safeVersion: '1.4.1',
	}), walletOwnerEntry])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [walletOwner],
		activeSigningAddress: walletOwner,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const socket = uniqueRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, [])
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://sealwort.example',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	const signRequest = {
		method: 'eth_signTypedData_v4' as const,
		params: [mismatchedRequestedAccount, EIP712Message.parse(safeTxToTypedDataJson(safeTx))] as const,
	}
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		...signRequest,
	}
	const unexpectedErrorBeforeRequest = await getLatestUnexpectedError()

	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		{ kind: 'message', parameters: signRequest },
		false,
		activeAddress,
		{ websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' },
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [pendingMessage] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingMessage?.type, 'SignableMessage')
	assert.equal(pendingMessage?.transactionOrMessageCreationStatus, 'Simulated')
	assert.equal(pendingMessage?.approvalStatus.status, 'SignerError')
	if (pendingMessage?.approvalStatus.status !== 'SignerError') throw new Error('Missing Safe account mismatch error')
	assert.equal(pendingMessage.approvalStatus.code, -32010)
	assert.equal(pendingMessage.approvalStatus.message, 'The Gnosis Safe transaction signing account does not match the active Gnosis Safe.')
	assert.deepEqual(pendingMessage.approvalStatus.safeSignerErrorDetails, {
		kind: 'safeSigningAccountMismatch',
		requestedSigningAccount: mismatchedRequestedAccount,
		activeSafe: activeAddress,
		requestedSafe: activeAddress,
		safeOwners: [walletOwner],
		safeOwnerAddressBookEntries: [walletOwnerEntry],
	})
	assert.equal(pendingMessage.type === 'SignableMessage' ? pendingMessage.safeMessageCoSignSnapshot : undefined, undefined)
	assert.deepEqual(await getLatestUnexpectedError(), unexpectedErrorBeforeRequest)

	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	fakeSafeContract.safeOwnerLookupFailure = 'expected'
	try {
		assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(
			simulator.ethereum,
			simulator.tokenPriceService,
			request,
			{ kind: 'message', parameters: signRequest },
			false,
			activeAddress,
			{ websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' },
			websiteTabConnections,
		), { type: 'doNotReply' })
	} finally {
		fakeSafeContract.safeOwnerLookupFailure = undefined
	}
	const [pendingMessageWithoutOwners] = await modules.getPendingTransactionsAndMessages()
	if (pendingMessageWithoutOwners?.approvalStatus.status !== 'SignerError') throw new Error('Missing Safe account mismatch error after owner lookup failure')
	assert.deepEqual(pendingMessageWithoutOwners.approvalStatus.safeSignerErrorDetails, {
		kind: 'safeSigningAccountMismatch',
		requestedSigningAccount: mismatchedRequestedAccount,
		activeSafe: activeAddress,
		requestedSafe: activeAddress,
		safeOwners: [],
		safeOwnerAddressBookEntries: [],
		safeOwnersUnavailableReason: 'Safe owner lookup unavailable',
	})
	assert.deepEqual(await getLatestUnexpectedError(), unexpectedErrorBeforeRequest)

	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	fakeSafeContract.safeOwnerLookupFailure = 'unexpected'
	try {
		const { createSafeMessageCoSignSnapshot } = await import('../../app/ts/background/safeConfirmationResolver.js')
		await assert.rejects(
			createSafeMessageCoSignSnapshot(simulator.ethereum, activeAddress, walletOwner, signRequest, safeTx),
			/Unexpected Safe owner decoder failure/u,
		)
	} finally {
		fakeSafeContract.safeOwnerLookupFailure = undefined
	}
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await getLatestUnexpectedError(), unexpectedErrorBeforeRequest)
})

test('signs Safe transaction typed data normally when the active signing address is an EOA', async () => {
	const eoaAddress = safeTestOwnerAddress
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeSafeContract.owners = [eoaAddress]
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(safeTx))
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [
		createSafeAddressBookEntry({ safeSignerAddresses: [eoaAddress], safeVersion: '1.4.1' }),
		{ type: 'contact', name: 'Sealwort signer', address: eoaAddress, chainId: fakeRpcNetwork.chainId, entrySource: 'User' },
	])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [eoaAddress],
		activeSigningAddress: eoaAddress,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const socket = uniqueRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, [])
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://sealwort.example',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	const signRequest = {
		method: 'eth_signTypedData_v4' as const,
		params: [eoaAddress, EIP712Message.parse(safeTxToTypedDataJson(safeTx))] as const,
	}
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		...signRequest,
	}
	const unexpectedErrorBeforeRequest = await getLatestUnexpectedError()

	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		{ kind: 'message', parameters: signRequest },
		false,
		eoaAddress,
		{ websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' },
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [pendingMessage] = await modules.getPendingTransactionsAndMessages()
	if (pendingMessage?.type !== 'SignableMessage' || pendingMessage.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Missing EOA Safe typed-data confirmation')
	assert.equal(pendingMessage.approvalStatus.status, 'WaitingForUser')
	assert.equal(pendingMessage.safeMessageCoSignSnapshot, undefined)
	assert.deepEqual(await modules.resolveSafeConfirmation(simulator.ethereum, pendingMessage, 'accept'), {
		status: 'ready',
		pending: pendingMessage,
		pendingChanged: false,
		signerFacingRequest: undefined,
	})
	assert.deepEqual(await modules.resolveSafeSignerReply(simulator.ethereum, pendingMessage, '0x1234'), { status: 'not-safe' })
	assert.deepEqual(await getLatestUnexpectedError(), unexpectedErrorBeforeRequest)
})

test('uses the configured Safe simulation signer without changing the active Safe account', async () => {
	const simulationSignerAddress = 0x4444444444444444444444444444444444444444n
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeSafeContract.owners = [simulationSignerAddress]
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(safeTx))
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSimulationSignerAddress: simulationSignerAddress,
		safeSignerAddresses: [simulationSignerAddress],
		safeVersion: '1.4.1',
	})])
	const signRequest = {
		method: 'eth_signTypedData_v4' as const,
		params: [activeAddress, EIP712Message.parse(safeTxToTypedDataJson(safeTx))] as const,
	}
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		...signRequest,
	}
	const port = createWebsitePort(uniqueRequestIdentifier.requestSocket, 0, [])
	const websiteTabConnections = new Map([[uniqueRequestIdentifier.requestSocket.tabId, {
		connections: {
			[modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)]: {
				port,
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://simulation-signer.example',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])

	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		{ kind: 'message', parameters: signRequest },
		true,
		activeAddress,
		{ websiteOrigin: 'https://simulation-signer.example', icon: undefined, title: 'Simulation signer' },
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [pendingMessage] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingMessage?.type, 'SignableMessage')
	if (pendingMessage?.type !== 'SignableMessage') throw new Error('Missing simulated Safe message')
	assert.equal(pendingMessage.activeAddress, activeAddress)
	assert.equal(pendingMessage.signedMessageTransaction.activeAddress, activeAddress)
	assert.equal(pendingMessage.signedMessageTransaction.fakeSignedFor, simulationSignerAddress)
})

test('requires an explicit Safe simulation signer instead of using the first cached owner', async () => {
	const cachedOwner = 0x4444444444444444444444444444444444444444n
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSimulationSignerAddress: undefined,
		safeSignerAddresses: [cachedOwner],
		safeVersion: '1.4.1',
	})])
	const signRequest = {
		method: 'personal_sign' as const,
		params: ['0x1234', activeAddress] as const,
	}
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		...signRequest,
	}

	const reply = await modules.openConfirmTransactionDialogForMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		{ kind: 'message', parameters: signRequest },
		true,
		activeAddress,
		{ websiteOrigin: 'https://simulation-signer.example', icon: undefined, title: 'Simulation signer' },
		new Map(),
	)

	assert.equal(reply.type, 'result')
	if (reply.type !== 'result' || !('error' in reply)) throw new Error('Missing Safe simulation signer error')
	assert.equal(reply.error.code, -32010)
	assert.match(reply.error.message, /Select a Gnosis Safe signer for simulation/u)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

test('recognizes only execTransaction calls to the active Safe for direct signer execution', async () => {
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const safeSignerAddress = 0x1234567890123456789012345678901234567890n
	const safeEntry = createSafeAddressBookEntry({ safeSimulationSignerAddress: recipientAddress })
	const transaction = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			data: '0x6a76120200',
		}],
	})

	assert.deepEqual(modules.getSafeExecutionSignerRoute(transaction, safeEntry, safeSignerAddress), {
		executor: safeSignerAddress,
		transactionParams: {
			method: 'eth_sendTransaction',
			params: [{
				...transaction.params[0],
				from: safeSignerAddress,
			}],
		},
	})
	assert.equal(modules.getSafeExecutionSignerRoute(SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(recipientAddress),
			to: addressString(activeAddress),
			data: '0x6a76120200',
		}],
	}), safeEntry, safeSignerAddress), undefined)
	assert.equal(modules.getSafeExecutionSignerRoute(SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			data: '0x6a76120200',
		}],
	}), safeEntry, safeSignerAddress), undefined)
	assert.equal(modules.getSafeExecutionSignerRoute(SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			data: '0xa9059cbb',
		}],
	}), safeEntry, safeSignerAddress), undefined)
	assert.equal(modules.getSafeExecutionSignerRoute(transaction, safeEntry, undefined), undefined)
	const nonzeroOuterValue = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			value: '0x1',
			data: '0x6a76120200',
		}],
	})
	await assert.rejects(
		modules.prepareSafeExecutionSignerRoute(ethereum, nonzeroOuterValue, safeEntry, safeSignerAddress),
		/A direct Gnosis Safe execution transaction must have zero outer ETH value/u,
	)
	fakeSafeContract.threshold = 3n
	const insufficientSignatures = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			data: encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [
				addressString(recipientAddress), 0n, '0x', 0n, 0n, 0n, 0n,
				addressString(0n), addressString(0n), `0x${ '00'.repeat(65) }`,
			]),
		}],
	})
	await assert.rejects(
		modules.prepareSafeExecutionSignerRoute(ethereum, insufficientSignatures, safeEntry, safeSignerAddress),
		/cannot satisfy its 3-signature threshold/u,
	)
	fakeSafeContract.threshold = 2n
	fakeSafeContract.owners = [safeSignerAddress]
	await assert.rejects(
		modules.prepareSafeExecutionSignerRoute(ethereum, insufficientSignatures, safeEntry, safeSignerAddress),
		/signature format that Interceptor cannot validate/u,
	)
})

test('changes the Safe simulation signer only after validating current on-chain ownership', async () => {
	const alternateSigner = 0x1234567890123456789012345678901234567890n
	fakeSafeContract.owners = [recipientAddress, alternateSigner]
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		useAsActiveAddress: false,
		safeSimulationSignerAddress: recipientAddress,
		safeSignerAddresses: [recipientAddress, alternateSigner],
	})])

	const reply = await modules.setSafeSimulationSigner(
		ethereum,
		createTestSimulationServicesOwner(simulator),
		new Map(),
		{
			method: 'popup_setSafeSimulationSigner',
			data: {
				chainId: fakeRpcNetwork.chainId,
				safeAddress: activeAddress,
				safeSimulationSignerAddress: alternateSigner,
			},
		},
	)

	assert.deepEqual(reply, { type: 'SetSafeSimulationSignerReply', ok: true })
	const updatedSafeEntry = (await modules.getUserAddressBookEntries())[0]
	assert.equal(updatedSafeEntry?.safeSimulationSignerAddress, alternateSigner)
	assert.deepEqual(updatedSafeEntry?.safeSignerAddresses, [recipientAddress, alternateSigner])
	assert.equal(updatedSafeEntry?.safeVersion, fakeSafeContract.version)
	assert.equal(fakeSafeContract.requestedCodeAddresses.includes(alternateSigner), true)

	fakeSafeContract.version = 'invalid-version'
	const unsupportedVersionFailure = await withSilencedConsole(async () => modules.setSafeSimulationSigner(
		ethereum,
		createTestSimulationServicesOwner(simulator),
		new Map(),
		{
			method: 'popup_setSafeSimulationSigner',
			data: {
				chainId: fakeRpcNetwork.chainId,
				safeAddress: activeAddress,
				safeSimulationSignerAddress: recipientAddress,
			},
		},
	))
	fakeSafeContract.version = '1.4.1'
	assert.equal(unsupportedVersionFailure.ok, false)
	assert.match(unsupportedVersionFailure.message ?? '', /version invalid-version is not supported/u)
	assert.equal(await getLatestUnexpectedError(), undefined)

	fakeSafeContract.version = 'invalid-version'
	const { addOrModifyAddressBookEntry } = await import('../../app/ts/background/popupMessageHandlers.js')
	const unsupportedVersionSaveFailure = await withSilencedConsole(async () => addOrModifyAddressBookEntry(
		ethereum,
		createTestSimulationServicesOwner({ ethereum: ethereum, tokenPriceService: simulator.tokenPriceService }),
		new Map(),
		{
			method: 'popup_addOrModifyAddressBookEntry',
			data: createSafeAddressBookEntry({
				useAsActiveAddress: false,
				safeSimulationSignerAddress: alternateSigner,
			}),
		},
	))
	fakeSafeContract.version = '1.4.1'
	assert.equal(unsupportedVersionSaveFailure.ok, false)
	assert.match(unsupportedVersionSaveFailure.message ?? '', /version invalid-version is not supported/u)
	assert.equal(await getLatestUnexpectedError(), undefined)
})

test('reconciles website approvals changed while Safe validation is pending instead of the admitted snapshot', async () => {
	const { updateWebsiteAccess } = await import('../../app/ts/background/settings.js')
	const { getActiveAddress } = await import('../../app/ts/background/backgroundUtils.js')
	const alternateSigner = 0x1234567890123456789012345678901234567890n
	fakeSafeContract.owners = [recipientAddress, alternateSigner]
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		useAsActiveAddress: true,
		safeSimulationSignerAddress: recipientAddress,
		safeSignerAddresses: [recipientAddress, alternateSigner],
	})])
	const revokedSocket = { tabId: 61, connectionName: 0n }
	const grantedSocket = { tabId: 62, connectionName: 0n }
	const revokedWebsite = { websiteOrigin: 'https://revoked-during-validation.example', icon: undefined, title: undefined }
	const grantedWebsite = { websiteOrigin: 'https://granted-during-validation.example', icon: undefined, title: undefined }
	const activeAddressEntry = await getActiveAddress(await getRequiredSettings(), revokedSocket.tabId)
	const approval = (website: typeof revokedWebsite) => ({ website, access: true, addressAccess: activeAddressEntry === undefined ? undefined : [{ address: activeAddressEntry.address, access: true }] })
	await updateWebsiteAccess(() => [approval(revokedWebsite)])
	const revokedMessages: unknown[] = []
	const revokedConnection = { port: createWebsitePort(revokedSocket, 0, revokedMessages), socket: revokedSocket, websiteOrigin: revokedWebsite.websiteOrigin, approved: true, wantsToConnect: false }
	const grantedConnection = { port: createWebsitePort(grantedSocket, 0, []), socket: grantedSocket, websiteOrigin: grantedWebsite.websiteOrigin, approved: false, wantsToConnect: false }
	const websiteTabConnections = new Map([
		[revokedSocket.tabId, { connections: { [modules.websiteSocketToString(revokedSocket)]: revokedConnection } }],
		[grantedSocket.tabId, { connections: { [modules.websiteSocketToString(grantedSocket)]: grantedConnection } }],
	])
	const validationStarted = createDeferredValue<void>()
	const releaseValidation = createDeferredValue<void>()
	const readBlockNumber = ethereum.getBlockNumber
	Object.defineProperty(ethereum, 'getBlockNumber', {
		configurable: true,
		writable: true,
		value: async (requestAbortController: AbortController | undefined) => {
			validationStarted.resolve(undefined)
			await releaseValidation.promise
			return await readBlockNumber(requestAbortController)
		},
	})
	try {
		const reply = modules.setSafeSimulationSigner(ethereum, createTestSimulationServicesOwner(simulator), websiteTabConnections, {
			method: 'popup_setSafeSimulationSigner',
			data: { chainId: fakeRpcNetwork.chainId, safeAddress: activeAddress, safeSimulationSignerAddress: alternateSigner },
		})
		await validationStarted.promise
		// Revoked and granted after admission, while the on-chain validation is in flight.
		await updateWebsiteAccess(() => [{ website: revokedWebsite, access: false, addressAccess: undefined }, approval(grantedWebsite)])
		releaseValidation.resolve(undefined)
		assert.deepEqual(await reply, { type: 'SetSafeSimulationSignerReply', ok: true })
	} finally {
		Object.defineProperty(ethereum, 'getBlockNumber', { configurable: true, writable: true, value: readBlockNumber })
	}

	assert.equal(revokedConnection.approved, false)
	assert.equal(revokedMessages.some((message) => isRecord(message) && message.method === 'accountsChanged' && Array.isArray(message.result) && message.result.length > 0), false)
	assert.equal(grantedConnection.approved, true)
	await updateWebsiteAccess(() => [])
})

test('reconciles website approvals for the active address changed while Safe validation is pending instead of the admitted one', async () => {
	const { changeSimulationMode, updateWebsiteAccess } = await import('../../app/ts/background/settings.js')
	const { getActiveAddress } = await import('../../app/ts/background/backgroundUtils.js')
	const alternateSigner = 0x1234567890123456789012345678901234567890n
	fakeSafeContract.owners = [recipientAddress, alternateSigner]
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		useAsActiveAddress: true,
		safeSimulationSignerAddress: recipientAddress,
		safeSignerAddresses: [recipientAddress, alternateSigner],
	})])
	const socket = { tabId: 63, connectionName: 0n }
	const website = { websiteOrigin: 'https://approved-for-admitted-address.example', icon: undefined, title: undefined }
	const previousSettings = await getRequiredSettings()
	await changeSimulationMode({ simulationMode: true, rpcNetwork: fakeRpcNetwork, activeSimulationAddress: activeAddress })
	const admittedSettings = await getRequiredSettings()
	const admittedActiveAddress = await getActiveAddress(admittedSettings, socket.tabId)
	if (admittedActiveAddress === undefined) throw new Error('missing admitted active address')
	// Only the address that was active at admission has access.
	await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: admittedActiveAddress.address, access: true }] }])
	const connection = { port: createWebsitePort(socket, 0, []), socket, websiteOrigin: website.websiteOrigin, approved: false, wantsToConnect: false }
	const websiteTabConnections = new Map([[socket.tabId, { connections: { [modules.websiteSocketToString(socket)]: connection } }]])
	const validationStarted = createDeferredValue<void>()
	const releaseValidation = createDeferredValue<void>()
	const readBlockNumber = ethereum.getBlockNumber
	Object.defineProperty(ethereum, 'getBlockNumber', {
		configurable: true,
		writable: true,
		value: async (requestAbortController: AbortController | undefined) => {
			validationStarted.resolve(undefined)
			await releaseValidation.promise
			return await readBlockNumber(requestAbortController)
		},
	})
	try {
		const reply = modules.setSafeSimulationSigner(ethereum, createTestSimulationServicesOwner(simulator), websiteTabConnections, {
			method: 'popup_setSafeSimulationSigner',
			data: { chainId: fakeRpcNetwork.chainId, safeAddress: activeAddress, safeSimulationSignerAddress: alternateSigner },
		})
		await validationStarted.promise
		// The active address changes after admission, while the on-chain validation is in flight.
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: alternateSigner })
		releaseValidation.resolve(undefined)
		assert.deepEqual(await reply, { type: 'SetSafeSimulationSignerReply', ok: true })
	} finally {
		Object.defineProperty(ethereum, 'getBlockNumber', { configurable: true, writable: true, value: readBlockNumber })
		await changeSimulationMode({ simulationMode: previousSettings.simulationMode, rpcNetwork: previousSettings.activeRpcNetwork, activeSimulationAddress: previousSettings.activeSimulationAddress })
	}

	assert.equal(connection.approved, false)
	await updateWebsiteAccess(() => [])
})

test('refreshes Safe owner metadata and clears a stale simulation signer without choosing a replacement', async () => {
	const staleSigner = 0x1234567890123456789012345678901234567890n
	fakeSafeContract.owners = [recipientAddress]
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		useAsActiveAddress: false,
		safeSimulationSignerAddress: staleSigner,
		safeSignerAddresses: [staleSigner],
		safeVersion: '1.3.0',
	})])

	const reply = await modules.setSafeSimulationSigner(
		ethereum,
		createTestSimulationServicesOwner(simulator),
		new Map(),
		{
			method: 'popup_setSafeSimulationSigner',
			data: {
				chainId: fakeRpcNetwork.chainId,
				safeAddress: activeAddress,
				safeSimulationSignerAddress: undefined,
			},
		},
	)

	assert.deepEqual(reply, { type: 'SetSafeSimulationSignerReply', ok: true })
	const updatedSafeEntry = (await modules.getUserAddressBookEntries())[0]
	assert.equal(updatedSafeEntry?.safeSimulationSignerAddress, undefined)
	assert.deepEqual(updatedSafeEntry?.safeSignerAddresses, [recipientAddress])
	assert.equal(updatedSafeEntry?.safeVersion, fakeSafeContract.version)
	assert.equal(fakeSafeContract.requestedCodeAddresses.includes(recipientAddress), false)
})

test('prompts a connected website for access after changing the active Safe simulation signer', async () => {
	const alternateSigner = 0x1234567890123456789012345678901234567890n
	fakeSafeContract.owners = [recipientAddress, alternateSigner]
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSimulationSignerAddress: recipientAddress,
		safeSignerAddresses: [recipientAddress, alternateSigner],
	})])
	const socket = { tabId: 7, connectionName: 70n }
	const websiteOrigin = 'https://needs-safe-access.example'
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: { port: createWebsitePort(socket, 0, []), socket, websiteOrigin, approved: false, wantsToConnect: true },
		},
	}]])

	const reply = await modules.setSafeSimulationSigner(
		ethereum,
		createTestSimulationServicesOwner(simulator),
		websiteTabConnections,
		{
			method: 'popup_setSafeSimulationSigner',
			data: {
				chainId: fakeRpcNetwork.chainId,
				safeAddress: activeAddress,
				safeSimulationSignerAddress: alternateSigner,
			},
		},
	)

	assert.deepEqual(reply, { type: 'SetSafeSimulationSignerReply', ok: true })
	assert.deepEqual((await getPendingAccessRequests()).map((pendingAccessRequest) => pendingAccessRequest.website.websiteOrigin), [websiteOrigin])
})

test('routes a completed active Safe execution through its configured signer and rechecks signer changes', async () => {
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const safeSignerAddress = recipientAddress
	const existingOwnerAccount = safeTestOwnerAccount
	const existingOwnerAddress = safeTestOwnerAddress
	const alternateSignerAddress = 0x3333333333333333333333333333333333333333n
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, fakeSafeContract.nonce)
	const existingSignature = await existingOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	fakeSafeContract.owners = [existingOwnerAddress, safeSignerAddress, alternateSignerAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSignerAddresses: [safeSignerAddress],
	})])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [],
		activeSigningAddress: undefined,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			value: '0x0',
			data: encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [
				addressString(recipientAddress),
				0n,
				'0x',
				0n,
				0n,
				0n,
				0n,
				addressString(0n),
				addressString(0n),
				existingSignature,
			]),
		}],
	})
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, postedMessages)
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://sealwort.example',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		...transactionParams,
	}

	assert.deepEqual(await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		{ kind: 'transaction', parameters: transactionParams },
		false,
		activeAddress,
		{ websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' },
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [disconnectedExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(disconnectedExecution?.type, 'Transaction')
	if (disconnectedExecution?.type !== 'Transaction') throw new Error('Missing disconnected direct Safe execution request')
	assert.deepEqual(disconnectedExecution.safeExecutionOriginalRequestParameters, transactionParams)
	assert.equal(disconnectedExecution.safeExecutionSignerAddress, undefined)
	assert.notEqual(disconnectedExecution.safeExecutionReviewedSafeState, undefined)
	assert.equal(disconnectedExecution.safeTransaction, undefined)
	assert.equal(disconnectedExecution.approvalStatus.status, 'SignerError')

	await modules.updateTabState(socket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress],
		activeSigningAddress: safeSignerAddress,
	}))
	fakeSafeContract.version = 'invalid-version'
	await withSilencedConsole(async () => modules.refreshPendingSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, socket.tabId))
	assert.equal(await getLatestUnexpectedError(), undefined)
	assert.equal((await modules.getPendingTransactionsAndMessages())[0]?.approvalStatus.status, 'SignerError')
	fakeSafeContract.version = '1.4.1'
	await modules.refreshPendingSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, socket.tabId)
	const [pendingExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingExecution?.type, 'Transaction')
	if (pendingExecution?.type !== 'Transaction') throw new Error('Missing direct Safe execution request')
	assert.equal(pendingExecution.transactionOrMessageCreationStatus, 'Simulated')
	assert.equal(pendingExecution.safeTransaction, undefined)
	assert.equal(pendingExecution.safeExecutionSignerAddress, safeSignerAddress)
	assert.deepEqual(pendingExecution.safeExecutionOriginalRequestParameters, transactionParams)
	assert.equal(pendingExecution.activeAddress, safeSignerAddress)
	assert.equal(pendingExecution.originalRequestParameters.method, 'eth_sendTransaction')
	if (pendingExecution.originalRequestParameters.method !== 'eth_sendTransaction') throw new Error('Unexpected direct Safe execution method')
	assert.equal(pendingExecution.originalRequestParameters.params[0].from, safeSignerAddress)
	const { refreshAndPersistSafeSignerSelection } = await import('../../app/ts/background/safeSignerSelectionRefresh.js')
	await assert.rejects(
		refreshAndPersistSafeSignerSelection(
			simulator.ethereum,
			pendingExecution,
			alternateSignerAddress,
			async () => { throw new Error('Direct Safe simulation refresh unavailable') },
		),
		/Direct Safe simulation refresh unavailable/u,
	)
	assert.deepEqual((await modules.getPendingTransactionsAndMessages())[0], pendingExecution)
	fakeSafeContract.safeOwnerLookupFailure = 'unexpected'
	try {
		await assert.rejects(
			modules.resolveSafeConfirmation(
				simulator.ethereum,
				pendingExecution,
				'accept',
				{ selectedSigner: safeSignerAddress, verificationError: undefined },
			),
			/Unexpected Safe owner decoder failure/u,
		)
		await assert.rejects(
			modules.resolveSafeConfirmation(
				simulator.ethereum,
				pendingExecution,
				'accept',
				{ selectedSigner: alternateSignerAddress, verificationError: undefined },
			),
			/Unexpected Safe owner decoder failure/u,
		)
	} finally {
		fakeSafeContract.safeOwnerLookupFailure = undefined
	}

	fakeSafeContract.version = 'invalid-version'
	const unexpectedErrorBeforeUnsupportedVersion = (await getLatestUnexpectedError())?.data.code
	assert.equal(await withSilencedConsole(async () => modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		{
			method: 'popup_confirmDialog',
			data: { action: 'accept', uniqueRequestIdentifier },
		},
		{ selectedSigner: safeSignerAddress, verificationError: undefined },
	)), false)
	assert.equal((await getLatestUnexpectedError())?.data.code, unexpectedErrorBeforeUnsupportedVersion)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)

	assert.equal(await withSilencedConsole(async () => modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		{
			method: 'popup_confirmDialog',
			data: { action: 'accept', uniqueRequestIdentifier },
		},
		{ selectedSigner: alternateSignerAddress, verificationError: undefined },
	)), false)
	assert.equal((await getLatestUnexpectedError())?.data.code, unexpectedErrorBeforeUnsupportedVersion)
	fakeSafeContract.version = '1.4.1'
	assert.equal(await modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		{
			method: 'popup_confirmDialog',
			data: { action: 'accept', uniqueRequestIdentifier },
		},
		{ selectedSigner: alternateSignerAddress, verificationError: undefined },
	), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [refreshedExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedExecution?.approvalStatus.status, 'WaitingForUser')
	assert.equal(refreshedExecution?.type === 'Transaction' ? refreshedExecution.safeExecutionSignerAddress : undefined, alternateSignerAddress)
	assert.equal(refreshedExecution?.originalRequestParameters.method === 'eth_sendTransaction' ? refreshedExecution.originalRequestParameters.params[0].from : undefined, alternateSignerAddress)

	await modules.updateTabState(socket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress],
		activeSigningAddress: safeSignerAddress,
	}))
	await modules.refreshPendingSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, socket.tabId)
	const [recoveredExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(recoveredExecution?.approvalStatus.status, 'WaitingForUser')

	fakeSafeContract.nonce += 1n
	assert.equal(await modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		{
			method: 'popup_confirmDialog',
			data: { action: 'accept', uniqueRequestIdentifier },
		},
		{ selectedSigner: safeSignerAddress, verificationError: undefined },
	), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [staleExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(staleExecution?.approvalStatus.status, 'SignerError')
	if (staleExecution?.approvalStatus.status !== 'SignerError') throw new Error('Missing stale Gnosis Safe execution error')
	assert.match(staleExecution.approvalStatus.message, /Gnosis Safe execution could not be prepared/u)

	fakeSafeContract.nonce -= 1n
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForUser' as const },
	}))
	fakeSafeContract.owners = [...fakeSafeContract.owners, 0x1111111111111111111111111111111111111111n]
	assert.equal(await modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		{
			method: 'popup_confirmDialog',
			data: { action: 'accept', uniqueRequestIdentifier },
		},
		{ selectedSigner: safeSignerAddress, verificationError: undefined },
	), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [changedOwnersExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(changedOwnersExecution?.approvalStatus.status, 'SignerError')
	if (changedOwnersExecution?.approvalStatus.status !== 'SignerError') throw new Error('Missing changed-owner Gnosis Safe execution error')
	assert.match(changedOwnersExecution.approvalStatus.message, /owner set changed/u)

	fakeSafeContract.owners = [existingOwnerAddress, safeSignerAddress, alternateSignerAddress]
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForUser' as const },
	}))
	assert.equal(await modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		{
			method: 'popup_confirmDialog',
			data: { action: 'accept', uniqueRequestIdentifier },
		},
		{ selectedSigner: safeSignerAddress, verificationError: undefined },
	), true)
	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing direct Safe execution signer request')
	const signerTransaction = signerRequest.params[0]
	if (!isRecord(signerTransaction)) throw new Error('Missing direct Safe execution transaction parameters')
	assert.equal(signerRequest.method, 'eth_sendTransaction')
	assert.equal(signerTransaction.from, addressString(safeSignerAddress))
	assert.equal(signerTransaction.to, addressString(activeAddress))
	const prevalidatedSignerSignature = `0x${ safeSignerAddress.toString(16).padStart(64, '0') }${ '0'.repeat(64) }01`
	const completedSignatures = [
		{ signer: existingOwnerAddress, signature: existingSignature },
		{ signer: safeSignerAddress, signature: prevalidatedSignerSignature },
	]
		.sort((left, right) => left.signer < right.signer ? -1 : left.signer > right.signer ? 1 : 0)
		.map(({ signature }) => signature.slice(2))
		.join('')
	assert.equal(signerTransaction.data, encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [
		addressString(recipientAddress),
		0n,
		'0x',
		0n,
		0n,
		0n,
		0n,
		addressString(0n),
		addressString(0n),
		`0x${ completedSignatures }`,
	]))
	assert.equal(postedMessages.some((message) => isRecord(message) && message.method === 'eth_signTypedData_v4'), false)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])

	const transactionHash = `0x${ 'ab'.repeat(32) }`
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: transactionHash, uniqueRequestIdentifier },
	}), true)
	const dappReply = postedMessages.find((message) =>
		isRecord(message) && message.type === 'result' && message.method === 'eth_sendTransaction' && message.requestId === uniqueRequestIdentifier.requestId
	)
	if (!isRecord(dappReply)) throw new Error('Missing direct Safe execution dapp reply')
	assert.equal(dappReply.result, transactionHash)
})

test('blocks direct Safe execution when the configured signer cannot satisfy the threshold', async () => {
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const configuredSigner = recipientAddress
	const existingOwnerAccount = safeTestOwnerAccount
	const existingOwnerAddress = safeTestOwnerAddress
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, fakeSafeContract.nonce)
	const existingSignature = await existingOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	fakeSafeContract.threshold = 3n
	fakeSafeContract.owners = [existingOwnerAddress, configuredSigner, 0x1111111111111111111111111111111111111111n]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSimulationSignerAddress: configuredSigner,
	})])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [configuredSigner],
		activeSigningAddress: configuredSigner,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			data: encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [
				addressString(recipientAddress),
				0n,
				'0x',
				0n,
				0n,
				0n,
				0n,
				addressString(0n),
				addressString(0n),
				existingSignature,
			]),
		}],
	})
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, postedMessages)
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://sealwort.example',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])

	assert.deepEqual(await withSilencedConsole(async () => await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		{
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier,
			...transactionParams,
		},
		{ kind: 'transaction', parameters: transactionParams },
		false,
		activeAddress,
		{ websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' },
		websiteTabConnections,
	)), { type: 'doNotReply' })

	const [pendingFailure] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingFailure?.transactionOrMessageCreationStatus, 'FailedToSimulate')
	if (pendingFailure?.type !== 'Transaction' || !('transactionToSimulate' in pendingFailure)) throw new Error('Missing failed direct Safe execution confirmation')
	assert.equal(pendingFailure.transactionToSimulate.success, false)
	if (pendingFailure.transactionToSimulate.success) throw new Error('Expected Safe execution preparation failure')
	assert.match(pendingFailure.transactionToSimulate.error.message, /cannot satisfy its 3-signature threshold/u)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
})

test('direct Safe execution checks delegate library bytecode before completing or forwarding owner signatures', async () => {
	const { spyOn } = await import('bun:test')
	const { encodeSafeBatch, SAFE_MULTI_SEND_CALL_ONLY, SAFE_SIGN_MESSAGE_LIB, SAFE_SIGN_MESSAGE_ABI } = await import('../../app/ts/safe/safeDelegateCalls.js')
	const { stringToUint8Array, dataStringWith0xStart } = await import('../../app/ts/utils/bigint.js')
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const multiSend = await import('../fixtures/safe-libraries/MultiSendCallOnly.json')
	const signMessage = await import('../fixtures/safe-libraries/SignMessageLib.json')
	fakeSafeContract.owners = [safeTestOwnerAddress]
	fakeSafeContract.threshold = 1n
	const safeEntry = createSafeAddressBookEntry({ safeVersion: '1.4.1' })
	const originalGetCode = simulator.ethereum.getCode.bind(simulator.ethereum)
	let libraryCode = new Uint8Array()
	const blocks: bigint[] = []
	const getCode = spyOn(simulator.ethereum, 'getCode').mockImplementation(async (address, block, abortController) => {
		if (address !== SAFE_MULTI_SEND_CALL_ONLY && address !== SAFE_SIGN_MESSAGE_LIB) return await originalGetCode(address, block, abortController)
		blocks.push(block)
		return libraryCode
	})
	try {
		for (const { to, data, bytecode } of [
			{ to: SAFE_MULTI_SEND_CALL_ONLY, data: dataStringWith0xStart(encodeSafeBatch([{ to: recipientAddress, value: 0n, data: new Uint8Array() }, { to: recipientAddress, value: 1n, data: new Uint8Array() }])), bytecode: multiSend.default.deployedBytecode },
			{ to: SAFE_SIGN_MESSAGE_LIB, data: encodeFunctionCall(SAFE_SIGN_MESSAGE_ABI, 'signMessage', ['0x' + '12'.repeat(32)]), bytecode: signMessage.default.deployedBytecode },
		]) for (const signatures of ['0x', '0x' + '00'.repeat(65)]) {
			const request = SendTransactionParams.parse({ method: 'eth_sendTransaction', params: [{ from: addressString(activeAddress), to: addressString(activeAddress), data: encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [addressString(to), 0n, data, 1n, 0n, 0n, 0n, addressString(0n), addressString(0n), signatures]) }] })
			for (const invalidCode of [new Uint8Array(), new Uint8Array([1])]) {
				libraryCode = invalidCode
				await assert.rejects(modules.prepareSafeExecutionSignerRoute(simulator.ethereum, request, safeEntry, safeTestOwnerAddress), /missing or has unexpected bytecode/)
			}
			libraryCode = stringToUint8Array(bytecode)
			const route = await modules.prepareSafeExecutionSignerRoute(simulator.ethereum, request, safeEntry, safeTestOwnerAddress)
			assert.equal(route?.executor, safeTestOwnerAddress)
			assert.equal(route?.transactionParams.params[0].from, safeTestOwnerAddress)
		}
		assert.equal(blocks.length, 12)
		assert.ok(blocks.every((block) => block === 123n))
	} finally { getCode.mockRestore() }
})
