import * as assert from 'assert'
import { test } from 'bun:test'
import { getLatestUnexpectedError } from '../../app/ts/background/storageVariables.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../app/ts/utils/constants.js'
import { activeAddress, browserMock, bytes32String, createDisconnectedPort, createRecordingPort, createSafeAddressBookEntry, createSafeTx, EIP712Message, fakeRequestHandler, fakeRpcNetwork, fakeSafeContract, getSafeTxHash, isRecord, modules, pendingTransaction, privateKeyToAccount, recipientAddress, safeTestOwnerAccount, safeTestOwnerAddress, safeTxToTypedDataJson, signedTransaction, simulator, uniqueRequestIdentifier, waitForPendingTransactionsToClear, withSilencedConsole } from './confirmTransactionTestHarness.js'

test('popup close rejects and removes pending confirmations while RPC services are unavailable', async () => {
	const postedMessages: unknown[] = []
	const socketKey = modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)
	const websiteTabConnections = new Map([[uniqueRequestIdentifier.requestSocket.tabId, { connections: {
		[socketKey]: {
			port: createRecordingPort(postedMessages),
			socket: uniqueRequestIdentifier.requestSocket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [pendingTransaction] })

	await modules.onCloseWindowOrTab(pendingTransaction.popupOrTabId, undefined, undefined, websiteTabConnections)

	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.equal(postedMessages.length, 1)
	const reply = postedMessages[0]
	assert.equal(isRecord(reply) && isRecord(reply.error) ? reply.error.code : undefined, 4001)
})

test('failed signer delivery keeps the request and replaces the waiting spinner with a wallet-neutral error', async () => {
	await browser.storage.local.set({ simulationMode: false })
	const disconnectedPort = createDisconnectedPort()
	const socketKey = modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)
	const connectionCases = [
		{ connections: new Map(), expectedPostAttempts: 0 },
		{ connections: new Map([[uniqueRequestIdentifier.requestSocket.tabId, { connections: {
			[socketKey]: {
				port: disconnectedPort.port,
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		} }]]), expectedPostAttempts: 1 },
	]

	for (const connectionCase of connectionCases) {
		browserMock.sentMessages.length = 0
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForUser' },
		}] })

		const delivered = await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, connectionCase.connections, {
			method: 'popup_confirmDialog',
			data: { action: 'accept', uniqueRequestIdentifier },
		})
		const retainedRequests = await modules.getPendingTransactionsAndMessages()
		const retainedRequest = retainedRequests[0]

		assert.equal(delivered, false)
		assert.equal(retainedRequests.length, 1)
		assert.equal(retainedRequest?.approvalStatus.status, 'SignerError')
		if (retainedRequest?.approvalStatus.status !== 'SignerError') throw new Error('missing signer delivery error')
		assert.match(retainedRequest.approvalStatus.message, /request reached your wallet/)
		const pendingUpdates = browserMock.sentMessages.filter((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions')
		assert.equal(pendingUpdates.length, 2)
		const finalUpdateData = pendingUpdates.at(-1)?.data
		if (!isRecord(finalUpdateData) || !Array.isArray(finalUpdateData.pendingTransactionAndSignableMessages)) throw new Error('missing final pending transaction popup update')
		const finalUpdatedRequest = finalUpdateData.pendingTransactionAndSignableMessages[0]
		if (!isRecord(finalUpdatedRequest) || !isRecord(finalUpdatedRequest.approvalStatus)) throw new Error('missing approval status in final popup update')
		assert.equal(finalUpdatedRequest.approvalStatus.status, 'SignerError')
		assert.equal(disconnectedPort.getPostAttempts(), connectionCase.expectedPostAttempts)
	}
})

test('reject and result replies remain durable after their pending request is removed', async () => {
	delete browserMock.storageState.pendingTerminalReplies
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const disconnectedConnections = new Map()
	const terminalReplies = [
		{
			name: 'reject',
			confirmation: { method: 'popup_confirmDialog' as const, data: { action: 'reject' as const, errorString: undefined, uniqueRequestIdentifier } },
			transaction: pendingTransaction,
		},
		{
			name: 'result',
			confirmation: { method: 'popup_confirmDialog' as const, data: { action: 'signerIncluded' as const, signerReply: modules.EthereumBytes32.serialize(signedTransaction.hash), uniqueRequestIdentifier } },
			transaction: { ...pendingTransaction, simulationMode: false as const },
		},
	]

	for (const terminalReply of terminalReplies) {
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [terminalReply.transaction] })
		assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, disconnectedConnections, terminalReply.confirmation), false, terminalReply.name)
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [], terminalReply.name)
		assert.equal((await modules.getPendingTerminalReplies()).length, 1, terminalReply.name)

		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[socketKey]: {
				port: createRecordingPort(postedMessages),
				socket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		} }]])
		assert.equal(await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket), 1, terminalReply.name)
		assert.deepEqual(await modules.getPendingTerminalReplies(), [], terminalReply.name)
	}
	assert.equal(postedMessages.length, 2)
})

test('terminal replies are persisted before removing the pending rejection or result request', async () => {
	const terminalReplies = [
		{
			name: 'reject',
			confirmation: { method: 'popup_confirmDialog' as const, data: { action: 'reject' as const, errorString: undefined, uniqueRequestIdentifier } },
			transaction: pendingTransaction,
		},
		{
			name: 'result',
			confirmation: { method: 'popup_confirmDialog' as const, data: { action: 'signerIncluded' as const, signerReply: modules.EthereumBytes32.serialize(signedTransaction.hash), uniqueRequestIdentifier } },
			transaction: { ...pendingTransaction, simulationMode: false as const },
		},
	]

	try {
		for (const terminalReply of terminalReplies) {
			delete browserMock.storageState.pendingTerminalReplies
			await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [terminalReply.transaction] })
			let signalPersistenceStarted: (() => void) | undefined
			const persistenceStarted = new Promise<void>((resolve) => { signalPersistenceStarted = resolve })
			let releasePersistence: (() => void) | undefined
			const allowPersistence = new Promise<void>((resolve) => { releasePersistence = resolve })
			browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
				if ('pendingTerminalReplies' in items) {
					signalPersistenceStarted?.()
					await allowPersistence
				}
				writeStoredItems()
			})

			const resolution = modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, new Map(), terminalReply.confirmation)
			await persistenceStarted
			assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1, terminalReply.name)
			releasePersistence?.()
			assert.equal(await resolution, false, terminalReply.name)
			assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [], terminalReply.name)
			assert.equal((await modules.getPendingTerminalReplies()).length, 1, terminalReply.name)
		}
	} finally {
		browserMock.setStorageSetHandler(undefined)
	}
})

test('MV2 popup close rejects its captured requests without deleting a concurrently appended request', async () => {
	const postedMessages: unknown[] = []
	const replacementPort = createRecordingPort(postedMessages)
	const disconnectedPort = createDisconnectedPort()
	const socketKey = modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)
	const websiteTabConnections = new Map([[uniqueRequestIdentifier.requestSocket.tabId, { connections: {
		[socketKey]: {
			port: disconnectedPort.port,
			socket: uniqueRequestIdentifier.requestSocket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	const secondCapturedRequest = {
		...pendingTransaction,
		simulationMode: false,
		approvalStatus: { status: 'WaitingForUser' },
		uniqueRequestIdentifier: { ...uniqueRequestIdentifier, requestId: 2 },
		transactionIdentifier: 2n,
	} as const
	const concurrentlyAppendedRequest = {
		...secondCapturedRequest,
		popupOrTabId: { type: 'popup' as const, id: 2 },
		uniqueRequestIdentifier: { ...uniqueRequestIdentifier, requestId: 3 },
		transactionIdentifier: 3n,
	}
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{
		...pendingTransaction,
		simulationMode: false,
		approvalStatus: { status: 'WaitingForUser' },
	}, secondCapturedRequest] })
	let reconnectRequests = 0
	browserMock.setManifestVersion(2)
	browserMock.setTabMessageHandler(async () => {
		reconnectRequests += 1
		await modules.appendPendingTransactionOrMessage(concurrentlyAppendedRequest)
		websiteTabConnections.set(uniqueRequestIdentifier.requestSocket.tabId, { connections: {
			[socketKey]: {
				port: replacementPort,
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		} })
		await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, uniqueRequestIdentifier.requestSocket)
		return { reconnected: true }
	})

	try {
		await modules.onCloseWindowOrTab({ type: 'popup', id: 1 }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
	} finally {
		browserMock.setManifestVersion(3)
		browserMock.setTabMessageHandler(undefined)
	}

	const remainingRequests = await modules.getPendingTransactionsAndMessages()
	assert.deepEqual(remainingRequests.map((request) => request.uniqueRequestIdentifier.requestId), [3])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	assert.equal(disconnectedPort.getPostAttempts(), 1)
	assert.equal(reconnectRequests, 1)
	assert.equal(postedMessages.length, 2)
	for (const [index, rejection] of postedMessages.entries()) {
		if (!isRecord(rejection) || !isRecord(rejection.error)) throw new Error('missing dapp rejection after popup close')
		assert.equal(rejection.requestId, index + 1)
		assert.equal(rejection.method, 'eth_sendTransaction')
		assert.equal(rejection.error.code, 4001)
		assert.equal(rejection.error.message, 'User denied transaction signature')
	}
})

test('popup close keeps the pending request when durable rejection enqueue fails', async () => {
	delete browserMock.storageState.pendingTerminalReplies
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[socketKey]: {
			port: createRecordingPort(postedMessages),
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{
		...pendingTransaction,
		simulationMode: false,
		approvalStatus: { status: 'WaitingForUser' },
	}] })
	let terminalReplyReadFailuresRemaining = 1
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (terminalReplyReadFailuresRemaining > 0 && Array.isArray(keys) && keys.includes('pendingTerminalReplies')) {
			terminalReplyReadFailuresRemaining -= 1
			throw new Error('storage temporarily unavailable')
		}
		return readStoredItems()
	})

	await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: 1 }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
	assert.equal(postedMessages.length, 0)
	assert.equal(browserMock.storageState.pendingTerminalReplies, undefined)

	browserMock.setStorageGetHandler(undefined)
	await waitForPendingTransactionsToClear()
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	assert.equal(postedMessages.length, 1)
	const rejection = postedMessages[0]
	if (!isRecord(rejection) || !isRecord(rejection.error)) throw new Error('missing popup-close rejection after storage recovery')
	assert.equal(rejection.error.code, 4001)
})

test('popup close retries outbox cleanup without reposting after direct delivery', async () => {
	delete browserMock.storageState.pendingTerminalReplies
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	let failNextTerminalReplyRead = false
	const recordingPort = createRecordingPort(postedMessages)
	const cleanupFailingPort: browser.runtime.Port = {
		...recordingPort,
		postMessage(message: unknown) {
			recordingPort.postMessage(message)
			failNextTerminalReplyRead = true
		},
	}
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[socketKey]: {
			port: cleanupFailingPort,
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{
		...pendingTransaction,
		simulationMode: false,
		approvalStatus: { status: 'WaitingForUser' },
	}] })
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (failNextTerminalReplyRead && Array.isArray(keys) && keys.includes('pendingTerminalReplies')) {
			failNextTerminalReplyRead = false
			throw new Error('storage cleanup temporarily unavailable')
		}
		return readStoredItems()
	})

	await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: 1 }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	assert.equal(postedMessages.length, 1)
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
	assert.equal((await modules.getPendingTerminalReplies()).length, 1)

	await waitForPendingTransactionsToClear()
	assert.equal(postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	browserMock.setStorageGetHandler(undefined)
})

test('popup close settles once and stops reading the queue even when follow-up view work failed', async () => {
	delete browserMock.storageState.pendingTerminalReplies
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[socketKey]: {
			port: createRecordingPort(postedMessages),
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{
		...pendingTransaction,
		simulationMode: false,
		approvalStatus: { status: 'WaitingForUser' },
	}] })
	let emptyPendingReads = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (Array.isArray(keys) && keys.includes('pendingTransactionsAndMessages') && Array.isArray(browserMock.storageState.pendingTransactionsAndMessages) && browserMock.storageState.pendingTransactionsAndMessages.length === 0) {
			emptyPendingReads += 1
			if (emptyPendingReads === 1) throw new Error('follow-up view storage unavailable')
		}
		return readStoredItems()
	})

	await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: 1 }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	const retryDeadline = Date.now() + 2_000
	while (emptyPendingReads < 2) {
		if (Date.now() > retryDeadline) throw new Error('Timed out waiting for the popup-close retry existence check')
		await new Promise((resolve) => setTimeout(resolve, 10))
	}

	assert.equal(postedMessages.length, 1)
	// The failed view step is reported instead of retried (the website already has its answer), so once the request is gone nothing reads the queue again.
	await new Promise((resolve) => setTimeout(resolve, 100))
	const readsAfterSettling = emptyPendingReads
	await new Promise((resolve) => setTimeout(resolve, 100))
	assert.equal(emptyPendingReads, readsAfterSettling)
	assert.equal(postedMessages.length, 1)
	browserMock.setStorageGetHandler(undefined)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

test('MV2 reconnect cleanup failure retries without reposting the rejection', async () => {
	delete browserMock.storageState.pendingTerminalReplies
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const disconnectedPort = createDisconnectedPort()
	let failNextTerminalReplyRead = false
	const replacementRecordingPort = createRecordingPort(postedMessages)
	const replacementPort: browser.runtime.Port = {
		...replacementRecordingPort,
		postMessage(message: unknown) {
			replacementRecordingPort.postMessage(message)
			failNextTerminalReplyRead = true
		},
	}
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[socketKey]: {
			port: disconnectedPort.port,
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{
		...pendingTransaction,
		simulationMode: false,
		approvalStatus: { status: 'WaitingForUser' },
	}] })
	browserMock.setManifestVersion(2)
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (failNextTerminalReplyRead && Array.isArray(keys) && keys.includes('pendingTerminalReplies')) {
			failNextTerminalReplyRead = false
			throw new Error('storage cleanup temporarily unavailable')
		}
		return readStoredItems()
	})
	browserMock.setTabMessageHandler(async () => {
		websiteTabConnections.set(socket.tabId, { connections: {
			[socketKey]: {
				port: replacementPort,
				socket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		} })
		await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket)
		return { reconnected: true }
	})

	try {
		await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: 1 }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
		assert.equal(postedMessages.length, 1)
		assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
		assert.equal((await modules.getPendingTerminalReplies()).length, 1)

		await waitForPendingTransactionsToClear()
		assert.equal(postedMessages.length, 1)
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
		assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	} finally {
		browserMock.setManifestVersion(3)
		browserMock.setStorageGetHandler(undefined)
		browserMock.setTabMessageHandler(undefined)
	}
})

test('startup recovery rejects orphaned requests and preserves requests with live confirmation windows', async () => {
	delete browserMock.storageState.pendingTerminalReplies
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[socketKey]: {
			port: createRecordingPort(postedMessages),
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	const livePopupId = 2
	const livePendingTransaction = {
		...pendingTransaction,
		popupOrTabId: { type: 'popup' as const, id: livePopupId },
		uniqueRequestIdentifier: { ...uniqueRequestIdentifier, requestId: uniqueRequestIdentifier.requestId + 1 },
	}
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [pendingTransaction, livePendingTransaction] })
	browserMock.setLiveWindowIds([livePopupId])

	await modules.resolvePendingRequestsForMissingConfirmationWindows(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
	const remainingTransactions = await modules.getPendingTransactionsAndMessages()
	assert.deepEqual(remainingTransactions.map((transaction) => transaction.uniqueRequestIdentifier.requestId), [livePendingTransaction.uniqueRequestIdentifier.requestId])
	assert.equal(postedMessages.length, 1)
	const rejection = postedMessages[0]
	if (!isRecord(rejection) || !isRecord(rejection.error)) throw new Error('missing startup orphan rejection')
	assert.equal(rejection.error.code, 4001)

	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	browserMock.setLiveWindowIds([])
})

test('startup recovery removes the unreachable rejection created for an orphaned request from a missing tab', async () => {
	delete browserMock.storageState.pendingTerminalReplies
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [pendingTransaction] })
	browserMock.setLiveTabIds([])
	browserMock.setLiveWindowIds([])

	await modules.resolvePendingRequestsForMissingConfirmationWindows(simulator.ethereum, simulator.tokenPriceService, new Map())
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.equal((await modules.getPendingTerminalReplies()).length, 1)

	assert.equal(await modules.prunePendingTerminalRepliesForMissingTabs(), 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

test('popup-close rejection remains queued after reconnect timeout and flushes on the exact socket', async () => {
	const postedMessages: unknown[] = []
	const replacementPort = createRecordingPort(postedMessages)
	const disconnectedPort = createDisconnectedPort()
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[socketKey]: {
			port: disconnectedPort.port,
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{
		...pendingTransaction,
		simulationMode: false,
		approvalStatus: { status: 'WaitingForUser' },
	}] })
	browserMock.setManifestVersion(2)
	browserMock.setTabMessageHandler(async () => ({ reconnected: true }))

	try {
		await modules.onCloseWindowOrTab({ type: 'popup', id: 1 }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
		await new Promise((resolve) => setTimeout(resolve, 1_050))
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
		assert.equal((await modules.getPendingTerminalReplies()).length, 1)
		assert.deepEqual(postedMessages, [])

		websiteTabConnections.set(socket.tabId, { connections: {
			[socketKey]: {
				port: replacementPort,
				socket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		} })
		assert.equal(await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket), 1)
		assert.deepEqual(await modules.getPendingTerminalReplies(), [])
		assert.equal(postedMessages.length, 1)
		const rejection = postedMessages[0]
		if (!isRecord(rejection) || !isRecord(rejection.error)) throw new Error('missing queued popup-close rejection')
		assert.equal(rejection.requestId, uniqueRequestIdentifier.requestId)
		assert.equal(rejection.error.code, 4001)
	} finally {
		browserMock.setManifestVersion(3)
		browserMock.setTabMessageHandler(undefined)
	}
})

test('same-request terminal reply producers coalesce into one delivery', async () => {
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[socketKey]: {
			port: createRecordingPort(postedMessages),
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	const terminalReply = {
		...pendingTransaction.originalRequestParameters,
		type: 'result' as const,
		error: { code: 4001, message: 'User denied transaction signature' },
		uniqueRequestIdentifier,
	}

	assert.deepEqual(await Promise.all([
		modules.queueTerminalReplyAndAttemptDelivery(websiteTabConnections, terminalReply),
		modules.queueTerminalReplyAndAttemptDelivery(websiteTabConnections, terminalReply),
	]), [true, true])
	assert.equal(postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

test('socket flush overlapping terminal reply persistence delivers exactly once', async () => {
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const websiteTabConnections = new Map<number, { connections: Record<string, {
		port: browser.runtime.Port,
		socket: typeof socket,
		websiteOrigin: string,
		approved: boolean,
		wantsToConnect: boolean,
	}> }>()
	const terminalReply = {
		...pendingTransaction.originalRequestParameters,
		type: 'result' as const,
		error: { code: 4001, message: 'User denied transaction signature' },
		uniqueRequestIdentifier,
	}

	const production = modules.queueTerminalReplyAndAttemptDelivery(websiteTabConnections, terminalReply)
	websiteTabConnections.set(socket.tabId, { connections: {
		[socketKey]: {
			port: createRecordingPort(postedMessages),
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} })
	const flush = modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket)
	await Promise.all([production, flush])

	assert.equal(postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

test('socket flush during terminal reply queueing keeps the completion marker for the original delivery attempt', async () => {
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const terminalReply = {
		...pendingTransaction.originalRequestParameters,
		type: 'result' as const,
		error: { code: 4001, message: 'User denied transaction signature' },
		uniqueRequestIdentifier,
	}
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[socketKey]: {
			port: createRecordingPort(postedMessages),
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])

	await modules.queueTerminalReply(terminalReply)
	assert.equal(await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket), 1)
	assert.equal(await modules.attemptQueuedTerminalReplyDelivery(websiteTabConnections, terminalReply), true)
	assert.equal(postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

test('corrupt terminal reply storage recovers and delivers the next rejection once', async () => {
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[socketKey]: {
			port: createRecordingPort(postedMessages),
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	const terminalReply = {
		...pendingTransaction.originalRequestParameters,
		type: 'result' as const,
		error: { code: 4001, message: 'User denied transaction signature' },
		uniqueRequestIdentifier,
	}
	browserMock.storageState.pendingTerminalReplies = { malformed: true }
	browserMock.storageState.popupRefreshGeneration = 17

	assert.equal(await withSilencedConsole(async () => await modules.queueTerminalReplyAndAttemptDelivery(websiteTabConnections, terminalReply)), true)

	assert.equal(postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	assert.equal(browserMock.storageState.popupRefreshGeneration, 17)
	const diagnostics = browserMock.storageState.interceptorErrorDiagnostics
	assert.ok(Array.isArray(diagnostics))
	assert.equal(diagnostics.at(-1)?.code, 'pending_terminal_replies_corrupt')
})

test('connected socket retries a transient terminal reply storage read failure without another reconnect', async () => {
	delete browserMock.storageState.pendingTerminalReplies
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const terminalReply = {
		...pendingTransaction.originalRequestParameters,
		type: 'result' as const,
		error: { code: 4001, message: 'User denied transaction signature' },
		uniqueRequestIdentifier,
	}
	await modules.queueTerminalReplyAndAttemptDelivery(new Map(), terminalReply)
	const storedReplyBeforeFailure = structuredClone(browserMock.storageState.pendingTerminalReplies)
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[socketKey]: {
			port: createRecordingPort(postedMessages),
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	let storageFailuresRemaining = 1
	browserMock.setStorageGetHandler(async (_keys, readStoredItems) => {
		if (storageFailuresRemaining > 0) {
			storageFailuresRemaining -= 1
			throw new Error('storage temporarily unavailable')
		}
		return readStoredItems()
	})
	const connectedPort = websiteTabConnections.get(socket.tabId)?.connections[socketKey]?.port
	if (connectedPort === undefined) throw new Error('missing connected terminal reply test port')

	assert.equal(await withSilencedConsole(async () => await modules.flushPendingTerminalRepliesForConnectedPortWithRetry(websiteTabConnections, socket, connectedPort)), 0)
	assert.deepEqual(browserMock.storageState.pendingTerminalReplies, storedReplyBeforeFailure)
	assert.equal(postedMessages.length, 0)

	const deadline = Date.now() + 2_000
	while (postedMessages.length === 0) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for connected socket terminal reply retry')
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	browserMock.setStorageGetHandler(undefined)
	assert.equal(postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

test('concurrent terminal reply flushes serialize storage reads and deliver once', async () => {
	delete browserMock.storageState.pendingTerminalReplies
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const terminalReply = {
		...pendingTransaction.originalRequestParameters,
		type: 'result' as const,
		error: { code: 4001, message: 'User denied transaction signature' },
		uniqueRequestIdentifier,
	}
	await modules.queueTerminalReplyAndAttemptDelivery(new Map(), terminalReply)
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[socketKey]: {
			port: createRecordingPort(postedMessages),
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	let storageReadCount = 0
	let signalFirstReadStarted: (() => void) | undefined
	const firstReadStarted = new Promise<void>((resolve) => { signalFirstReadStarted = resolve })
	let releaseFirstRead: (() => void) | undefined
	const firstReadCanFinish = new Promise<void>((resolve) => { releaseFirstRead = resolve })
	browserMock.setStorageGetHandler(async (_keys, readStoredItems) => {
		storageReadCount += 1
		if (storageReadCount === 1) {
			signalFirstReadStarted?.()
			await firstReadCanFinish
		}
		return readStoredItems()
	})

	const firstFlush = modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket)
	await firstReadStarted
	const secondFlush = modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket)
	await Promise.resolve()
	assert.equal(storageReadCount, 1)
	releaseFirstRead?.()
	assert.deepEqual(await Promise.all([firstFlush, secondFlush]), [1, 0])

	browserMock.setStorageGetHandler(undefined)
	assert.equal(postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

test('startup pruning removes terminal replies for missing tabs and preserves live tabs', async () => {
	delete browserMock.storageState.pendingTerminalReplies
	const missingTabReply = {
		...pendingTransaction.originalRequestParameters,
		type: 'result' as const,
		error: { code: 4001, message: 'User denied transaction signature' },
		uniqueRequestIdentifier,
	}
	const liveTabId = uniqueRequestIdentifier.requestSocket.tabId + 1
	const liveTabReply = {
		...missingTabReply,
		uniqueRequestIdentifier: {
			requestId: uniqueRequestIdentifier.requestId + 1,
			requestSocket: { ...uniqueRequestIdentifier.requestSocket, tabId: liveTabId },
		},
	}
	const noConnections = new Map()
	await modules.queueTerminalReplyAndAttemptDelivery(noConnections, missingTabReply)
	await modules.queueTerminalReplyAndAttemptDelivery(noConnections, liveTabReply)
	browserMock.storageState.popupRefreshGeneration = 23
	browserMock.setLiveTabIds([liveTabId])

	assert.equal(await modules.prunePendingTerminalRepliesForMissingTabs(), 1)
	const remainingReplies = await modules.getPendingTerminalReplies()
	assert.equal(remainingReplies.length, 1)
	assert.equal(remainingReplies[0]?.uniqueRequestIdentifier.requestSocket.tabId, liveTabId)
	assert.equal(browserMock.storageState.popupRefreshGeneration, 23)
	delete browserMock.storageState.pendingTerminalReplies
})


// Chrome refuses to focus, open or close tabs and windows while the user drags a tab. Missing tabs and windows are already ignored by the browser helpers, so a failure like this is what reaches the confirmation window cleanup.
const TAB_DRAG_ERROR_MESSAGE = 'Tabs cannot be edited right now (user may be dragging a tab).'

function connectRequestingWebsite() {
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[modules.websiteSocketToString(socket)]: { port: createRecordingPort(postedMessages), socket, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true },
	} }]])
	return { postedMessages, websiteTabConnections }
}

const getRepliesToWebsite = (postedMessages: readonly unknown[]) => postedMessages.filter((message) => isRecord(message) && message.type === 'result')

// Fails focusing the website's tab, which the cleanup does once the confirmation queue is empty, and records how many replies the website had received by then.
function failFocusingTheWebsiteTab(postedMessages: readonly unknown[]) {
	const repliesReceivedBeforeCleanup: number[] = []
	browserMock.setLiveTabIds([uniqueRequestIdentifier.requestSocket.tabId])
	browserMock.setTabUpdateHandler(async () => {
		repliesReceivedBeforeCleanup.push(getRepliesToWebsite(postedMessages).length)
		throw new Error(TAB_DRAG_ERROR_MESSAGE)
	})
	return repliesReceivedBeforeCleanup
}

async function assertConfirmationViewFailureWasReported() {
	const reportedError = await getLatestUnexpectedError()
	assert.equal(reportedError?.data.code, 'confirm_transaction_view_update_failed')
	assert.equal(reportedError?.data.message, TAB_DRAG_ERROR_MESSAGE)
}

test('approving a simulated transaction answers the website before the window cleanup, whose failure is reported', async () => {
	const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
	const repliesReceivedBeforeCleanup = failFocusingTheWebsiteTab(postedMessages)

	const delivered = await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	}))

	assert.equal(delivered, true)
	assert.deepEqual(repliesReceivedBeforeCleanup, [1])
	const [reply] = getRepliesToWebsite(postedMessages)
	if (!isRecord(reply)) throw new Error('Missing reply to the website')
	assert.equal(reply.method, 'eth_sendTransaction')
	assert.equal(reply.result, modules.EthereumBytes32.serialize(signedTransaction.hash))
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 1)
	await assertConfirmationViewFailureWasReported()
})

test('rejecting a transaction answers the website before the window cleanup, whose failure is reported', async () => {
	const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
	const repliesReceivedBeforeCleanup: number[] = []
	browserMock.setLiveWindowIds([pendingTransaction.popupOrTabId.id])
	browserMock.setWindowRemoveHandler(async () => {
		repliesReceivedBeforeCleanup.push(getRepliesToWebsite(postedMessages).length)
		throw new Error(TAB_DRAG_ERROR_MESSAGE)
	})

	const delivered = await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'reject', errorString: undefined, uniqueRequestIdentifier },
	}))

	assert.equal(delivered, true)
	assert.deepEqual(repliesReceivedBeforeCleanup, [1])
	const [reply] = getRepliesToWebsite(postedMessages)
	if (!isRecord(reply) || !isRecord(reply.error)) throw new Error('Missing rejection sent to the website')
	assert.equal(reply.method, 'eth_sendTransaction')
	assert.equal(reply.error.code, METAMASK_ERROR_USER_REJECTED_REQUEST)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
	await assertConfirmationViewFailureWasReported()
})

test('approving a simulated message signature answers the website before the window cleanup, whose failure is reported', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
	const message = '0x68656c6c6f'
	// Simulation mode signs for addresses it holds no key for, such as the default active address, with the mock private key 2.
	const expectedSignature = await privateKeyToAccount(bytes32String(2n)).signMessage({ message: 'hello' })
	const request = { method: 'personal_sign', params: [message, addressString(activeAddress)], interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier }
	const signRequest = { method: 'personal_sign' as const, params: [message, activeAddress] as const }
	const website = { websiteOrigin: 'https://example.com', icon: undefined, title: undefined }
	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, request, { kind: 'message', parameters: signRequest }, true, activeAddress, website, websiteTabConnections), { type: 'doNotReply' })
	const repliesReceivedBeforeCleanup = failFocusingTheWebsiteTab(postedMessages)

	const delivered = await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	}))

	assert.equal(delivered, true)
	assert.deepEqual(repliesReceivedBeforeCleanup, [1])
	const [reply] = getRepliesToWebsite(postedMessages)
	if (!isRecord(reply)) throw new Error('Missing reply to the website')
	assert.equal(reply.method, 'personal_sign')
	assert.equal(reply.result, expectedSignature)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	const stackOperations = (await modules.getInterceptorTransactionStack()).operations
	assert.equal(stackOperations.length, 1)
	const [signedMessage] = stackOperations
	if (signedMessage?.type !== 'Message') throw new Error('Missing signed message on the simulation stack')
	assert.equal(signedMessage.signedMessageTransaction.fakeSignedFor, activeAddress)
	assert.deepEqual(signedMessage.signedMessageTransaction.originalRequestParameters, signRequest)
	await assertConfirmationViewFailureWasReported()
})

test('a request the website sends while the previous window is still being cleaned up opens its own window and the previous window is closed', async () => {
	const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
	const previousWindow = pendingTransaction.popupOrTabId
	// The mock browser opens every new window with id 99.
	const nextRequestWindow = { type: 'popup', id: 99 }
	browserMock.setLiveWindowIds([previousWindow.id, nextRequestWindow.id])
	const removedWindowIds: number[] = []
	browserMock.setWindowRemoveHandler(async (windowId) => { removedWindowIds.push(windowId) })
	const nextRequestIdentifier = { ...uniqueRequestIdentifier, requestId: 2 }
	const nextSignRequest = { method: 'personal_sign' as const, params: ['0x68656c6c6f', activeAddress] as const }
	const nextRequest = { method: 'personal_sign', params: ['0x68656c6c6f', addressString(activeAddress)], interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: nextRequestIdentifier }
	let nextRequestOutcome: unknown
	// The cleanup first refreshes the simulation view of the approved transaction. The website, which already has its answer, sends its next request while that refresh waits on the popup probe.
	browserMock.setRuntimeSendMessageHandler(async (message) => {
		if (message.method !== 'popup_isSimulationVisualizerOpen' || nextRequestOutcome !== undefined || getRepliesToWebsite(postedMessages).length !== 1) return
		nextRequestOutcome = 'pending'
		nextRequestOutcome = await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, nextRequest, { kind: 'message', parameters: nextSignRequest }, true, activeAddress, pendingTransaction.website, websiteTabConnections)
	})

	const delivered = await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	})

	assert.equal(delivered, true)
	assert.deepEqual(nextRequestOutcome, { type: 'doNotReply' })
	assert.deepEqual((await modules.getPendingTransactionsAndMessages()).map((pending) => ({ uniqueRequestIdentifier: pending.uniqueRequestIdentifier, popupOrTabId: pending.popupOrTabId })), [{ uniqueRequestIdentifier: nextRequestIdentifier, popupOrTabId: nextRequestWindow }])
	assert.deepEqual(removedWindowIds, [previousWindow.id])
})

// Fails opening the simulation stack window, which the cleanup does after a Gnosis Safe proposal is stored, and records how many replies the website had received by then.
function failOpeningTheSimulationStackWindow(postedMessages: readonly unknown[]) {
	const repliesReceivedBeforeCleanup: number[] = []
	browserMock.setWindowCreateHandler(async () => {
		repliesReceivedBeforeCleanup.push(getRepliesToWebsite(postedMessages).length)
		throw new Error(TAB_DRAG_ERROR_MESSAGE)
	})
	return repliesReceivedBeforeCleanup
}

// A signing-mode Gnosis Safe proposal from the requesting website, reviewed against a Safe whose only owner is the test owner.
async function storeSafeProposalRequest(approvalStatus: { readonly status: 'WaitingForUser' } | { readonly status: 'WaitingForSigner' }) {
	fakeSafeContract.owners = [safeTestOwnerAddress]
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, { to: recipientAddress, value: 0n, input: new Uint8Array() }, 0n)
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	await modules.updateSafeTransactionStacks(() => [])
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({ simulationMode: false, rpcNetwork: fakeRpcNetwork, activeSigningSafeAddress: activeAddress })
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{
		...pendingTransaction,
		simulationMode: false,
		approvalStatus,
		// Recorded by the Accept that forwarded the proposal to its signer.
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
	}] })
	return { safeTx, safeTxHash }
}

// The proposal is stored once in its Gnosis Safe stack and mirrored once on the simulation stack, both with the expected owner signatures, even though opening the stack window failed afterwards.
async function assertSafeProposalWasStoredAndAnswered(postedMessages: readonly unknown[], safeTxHash: bigint, expectedSignatures: readonly { readonly signer: bigint, readonly signature: string }[]) {
	const [reply] = getRepliesToWebsite(postedMessages)
	if (!isRecord(reply)) throw new Error('Missing reply to the website')
	assert.equal(reply.method, 'eth_sendTransaction')
	assert.equal(reply.result, modules.EthereumBytes32.serialize(safeTxHash))
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	const safeStacks = await modules.getSafeTransactionStacks()
	assert.equal(safeStacks.length, 1)
	assert.deepEqual(safeStacks[0]?.transactions.map((transaction) => ({ safeTxHash: transaction.safeTxHash, signatures: transaction.signatures })), [{ safeTxHash, signatures: expectedSignatures }])
	const mirroredProposals = (await modules.getInterceptorTransactionStack()).operations.flatMap((operation) =>
		operation.type === 'Transaction' && operation.preSimulationTransaction.safeTransaction?.safeTxHash === safeTxHash ? [operation.preSimulationTransaction.safeTransaction] : []
	)
	assert.equal(mirroredProposals.length, 1)
	assert.deepEqual(mirroredProposals[0]?.signatures, expectedSignatures)
	await assertConfirmationViewFailureWasReported()
}

test('adding a Gnosis Safe proposal to its stack answers the website with the proposal hash before opening the stack window, whose failure is reported', async () => {
	const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
	const { safeTxHash } = await storeSafeProposalRequest({ status: 'WaitingForUser' })
	const repliesReceivedBeforeCleanup = failOpeningTheSimulationStackWindow(postedMessages)

	const delivered = await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'addToSafeStack', uniqueRequestIdentifier },
	}))

	assert.equal(delivered, true)
	assert.deepEqual(repliesReceivedBeforeCleanup, [1])
	await assertSafeProposalWasStoredAndAnswered(postedMessages, safeTxHash, [])
})

test('a Gnosis Safe owner signature answers the website with the proposal hash before opening the stack window, whose failure is reported', async () => {
	const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeSimulationSignerAddress: safeTestOwnerAddress })])
	const { safeTx, safeTxHash } = await storeSafeProposalRequest({ status: 'WaitingForSigner' })
	const signature = await safeTestOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	const repliesReceivedBeforeCleanup = failOpeningTheSimulationStackWindow(postedMessages)

	const delivered = await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: signature, uniqueRequestIdentifier },
	}))

	assert.equal(delivered, true)
	assert.deepEqual(repliesReceivedBeforeCleanup, [1])
	await assertSafeProposalWasStoredAndAnswered(postedMessages, safeTxHash, [{ signer: safeTestOwnerAddress, signature }])
})

// Records the website tab focused and the windows closed by the confirmation window cleanup, with the confirmation window of the pending request still open.
function recordConfirmationWindowCleanup() {
	const focusedTabIds: number[] = []
	const removedWindowIds: number[] = []
	browserMock.setLiveTabIds([uniqueRequestIdentifier.requestSocket.tabId])
	browserMock.setLiveWindowIds([pendingTransaction.popupOrTabId.id])
	browserMock.setTabUpdateHandler(async (tabId) => { focusedTabIds.push(tabId) })
	browserMock.setWindowRemoveHandler(async (windowId) => { removedWindowIds.push(windowId) })
	return { focusedTabIds, removedWindowIds }
}

test('failing to open the stack window after a Gnosis Safe proposal is stored still focuses the website and closes the confirmation window', async () => {
	const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
	const { safeTxHash } = await storeSafeProposalRequest({ status: 'WaitingForUser' })
	const repliesReceivedBeforeCleanup = failOpeningTheSimulationStackWindow(postedMessages)
	const { focusedTabIds, removedWindowIds } = recordConfirmationWindowCleanup()

	const delivered = await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'addToSafeStack', uniqueRequestIdentifier },
	}))

	assert.equal(delivered, true)
	assert.deepEqual(repliesReceivedBeforeCleanup, [1])
	assert.deepEqual(focusedTabIds, [uniqueRequestIdentifier.requestSocket.tabId])
	assert.deepEqual(removedWindowIds, [pendingTransaction.popupOrTabId.id])
	await assertSafeProposalWasStoredAndAnswered(postedMessages, safeTxHash, [])
})

test('a terminal reply delivery that throws still focuses the website and closes the confirmation window, and the delivery error reaches the caller', async () => {
	const disconnectedPort = createDisconnectedPort()
	const socket = uniqueRequestIdentifier.requestSocket
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[modules.websiteSocketToString(socket)]: { port: disconnectedPort.port, socket, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true },
	} }]])
	const { focusedTabIds, removedWindowIds } = recordConfirmationWindowCleanup()
	// Delivery to the disconnected port fails, so on Manifest V2 the website is asked to reconnect, and that request fails with an error delivery does not handle.
	const reconnectError = new Error('The website could not be asked to reconnect.')
	browserMock.setManifestVersion(2)
	browserMock.setTabMessageHandler(async () => { throw reconnectError })

	await assert.rejects(modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'reject', errorString: undefined, uniqueRequestIdentifier },
	}), reconnectError)

	assert.equal(disconnectedPort.getPostAttempts(), 1)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.equal((await modules.getPendingTerminalReplies()).length, 1)
	assert.deepEqual(focusedTabIds, [socket.tabId])
	assert.deepEqual(removedWindowIds, [pendingTransaction.popupOrTabId.id])
})

await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))

// A deferred Gnosis Safe co-signature waits for services for its own network after its window closed, so it stays at the queue head with a window that no longer exists.
function storeDeferredCoSignatureBeforeLaterRequest() {
	const deferredCoSignature = {
		...pendingTransaction,
		uniqueRequestIdentifier: { ...uniqueRequestIdentifier, requestId: 70 },
		popupOrTabId: { type: 'popup' as const, id: 41 },
		simulationMode: false,
		approvalStatus: { status: 'WaitingForSigner' as const },
		deferredSafeSignerReply: { signerReply: '0x1234', chainId: fakeRpcNetwork.chainId + 1n },
	}
	const laterWindow = { type: 'popup' as const, id: 77 }
	const laterRequest = { ...pendingTransaction, uniqueRequestIdentifier: { ...uniqueRequestIdentifier, requestId: 71 }, popupOrTabId: laterWindow }
	return { laterWindow, store: async () => await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [deferredCoSignature, laterRequest] }) }
}

const getRejectionsTo = (postedMessages: readonly unknown[], requestId: number) => getRepliesToWebsite(postedMessages).filter((message) => isRecord(message) && message.requestId === requestId && 'error' in message)

test('closing a later confirmation window answers its request while a deferred co-signature keeps its closed window', async () => {
	const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
	const { laterWindow, store } = storeDeferredCoSignatureBeforeLaterRequest()
	await store()
	browserMock.setLiveWindowIds([laterWindow.id])

	await modules.onCloseWindowOrTab(laterWindow, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)

	assert.deepEqual((await modules.getPendingTransactionsAndMessages()).map((pending) => pending.uniqueRequestIdentifier.requestId), [70])
	assert.equal(getRejectionsTo(postedMessages, 71).length, 1)
	assert.equal(getRepliesToWebsite(postedMessages).length, 1)
})

test.each(['open', 'closed'] as const)('a new request joins the open confirmation window, or answers orphaned requests when none is, without touching a deferred co-signature (later window %s)', async (laterWindowState) => {
	const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
	const { laterWindow, store } = storeDeferredCoSignatureBeforeLaterRequest()
	await store()
	// The mock browser opens every new window with id 99.
	browserMock.setLiveWindowIds(laterWindowState === 'open' ? [laterWindow.id] : [99])
	const nextRequestIdentifier = { ...uniqueRequestIdentifier, requestId: 72 }
	const nextSignRequest = { method: 'personal_sign' as const, params: ['0x68656c6c6f', activeAddress] as const }
	const nextRequest = { method: 'personal_sign', params: ['0x68656c6c6f', addressString(activeAddress)], interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: nextRequestIdentifier }

	assert.deepEqual(await withSilencedConsole(async () => await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, nextRequest, { kind: 'message', parameters: nextSignRequest }, true, activeAddress, pendingTransaction.website, websiteTabConnections)), { type: 'doNotReply' })

	const pending = (await modules.getPendingTransactionsAndMessages()).map((request) => ({ requestId: request.uniqueRequestIdentifier.requestId, windowId: request.popupOrTabId.id }))
	if (laterWindowState === 'open') {
		assert.deepEqual(pending, [{ requestId: 70, windowId: 41 }, { requestId: 71, windowId: laterWindow.id }, { requestId: 72, windowId: laterWindow.id }])
		assert.equal(getRejectionsTo(postedMessages, 71).length, 0)
		return
	}
	assert.deepEqual(pending, [{ requestId: 70, windowId: 41 }, { requestId: 72, windowId: 99 }])
	assert.equal(getRejectionsTo(postedMessages, 71).length, 1)
})

test('the confirmation window shows, refreshes and approves a later request while a deferred co-signature waits for its chain', async () => {
	const { getConfirmationWindowRequests } = await import('../../app/ts/utils/confirmationQueue.js')
	const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
	const { laterWindow, store } = storeDeferredCoSignatureBeforeLaterRequest()
	await store()
	browserMock.setLiveWindowIds([laterWindow.id])
	const requestIdsOf = (requests: readonly unknown[]) => requests.map((request) => isRecord(request) && isRecord(request.uniqueRequestIdentifier) ? request.uniqueRequestIdentifier.requestId : undefined)

	// Opening (or reloading) the window and storage hydration show the later request in its own window.
	const bootstrap = await modules.popupReadyAndListening(simulator.ethereum, websiteTabConnections, 'confirmTransaction')
	if (bootstrap?.ok !== true || bootstrap.data.confirmTransactionBootstrap === undefined) throw new Error('Missing confirmation bootstrap')
	assert.deepEqual(bootstrap.data.popupOrTabId, laterWindow)
	assert.deepEqual(requestIdsOf(bootstrap.data.confirmTransactionBootstrap.pendingTransactionAndSignableMessages), [71])
	assert.deepEqual(requestIdsOf(getConfirmationWindowRequests(await modules.getPendingTransactionsAndMessages())), [71])

	// Pushed updates show it too.
	browserMock.sentMessages.length = 0
	await modules.updateConfirmTransactionView(simulator.ethereum, simulator.tokenPriceService)
	const pushedUpdate = browserMock.sentMessages.filter((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions').at(-1)?.data
	if (!isRecord(pushedUpdate) || !Array.isArray(pushedUpdate.pendingTransactionAndSignableMessages)) throw new Error('Missing pushed pending transactions')
	assert.deepEqual(requestIdsOf(pushedUpdate.pendingTransactionAndSignableMessages), [71])

	// The later request can be approved while the deferred co-signature stays in storage.
	assert.equal(await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier: { ...uniqueRequestIdentifier, requestId: 71 } },
	})), true)
	assert.equal(getRepliesToWebsite(postedMessages).filter((message) => isRecord(message) && message.requestId === 71 && 'result' in message).length, 1)
	assert.deepEqual(requestIdsOf(await modules.getPendingTransactionsAndMessages()), [70])
	assert.equal(await modules.popupReadyAndListening(simulator.ethereum, websiteTabConnections, 'confirmTransaction'), undefined)
})

// Opens simulated personal_sign requests in one confirmation window and turns the first into a Gnosis Safe co-signature waiting for its signer on chain A.
async function openMessagesWithFirstAwaitingSafeCoSignature(requestIds: readonly number[], websiteTabConnections: ReturnType<typeof connectRequestingWebsite>['websiteTabConnections']) {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	// The mock browser opens every new window with id 99.
	browserMock.setLiveWindowIds([99])
	for (const requestId of requestIds) {
		const requestIdentifier = { ...uniqueRequestIdentifier, requestId }
		const signRequest = { method: 'personal_sign' as const, params: ['0x68656c6c6f', activeAddress] as const }
		const request = { method: 'personal_sign', params: ['0x68656c6c6f', addressString(activeAddress)], interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: requestIdentifier }
		assert.deepEqual(await withSilencedConsole(async () => await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, request, { kind: 'message', parameters: signRequest }, true, activeAddress, pendingTransaction.website, websiteTabConnections)), { type: 'doNotReply' })
	}
	const [firstRequestId] = requestIds
	if (firstRequestId === undefined) throw new Error('Missing request')
	const firstRequestIdentifier = { ...uniqueRequestIdentifier, requestId: firstRequestId }
	await modules.updatePendingTransactionOrMessage(firstRequestIdentifier, async (pending) => ({
		...pending,
		simulationMode: false,
		approvalStatus: { status: 'WaitingForSigner' as const },
		signerRequestChainId: fakeRpcNetwork.chainId,
		...(pending.type === 'SignableMessage' ? { safeMessageCoSignSnapshot: { safeAddress: activeAddress, safeSignerAddress: recipientAddress, reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [recipientAddress], threshold: 1n }, safeMessageHash: 1n } } : {}),
	}))
	return firstRequestIdentifier
}

const otherChainSimulatorForWindowTests = () => {
	const otherChainEthereum = new modules.EthereumClientService(fakeRequestHandler, async () => undefined, async () => undefined, { ...fakeRpcNetwork, chainId: fakeRpcNetwork.chainId + 1n })
	return { ethereum: otherChainEthereum, tokenPriceService: new modules.TokenPriceService(otherChainEthereum, 60_000) }
}

const lastPushedRequestIds = () => {
	const pushed = browserMock.sentMessages.filter((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions').at(-1)?.data
	if (!isRecord(pushed) || !Array.isArray(pushed.pendingTransactionAndSignableMessages)) return undefined
	return pushed.pendingTransactionAndSignableMessages.map((request) => isRecord(request) && isRecord(request.uniqueRequestIdentifier) ? request.uniqueRequestIdentifier.requestId : undefined)
}

test.each(['services unavailable', 'services on another chain'] as const)('a co-signature becoming deferred moves its open window on to the next request (%s)', async (servicesState) => {
	const { websiteTabConnections } = connectRequestingWebsite()
	const coSignature = await openMessagesWithFirstAwaitingSafeCoSignature([1, 2], websiteTabConnections)
	const removedWindowIds: number[] = []
	browserMock.setWindowRemoveHandler(async (windowId) => { removedWindowIds.push(windowId) })
	browserMock.sentMessages.length = 0
	const services = servicesState === 'services unavailable' ? undefined : otherChainSimulatorForWindowTests()

	await withSilencedConsole(async () => await modules.resolvePendingSignerReply(services, async () => services, websiteTabConnections, coSignature, { success: true, signerProviderGeneration: 0, forwardRequest: { type: 'forwardToSigner', replyWithSignersReply: true, method: 'personal_sign', params: ['0x68656c6c6f', activeAddress], requestId: coSignature.requestId }, reply: '0x1234' }))

	assert.deepEqual((await modules.getPendingTransactionsAndMessages()).map((pending) => ({ requestId: pending.uniqueRequestIdentifier.requestId, deferred: pending.deferredSafeSignerReply !== undefined })), [{ requestId: 1, deferred: true }, { requestId: 2, deferred: false }])
	assert.deepEqual(lastPushedRequestIds(), [2])
	assert.deepEqual(removedWindowIds, [])
})

test('a sole co-signature becoming deferred closes its confirmation window', async () => {
	const { websiteTabConnections } = connectRequestingWebsite()
	const coSignature = await openMessagesWithFirstAwaitingSafeCoSignature([1], websiteTabConnections)
	const removedWindowIds: number[] = []
	browserMock.setWindowRemoveHandler(async (windowId) => { removedWindowIds.push(windowId) })

	await withSilencedConsole(async () => await modules.resolvePendingSignerReply(undefined, async () => undefined, websiteTabConnections, coSignature, { success: true, signerProviderGeneration: 0, forwardRequest: { type: 'forwardToSigner', replyWithSignersReply: true, method: 'personal_sign', params: ['0x68656c6c6f', activeAddress], requestId: coSignature.requestId }, reply: '0x1234' }))

	assert.equal((await modules.getPendingTransactionsAndMessages())[0]?.deferredSafeSignerReply !== undefined, true)
	assert.deepEqual(removedWindowIds, [99])
})

test('a rejected request stays answered when its removal fails, so a later signature is not deferred and the cleanup retry removes it', async () => {
	const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
	const coSignature = await openMessagesWithFirstAwaitingSafeCoSignature([1], websiteTabConnections)
	// The rejection reaches the website, then removing the request fails once.
	let failRequestRemoval = true
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if (failRequestRemoval && getRejectionsTo(postedMessages, 1).length === 1 && Object.keys(items).join() === 'pendingTransactionsAndMessages') {
			failRequestRemoval = false
			throw new Error('Pending request removal unavailable.')
		}
		writeStoredItems()
	})
	try {
		await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: 99 }, undefined, undefined, websiteTabConnections))
		assert.equal(failRequestRemoval, false)
		assert.equal(getRejectionsTo(postedMessages, 1).length, 1)
		assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)

		// The signer's reply arrives before the cleanup retry: the request is already answered, so the signature is not deferred.
		await withSilencedConsole(async () => await modules.resolvePendingSignerReply(undefined, async () => undefined, websiteTabConnections, coSignature, { success: true, signerProviderGeneration: 0, forwardRequest: { type: 'forwardToSigner', replyWithSignersReply: true, method: 'personal_sign', params: ['0x68656c6c6f', activeAddress], requestId: coSignature.requestId }, reply: '0x1234' }))
		assert.equal((await modules.getPendingTransactionsAndMessages())[0]?.deferredSafeSignerReply, undefined)

		const retryDeadline = Date.now() + 2_000
		while ((await modules.getPendingTransactionsAndMessages()).length > 0) {
			if (Date.now() > retryDeadline) throw new Error('Timed out waiting for the cleanup retry')
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
		assert.equal(getRepliesToWebsite(postedMessages).filter((message) => isRecord(message) && message.requestId === 1).length, 1)
		assert.deepEqual(await modules.getPendingSafeProposalStores(), [])
	} finally {
		browserMock.setStorageSetHandler(undefined)
	}
})

test('cleanup after a failed removal delivers the queued success reply, never a rejection', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [pendingTransaction] })
	const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
	// The approved transaction's result is queued (marking the request answered), then removing the request fails once.
	let resultQueued = false
	let failRequestRemoval = true
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		const keys = Object.keys(items).sort().join()
		if (keys === 'pendingTerminalReplies,pendingTransactionsAndMessages') resultQueued = true
		else if (resultQueued && failRequestRemoval && keys === 'pendingTransactionsAndMessages') {
			failRequestRemoval = false
			throw new Error('Pending request removal unavailable.')
		}
		writeStoredItems()
	})
	try {
		await assert.rejects(withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } })), /Pending request removal unavailable/u)
	} finally {
		browserMock.setStorageSetHandler(undefined)
	}
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
	const [queuedResult] = await modules.getPendingTerminalReplies()
	if (queuedResult === undefined || !('result' in queuedResult)) throw new Error('Missing the queued transaction result')
	// The answered request only waits for its cleanup, so the confirmation window no longer shows it.
	assert.equal(await modules.popupReadyAndListening(simulator.ethereum, websiteTabConnections, 'confirmTransaction'), undefined)

	// The popup closes and later startup recovery runs: the website gets exactly the queued result.
	await withSilencedConsole(async () => await modules.onCloseWindowOrTab(pendingTransaction.popupOrTabId, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	await withSilencedConsole(async () => await modules.resolvePendingRequestsForMissingConfirmationWindows(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, uniqueRequestIdentifier.requestSocket)

	const replies = getRepliesToWebsite(postedMessages)
	assert.equal(replies.length, 1)
	assert.equal(isRecord(replies[0]) ? replies[0].result : undefined, modules.EthereumBytes32.serialize(queuedResult.result))
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

// The flow that queued a reply still owns its delivery while the answered request's cleanup runs: the cleanup read the queued reply, a socket flush then delivered it (leaving a completion marker for that flow), and the cleanup resumed. The cleanup leaves the reply and the marker to the flow, which then finds it delivered, so the website receives one reply.
test('an answered request\'s cleanup never consumes the completion marker of the flow still delivering its reply', async () => {
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[modules.websiteSocketToString(socket)]: { port: createRecordingPort(postedMessages), socket, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true },
	} }]])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [pendingTransaction] })
	const reply = { ...pendingTransaction.originalRequestParameters, type: 'result' as const, result: signedTransaction.hash, uniqueRequestIdentifier }
	assert.equal(await modules.queueTerminalReplyUnlessDeferred(reply), 'queued')
	let cleanupReadPaused = false
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		const readsReplies = Array.isArray(keys) ? keys.includes('pendingTerminalReplies') : keys === 'pendingTerminalReplies'
		if (cleanupReadPaused || !readsReplies) return readStoredItems()
		cleanupReadPaused = true
		const readBeforeTheFlush = readStoredItems()
		assert.equal(await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket), 1)
		return readBeforeTheFlush
	})
	try {
		await modules.resolveDeferredSafeSignerReplies(simulator, websiteTabConnections)
	} finally {
		browserMock.setStorageGetHandler(undefined)
	}
	assert.equal(cleanupReadPaused, true)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])

	assert.equal(await modules.attemptQueuedTerminalReplyDelivery(websiteTabConnections, reply), true)

	assert.equal(postedMessages.filter((message) => isRecord(message) && message.type === 'result' && message.requestId === uniqueRequestIdentifier.requestId).length, 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

// The last confirmation left the queue while the stored RPC configuration is corrupt: the view update returns early without reading the unavailable settings, so nothing rejects unhandled.
test('updating the confirmation view after its last request left reads no unavailable settings', async () => {
	const unhandledRejections: unknown[] = []
	const recordUnhandledRejection = (reason: unknown) => { unhandledRejections.push(reason) }
	const storedRpcNetwork = await browser.storage.local.get('activeRpcNetwork')
	process.on('unhandledRejection', recordUnhandledRejection)
	try {
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
		await browser.storage.local.set({ activeRpcNetwork: 'corrupt' })
		assert.equal(await modules.updateConfirmTransactionView(simulator.ethereum, simulator.tokenPriceService), false)
		await new Promise((resolve) => setTimeout(resolve, 20))
	} finally {
		process.off('unhandledRejection', recordUnhandledRejection)
		await browser.storage.local.set(storedRpcNetwork)
	}
	assert.deepEqual(unhandledRejections, [])
})
