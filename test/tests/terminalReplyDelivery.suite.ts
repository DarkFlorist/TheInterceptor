import * as assert from 'node:assert'
import { test } from 'bun:test'
import * as funtypes from 'funtypes'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import { flushMicrotasks, waitFor } from '../harness/async.js'
import { answerTabMessages, browserMock, createDisconnectedPort, createRecordingPort, createTabConnection, createWebsiteTabConnections, getSentPendingTransactionDialogUpdates, interceptStorageGet, interceptStorageSet, modules, openBrowserTargets, pendingTransaction, readStoredItem, requireWebsiteErrorReply, signedTransaction, simulator, uniqueRequestIdentifier, useManifestVersion, waitForPendingTransactionsToClear, withSilencedConsole } from './confirmTransactionTestHarness.js'
import { requireDefined } from '../harness/assertions.js'

const createUserRejectionReply = (requestIdentifier: typeof uniqueRequestIdentifier = uniqueRequestIdentifier) => ({
	...pendingTransaction.originalRequestParameters,
	type: 'result' as const,
	error: { code: 4001, message: 'User denied transaction signature' },
	uniqueRequestIdentifier: requestIdentifier,
})

const waitingForUserTransaction = { ...pendingTransaction, simulationMode: false, approvalStatus: { status: 'WaitingForUser' } } as const

const terminalReplyCases = () => [
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

const InterceptorErrorDiagnosticCodes = funtypes.ReadonlyArray(funtypes.ReadonlyObject({ code: funtypes.String }))

test('failed signer delivery keeps the request and replaces the waiting spinner with a wallet-neutral error', async () => {
	await browser.storage.local.set({ simulationMode: false })
	const disconnectedPort = createDisconnectedPort()
	const noConnections: WebsiteTabConnections = new Map()
	const connectionCases = [
		{ connections: noConnections, expectedPostAttempts: 0 },
		{ connections: createWebsiteTabConnections(disconnectedPort.port), expectedPostAttempts: 1 },
	]

	for (const connectionCase of connectionCases) {
		browserMock.calls.runtimeSendMessage.length = 0
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [waitingForUserTransaction] })

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
		const pendingUpdates = getSentPendingTransactionDialogUpdates()
		assert.equal(pendingUpdates.length, 2)
		const finalUpdatedRequest = requireDefined(pendingUpdates.at(-1)?.data.pendingTransactionAndSignableMessages[0], 'approval status in final popup update')
		assert.equal(finalUpdatedRequest.approvalStatus.status, 'SignerError')
		assert.equal(disconnectedPort.getPostAttempts(), connectionCase.expectedPostAttempts)
	}
})

test('reject and result replies remain durable after their pending request is removed', async () => {
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const disconnectedConnections: WebsiteTabConnections = new Map()

	for (const terminalReply of terminalReplyCases()) {
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [terminalReply.transaction] })
		assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, disconnectedConnections, terminalReply.confirmation), false, terminalReply.name)
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [], terminalReply.name)
		assert.equal((await modules.getPendingTerminalReplies()).length, 1, terminalReply.name)

		const websiteTabConnections = createWebsiteTabConnections(createRecordingPort((message) => { postedMessages.push(message) }).port)
		assert.equal(await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket), 1, terminalReply.name)
		assert.deepEqual(await modules.getPendingTerminalReplies(), [], terminalReply.name)
	}
	assert.equal(postedMessages.length, 2)
})

test('terminal replies are persisted before removing the pending rejection or result request', async () => {
	for (const terminalReply of terminalReplyCases()) {
		await browser.storage.local.remove('pendingTerminalReplies')
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [terminalReply.transaction] })
		const persistenceStarted = Promise.withResolvers<void>()
		const allowPersistence = Promise.withResolvers<void>()
		const restoreStorageSet = interceptStorageSet(async (items, writeStoredItems) => {
			if ('pendingTerminalReplies' in items) {
				persistenceStarted.resolve()
				await allowPersistence.promise
			}
			await writeStoredItems()
		})

		try {
			const resolution = modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, new Map(), terminalReply.confirmation)
			await persistenceStarted.promise
			assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1, terminalReply.name)
			allowPersistence.resolve()
			assert.equal(await resolution, false, terminalReply.name)
			assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [], terminalReply.name)
			assert.equal((await modules.getPendingTerminalReplies()).length, 1, terminalReply.name)
		} finally {
			restoreStorageSet()
		}
	}
})

test('MV2 popup close rejects its captured requests without deleting a concurrently appended request', async () => {
	const replacementPort = createRecordingPort()
	const disconnectedPort = createDisconnectedPort()
	const websiteTabConnections = createWebsiteTabConnections(disconnectedPort.port)
	const secondCapturedRequest = {
		...waitingForUserTransaction,
		uniqueRequestIdentifier: { ...uniqueRequestIdentifier, requestId: 2 },
		transactionIdentifier: 2n,
	} as const
	const concurrentlyAppendedRequest = {
		...secondCapturedRequest,
		popupOrTabId: { type: 'popup' as const, id: 2 },
		uniqueRequestIdentifier: { ...uniqueRequestIdentifier, requestId: 3 },
		transactionIdentifier: 3n,
	}
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [waitingForUserTransaction, secondCapturedRequest] })
	let reconnectRequests = 0
	const restoreManifestVersion = useManifestVersion(2)
	const restoreTabMessages = answerTabMessages(async () => {
		reconnectRequests += 1
		await modules.appendPendingTransactionOrMessage(concurrentlyAppendedRequest)
		websiteTabConnections.set(uniqueRequestIdentifier.requestSocket.tabId, createTabConnection(replacementPort.port))
		await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, uniqueRequestIdentifier.requestSocket)
		return { reconnected: true }
	})

	try {
		await modules.onCloseWindowOrTab({ type: 'popup', id: 1 }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
	} finally {
		restoreManifestVersion()
		restoreTabMessages()
	}

	const remainingRequests = await modules.getPendingTransactionsAndMessages()
	assert.deepEqual(remainingRequests.map((request) => request.uniqueRequestIdentifier.requestId), [3])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	assert.equal(disconnectedPort.getPostAttempts(), 1)
	assert.equal(reconnectRequests, 1)
	assert.equal(replacementPort.postedMessages.length, 2)
	for (const [index, message] of replacementPort.postedMessages.entries()) {
		const rejection = requireWebsiteErrorReply(message, 'dapp rejection after popup close')
		assert.equal(rejection.requestId, index + 1)
		assert.equal(rejection.method, 'eth_sendTransaction')
		assert.equal(rejection.error.code, 4001)
		assert.equal(rejection.error.message, 'User denied transaction signature')
	}
})

test('popup close keeps the pending request when durable rejection enqueue fails', async () => {
	const recordingPort = createRecordingPort()
	const websiteTabConnections = createWebsiteTabConnections(recordingPort.port)
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [waitingForUserTransaction] })
	let terminalReplyReadFailuresRemaining = 1
	const restoreStorageGet = interceptStorageGet(async (keys, readStoredItems) => {
		if (terminalReplyReadFailuresRemaining > 0 && Array.isArray(keys) && keys.includes('pendingTerminalReplies')) {
			terminalReplyReadFailuresRemaining -= 1
			throw new Error('storage temporarily unavailable')
		}
		return await readStoredItems()
	})

	await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: 1 }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
	assert.equal(recordingPort.postedMessages.length, 0)
	assert.equal(readStoredItem('pendingTerminalReplies'), undefined)

	restoreStorageGet()
	await waitForPendingTransactionsToClear()
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	assert.equal(recordingPort.postedMessages.length, 1)
	const rejection = requireWebsiteErrorReply(recordingPort.postedMessages[0], 'popup-close rejection after storage recovery')
	assert.equal(rejection.error.code, 4001)
})

test('popup close retries outbox cleanup without reposting after direct delivery', async () => {
	let failNextTerminalReplyRead = false
	const cleanupFailingPort = createRecordingPort(() => { failNextTerminalReplyRead = true })
	const websiteTabConnections = createWebsiteTabConnections(cleanupFailingPort.port)
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [waitingForUserTransaction] })
	const restoreStorageGet = interceptStorageGet(async (keys, readStoredItems) => {
		if (failNextTerminalReplyRead && Array.isArray(keys) && keys.includes('pendingTerminalReplies')) {
			failNextTerminalReplyRead = false
			throw new Error('storage cleanup temporarily unavailable')
		}
		return await readStoredItems()
	})

	await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: 1 }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	assert.equal(cleanupFailingPort.postedMessages.length, 1)
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
	assert.equal((await modules.getPendingTerminalReplies()).length, 1)

	await waitForPendingTransactionsToClear()
	assert.equal(cleanupFailingPort.postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	restoreStorageGet()
})

test('MV2 reconnect cleanup failure retries without reposting the rejection', async () => {
	const socket = uniqueRequestIdentifier.requestSocket
	const disconnectedPort = createDisconnectedPort()
	let failNextTerminalReplyRead = false
	const replacementPort = createRecordingPort(() => { failNextTerminalReplyRead = true })
	const websiteTabConnections = createWebsiteTabConnections(disconnectedPort.port)
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [waitingForUserTransaction] })
	const restoreManifestVersion = useManifestVersion(2)
	const restoreStorageGet = interceptStorageGet(async (keys, readStoredItems) => {
		if (failNextTerminalReplyRead && Array.isArray(keys) && keys.includes('pendingTerminalReplies')) {
			failNextTerminalReplyRead = false
			throw new Error('storage cleanup temporarily unavailable')
		}
		return await readStoredItems()
	})
	const restoreTabMessages = answerTabMessages(async () => {
		websiteTabConnections.set(socket.tabId, createTabConnection(replacementPort.port))
		await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket)
		return { reconnected: true }
	})

	try {
		await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: 1 }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
		assert.equal(replacementPort.postedMessages.length, 1)
		assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
		assert.equal((await modules.getPendingTerminalReplies()).length, 1)

		await waitForPendingTransactionsToClear()
		assert.equal(replacementPort.postedMessages.length, 1)
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
		assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	} finally {
		restoreManifestVersion()
		restoreStorageGet()
		restoreTabMessages()
	}
})

test('startup recovery rejects orphaned requests and preserves requests with live confirmation windows', async () => {
	const livePopupId = 2
	openBrowserTargets({ windows: [{ id: livePopupId, type: 'popup' }] })
	const recordingPort = createRecordingPort()
	const websiteTabConnections = createWebsiteTabConnections(recordingPort.port)
	const livePendingTransaction = {
		...pendingTransaction,
		popupOrTabId: { type: 'popup' as const, id: livePopupId },
		uniqueRequestIdentifier: { ...uniqueRequestIdentifier, requestId: uniqueRequestIdentifier.requestId + 1 },
	}
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [pendingTransaction, livePendingTransaction] })

	await modules.resolvePendingRequestsForMissingConfirmationWindows(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
	const remainingTransactions = await modules.getPendingTransactionsAndMessages()
	assert.deepEqual(remainingTransactions.map((transaction) => transaction.uniqueRequestIdentifier.requestId), [livePendingTransaction.uniqueRequestIdentifier.requestId])
	assert.equal(recordingPort.postedMessages.length, 1)
	const rejection = requireWebsiteErrorReply(recordingPort.postedMessages[0], 'startup orphan rejection')
	assert.equal(rejection.error.code, 4001)
})

test('startup recovery removes the unreachable rejection created for an orphaned request from a missing tab', async () => {
	// The fresh browser has neither the request's confirmation popup nor its website tab open.
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [pendingTransaction] })

	await modules.resolvePendingRequestsForMissingConfirmationWindows(simulator.ethereum, simulator.tokenPriceService, new Map())
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.equal((await modules.getPendingTerminalReplies()).length, 1)

	assert.equal(await modules.prunePendingTerminalRepliesForMissingTabs(), 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

test('popup-close rejection remains queued after reconnect timeout and flushes on the exact socket', async () => {
	const replacementPort = createRecordingPort()
	const disconnectedPort = createDisconnectedPort()
	const socket = uniqueRequestIdentifier.requestSocket
	const websiteTabConnections = createWebsiteTabConnections(disconnectedPort.port)
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [waitingForUserTransaction] })
	const restoreManifestVersion = useManifestVersion(2)
	const restoreTabMessages = answerTabMessages(async () => ({ reconnected: true }))

	try {
		// The content script claims to reconnect but never opens a replacement port, so closing the popup only finishes once the background's 1 s reconnect wait has expired.
		await modules.onCloseWindowOrTab({ type: 'popup', id: 1 }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
		await flushMicrotasks()
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
		assert.equal((await modules.getPendingTerminalReplies()).length, 1)
		assert.deepEqual(replacementPort.postedMessages, [])

		websiteTabConnections.set(socket.tabId, createTabConnection(replacementPort.port))
		assert.equal(await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket), 1)
		assert.deepEqual(await modules.getPendingTerminalReplies(), [])
		assert.equal(replacementPort.postedMessages.length, 1)
		const rejection = requireWebsiteErrorReply(replacementPort.postedMessages[0], 'queued popup-close rejection')
		assert.equal(rejection.requestId, uniqueRequestIdentifier.requestId)
		assert.equal(rejection.error.code, 4001)
	} finally {
		restoreManifestVersion()
		restoreTabMessages()
	}
})

test('same-request terminal reply producers coalesce into one delivery', async () => {
	const recordingPort = createRecordingPort()
	const websiteTabConnections = createWebsiteTabConnections(recordingPort.port)
	const terminalReply = createUserRejectionReply()

	assert.deepEqual(await Promise.all([
		modules.queueTerminalReplyAndAttemptDelivery(websiteTabConnections, terminalReply),
		modules.queueTerminalReplyAndAttemptDelivery(websiteTabConnections, terminalReply),
	]), [true, true])
	assert.equal(recordingPort.postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

test('socket flush overlapping terminal reply persistence delivers exactly once', async () => {
	const recordingPort = createRecordingPort()
	const socket = uniqueRequestIdentifier.requestSocket
	const websiteTabConnections: WebsiteTabConnections = new Map()
	const terminalReply = createUserRejectionReply()

	const production = modules.queueTerminalReplyAndAttemptDelivery(websiteTabConnections, terminalReply)
	websiteTabConnections.set(socket.tabId, createTabConnection(recordingPort.port))
	const flush = modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket)
	await Promise.all([production, flush])

	assert.equal(recordingPort.postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

test('socket flush during terminal reply queueing keeps the completion marker for the original delivery attempt', async () => {
	const recordingPort = createRecordingPort()
	const socket = uniqueRequestIdentifier.requestSocket
	const terminalReply = createUserRejectionReply()
	const websiteTabConnections = createWebsiteTabConnections(recordingPort.port)

	await modules.queueTerminalReply(terminalReply)
	assert.equal(await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket), 1)
	assert.equal(await modules.attemptQueuedTerminalReplyDelivery(websiteTabConnections, terminalReply), true)
	assert.equal(recordingPort.postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

test('corrupt terminal reply storage recovers and delivers the next rejection once', async () => {
	const recordingPort = createRecordingPort()
	const websiteTabConnections = createWebsiteTabConnections(recordingPort.port)
	const terminalReply = createUserRejectionReply()
	await browser.storage.local.set({ pendingTerminalReplies: { malformed: true }, popupRefreshGeneration: 17 })

	assert.equal(await withSilencedConsole(async () => await modules.queueTerminalReplyAndAttemptDelivery(websiteTabConnections, terminalReply)), true)

	assert.equal(recordingPort.postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	assert.equal(readStoredItem('popupRefreshGeneration'), 17)
	const diagnostics = InterceptorErrorDiagnosticCodes.parse(readStoredItem('interceptorErrorDiagnostics'))
	assert.equal(diagnostics.at(-1)?.code, 'pending_terminal_replies_corrupt')
})

test('connected socket retries a transient terminal reply storage read failure without another reconnect', async () => {
	const recordingPort = createRecordingPort()
	const socket = uniqueRequestIdentifier.requestSocket
	const terminalReply = createUserRejectionReply()
	await modules.queueTerminalReplyAndAttemptDelivery(new Map(), terminalReply)
	const storedReplyBeforeFailure = readStoredItem('pendingTerminalReplies')
	const websiteTabConnections = createWebsiteTabConnections(recordingPort.port)
	let storageFailuresRemaining = 1
	const restoreStorageGet = interceptStorageGet(async (_keys, readStoredItems) => {
		if (storageFailuresRemaining > 0) {
			storageFailuresRemaining -= 1
			throw new Error('storage temporarily unavailable')
		}
		return await readStoredItems()
	})

	assert.equal(await withSilencedConsole(async () => await modules.flushPendingTerminalRepliesForConnectedPortWithRetry(websiteTabConnections, socket, recordingPort.port)), 0)
	assert.deepEqual(readStoredItem('pendingTerminalReplies'), storedReplyBeforeFailure)
	assert.equal(recordingPort.postedMessages.length, 0)

	await waitFor(() => recordingPort.postedMessages.length > 0, { timeoutMs: 2_000, description: 'the connected socket terminal reply retry' })
	restoreStorageGet()
	assert.equal(recordingPort.postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

test('concurrent terminal reply flushes serialize storage reads and deliver once', async () => {
	const recordingPort = createRecordingPort()
	const socket = uniqueRequestIdentifier.requestSocket
	await modules.queueTerminalReplyAndAttemptDelivery(new Map(), createUserRejectionReply())
	const websiteTabConnections = createWebsiteTabConnections(recordingPort.port)
	let storageReadCount = 0
	const firstReadStarted = Promise.withResolvers<void>()
	const firstReadCanFinish = Promise.withResolvers<void>()
	const restoreStorageGet = interceptStorageGet(async (_keys, readStoredItems) => {
		storageReadCount += 1
		if (storageReadCount === 1) {
			firstReadStarted.resolve()
			await firstReadCanFinish.promise
		}
		return await readStoredItems()
	})

	const firstFlush = modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket)
	await firstReadStarted.promise
	const secondFlush = modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket)
	await flushMicrotasks()
	assert.equal(storageReadCount, 1)
	firstReadCanFinish.resolve()
	assert.deepEqual(await Promise.all([firstFlush, secondFlush]), [1, 0])

	restoreStorageGet()
	assert.equal(recordingPort.postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

test('startup pruning removes terminal replies for missing tabs and preserves live tabs', async () => {
	const liveTabId = uniqueRequestIdentifier.requestSocket.tabId + 1
	openBrowserTargets({ tabs: [{ id: liveTabId }] })
	const missingTabReply = createUserRejectionReply()
	const liveTabReply = createUserRejectionReply({
		requestId: uniqueRequestIdentifier.requestId + 1,
		requestSocket: { ...uniqueRequestIdentifier.requestSocket, tabId: liveTabId },
	})
	const noConnections: WebsiteTabConnections = new Map()
	await modules.queueTerminalReplyAndAttemptDelivery(noConnections, missingTabReply)
	await modules.queueTerminalReplyAndAttemptDelivery(noConnections, liveTabReply)
	await browser.storage.local.set({ popupRefreshGeneration: 23 })

	assert.equal(await modules.prunePendingTerminalRepliesForMissingTabs(), 1)
	const remainingReplies = await modules.getPendingTerminalReplies()
	assert.equal(remainingReplies.length, 1)
	assert.equal(remainingReplies[0]?.uniqueRequestIdentifier.requestSocket.tabId, liveTabId)
	assert.equal(readStoredItem('popupRefreshGeneration'), 23)
})
