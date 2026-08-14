import * as assert from 'assert'
import { test } from 'bun:test'
import { activeAddress, browserMock, createDisconnectedPort, createRecordingPort, isRecord, modules, pendingTransaction, signedTransaction, simulator, uniqueRequestIdentifier, waitForPendingTransactionsToClear, withSilencedConsole } from './confirmTransactionTestHarness.js'

test('failed signer delivery keeps the request and replaces the waiting spinner with a wallet-neutral error', async () => {
	await browser.storage.local.set({ simulationMode: false })
	const disconnectedPort = createDisconnectedPort()
	const socketKey = modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)
	const connectionCases = [
		{ connections: new Map(), expectedPostAttempts: 0, expectedPendingUpdates: 1 },
		{ connections: new Map([[uniqueRequestIdentifier.requestSocket.tabId, { connections: {
			[socketKey]: {
				port: disconnectedPort.port,
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://example.com',
				approved: true,
				approvedAddress: activeAddress + 1n,
				wantsToConnect: true,
			},
		} }]]), expectedPostAttempts: 0, expectedPendingUpdates: 1 },
		{ connections: new Map([[uniqueRequestIdentifier.requestSocket.tabId, { connections: {
			[socketKey]: {
				port: disconnectedPort.port,
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://example.com',
				approved: true,
				approvedAddress: activeAddress,
				wantsToConnect: true,
			},
		} }]]), expectedPostAttempts: 1, expectedPendingUpdates: 2 },
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
			data: { action: 'accept', uniqueRequestIdentifier, quarantineAccepted: false },
		})
		const retainedRequests = await modules.getPendingTransactionsAndMessages()
		const retainedRequest = retainedRequests[0]

		assert.equal(delivered, false)
		assert.equal(retainedRequests.length, 1)
		assert.equal(retainedRequest?.approvalStatus.status, 'SignerError')
		if (retainedRequest?.approvalStatus.status !== 'SignerError') throw new Error('missing signer delivery error')
		assert.match(retainedRequest.approvalStatus.message, /request reached your wallet/)
		const pendingUpdates = browserMock.sentMessages.filter((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions')
		assert.equal(pendingUpdates.length, connectionCase.expectedPendingUpdates)
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

await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
