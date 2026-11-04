import * as assert from 'assert'
import { test } from 'bun:test'
import { getInterceptorErrorDiagnostics, getLatestUnexpectedError } from '../../app/ts/background/storageVariables.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../app/ts/utils/constants.js'
import { activeAddress, browserMock, bytes32String, createDisconnectedPort, createRecordingPort, createSafeAddressBookEntry, createSafeTx, EIP712Message, fakeRpcNetwork, fakeSafeContract, getSafeTxHash, isRecord, modules, pendingTransaction, privateKeyToAccount, recipientAddress, safeTestOwnerAccount, safeTestOwnerAddress, safeTxToTypedDataJson, signedTransaction, simulator, testResolutionContext, uniqueRequestIdentifier, waitForPendingTransactionsToClear, withSilencedConsole } from './confirmTransactionTestHarness.js'

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
	// The failed delivery step does not hold back removing the request; its reply stays queued for the retry.
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.equal((await modules.getPendingTerminalReplies()).length, 1)

	await waitForResolutionRetriesToFinish()
	assert.equal(postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	browserMock.setStorageGetHandler(undefined)
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
		// The failed delivery step does not hold back removing the request; its reply stays queued for the retry.
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
		assert.equal((await modules.getPendingTerminalReplies()).length, 1)

		await waitForResolutionRetriesToFinish()
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

	// The rejection can never reach the missing tab, so finishing the request retires it.
	await modules.resolvePendingRequestsForMissingConfirmationWindows(simulator.ethereum, simulator.tokenPriceService, new Map())
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
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
	// The request was resolved, so a delivered reply is retired.
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
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
	// Only finishing its request deletes the reply; delivery marks it delivered.
	assert.deepEqual((await modules.getPendingTerminalReplies()).map((reply) => reply.delivered), [true])
})

test('socket flush overlapping terminal reply persistence delivers exactly once', async () => {
	// The request was resolved, so a delivered reply is retired.
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
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
	// The request was resolved, so a delivered reply is retired.
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
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
	// The request was resolved, so a delivered reply is retired.
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
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
	assert.deepEqual((await modules.getPendingTerminalReplies()).map((reply) => reply.delivered), [true])
	assert.equal(browserMock.storageState.popupRefreshGeneration, 17)
	const diagnostics = browserMock.storageState.interceptorErrorDiagnostics
	assert.ok(Array.isArray(diagnostics))
	assert.equal(diagnostics.at(-1)?.code, 'pending_terminal_replies_corrupt')
})

test('connected socket retries a transient terminal reply storage read failure without another reconnect', async () => {
	// The request was resolved, so a delivered reply is retired.
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
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
	// The request was resolved, so a delivered reply is retired.
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
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

test('startup recovery retires committed replies for missing tabs and keeps those for live tabs', async () => {
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

	await (await import('../../app/ts/background/requestResolution.js')).resumeCommittedRequests(testResolutionContext(noConnections))
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

// Waits until no resolution of a request is in flight or awaiting a retry.
async function waitForResolutionRetriesToFinish() {
	const { getResolutionBookkeepingSize } = await import('../../app/ts/background/requestResolution.js')
	for (let attempt = 0; attempt < 200 && getResolutionBookkeepingSize() > 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 25))
	assert.equal(getResolutionBookkeepingSize(), 0, 'the resolution retries finished')
}

// Closing the confirmation window is a finishing step that is retried, not view work given up on: the reply keeps its window until the window is closed.
test('rejecting a transaction answers the website before closing the window, whose failure is reported and retried', async () => {
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
	assert.deepEqual((await modules.getPendingTerminalReplies()).map((entry) => entry.confirmationWindow), [pendingTransaction.popupOrTabId])
	assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
	assert.ok((await getInterceptorErrorDiagnostics()).some((diagnostic) => diagnostic.code === 'request_resolution_retrying' && diagnostic.cause === TAB_DRAG_ERROR_MESSAGE))

	const removedWindowIds: number[] = []
	browserMock.setWindowRemoveHandler(async (windowId) => { removedWindowIds.push(windowId) })
	await withSilencedConsole(waitForResolutionRetriesToFinish)
	assert.deepEqual(removedWindowIds, [pendingTransaction.popupOrTabId.id])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	assert.equal(getRepliesToWebsite(postedMessages).length, 1)
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

// A delivery that throws is a finishing step that is retried: its error is reported instead of reaching the caller, and it does not hold back removing the request and updating its window.
test('a terminal reply delivery that throws still focuses the website and closes the confirmation window, and the delivery is retried', async () => {
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

	const delivered = await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'reject', errorString: undefined, uniqueRequestIdentifier },
	}))

	assert.equal(delivered, false)
	assert.equal(disconnectedPort.getPostAttempts(), 1)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual((await modules.getPendingTerminalReplies()).map((entry) => ({ delivered: entry.delivered, confirmationWindow: entry.confirmationWindow })), [{ delivered: undefined, confirmationWindow: undefined }])
	assert.deepEqual(focusedTabIds, [socket.tabId])
	assert.deepEqual(removedWindowIds, [pendingTransaction.popupOrTabId.id])
	assert.ok((await getInterceptorErrorDiagnostics()).some((diagnostic) => diagnostic.code === 'request_resolution_retrying' && diagnostic.cause === reconnectError.message))

	// Once the website can be asked to reconnect, the retry leaves the undelivered reply queued for the reconnected page.
	browserMock.setTabMessageHandler(async () => undefined)
	await withSilencedConsole(waitForResolutionRetriesToFinish)
	assert.equal((await modules.getPendingTerminalReplies()).length, 1)
	assert.deepEqual(removedWindowIds, [pendingTransaction.popupOrTabId.id])
})

test('a reply posted without its delivered mark whose tab then closes is retired with its posted marker', async () => {
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	let failNextTerminalReplyWrite = false
	const recordingPort = createRecordingPort(postedMessages)
	// Posting the reply succeeds; the tab then closes and the delivered mark cannot be stored.
	const closingTabPort: browser.runtime.Port = {
		...recordingPort,
		postMessage(message: unknown) {
			recordingPort.postMessage(message)
			browserMock.setLiveTabIds([])
			failNextTerminalReplyWrite = true
		},
	}
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[modules.websiteSocketToString(socket)]: { port: closingTabPort, socket, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true },
	} }]])
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if (failNextTerminalReplyWrite && 'pendingTerminalReplies' in items) {
			failNextTerminalReplyWrite = false
			throw new Error('The delivered mark could not be stored.')
		}
		writeStoredItems()
	})

	try {
		await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
			method: 'popup_confirmDialog',
			data: { action: 'reject', errorString: undefined, uniqueRequestIdentifier },
		}))

		assert.equal(getRepliesToWebsite(postedMessages).length, 1)
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
		assert.deepEqual(await modules.getPendingTerminalReplies(), [])
		const { getResolutionBookkeepingSize } = await import('../../app/ts/background/requestResolution.js')
		const { getTerminalReplyBookkeepingSize } = await import('../../app/ts/background/terminalReplyDelivery.js')
		assert.equal(getResolutionBookkeepingSize() + getTerminalReplyBookkeepingSize(), 0, 'no bookkeeping is left')
	} finally {
		browserMock.setStorageSetHandler(undefined)
	}
})

// Rejects the pending transaction while its confirmation window cannot be closed, until the finishing runs out of retries: the reply is delivered and the request removed, and the committed reply is left owing its window update.
async function strandCommittedRejectionOnItsWindow(postedMessages: unknown[], websiteTabConnections: ReturnType<typeof connectRequestingWebsite>['websiteTabConnections']) {
	browserMock.setLiveWindowIds([pendingTransaction.popupOrTabId.id])
	browserMock.setWindowRemoveHandler(async () => { throw new Error(TAB_DRAG_ERROR_MESSAGE) })
	await withSilencedConsole(async () => {
		await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
			method: 'popup_confirmDialog',
			data: { action: 'reject', errorString: undefined, uniqueRequestIdentifier },
		})
		await waitForResolutionRetriesToFinish()
	})
	assert.equal(getRepliesToWebsite(postedMessages).length, 1)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual((await modules.getPendingTerminalReplies()).map((entry) => entry.confirmationWindow), [pendingTransaction.popupOrTabId])
	const removedWindowIds: number[] = []
	browserMock.setWindowRemoveHandler(async (windowId) => { removedWindowIds.push(windowId) })
	return removedWindowIds
}

test('the user closing the window of a committed reply whose window update ran out of retries finishes it', async () => {
	const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
	const removedWindowIds = await strandCommittedRejectionOnItsWindow(postedMessages, websiteTabConnections)

	await modules.onCloseWindowOrTab(pendingTransaction.popupOrTabId, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)

	assert.deepEqual(removedWindowIds, [pendingTransaction.popupOrTabId.id])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	assert.equal(getRepliesToWebsite(postedMessages).length, 1)
	await waitForResolutionRetriesToFinish()
})

test('a user action on a request whose committed reply ran out of retries for its window update finishes it', async () => {
	const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
	const removedWindowIds = await strandCommittedRejectionOnItsWindow(postedMessages, websiteTabConnections)

	await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	})

	assert.deepEqual(removedWindowIds, [pendingTransaction.popupOrTabId.id])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	const replies = getRepliesToWebsite(postedMessages)
	assert.equal(replies.length, 1, 'the accept never follows the delivered rejection')
	assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
	await waitForResolutionRetriesToFinish()
})

test('closing a tab before the simulation services exist still finishes its committed request, once they do', async () => {
	const { finishCommittedRequestsOfClosedTab } = await import('../../app/ts/background/requestResolution.js')
	// The closed tab's request and another tab's request share the confirmation window, so finishing must show the queue in it, the one step that needs the services.
	const otherTabRequest = { ...pendingTransaction, uniqueRequestIdentifier: { ...uniqueRequestIdentifier, requestId: 2, requestSocket: { ...uniqueRequestIdentifier.requestSocket, tabId: uniqueRequestIdentifier.requestSocket.tabId + 1 } } }
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [pendingTransaction, otherTabRequest] })
	await modules.queueTerminalReply({ ...pendingTransaction.originalRequestParameters, type: 'result' as const, error: { code: METAMASK_ERROR_USER_REJECTED_REQUEST, message: 'User denied transaction signature' }, uniqueRequestIdentifier })
	browserMock.setLiveTabIds([])
	browserMock.setLiveWindowIds([pendingTransaction.popupOrTabId.id])
	const removedWindowIds: number[] = []
	browserMock.setWindowRemoveHandler(async (windowId) => { removedWindowIds.push(windowId) })
	// As the background composes it (background-startup.ts): before the services exist the window refresh fails.
	let servicesExist = false
	let refreshes = 0
	const refreshConfirmationWindow = async () => {
		if (!servicesExist) throw new Error('Simulation services are not initialized, so the confirmation window cannot be refreshed yet')
		refreshes += 1
		return true
	}

	await withSilencedConsole(async () => await finishCommittedRequestsOfClosedTab(uniqueRequestIdentifier.requestSocket.tabId, { ...testResolutionContext(new Map()), refreshConfirmationWindow }))
	assert.deepEqual((await modules.getPendingTransactionsAndMessages()).map((pending) => pending.uniqueRequestIdentifier.requestId), [2], 'the closed tab\'s request is removed without the services')
	assert.deepEqual((await modules.getPendingTerminalReplies()).map((entry) => entry.confirmationWindow), [pendingTransaction.popupOrTabId], 'the window update is owed')

	servicesExist = true
	await withSilencedConsole(waitForResolutionRetriesToFinish)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	assert.equal(refreshes, 1, 'the window is refreshed once')
	assert.deepEqual(removedWindowIds, [], 'the window still shows the other tab\'s request')
	assert.deepEqual((await modules.getPendingTransactionsAndMessages()).map((pending) => pending.uniqueRequestIdentifier.requestId), [2])
})

// The resolutions that persist an outcome besides the stack (a Gnosis Safe proposal, a signer's result) and the reply each gives the website.
const outcomePersistingResolutions = [
	{
		name: 'adding a Gnosis Safe proposal to its stack',
		prepare: async () => {
			const { safeTxHash } = await storeSafeProposalRequest({ status: 'WaitingForUser' })
			return { data: { action: 'addToSafeStack' as const, uniqueRequestIdentifier }, result: modules.EthereumBytes32.serialize(safeTxHash) }
		},
	},
	{
		name: 'a Gnosis Safe owner signature',
		// Accepting a Gnosis Safe proposal again reviews it before taking the claim, so a reconnecting page finishing the request holds the claim instead.
		claimHolder: 'reconnecting page',
		prepare: async () => {
			await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeSimulationSignerAddress: safeTestOwnerAddress })])
			const { safeTx, safeTxHash } = await storeSafeProposalRequest({ status: 'WaitingForSigner' })
			const signature = await safeTestOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
			return { data: { action: 'signerIncluded' as const, signerReply: signature, uniqueRequestIdentifier }, result: modules.EthereumBytes32.serialize(safeTxHash) }
		},
	},
	{
		name: 'a signer\'s transaction hash',
		claimHolder: 'repeated accept',
		prepare: async () => {
			await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{ ...pendingTransaction, simulationMode: false, approvalStatus: { status: 'WaitingForSigner' } }] })
			const signerReply = modules.EthereumBytes32.serialize(signedTransaction.hash)
			return { data: { action: 'signerIncluded' as const, signerReply, uniqueRequestIdentifier }, result: signerReply }
		},
	},
] as const

const rejectRequest = async (websiteTabConnections: ReturnType<typeof connectRequestingWebsite>['websiteTabConnections']) => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
	method: 'popup_confirmDialog',
	data: { action: 'reject', errorString: undefined, uniqueRequestIdentifier },
})

// Nothing the resolution persists besides its reply: no Gnosis Safe proposal and no simulation stack entry.
async function assertNoOutcomePersisted() {
	assert.deepEqual((await modules.getSafeTransactionStacks()).flatMap((stack) => stack.transactions), [])
	assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
}

// Pauses the next storage read (or write) of the pending requests until resumed; resuming more than once is harmless.
function pauseNextPendingRequestsAccess(access: 'read' | 'write') {
	let signalPaused: (() => void) | undefined
	const paused = new Promise<void>((resolve) => { signalPaused = resolve })
	let resume: () => void = () => undefined
	const resumed = new Promise<void>((resolve) => { resume = resolve })
	let armed = true
	if (access === 'read') {
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			const items = readStoredItems()
			if (!armed || !Array.isArray(keys) || !keys.includes('pendingTransactionsAndMessages')) return items
			armed = false
			signalPaused?.()
			await resumed
			return items
		})
	} else {
		browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
			if (armed && 'pendingTransactionsAndMessages' in items) {
				armed = false
				signalPaused?.()
				await resumed
			}
			writeStoredItems()
		})
	}
	return { paused, resume: () => resume() }
}

const resolveRequest = async (websiteTabConnections: ReturnType<typeof connectRequestingWebsite>['websiteTabConnections'], data: TransactionConfirmationData) => await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data }))
type TransactionConfirmationData = Parameters<typeof modules.resolvePendingTransactionOrMessage>[3]['data']

// The website got exactly one reply, the success, and the request is cleaned up.
async function assertSettledOnceWithSuccess(postedMessages: readonly unknown[], result: string) {
	const replies = getRepliesToWebsite(postedMessages)
	assert.equal(replies.length, 1, 'exactly one reply')
	const [success] = replies
	if (!isRecord(success)) throw new Error('Missing reply to the website')
	assert.equal(success.result, result)
	assert.equal('error' in success, false)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
}

// A Gnosis Safe owner signature is stored with its proposal; an ordinary signer's result persists nothing besides its reply.
async function assertSignerOutcomePersisted(name: string, data: TransactionConfirmationData) {
	const storedSignatures = (await modules.getSafeTransactionStacks()).flatMap((stack) => stack.transactions.map((transaction) => transaction.signatures))
	if (name !== 'a Gnosis Safe owner signature') {
		assert.deepEqual(storedSignatures, [])
		return
	}
	if (data.action !== 'signerIncluded') throw new Error('Expected a signer result')
	assert.deepEqual(storedSignatures, [[{ signer: safeTestOwnerAddress, signature: data.signerReply }]])
}

const [addToSafeStackResolution, ...signerResults] = outcomePersistingResolutions

test(`a reject that wins while ${ addToSafeStackResolution.name } waits on its read of the request leaves it without effect`, async () => {
	const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
	const { data } = await addToSafeStackResolution.prepare()
	// Pauses the resolution right after it read the pending request, before it takes the request's claim.
	const { paused, resume } = pauseNextPendingRequestsAccess('read')
	try {
		const resolving = resolveRequest(websiteTabConnections, data)
		await paused
		assert.equal(await withSilencedConsole(async () => await rejectRequest(websiteTabConnections)), true)
		assert.deepEqual(await modules.getPendingTerminalReplies(), [])
		resume()
		assert.equal(await resolving, false)
	} finally {
		resume()
		browserMock.setStorageGetHandler(undefined)
	}

	const replies = getRepliesToWebsite(postedMessages)
	assert.equal(replies.length, 1, 'no second reply')
	const [rejection] = replies
	if (!isRecord(rejection) || !isRecord(rejection.error)) throw new Error('Missing rejection sent to the website')
	assert.equal(rejection.error.code, METAMASK_ERROR_USER_REJECTED_REQUEST)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	await assertNoOutcomePersisted()
})

for (const resolution of outcomePersistingResolutions) {
	test(`a reject after ${ resolution.name } completed does nothing`, async () => {
		const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
		const { data, result } = await resolution.prepare()
		assert.equal(await resolveRequest(websiteTabConnections, data), true)
		assert.equal(await withSilencedConsole(async () => await rejectRequest(websiteTabConnections)), false)
		await assertSettledOnceWithSuccess(postedMessages, result)
	})
}

for (const signerResult of signerResults) {
	test(`${ signerResult.name } after a completed reject does nothing`, async () => {
		const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
		const { data } = await signerResult.prepare()
		assert.equal(await withSilencedConsole(async () => await rejectRequest(websiteTabConnections)), true)
		assert.equal(await resolveRequest(websiteTabConnections, data), false)

		const replies = getRepliesToWebsite(postedMessages)
		assert.equal(replies.length, 1, 'no second reply')
		const [rejection] = replies
		if (!isRecord(rejection) || !isRecord(rejection.error)) throw new Error('Missing rejection sent to the website')
		assert.equal(rejection.error.code, METAMASK_ERROR_USER_REJECTED_REQUEST)
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
		assert.deepEqual(await modules.getPendingTerminalReplies(), [])
		await assertNoOutcomePersisted()
	})

	test(`a reject arriving while ${ signerResult.name } is settled is deferred, and the signer result, first to arrive, wins`, async () => {
		const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
		const { data, result } = await signerResult.prepare()
		// Pauses the settlement under the request's claim, at its first read of the pending request.
		const { paused, resume } = pauseNextPendingRequestsAccess('read')
		try {
			const settling = resolveRequest(websiteTabConnections, data)
			await paused
			assert.equal(await withSilencedConsole(async () => await rejectRequest(websiteTabConnections)), false, 'the reject is deferred to the claim\'s release')
			resume()
			assert.equal(await settling, true)
		} finally {
			resume()
			browserMock.setStorageGetHandler(undefined)
		}
		await withSilencedConsole(waitForResolutionRetriesToFinish)
		await assertSettledOnceWithSuccess(postedMessages, result)
	})

	test(`${ signerResult.name } arriving while a ${ signerResult.claimHolder } holds the request's claim is kept and settled once the claim is released`, async () => {
		const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
		const { data, result } = await signerResult.prepare()
		// A repeated accept forwards the request to the signer again under the request's claim, and pauses on storing that it waits for its signer; a reconnecting page's finishing pauses on reading the pending request.
		const { paused, resume } = pauseNextPendingRequestsAccess(signerResult.claimHolder === 'repeated accept' ? 'write' : 'read')
		try {
			const { resumeRequest } = await import('../../app/ts/background/requestResolution.js')
			const holding = signerResult.claimHolder === 'repeated accept'
				? resolveRequest(websiteTabConnections, { action: 'accept', uniqueRequestIdentifier })
				: resumeRequest(uniqueRequestIdentifier, { ...testResolutionContext(websiteTabConnections), automatic: true })
			await paused
			assert.equal(await resolveRequest(websiteTabConnections, data), false, 'the signer result waits for the claim')
			resume()
			await holding
		} finally {
			resume()
			browserMock.setStorageGetHandler(undefined)
			browserMock.setStorageSetHandler(undefined)
		}
		await withSilencedConsole(waitForResolutionRetriesToFinish)
		await assertSettledOnceWithSuccess(postedMessages, result)
	})

	for (const decline of ['reject', 'close'] as const) {
		test(`${ signerResult.name } whose committed-reply lookup fails once wins over a ${ decline } that arrives before the retry`, async () => {
			const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
			const { data, result } = await signerResult.prepare()
			browserMock.setLiveWindowIds([pendingTransaction.popupOrTabId.id])
			let failNextCommittedReplyLookup = true
			browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
				if (failNextCommittedReplyLookup && Array.isArray(keys) && keys.includes('pendingTerminalReplies')) {
					failNextCommittedReplyLookup = false
					throw new Error('The committed reply could not be read.')
				}
				return readStoredItems()
			})
			try {
				assert.equal(await resolveRequest(websiteTabConnections, data), undefined, 'the settlement is retried')
				if (decline === 'reject') await withSilencedConsole(async () => await rejectRequest(websiteTabConnections))
				else await withSilencedConsole(async () => await modules.onCloseWindowOrTab(pendingTransaction.popupOrTabId, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
				await withSilencedConsole(waitForResolutionRetriesToFinish)
			} finally {
				browserMock.setStorageGetHandler(undefined)
			}
			await assertSettledOnceWithSuccess(postedMessages, result)
			await assertSignerOutcomePersisted(signerResult.name, data)
		})
	}

	// Fails the next read of the committed replies once.
	const failNextCommittedReplyLookup = () => {
		let failing = true
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			if (failing && Array.isArray(keys) && keys.includes('pendingTerminalReplies')) {
				failing = false
				throw new Error('The committed reply could not be read.')
			}
			return readStoredItems()
		})
	}

	// The website got exactly one reply, the rejection, nothing the signer result stands for was persisted, and the request is cleaned up.
	const assertRejectedOnce = async (postedMessages: readonly unknown[]) => {
		const replies = getRepliesToWebsite(postedMessages)
		assert.equal(replies.length, 1, 'exactly one reply')
		const [rejection] = replies
		if (!isRecord(rejection) || !isRecord(rejection.error)) throw new Error('Missing rejection sent to the website')
		assert.equal(rejection.error.code, METAMASK_ERROR_USER_REJECTED_REQUEST)
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
		assert.deepEqual(await modules.getPendingTerminalReplies(), [])
		await assertNoOutcomePersisted()
	}

	test(`a decline stored before a restart wins over ${ signerResult.name } that arrives before startup recovery's retry`, async () => {
		const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
		const { data } = await signerResult.prepare()
		await modules.updateOwnedPendingRequestField(uniqueRequestIdentifier, 'resolutionInputs', async (pending) => ({ ...pending, resolutionInputs: [{ kind: 'decline' as const, reason: 'reject' as const }] }))
		browserMock.setLiveWindowIds([pendingTransaction.popupOrTabId.id])
		const { beginStartupRecovery, resumeCommittedRequests } = await import('../../app/ts/background/requestResolution.js')
		beginStartupRecovery()
		failNextCommittedReplyLookup()
		try {
			await assert.rejects(resumeCommittedRequests(testResolutionContext(websiteTabConnections)), /The committed reply could not be read/)
			// Arbitrated under the claim, the earlier decline wins and is delivered.
			await resolveRequest(websiteTabConnections, data)
			assert.equal(getRepliesToWebsite(postedMessages).length, 1)
			// Startup recovery's retry finds the request resolved.
			await withSilencedConsole(async () => await resumeCommittedRequests(testResolutionContext(websiteTabConnections)))
			await withSilencedConsole(waitForResolutionRetriesToFinish)
		} finally {
			browserMock.setStorageGetHandler(undefined)
		}
		await assertRejectedOnce(postedMessages)
	})

	test(`a decline stored before a restart wins over ${ signerResult.name } kept for its retry, even when startup recovery records the decline after it`, async () => {
		const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
		const { data } = await signerResult.prepare()
		await modules.updateOwnedPendingRequestField(uniqueRequestIdentifier, 'resolutionInputs', async (pending) => ({ ...pending, resolutionInputs: [{ kind: 'decline' as const, reason: 'reject' as const }] }))
		browserMock.setLiveWindowIds([pendingTransaction.popupOrTabId.id])
		const { beginStartupRecovery, resumeCommittedRequests } = await import('../../app/ts/background/requestResolution.js')
		beginStartupRecovery()
		failNextCommittedReplyLookup()
		try {
			assert.equal(await resolveRequest(websiteTabConnections, data), undefined, 'the signer result is kept for its retry')
			// Startup recovery runs before that retry and records the stored decline, later than the signer result.
			await withSilencedConsole(async () => await resumeCommittedRequests(testResolutionContext(websiteTabConnections)))
			await withSilencedConsole(waitForResolutionRetriesToFinish)
		} finally {
			browserMock.setStorageGetHandler(undefined)
		}
		await assertRejectedOnce(postedMessages)
	})

	test(`a reject of this session whose lookup failed still wins over ${ signerResult.name } that arrives after it`, async () => {
		const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
		const { data } = await signerResult.prepare()
		failNextCommittedReplyLookup()
		try {
			await withSilencedConsole(async () => await rejectRequest(websiteTabConnections))
			assert.deepEqual(getRepliesToWebsite(postedMessages), [], 'the reject is retried')
			await resolveRequest(websiteTabConnections, data)
			await withSilencedConsole(waitForResolutionRetriesToFinish)
		} finally {
			browserMock.setStorageGetHandler(undefined)
		}
		await assertRejectedOnce(postedMessages)
	})

	test(`${ signerResult.name } submitted again after a later reject keeps its first arrival and wins`, async () => {
		const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
		const { data, result } = await signerResult.prepare()
		try {
			failNextCommittedReplyLookup()
			assert.equal(await resolveRequest(websiteTabConnections, data), undefined, 'the signer result is kept for its retry')
			failNextCommittedReplyLookup()
			await withSilencedConsole(async () => await rejectRequest(websiteTabConnections))
			assert.deepEqual(getRepliesToWebsite(postedMessages), [], 'the reject is kept for its retry')
			// The signer answers again, as it does for a request forwarded to it twice.
			await resolveRequest(websiteTabConnections, data)
			await withSilencedConsole(waitForResolutionRetriesToFinish)
		} finally {
			browserMock.setStorageGetHandler(undefined)
		}
		await assertSettledOnceWithSuccess(postedMessages, result)
		await assertSignerOutcomePersisted(signerResult.name, data)
	})

	test(`${ signerResult.name } that arrived before a reject wins after a restart, from the stored order of the two`, async () => {
		const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
		const { data, result } = await signerResult.prepare()
		// Every committed-reply lookup fails before the restart: the signer result, then the reject, are stored and retried until their budget runs out.
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			if (Array.isArray(keys) && keys.includes('pendingTerminalReplies')) throw new Error('The committed reply could not be read.')
			return readStoredItems()
		})
		try {
			await resolveRequest(websiteTabConnections, data)
			await withSilencedConsole(async () => await rejectRequest(websiteTabConnections))
			await withSilencedConsole(waitForResolutionRetriesToFinish)
		} finally {
			browserMock.setStorageGetHandler(undefined)
		}
		assert.deepEqual(getRepliesToWebsite(postedMessages), [], 'nothing was answered before the restart')
		assert.deepEqual((await modules.getPendingTransactionsAndMessages())[0]?.resolutionInputs?.map((input) => input.kind), ['signerResult', 'decline'])

		// The restarted extension: a fresh resolution module, with nothing in memory, recovers from the saved storage.
		const restarted = await import(`../../app/ts/background/requestResolution.js?restart=${ encodeURIComponent(signerResult.name) }`)
		assert.notEqual(restarted.resumeRequest, (await import('../../app/ts/background/requestResolution.js')).resumeRequest, 'the restarted module is a fresh one')
		restarted.beginStartupRecovery()
		await withSilencedConsole(async () => await restarted.resumeCommittedRequests(testResolutionContext(websiteTabConnections)))
		await withSilencedConsole(waitForResolutionRetriesToFinish)
		assert.equal(restarted.getResolutionBookkeepingSize(), 0)
		await assertSettledOnceWithSuccess(postedMessages, result)
		await assertSignerOutcomePersisted(signerResult.name, data)
	})

	test(`${ signerResult.name } whose settlement throws wins over a later decline on the request's retry`, async () => {
		const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
		const { data, result } = await signerResult.prepare()
		if (data.action !== 'signerIncluded') throw new Error('Expected a signer result')
		const { declinePendingRequests, submitSignerResult } = await import('../../app/ts/background/requestResolution.js')
		// The first two settlements throw: the signer result's own, and the one the decline arbitrates; the request's retry settles it.
		let failedSettlements = 0
		const realContext = testResolutionContext(websiteTabConnections)
		const failingContext = {
			...realContext,
			settleSignerResult: async (...settlement: Parameters<typeof realContext.settleSignerResult>) => {
				if (failedSettlements < 2) {
					failedSettlements += 1
					throw new Error('The signer result could not be settled.')
				}
				return await realContext.settleSignerResult(...settlement)
			},
		}
		await withSilencedConsole(async () => {
			assert.equal(await submitSignerResult(uniqueRequestIdentifier, data.signerReply, failingContext), undefined)
			const [pending] = await modules.getPendingTransactionsAndMessages()
			if (pending === undefined) throw new Error('Missing pending request')
			await declinePendingRequests([pending], failingContext)
			assert.equal(failedSettlements, 2, 'the decline arbitrated the earlier signer result first')
			assert.deepEqual(getRepliesToWebsite(postedMessages), [], 'nothing was answered yet')
			await waitForResolutionRetriesToFinish()
		})
		await assertSettledOnceWithSuccess(postedMessages, result)
		await assertSignerOutcomePersisted(signerResult.name, data)
	})

	test(`${ signerResult.name } whose committed-reply lookup fails once is kept and settled by the request's retry`, async () => {
		const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
		const { data, result } = await signerResult.prepare()
		let failNextCommittedReplyLookup = true
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			if (failNextCommittedReplyLookup && Array.isArray(keys) && keys.includes('pendingTerminalReplies')) {
				failNextCommittedReplyLookup = false
				throw new Error('The committed reply could not be read.')
			}
			return readStoredItems()
		})
		try {
			assert.equal(await resolveRequest(websiteTabConnections, data), undefined, 'the settlement is retried')
			await withSilencedConsole(waitForResolutionRetriesToFinish)
		} finally {
			browserMock.setStorageGetHandler(undefined)
		}
		await assertSettledOnceWithSuccess(postedMessages, result)
	})
}

// The actions that resolve a request with an outcome of their own, each from its starting state.
const outcomeActions = [
	{ name: 'a simulated accept', prepare: async () => ({ action: 'accept' as const, uniqueRequestIdentifier }) },
	{
		name: 'adding a Gnosis Safe proposal to its stack',
		prepare: async () => {
			await storeSafeProposalRequest({ status: 'WaitingForUser' })
			return { action: 'addToSafeStack' as const, uniqueRequestIdentifier }
		},
	},
	{
		name: 'an accept that forwards to the signer',
		prepare: async () => {
			await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{ ...pendingTransaction, simulationMode: false, approvalStatus: { status: 'WaitingForUser' } }] })
			return { action: 'accept' as const, uniqueRequestIdentifier }
		},
	},
] as const

// The website got exactly one message, the rejection: nothing was forwarded to its signer, no Gnosis Safe proposal or simulation stack entry was persisted, and the request is cleaned up.
async function assertOnlyTheRejection(postedMessages: readonly unknown[]) {
	assert.equal(postedMessages.filter((message) => isRecord(message) && message.type === 'forwardToSigner').length, 0, 'nothing was forwarded to the signer')
	const replies = getRepliesToWebsite(postedMessages)
	assert.equal(replies.length, 1, 'exactly one reply')
	const [rejection] = replies
	if (!isRecord(rejection) || !isRecord(rejection.error)) throw new Error('Missing rejection sent to the website')
	assert.equal(rejection.error.code, METAMASK_ERROR_USER_REJECTED_REQUEST)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	await assertNoOutcomePersisted()
}

for (const outcomeAction of outcomeActions) {
	test(`${ outcomeAction.name } after a reject whose lookup failed is overruled by that reject`, async () => {
		const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
		const data = await outcomeAction.prepare()
		let failNextCommittedReplyLookup = true
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			if (failNextCommittedReplyLookup && Array.isArray(keys) && keys.includes('pendingTerminalReplies')) {
				failNextCommittedReplyLookup = false
				throw new Error('The committed reply could not be read.')
			}
			return readStoredItems()
		})
		try {
			await withSilencedConsole(async () => await rejectRequest(websiteTabConnections))
			assert.deepEqual((await modules.getPendingTransactionsAndMessages())[0]?.resolutionInputs, [{ kind: 'decline', reason: 'reject' }], 'the reject is stored and retried')
			await resolveRequest(websiteTabConnections, data)
			await withSilencedConsole(waitForResolutionRetriesToFinish)
		} finally {
			browserMock.setStorageGetHandler(undefined)
		}
		await assertOnlyTheRejection(postedMessages)
	})

	test(`${ outcomeAction.name } after a restart is overruled by the decline stored before it`, async () => {
		const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
		const data = await outcomeAction.prepare()
		await modules.updateOwnedPendingRequestField(uniqueRequestIdentifier, 'resolutionInputs', async (pending) => ({ ...pending, resolutionInputs: [{ kind: 'decline' as const, reason: 'reject' as const }] }))
		const { beginStartupRecovery } = await import('../../app/ts/background/requestResolution.js')
		beginStartupRecovery()
		await resolveRequest(websiteTabConnections, data)
		await withSilencedConsole(waitForResolutionRetriesToFinish)
		await assertOnlyTheRejection(postedMessages)
	})
}

// Pauses the claimed resolution at its first committed-reply lookup under the claim: the resolution reads the committed replies once before claiming, so the second read is the claim's.
function pauseTheClaimsCommittedReplyLookup() {
	let reads = 0
	let signalPaused: (() => void) | undefined
	const paused = new Promise<void>((resolve) => { signalPaused = resolve })
	let resume: () => void = () => undefined
	const resumed = new Promise<void>((resolve) => { resume = resolve })
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		const items = readStoredItems()
		if (!Array.isArray(keys) || !keys.includes('pendingTerminalReplies')) return items
		reads += 1
		if (reads !== 2) return items
		signalPaused?.()
		await resumed
		return items
	})
	return { paused, resume: () => resume() }
}

for (const outcomeAction of outcomeActions) {
	for (const decline of ['reject', 'close'] as const) {
		test(`a ${ decline } arriving while ${ outcomeAction.name } holds the claim comes after it`, async () => {
			const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
			const data = await outcomeAction.prepare()
			browserMock.setLiveWindowIds([pendingTransaction.popupOrTabId.id])
			const { paused, resume } = pauseTheClaimsCommittedReplyLookup()
			try {
				const acting = resolveRequest(websiteTabConnections, data)
				await paused
				const declining = decline === 'reject'
					? withSilencedConsole(async () => await rejectRequest(websiteTabConnections))
					: withSilencedConsole(async () => await modules.onCloseWindowOrTab(pendingTransaction.popupOrTabId, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
				if (decline === 'reject') assert.equal(await declining, false, 'the reject is deferred to the claim\'s release')
				resume()
				await acting
				await declining
				await withSilencedConsole(waitForResolutionRetriesToFinish)
			} finally {
				resume()
				browserMock.setStorageGetHandler(undefined)
			}
			const forwards = postedMessages.filter((message) => isRecord(message) && message.type === 'forwardToSigner')
			const replies = getRepliesToWebsite(postedMessages)
			assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
			assert.deepEqual(await modules.getPendingTerminalReplies(), [])
			const stackOperations = (await modules.getInterceptorTransactionStack()).operations
			const safeProposals = (await modules.getSafeTransactionStacks()).flatMap((stack) => stack.transactions)
			if (outcomeAction.name === 'an accept that forwards to the signer') {
				// A forward commits no reply: the request waits for its signer, so the later decline rejects it, after the forward.
				assert.equal(forwards.length, 1, 'the request was forwarded to its signer first')
				assert.equal(replies.length, 1)
				const [rejection] = replies
				if (!isRecord(rejection) || !isRecord(rejection.error)) throw new Error('Missing rejection sent to the website')
				assert.equal(rejection.error.code, METAMASK_ERROR_USER_REJECTED_REQUEST)
				assert.equal(postedMessages.indexOf(forwards[0]) < postedMessages.indexOf(rejection), true)
				assert.deepEqual(stackOperations, [])
				assert.deepEqual(safeProposals, [])
				return
			}
			assert.equal(replies.length, 1, 'exactly one reply, the action\'s success')
			const [success] = replies
			if (!isRecord(success)) throw new Error('Missing reply to the website')
			assert.equal('error' in success, false)
			if (outcomeAction.name === 'a simulated accept') {
				assert.equal(stackOperations.length, 1)
				const [stacked] = stackOperations
				if (stacked?.type !== 'Transaction') throw new Error('Missing stacked transaction')
				assert.equal(success.result, modules.EthereumBytes32.serialize(stacked.preSimulationTransaction.signedTransaction.hash))
				assert.deepEqual(safeProposals, [])
				return
			}
			assert.equal(safeProposals.length, 1)
			assert.equal(success.result, modules.EthereumBytes32.serialize(safeProposals[0]?.safeTxHash ?? 0n))
			assert.equal(stackOperations.filter((operation) => operation.type === 'Transaction' && operation.preSimulationTransaction.safeTransaction?.safeTxHash === safeProposals[0]?.safeTxHash).length, 1)
		})
	}
}

// A confirmation window refresh that read the pending request before an input was stored, and writes its refreshed copy after: the stored input must survive it.
for (const storedInput of ['signer result', 'decline'] as const) {
	for (const restart of [false, true]) {
		test(`a ${ storedInput } stored while a confirmation refresh overlaps it still decides the request${ restart ? ' after a restart' : '' }`, async () => {
			const { postedMessages, websiteTabConnections } = connectRequestingWebsite()
			const signerReply = modules.EthereumBytes32.serialize(signedTransaction.hash)
			if (storedInput === 'signer result') await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{ ...pendingTransaction, simulationMode: false, approvalStatus: { status: 'WaitingForSigner' } }] })
			// The refresh pauses right after reading the pending request; committed-reply lookups fail, once, or until the restart.
			let pauseNextPendingRead = true
			let signalPaused: (() => void) | undefined
			const paused = new Promise<void>((resolve) => { signalPaused = resolve })
			let resume: () => void = () => undefined
			const resumed = new Promise<void>((resolve) => { resume = resolve })
			let failingLookups = restart ? Number.POSITIVE_INFINITY : 1
			browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
				if (failingLookups > 0 && Array.isArray(keys) && keys.includes('pendingTerminalReplies')) {
					failingLookups -= 1
					throw new Error('The committed reply could not be read.')
				}
				const items = readStoredItems()
				if (!pauseNextPendingRead || !Array.isArray(keys) || !keys.includes('pendingTransactionsAndMessages')) return items
				pauseNextPendingRead = false
				signalPaused?.()
				await resumed
				return items
			})
			try {
				const refreshing = withSilencedConsole(async () => await modules.refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService, undefined))
				await paused
				if (storedInput === 'signer result') await resolveRequest(websiteTabConnections, { action: 'signerIncluded', signerReply, uniqueRequestIdentifier })
				else await withSilencedConsole(async () => await rejectRequest(websiteTabConnections))
				resume()
				await refreshing
				assert.deepEqual((await modules.getPendingTransactionsAndMessages())[0]?.resolutionInputs, [storedInput === 'signer result' ? { kind: 'signerResult', signerReply } : { kind: 'decline', reason: 'reject' }], 'the refresh kept the stored input')
				// A later reject comes after the stored signer result.
				if (storedInput === 'signer result') await withSilencedConsole(async () => await rejectRequest(websiteTabConnections))
				await withSilencedConsole(waitForResolutionRetriesToFinish)
			} finally {
				resume()
				browserMock.setStorageGetHandler(undefined)
			}
			if (restart) {
				assert.deepEqual(getRepliesToWebsite(postedMessages), [], 'nothing was answered before the restart')
				const restarted = await import(`../../app/ts/background/requestResolution.js?refresh-restart=${ encodeURIComponent(storedInput) }`)
				restarted.beginStartupRecovery()
				await withSilencedConsole(async () => await restarted.resumeCommittedRequests(testResolutionContext(websiteTabConnections)))
				await withSilencedConsole(waitForResolutionRetriesToFinish)
			}
			const replies = getRepliesToWebsite(postedMessages)
			assert.equal(replies.length, 1, 'exactly one reply')
			const [reply] = replies
			if (!isRecord(reply)) throw new Error('Missing reply to the website')
			if (storedInput === 'signer result') assert.equal(reply.result, signerReply)
			else assert.equal(isRecord(reply.error) ? reply.error.code : undefined, METAMASK_ERROR_USER_REJECTED_REQUEST)
			assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
			assert.deepEqual(await modules.getPendingTerminalReplies(), [])
		})
	}
}

await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
