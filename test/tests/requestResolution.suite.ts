import * as assert from 'assert'
import { test } from 'bun:test'
import { toPreSimulationTransaction } from '../../app/ts/simulation/services/simulationTransactionSigning.js'
import { addressString, browserMock, createReplayableAcceptConfirmation, isRecord, modules, simulator, testResolutionContext, withSilencedConsole } from './confirmTransactionTestHarness.js'
import { CONFIRMATION_WINDOW_ID, REQUEST_SOCKET, SENDER, WEBSITE, asOperation, assertNoResolutionBookkeeping, createWebsiteTabConnections, getPageResponses, getStackedTransactions, hashesOf, openConfirmation, pauseNextStackReadThen, readsKey, startSimulationStack, waitForCondition, waitUntilNothingPending, withoutReservations } from './simulationConfirmationTestHarness.js'

const pauseNextStackRead = () => {
	let signalPaused = () => undefined
	const paused = new Promise<void>((resolve) => { signalPaused = () => { resolve() } })
	let release = () => undefined
	const released = new Promise<void>((resolve) => { release = () => { resolve() } })
	let armed = true
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!armed || !Array.isArray(keys) || !keys.includes('interceptorTransactionStack')) return readStoredItems()
		armed = false
		signalPaused()
		await released
		return readStoredItems()
	})
	return { paused, release: () => { browserMock.setStorageGetHandler(undefined); release() } }
}

const pauseNextPendingWriteThen = () => {
	let signalPaused = () => undefined
	const paused = new Promise<void>((resolve) => { signalPaused = () => { resolve() } })
	let release: (fail: boolean) => void = () => undefined
	const released = new Promise<boolean>((resolve) => { release = resolve })
	let armed = true
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if (!armed || !Array.isArray(items.pendingTransactionsAndMessages) || items.pendingTransactionsAndMessages.length !== 0) return writeStoredItems()
		armed = false
		signalPaused()
		if (await released) throw new Error('transient pending request write failure')
		writeStoredItems()
	})
	return { paused, release: (fail: boolean) => { release(fail) } }
}

const failNextPendingWrite = () => {
	let armed = true
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if (!armed || !('pendingTransactionsAndMessages' in items)) return writeStoredItems()
		armed = false
		throw new Error('transient pending request write failure')
	})
}

const rejectRequest = async (request: Awaited<ReturnType<typeof openConfirmation>>, websiteTabConnections: ReturnType<typeof createWebsiteTabConnections>) => await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'reject', uniqueRequestIdentifier: request } }))

const recoverAfterRestart = async (requestId: number, operation: Parameters<typeof asOperation>[0] | { readonly type: 'Message', readonly signedMessageTransaction: unknown }, queuedResult: bigint | string | undefined, websiteTabConnections: ReturnType<typeof createWebsiteTabConnections>) => {
	await modules.updateInterceptorTransactionStack((stack) => ({ operations: [...stack.operations, 'signedMessageTransaction' in operation ? operation : asOperation(operation)] }))
	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending === undefined) throw new Error('Expected the pending request')
	if (queuedResult !== undefined) {
		const { commitPendingTerminalReply } = await import('../../app/ts/background/pendingTerminalReplies.js')
		await commitPendingTerminalReply({ ...pending.originalRequestParameters, type: 'result', result: queuedResult, uniqueRequestIdentifier: { requestId, requestSocket: REQUEST_SOCKET } })
	}
	browserMock.setLiveWindowIds([])
	await withSilencedConsole(async () => await modules.resolvePendingRequestsForMissingConfirmationWindows(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	await waitUntilNothingPending()
}

const openMessageConfirmation = async (websiteTabConnections: ReturnType<typeof createWebsiteTabConnections>) => {
	const signRequest = (await import('../../app/ts/types/jsonRpc-signing-types.js')).PersonalSignParams.parse({ method: 'personal_sign', params: ['0x68656c6c6f', addressString(SENDER)] })
	const uniqueRequestIdentifier = { requestId: 1, requestSocket: REQUEST_SOCKET }
	const opened = await withSilencedConsole(async () => await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, { interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier, ...signRequest }, { kind: 'message', parameters: signRequest }, true, SENDER, WEBSITE, websiteTabConnections))
	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending?.type !== 'SignableMessage' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error(`Expected a simulated pending message, got ${ JSON.stringify(opened) }`)
	const { simulatePersonalSign } = await import('../../app/ts/simulation/services/simulationPersonalSigning.js')
	const signature = (await simulatePersonalSign(pending.originalRequestParameters, pending.signedMessageTransaction.fakeSignedFor)).signature
	return { operation: { type: 'Message' as const, signedMessageTransaction: pending.signedMessageTransaction }, signature }
}

const seedCommittedReply = async (requestId: number, result: { readonly result: unknown } | { readonly error: { readonly code: number, readonly message: string } }) => {
	const pendingRequests = await modules.getPendingTransactionsAndMessages()
	const [pending] = pendingRequests
	if (pending === undefined) throw new Error('Expected the pending request')
	const { commitPendingTerminalReply } = await import('../../app/ts/background/pendingTerminalReplies.js')
	await commitPendingTerminalReply({ ...pending.originalRequestParameters, type: 'result', ...result, uniqueRequestIdentifier: { requestId, requestSocket: REQUEST_SOCKET }, confirmationWindow: pending.popupOrTabId })
}

const getAllPageResponses = (postedMessages: readonly unknown[], requestId: number) => postedMessages.flatMap((message) => isRecord(message) && message.requestId === requestId && ('result' in message || 'error' in message) ? [isRecord(message.error) ? { error: message.error.code } : { result: message.result }] : [])

const getStackedMessages = async () => (await modules.getInterceptorTransactionStack()).operations.filter((operation) => operation.type === 'Message')

const restartStates = [
	{ boundary: 'the commitment write', entry: 'none', pending: true, windowPending: false },
	{ boundary: 'the delivery', entry: 'undelivered', pending: true, windowPending: true },
	{ boundary: 'the pending request removal', entry: 'delivered', pending: true, windowPending: true },
	{ boundary: 'the window update', entry: 'delivered', pending: false, windowPending: true },
	{ boundary: 'the entry delete', entry: 'delivered', pending: false, windowPending: false },
] as const

const countingClosedWindows = async (run: () => Promise<void>) => {
	const windows = Reflect.get(globalThis, 'browser').windows
	const removeWindow = windows.remove
	const removedWindows: number[] = []
	windows.remove = async (windowId: number) => { removedWindows.push(windowId); return await removeWindow(windowId) }
	try {
		await run()
	} finally {
		windows.remove = removeWindow
	}
	return removedWindows
}

const collectingUnhandledRejections = async (run: () => Promise<void>) => {
	const rejections: unknown[] = []
	const onUnhandledRejection = (reason: unknown) => { rejections.push(reason) }
	process.on('unhandledRejection', onUnhandledRejection)
	try {
		await run()
		await new Promise((resolve) => setTimeout(resolve, 20))
	} finally {
		process.off('unhandledRejection', onUnhandledRejection)
	}
	return rejections
}

const scheduledRetryFailures = [
	{ step: 'its committed reply lookup', fails: (kind: 'get' | 'set', items: unknown) => kind === 'get' && readsKey(items, 'pendingTerminalReplies') },
	{ step: 'its pending request lookup', fails: (kind: 'get' | 'set', items: unknown) => kind === 'get' && readsKey(items, 'pendingTransactionsAndMessages') },
	{ step: 'deleting its delivered reply', fails: (kind: 'get' | 'set', items: unknown) => kind === 'set' && isRecord(items) && Array.isArray(items.pendingTerminalReplies) && items.pendingTerminalReplies.length === 0 },
] as const

const failingFirstWindowRemoval = async (run: () => Promise<void>) => {
	const windows = Reflect.get(globalThis, 'browser').windows
	const removeWindow = windows.remove
	const removalAttempts: number[] = []
	windows.remove = async (windowId: number) => {
		removalAttempts.push(windowId)
		if (removalAttempts.length === 1) throw new Error('transient window removal failure')
		return await removeWindow(windowId)
	}
	try {
		await run()
	} finally {
		windows.remove = removeWindow
	}
	return removalAttempts
}

const seedCommittedRejection = async (options: { readonly delivered: boolean, readonly withWindow: boolean }) => {
	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending === undefined) throw new Error('Expected the pending request')
	const { commitPendingTerminalReply, markPendingTerminalReplyDelivered } = await import('../../app/ts/background/pendingTerminalReplies.js')
	await commitPendingTerminalReply({ ...pending.originalRequestParameters, type: 'result', error: { code: 4001, message: 'User denied transaction signature' }, uniqueRequestIdentifier: pending.uniqueRequestIdentifier, ...(options.withWindow ? { confirmationWindow: pending.popupOrTabId } : {}) })
	if (options.delivered) await markPendingTerminalReplyDelivered(pending.uniqueRequestIdentifier)
}

const withBrowserWindows = async (hooks: { readonly beforeCreate?: (attempt: number) => Promise<void>, readonly beforeRemove?: (windowId: number) => Promise<void> }, run: (state: { readonly liveWindows: () => readonly number[], readonly createdWindows: () => readonly number[] }) => Promise<void>) => {
	const windows = Reflect.get(globalThis, 'browser').windows
	const { create: createWindow, remove: removeWindow } = windows
	let liveWindows = [CONFIRMATION_WINDOW_ID]
	const createdWindows: number[] = []
	let createAttempts = 0
	windows.create = async () => {
		createAttempts += 1
		await hooks.beforeCreate?.(createAttempts)
		const windowId = CONFIRMATION_WINDOW_ID + 1 + createdWindows.length
		createdWindows.push(windowId)
		liveWindows = [...liveWindows, windowId]
		browserMock.setLiveWindowIds(liveWindows)
		return { id: windowId }
	}
	windows.remove = async (windowId: number) => {
		await hooks.beforeRemove?.(windowId)
		liveWindows = liveWindows.filter((id) => id !== windowId)
		browserMock.setLiveWindowIds(liveWindows)
	}
	try {
		await run({ liveWindows: () => liveWindows, createdWindows: () => createdWindows })
	} finally {
		windows.create = createWindow
		windows.remove = removeWindow
	}
}

const createGate = () => {
	let signalReached = () => undefined
	const reached = new Promise<void>((resolve) => { signalReached = () => { resolve() } })
	let open = () => undefined
	const opened = new Promise<void>((resolve) => { open = () => { resolve() } })
	return { reached, open, pass: async () => { signalReached(); await opened } }
}

const pausingRegistrationAfterWindowPick = (gate: ReturnType<typeof createGate>) => {
	const windows = Reflect.get(globalThis, 'browser').windows
	const getWindow = windows.get
	let pickedWindow = false
	windows.get = async (windowId: number) => {
		const window = await getWindow(windowId)
		pickedWindow = true
		return window
	}
	let armed = true
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!pickedWindow || !armed || !readsKey(keys, 'pendingTransactionsAndMessages')) return readStoredItems()
		armed = false
		await gate.pass()
		return readStoredItems()
	})
	return () => {
		windows.get = getWindow
		browserMock.setStorageGetHandler(undefined)
	}
}

const failingCommittedReplyRead = (failingRead: number) => {
	let reads = 0
	let failed = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
		reads += 1
		if (reads !== failingRead) return readStoredItems()
		failed += 1
		throw new Error('transient committed reply read failure')
	})
	return () => failed
}

const waitForNoResolutionBookkeeping = async () => await withSilencedConsole(async () => await waitForCondition(async () => {
	const { getResolutionActivitySize } = await import('../../app/ts/background/requestResolutionState.js')
	const { getTerminalReplyBookkeepingSize } = await import('../../app/ts/background/terminalReplyDelivery.js')
	return getResolutionActivitySize() + getTerminalReplyBookkeepingSize() === 0
}))

const waitForNoResolutionBookkeepingWhileFailing = async () => {
	const { getResolutionActivitySize } = await import('../../app/ts/background/requestResolutionState.js')
	const deadline = Date.now() + 10_000
	while (getResolutionActivitySize() > 0) {
		if (Date.now() > deadline) throw new Error('The retries did not stop')
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
}

for (const competitor of ['reject', 'popup close'] as const) {
	test(`lets an accept paused while it allocates win over a ${ competitor }, so the stack and the page agree`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		await withoutReservations([1])
		const pause = pauseNextStackRead()
		const accepting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createReplayableAcceptConfirmation(request)))
		await pause.paused
		try {
			const competing = competitor === 'reject'
				? await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'reject', uniqueRequestIdentifier: request } }))
				: await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
			if (competitor === 'reject') assert.equal(competing, false, 'the reject loses to the claimed accept')
		} finally {
			pause.release()
			await accepting
		}
		const stacked = await getStackedTransactions()
		assert.equal(stacked.length, 1)
		assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ result: stacked[0]?.signedTransaction.hash }], 'the page gets only the accepted hash')
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	})
}

test('stacks nothing for an accept that comes after a reject resolved the request', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'reject', uniqueRequestIdentifier: request } }))
	const accepted = await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createReplayableAcceptConfirmation(request)))
	assert.notEqual(accepted, true)
	assert.deepEqual(await getStackedTransactions(), [])
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'the page gets only the rejection')
})

test('lets a reject that claimed the request first win over an accept that starts while it replies', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const resolve = (action: 'accept' | 'reject') => withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action, uniqueRequestIdentifier: request } }))
	const outcomes = await Promise.allSettled([resolve('reject'), resolve('accept')])
	assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'fulfilled'])
	assert.deepEqual(await getStackedTransactions(), [])
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
})

test('delivers the accepted hash, never a rejection, when the removal after stacking fails behind a popup close', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const pause = pauseNextPendingWriteThen()
	const accepting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createReplayableAcceptConfirmation(request))).then(() => undefined, () => undefined)
	await pause.paused
	try {
		assert.equal((await getStackedTransactions()).length, 1, 'the accept stacked the transaction before removing the request')
		await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	} finally {
		pause.release(true)
	}
	await accepting
	browserMock.setStorageSetHandler(undefined)
	await waitUntilNothingPending()
	const stacked = await getStackedTransactions()
	assert.equal(stacked.length, 1)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ result: stacked[0]?.signedTransaction.hash }], 'the page gets exactly the stacked hash')
})

test('rejects a request once when the removal after a deferred close\'s rejection fails and is retried', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const pause = pauseNextStackReadThen()
	const accepting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createReplayableAcceptConfirmation(request))).then(() => undefined, () => undefined)
	await pause.paused
	try {
		await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
		failNextPendingWrite()
	} finally {
		pause.release(true)
	}
	await withSilencedConsole(async () => {
		await accepting
		await waitUntilNothingPending()
	})
	browserMock.setStorageSetHandler(undefined)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'the retry sends no second rejection')
	assert.deepEqual(await getStackedTransactions(), [])
})

test('rejects a request once when a reject\'s removal fails and a popup close follows', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	failNextPendingWrite()
	await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'reject', uniqueRequestIdentifier: request } })).then(() => undefined, () => undefined)
	browserMock.setStorageSetHandler(undefined)
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1, 'the failed removal left the request pending')
	await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	await waitUntilNothingPending()
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
})

test('answers a popup close with the stacked hash when the request\'s transaction is already stacked but no reply was committed', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected a simulated pending transaction')
	// As an accept leaves it that stacked the transaction and stopped before committing its reply, or one whose commitment a restart lost.
	const stackedTransaction = toPreSimulationTransaction(pending.transactionToSimulate, pending.simulationHashReservation)
	await modules.updateInterceptorTransactionStack(() => ({ operations: [asOperation(stackedTransaction)] }))
	await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	await waitUntilNothingPending()
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ result: stackedTransaction.signedTransaction.hash }])
})

test('delivers a rejection once and closes the window when a read after removing the request fails', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	let removed = false
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		writeStoredItems()
		if (Array.isArray(items.pendingTransactionsAndMessages) && items.pendingTransactionsAndMessages.length === 0) removed = true
	})
	let failedViewReads = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!removed || failedViewReads > 0 || !readsKey(keys, 'pendingTransactionsAndMessages')) return readStoredItems()
		failedViewReads += 1
		throw new Error('transient pending request read failure')
	})
	const closedWindows = await countingClosedWindows(async () => {
		await rejectRequest(request, websiteTabConnections)
		await new Promise((resolve) => setTimeout(resolve, 200))
	})
	browserMock.setStorageSetHandler(undefined)
	browserMock.setStorageGetHandler(undefined)
	assert.equal(failedViewReads, 1, 'a read after the removal failed')
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'the rejection is delivered once')
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(closedWindows, [CONFIRMATION_WINDOW_ID], 'the window closes')
	await assertNoResolutionBookkeeping()
})

test('retries closing the confirmation window when removing it fails, delivering the reply once', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const windows = Reflect.get(globalThis, 'browser').windows
	const removeWindow = windows.remove
	const removalAttempts: number[] = []
	windows.remove = async (windowId: number) => {
		removalAttempts.push(windowId)
		if (removalAttempts.length === 1) throw new Error('transient window removal failure')
		return await removeWindow(windowId)
	}
	try {
		await withSilencedConsole(async () => {
			await rejectRequest(request, websiteTabConnections)
			await waitForCondition(async () => removalAttempts.length === 2 && (await modules.getPendingTerminalReplies()).length === 0)
		})
	} finally {
		windows.remove = removeWindow
	}
	assert.deepEqual(removalAttempts, [CONFIRMATION_WINDOW_ID, CONFIRMATION_WINDOW_ID], 'the failed removal is retried')
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'the page settles once')
	await assertNoResolutionBookkeeping()
})

test('retries moving the confirmation window to the next request when that update fails', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	await openConfirmation(2, SENDER, 2n, websiteTabConnections)
	// The view update reads the block number; it fails once after the first request is removed.
	let removed = false
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		writeStoredItems()
		if (Array.isArray(items.pendingTransactionsAndMessages) && items.pendingTransactionsAndMessages.length === 1) removed = true
	})
	const getBlockNumber = simulator.ethereum.getBlockNumber
	let failedViewUpdates = 0
	simulator.ethereum.getBlockNumber = async (...args: Parameters<typeof getBlockNumber>) => {
		if (removed && failedViewUpdates === 0) {
			failedViewUpdates += 1
			throw new Error('transient block number failure')
		}
		return await getBlockNumber.apply(simulator.ethereum, args)
	}
	browserMock.sentMessages.length = 0
	try {
		await withSilencedConsole(async () => {
			await rejectRequest(request, websiteTabConnections)
			await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
		})
	} finally {
		simulator.ethereum.getBlockNumber = getBlockNumber
		browserMock.setStorageSetHandler(undefined)
	}
	assert.equal(failedViewUpdates, 1)
	assert.ok(browserMock.sentMessages.some((message) => message.method === 'popup_update_confirm_transaction_dialog'), 'the window moves to the next request')
	assert.deepEqual((await modules.getPendingTransactionsAndMessages()).map((pending) => pending.uniqueRequestIdentifier.requestId), [2])
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
	await assertNoResolutionBookkeeping()
})

for (const flushFirst of [true, false]) {
	test(`closes the live window of a request whose reply was queued before windows were stored, at startup, flushing ${ flushFirst ? 'before' : 'after' }`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		const [pending] = await modules.getPendingTransactionsAndMessages()
		if (pending === undefined) throw new Error('Expected the pending request')
		const { commitPendingTerminalReply } = await import('../../app/ts/background/pendingTerminalReplies.js')
		await commitPendingTerminalReply({ ...pending.originalRequestParameters, type: 'result', error: { code: 4001, message: 'User denied transaction signature' }, uniqueRequestIdentifier: pending.uniqueRequestIdentifier })
		const { beginStartupRecovery, resumeCommittedRequests } = await import('../../app/ts/background/requestResolution.js')
	beginStartupRecovery()
		const closedWindows = await countingClosedWindows(async () => {
			if (flushFirst) await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, REQUEST_SOCKET)
			await withSilencedConsole(async () => await resumeCommittedRequests(testResolutionContext(websiteTabConnections)))
			if (!flushFirst) await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, REQUEST_SOCKET)
		})
		assert.deepEqual(closedWindows, [CONFIRMATION_WINDOW_ID], 'the live window closes')
		assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
		assert.deepEqual(await modules.getPendingTerminalReplies(), [])
		await assertNoResolutionBookkeeping()
	})
}

test('closes the live window of a request whose reply was queued before windows were stored after a restart interrupts its cleanup', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending === undefined) throw new Error('Expected the pending request')
	const { commitPendingTerminalReply } = await import('../../app/ts/background/pendingTerminalReplies.js')
	await commitPendingTerminalReply({ ...pending.originalRequestParameters, type: 'result', error: { code: 4001, message: 'User denied transaction signature' }, uniqueRequestIdentifier: pending.uniqueRequestIdentifier })
	const { beginStartupRecovery, resumeCommittedRequests } = await import('../../app/ts/background/requestResolution.js')
	beginStartupRecovery()
	// The first startup removes the request but cannot close the window, until its retries give up.
	const windows = Reflect.get(globalThis, 'browser').windows
	const removeWindow = windows.remove
	windows.remove = async () => { throw new Error('window removal unavailable') }
	try {
		await withSilencedConsole(async () => {
			await resumeCommittedRequests(testResolutionContext(websiteTabConnections))
			await new Promise((resolve) => setTimeout(resolve, 2_000))
		})
	} finally {
		windows.remove = removeWindow
	}
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [], 'the request was removed')
	assert.equal((await modules.getPendingTerminalReplies())[0]?.confirmationWindow?.id, CONFIRMATION_WINDOW_ID, 'its window is kept with the reply')
	await assertNoResolutionBookkeeping()

	beginStartupRecovery()
	const closedWindows = await countingClosedWindows(async () => await withSilencedConsole(async () => await resumeCommittedRequests(testResolutionContext(websiteTabConnections))))
	assert.deepEqual(closedWindows, [CONFIRMATION_WINDOW_ID], 'the next startup closes it')
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	await assertNoResolutionBookkeeping()
})

test('delivers a rejection once when cleaning up the delivered reply\'s queue entry fails', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	let failQueueRead = false
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!failQueueRead || !readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
		failQueueRead = false
		throw new Error('transient terminal reply queue read failure')
	})
	// The page receives the reply, and the delivery then fails to remove it from the durable queue.
	const connection = websiteTabConnections.get(REQUEST_SOCKET.tabId)?.connections[modules.websiteSocketToString(REQUEST_SOCKET)]
	if (connection === undefined) throw new Error('missing connection')
	const port = connection.port
	connection.port = { ...port, postMessage(message: unknown) { port.postMessage(message); failQueueRead = true } }
	await rejectRequest(request, websiteTabConnections)
	await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
	browserMock.setStorageGetHandler(undefined)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'the retry does not repost it')
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

test('retries a popup close whose commitment write failed while the page was disconnected, and delivers it once the page reconnects', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	let failedCommits = 0
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if (failedCommits > 0 || !('pendingTerminalReplies' in items)) return writeStoredItems()
		failedCommits += 1
		throw new Error('transient terminal reply queue write failure')
	})
	await withSilencedConsole(async () => {
		await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, new Map())
		await waitUntilNothingPending()
	})
	browserMock.setStorageSetHandler(undefined)
	assert.equal(failedCommits, 1)
	assert.equal((await modules.getPendingTerminalReplies()).length, 1, 'the retried commitment keeps the reply durably')
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [])
	await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, REQUEST_SOCKET)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'the reconnected page gets it once')
	assert.deepEqual(await modules.getPendingTerminalReplies(), [], 'the delivered reply of a finished request is deleted')
})

test('stops retrying a resolution whose removal keeps failing while the page is disconnected, keeps its queued reply, and finishes it on a later close', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	let failedRemovals = 0
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		const pending = items.pendingTransactionsAndMessages
		if (!Array.isArray(pending) || pending.length > 0) return writeStoredItems()
		failedRemovals += 1
		throw new Error('persistent pending request removal failure')
	})
	await rejectRequest(request, new Map())
	await withSilencedConsole(async () => await new Promise((resolve) => setTimeout(resolve, 2_000)))
	const removalsWhenGivenUp = failedRemovals
	assert.equal(removalsWhenGivenUp, 6, 'the first attempt and five retries')
	await new Promise((resolve) => setTimeout(resolve, 500))
	assert.equal(failedRemovals, removalsWhenGivenUp, 'no more retries')
	browserMock.setStorageSetHandler(undefined)
	assert.equal((await modules.getPendingTerminalReplies()).length, 1, 'the undelivered reply stays queued')
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1, 'the committed request stays pending')

	await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	await waitUntilNothingPending()
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'the close finishes the committed rejection, once')
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

test('delivers a reply once when its delivery throws before posting and a reconnect flush runs during the retry\'s backoff', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	// The delivery's lookup of the page's connection throws once, before anything is posted.
	const getConnection = websiteTabConnections.get.bind(websiteTabConnections)
	let failNextLookup = false
	websiteTabConnections.get = (tabId: number) => {
		if (!failNextLookup) return getConnection(tabId)
		failNextLookup = false
		throw new Error('transient connection lookup failure')
	}
	// Armed when the rejection is committed, so the failing lookup is its delivery's.
	let committed = false
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		writeStoredItems()
		if (!committed && 'pendingTerminalReplies' in items) {
			committed = true
			failNextLookup = true
		}
	})
	await rejectRequest(request, websiteTabConnections)
	browserMock.setStorageSetHandler(undefined)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [], 'the delivery failed before posting')
	await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, REQUEST_SOCKET)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'the reconnect flush delivers it')
	await new Promise((resolve) => setTimeout(resolve, 300))
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'the scheduled retry does not deliver it again')
})

test('finishes an accepted transaction\'s queued reply on recovery after a restart, never rejecting it', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected a simulated pending transaction')
	const stacked = toPreSimulationTransaction(pending.transactionToSimulate, pending.simulationHashReservation)
	await recoverAfterRestart(1, stacked, stacked.signedTransaction.hash, websiteTabConnections)
	assert.deepEqual(getPageResponses(postedMessages, 1), [{ result: stacked.signedTransaction.hash }])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

for (const queued of [true, false]) {
	test(`answers an accepted message with its signature on recovery after a restart, never a rejection, when its reply ${ queued ? 'was queued' : 'was lost' }`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const { operation, signature } = await openMessageConfirmation(websiteTabConnections)
		await recoverAfterRestart(1, operation, queued ? signature : undefined, websiteTabConnections)
		const responses = postedMessages.flatMap((message) => isRecord(message) && message.requestId === 1 && ('result' in message || 'error' in message) ? [isRecord(message.error) ? { error: message.error.code } : { result: message.result }] : [])
		assert.deepEqual(responses, [{ result: signature }])
		assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	})
}

for (const action of ['accept', 'reject', 'close'] as const) {
	test(`only finishes a committed message rejection that a reconnect flush delivered after a restart, on a later ${ action }`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		await openMessageConfirmation(websiteTabConnections)
		await seedCommittedReply(1, { error: { code: 4001, message: 'User denied transaction signature' } })
		// The window is still open, so startup recovery leaves the request alone; the page reconnects and gets the queued rejection.
		await withSilencedConsole(async () => await modules.resolvePendingRequestsForMissingConfirmationWindows(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
		assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
		await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, REQUEST_SOCKET)
		assert.deepEqual(getAllPageResponses(postedMessages, 1), [{ error: 4001 }])
		const request = { requestId: 1, requestSocket: REQUEST_SOCKET }
		await withSilencedConsole(async () => action === 'close'
			? await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
			: await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action, uniqueRequestIdentifier: request } }))
		await waitUntilNothingPending()
		assert.deepEqual(getAllPageResponses(postedMessages, 1), [{ error: 4001 }], 'no second reply')
		assert.deepEqual(await getStackedMessages(), [], 'the rejected message is not stacked')
	})
}

test('delivers a committed message signature once when a reconnect flush delivered it before recovery after a restart', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const { operation, signature } = await openMessageConfirmation(websiteTabConnections)
	await modules.updateInterceptorTransactionStack((stack) => ({ operations: [...stack.operations, operation] }))
	await seedCommittedReply(1, { result: signature })
	await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, REQUEST_SOCKET)
	browserMock.setLiveWindowIds([])
	await withSilencedConsole(async () => await modules.resolvePendingRequestsForMissingConfirmationWindows(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	await waitUntilNothingPending()
	assert.deepEqual(getAllPageResponses(postedMessages, 1), [{ result: signature }])
	assert.equal((await getStackedMessages()).length, 1)
})

test('stacks a message an earlier accept already stacked only once when accepted again', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const { operation, signature } = await openMessageConfirmation(websiteTabConnections)
	await modules.updateInterceptorTransactionStack((stack) => ({ operations: [...stack.operations, operation] }))
	await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createReplayableAcceptConfirmation({ requestId: 1, requestSocket: REQUEST_SOCKET })))
	assert.equal((await getStackedMessages()).length, 1)
	assert.deepEqual(getAllPageResponses(postedMessages, 1), [{ result: signature }])
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

for (const state of restartStates) {
	for (const windowSurvived of [false, true]) {
		for (const flushFirst of [true, false]) {
			test(`finishes an accepted transaction once with its stacked hash after a restart at ${ state.boundary }, ${ windowSurvived ? 'with its window open' : 'with its window gone' }, flushing ${ flushFirst ? 'before' : 'after' } startup`, async () => {
				await startSimulationStack(SENDER)
				const postedMessages: unknown[] = []
				const websiteTabConnections = createWebsiteTabConnections(postedMessages)
				await openConfirmation(1, SENDER, 1n, websiteTabConnections)
				const [pending] = await modules.getPendingTransactionsAndMessages()
				if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected a simulated pending transaction')
				const stacked = toPreSimulationTransaction(pending.transactionToSimulate, pending.simulationHashReservation)
				await modules.updateInterceptorTransactionStack(() => ({ operations: [asOperation(stacked)] }))
				const { commitPendingTerminalReply, markPendingTerminalReplyDelivered } = await import('../../app/ts/background/pendingTerminalReplies.js')
				if (state.entry !== 'none') await commitPendingTerminalReply({ ...pending.originalRequestParameters, type: 'result', result: stacked.signedTransaction.hash, uniqueRequestIdentifier: pending.uniqueRequestIdentifier, ...(state.windowPending ? { confirmationWindow: pending.popupOrTabId } : {}) })
				if (state.entry === 'delivered') await markPendingTerminalReplyDelivered(pending.uniqueRequestIdentifier)
				if (!state.pending) await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
				// A delivered entry's reply reached the page before the restart.
				const expectedNewReplies = state.entry === 'delivered' ? [] : [{ result: modules.EthereumBytes32.serialize(stacked.signedTransaction.hash) }]

				browserMock.setLiveWindowIds(windowSurvived ? [CONFIRMATION_WINDOW_ID] : [])
				const { resumeCommittedRequests } = await import('../../app/ts/background/requestResolution.js')
				const { getResolutionActivitySize } = await import('../../app/ts/background/requestResolutionState.js')
				const { getTerminalReplyBookkeepingSize } = await import('../../app/ts/background/terminalReplyDelivery.js')
				const startUp = async () => await withSilencedConsole(async () => {
					await modules.resolvePendingRequestsForMissingConfirmationWindows(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
					await resumeCommittedRequests(testResolutionContext(websiteTabConnections))
				})
				const closedWindows = await countingClosedWindows(async () => {
					if (flushFirst) await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, REQUEST_SOCKET)
					await startUp()
					if (!flushFirst) await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, REQUEST_SOCKET)
				})
				if (state.entry === 'none' && windowSurvived) {
					// An uncommitted request whose window survived waits for the user, whose accept answers with the stacked hash.
					assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
					assert.deepEqual(getAllPageResponses(postedMessages, 1), [])
					await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createReplayableAcceptConfirmation({ requestId: 1, requestSocket: REQUEST_SOCKET })))
				}
				assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [], 'the request completes')
				assert.deepEqual(getAllPageResponses(postedMessages, 1), expectedNewReplies, 'exactly the original reply, once')
				assert.deepEqual(await modules.getPendingTerminalReplies(), [], 'the finished request leaves no entry')
				assert.deepEqual(hashesOf(await getStackedTransactions()), [stacked.signedTransaction.hash], 'the stack keeps the accepted transaction')
				if (windowSurvived && state.entry !== 'none' && state.windowPending) assert.deepEqual(closedWindows, [CONFIRMATION_WINDOW_ID], 'the window that showed the last request closes')
				assert.equal(getResolutionActivitySize() + getTerminalReplyBookkeepingSize(), 0, 'no bookkeeping is left')
			})
		}
	}
}

test('posts a reply once when storing its delivered mark fails, and deletes it once its request is finished', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	let queueWrites = 0
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if (!('pendingTerminalReplies' in items)) return writeStoredItems()
		queueWrites += 1
		// The first write commits the reply; the second, its delivered mark, fails once.
		if (queueWrites === 2) throw new Error('transient delivered mark failure')
		writeStoredItems()
	})
	await rejectRequest(request, websiteTabConnections)
	await withSilencedConsole(async () => await waitUntilNothingPending())
	await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
	browserMock.setStorageSetHandler(undefined)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
})

test('deletes a finished request\'s delivered reply when the first delete fails', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	let failDelete = true
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if (failDelete && Array.isArray(items.pendingTerminalReplies) && items.pendingTerminalReplies.length === 0) {
			failDelete = false
			throw new Error('transient entry delete failure')
		}
		writeStoredItems()
	})
	const closedWindows = await countingClosedWindows(async () => {
		await rejectRequest(request, websiteTabConnections)
		await withSilencedConsole(async () => await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0))
	})
	browserMock.setStorageSetHandler(undefined)
	assert.equal(failDelete, false, 'the first delete failed')
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(closedWindows, [CONFIRMATION_WINDOW_ID], 'the window closes once')
	await assertNoResolutionBookkeeping()
})

for (const { step, fails } of scheduledRetryFailures) {
	test(`completes a request whose scheduled finishing retry fails at ${ step }, without an unhandled rejection`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		// The first attempt fails removing the request, which schedules a retry; that retry then fails once at the step.
		let removalFailed = false
		let retryFailed = false
		browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
			if (!removalFailed && Array.isArray(items.pendingTransactionsAndMessages) && items.pendingTransactionsAndMessages.length === 0) {
				removalFailed = true
				throw new Error('transient pending request removal failure')
			}
			if (removalFailed && !retryFailed && fails('set', items)) {
				retryFailed = true
				throw new Error('transient failure during the scheduled retry')
			}
			writeStoredItems()
		})
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			if (removalFailed && !retryFailed && fails('get', keys)) {
				retryFailed = true
				throw new Error('transient failure during the scheduled retry')
			}
			return readStoredItems()
		})
		const unhandledRejections = await collectingUnhandledRejections(async () => await withSilencedConsole(async () => {
			await rejectRequest(request, websiteTabConnections)
			// Wait without reading storage until the scheduled retry has failed, so only the retry meets the failure.
			const deadline = Date.now() + 2_000
			while (!retryFailed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
			await waitUntilNothingPending()
			await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
		}))
		browserMock.setStorageSetHandler(undefined)
		browserMock.setStorageGetHandler(undefined)
		assert.deepEqual([removalFailed, retryFailed], [true, true], 'both failures happened')
		assert.deepEqual(unhandledRejections, [])
		assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
		await assertNoResolutionBookkeeping()
	})
}

test('retries an explicit reject whose commitment write failed, keeping the rejection', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	let failedCommits = 0
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if (failedCommits > 0 || !('pendingTerminalReplies' in items)) return writeStoredItems()
		failedCommits += 1
		throw new Error('transient terminal reply queue write failure')
	})
	await rejectRequest(request, websiteTabConnections)
	assert.equal(failedCommits, 1)
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1, 'the request waits for the retried commitment')
	// An accept meanwhile does not change the chosen outcome.
	await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createReplayableAcceptConfirmation(request)))
	await withSilencedConsole(async () => await waitUntilNothingPending())
	browserMock.setStorageSetHandler(undefined)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
	assert.deepEqual(await getStackedTransactions(), [], 'nothing is stacked')
	await assertNoResolutionBookkeeping()
})

for (const requestCount of [1, 2]) {
	test(`${ requestCount === 1 ? 'closes the confirmation window' : 'moves the confirmation window to the next request' } when a committed request it shows is finished from storage alone`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		if (requestCount === 2) await openConfirmation(2, SENDER, 2n, websiteTabConnections)
		await seedCommittedReply(1, { error: { code: 4001, message: 'User denied transaction signature' } })
		const windows = Reflect.get(globalThis, 'browser').windows
		const removeWindow = windows.remove
		const removedWindows: number[] = []
		windows.remove = async (windowId: number) => { removedWindows.push(windowId); return await removeWindow(windowId) }
		browserMock.sentMessages.length = 0
		try {
			await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createReplayableAcceptConfirmation({ requestId: 1, requestSocket: REQUEST_SOCKET })))
		} finally {
			windows.remove = removeWindow
		}
		assert.deepEqual(getAllPageResponses(postedMessages, 1), [{ error: 4001 }], 'the committed rejection, not the accept')
		assert.deepEqual((await modules.getPendingTransactionsAndMessages()).map((pending) => pending.uniqueRequestIdentifier.requestId), requestCount === 1 ? [] : [2])
		if (requestCount === 1) assert.deepEqual(removedWindows, [CONFIRMATION_WINDOW_ID], 'the window closes after its last request')
		else {
			assert.deepEqual(removedWindows, [], 'the window stays open')
			assert.ok(browserMock.sentMessages.some((message) => message.method === 'popup_update_confirm_transaction_dialog'), 'and moves to the next request')
		}
	})
}

test('leaves no delivery bookkeeping behind when a reconnect flush delivers a reply before its resolution looks it up', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const { getTerminalReplyBookkeepingSize } = await import('../../app/ts/background/terminalReplyDelivery.js')
	const bookkeepingBefore = getTerminalReplyBookkeepingSize()
	// The flush runs as soon as the reply is committed, before the resolution delivers it.
	let flushed = false
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		writeStoredItems()
		if (flushed || !('pendingTerminalReplies' in items)) return
		flushed = true
		void modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, REQUEST_SOCKET)
	})
	await rejectRequest(request, websiteTabConnections)
	await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
	browserMock.setStorageSetHandler(undefined)
	assert.equal(flushed, true)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
	assert.equal(getTerminalReplyBookkeepingSize(), bookkeepingBefore)
})

for (const trigger of ['startup', 'the requesting tab closing'] as const) {
	test(`finishes a committed request whose requesting tab is gone on ${ trigger }, closing its window despite a failed first close`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		await seedCommittedRejection({ delivered: false, withWindow: true })
		browserMock.setLiveTabIds([])
		const requestResolution = await import('../../app/ts/background/requestResolution.js')
		const removalAttempts = await failingFirstWindowRemoval(async () => await withSilencedConsole(async () => {
			if (trigger === 'startup') await requestResolution.resumeCommittedRequests(testResolutionContext(new Map()))
			else await requestResolution.finishCommittedRequestsOfClosedTab(REQUEST_SOCKET.tabId, testResolutionContext(new Map()))
			await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
		}))
		assert.deepEqual(removalAttempts, [CONFIRMATION_WINDOW_ID, CONFIRMATION_WINDOW_ID], 'the window closes on the retry')
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
		assert.deepEqual(getPageResponses(postedMessages, 1), [], 'the gone tab gets nothing')
		await assertNoResolutionBookkeeping()
	})
}

test('finishes a request once when a reconnect flush overlaps its finishing, closing its window despite a failed first close', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	// A reply queued before windows were stored, not yet delivered.
	await seedCommittedRejection({ delivered: false, withWindow: false })
	// The flush's read of the queue is held while the finishing starts; storing the window takes the same lock as the flush, so it waits for the flush instead of racing it.
	let signalFlushRead = () => undefined
	const flushRead = new Promise<void>((resolve) => { signalFlushRead = () => { resolve() } })
	let releaseFlushRead = () => undefined
	const flushReadReleased = new Promise<void>((resolve) => { releaseFlushRead = () => { resolve() } })
	let holdNextQueueRead = true
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!holdNextQueueRead || !readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
		holdNextQueueRead = false
		signalFlushRead()
		await flushReadReleased
		return readStoredItems()
	})
	const { beginStartupRecovery, resumeCommittedRequests } = await import('../../app/ts/background/requestResolution.js')
	beginStartupRecovery()
	const removalAttempts = await failingFirstWindowRemoval(async () => await withSilencedConsole(async () => {
		const flushing = modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, REQUEST_SOCKET)
		await flushRead
		browserMock.setStorageGetHandler(undefined)
		const finishing = resumeCommittedRequests(testResolutionContext(websiteTabConnections))
		await new Promise((resolve) => setTimeout(resolve, 20))
		releaseFlushRead()
		await Promise.all([flushing, finishing])
		await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
	}))
	assert.deepEqual(removalAttempts, [CONFIRMATION_WINDOW_ID, CONFIRMATION_WINDOW_ID], 'the window closes on the retry')
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(getPageResponses(postedMessages, 1), [{ error: 4001 }], 'the page settles once')
	await assertNoResolutionBookkeeping()
})

for (const closeDeferred of [false, true]) {
	test(`finishes a request again when its requesting tab closes after the finishing checked it, retiring the undeliverable reply${ closeDeferred ? ', also after a popup close deferred before the commitment' : '' }`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		const requestResolution = await import('../../app/ts/background/requestResolution.js')
		// A popup close arriving while the reject holds the claim, before its reply is committed, is deferred.
		let closesDeferred = 0
		browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
			if (closeDeferred && closesDeferred === 0 && 'pendingTerminalReplies' in items) {
				closesDeferred += 1
				await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, new Map())
			}
			writeStoredItems()
		})
		// The page is disconnected, so the rejection stays undelivered; the tab closes while the finishing closes the window, after it found the tab open.
		const windows = Reflect.get(globalThis, 'browser').windows
		const removeWindow = windows.remove
		let tabClosings = 0
		windows.remove = async (windowId: number) => {
			if (tabClosings === 0) {
				tabClosings += 1
				browserMock.setLiveTabIds([])
				await requestResolution.finishCommittedRequestsOfClosedTab(REQUEST_SOCKET.tabId, testResolutionContext(new Map()))
			}
			return await removeWindow(windowId)
		}
		try {
			await withSilencedConsole(async () => {
				await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, new Map(), { method: 'popup_confirmDialog', data: { action: 'reject', uniqueRequestIdentifier: request } })
				await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
			})
		} finally {
			windows.remove = removeWindow
			browserMock.setStorageSetHandler(undefined)
		}
		assert.deepEqual([tabClosings, closesDeferred], [1, closeDeferred ? 1 : 0])
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
		assert.deepEqual(getPageResponses(postedMessages, request.requestId), [], 'the closed tab gets no reply')
		await assertNoResolutionBookkeeping()
	})
}

test('retries listing a closed tab\'s committed replies when the first listing fails', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	await seedCommittedRejection({ delivered: false, withWindow: true })
	browserMock.setLiveTabIds([])
	let failedListings = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (failedListings > 0 || !readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
		failedListings += 1
		throw new Error('transient terminal reply queue read failure')
	})
	const { finishCommittedRequestsOfClosedTab } = await import('../../app/ts/background/requestResolution.js')
	await withSilencedConsole(async () => {
		await finishCommittedRequestsOfClosedTab(REQUEST_SOCKET.tabId, testResolutionContext(new Map()))
		await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
	})
	browserMock.setStorageGetHandler(undefined)
	assert.equal(failedListings, 1)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(getPageResponses(postedMessages, 1), [])
	await assertNoResolutionBookkeeping()
})

test('moves the window to a confirmation that registers in it before the window\'s last other request is resolved', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const first = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const registration = createGate()
	await withBrowserWindows({}, async ({ liveWindows, createdWindows }) => {
		const restore = pausingRegistrationAfterWindowPick(registration)
		try {
			// The second confirmation picks the open window and pauses before registering, holding the pending-confirmation lock.
			const opening = openConfirmation(2, SENDER, 2n, websiteTabConnections)
			await registration.reached
			// Rejecting the first request decides about the window only once the second registered.
			const rejecting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'reject', uniqueRequestIdentifier: first } }))
			await new Promise((resolve) => setTimeout(resolve, 50))
			assert.deepEqual(liveWindows(), [CONFIRMATION_WINDOW_ID], 'the window is not closed while the second registers')
			browserMock.sentMessages.length = 0
			registration.open()
			await Promise.all([opening, rejecting])
		} finally {
			restore()
		}
		assert.deepEqual(liveWindows(), [CONFIRMATION_WINDOW_ID], 'the window stays open')
		assert.deepEqual(createdWindows(), [], 'no other window opens')
	})
	const [second] = await modules.getPendingTransactionsAndMessages()
	assert.deepEqual(second?.popupOrTabId, { type: 'popup', id: CONFIRMATION_WINDOW_ID }, 'the second request is in the open window')
	assert.ok(browserMock.sentMessages.some((message) => message.method === 'popup_update_confirm_transaction_dialog'), 'and the window moves to it')
	assert.deepEqual(getPageResponses(postedMessages, 1), [{ error: 4001 }])
	assert.deepEqual(getPageResponses(postedMessages, 2), [])
	await assertNoResolutionBookkeeping()
})

test('opens a new window for a confirmation that chooses its window while the window\'s last request is closing it', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const first = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const windowClose = createGate()
	await withBrowserWindows({ beforeRemove: async () => await windowClose.pass() }, async ({ liveWindows, createdWindows }) => {
		// Rejecting the first request closes its window, holding the pending-confirmation lock.
		const rejecting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'reject', uniqueRequestIdentifier: first } }))
		await windowClose.reached
		// The second confirmation chooses its window only once the close is done.
		const opening = openConfirmation(2, SENDER, 2n, websiteTabConnections)
		await new Promise((resolve) => setTimeout(resolve, 50))
		windowClose.open()
		await Promise.all([rejecting, opening])
		assert.equal(createdWindows().length, 1, 'one new window opens')
		assert.deepEqual(liveWindows(), createdWindows(), 'only the new window is open')
		const [second] = await modules.getPendingTransactionsAndMessages()
		assert.deepEqual(second?.popupOrTabId, { type: 'popup', id: createdWindows()[0] }, 'the second request is in the new window')
	})
	assert.deepEqual(getPageResponses(postedMessages, 1), [{ error: 4001 }])
	assert.deepEqual(getPageResponses(postedMessages, 2), [])
	await assertNoResolutionBookkeeping()
})

test('rejects a request once when the user closes a window whose programmatic close failed, opening no new window', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const first = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	await withBrowserWindows({ beforeRemove: async () => { throw new Error('transient window removal failure') } }, async ({ createdWindows }) => {
		// Rejecting the request fails to close its window; the finishing retries.
		await rejectRequest(first, websiteTabConnections)
		// The user closes the window before the retry.
		browserMock.setLiveWindowIds([])
		await withSilencedConsole(async () => {
			await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
			await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
		})
		assert.deepEqual(createdWindows(), [], 'no new window opens')
	})
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(getPageResponses(postedMessages, 1), [{ error: 4001 }], 'the request is rejected once')
	await assertNoResolutionBookkeeping()
})

test('runs a popup close deferred behind an orphan rejection in the claim holder\'s context, so registration under the pending-confirmation lock completes', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const orphan = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const orphanStackRead = createGate()
	await withBrowserWindows({}, async ({ createdWindows }) => {
		// The orphan's window is gone, so the next registration rejects it under the pending-confirmation lock.
		browserMock.setLiveWindowIds([])
		const windows = Reflect.get(globalThis, 'browser').windows
		const getWindow = windows.get
		let choosingWindow = false
		windows.get = async (windowId: number) => {
			choosingWindow = true
			return await getWindow(windowId)
		}
		// The orphan's rejection reads the stack after claiming it; that read is held, then fails once.
		let armed = true
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			if (!choosingWindow || !armed || !readsKey(keys, 'interceptorTransactionStack')) return readStoredItems()
			armed = false
			await orphanStackRead.pass()
			throw new Error('transient stack read failure')
		})
		try {
			const registering = openConfirmation(2, SENDER, 2n, websiteTabConnections)
			await orphanStackRead.reached
			// A close event for the orphan's window arrives meanwhile and is deferred behind the claim.
			await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
			orphanStackRead.open()
			await withSilencedConsole(async () => await registering)
		} finally {
			windows.get = getWindow
			browserMock.setStorageGetHandler(undefined)
		}
		await withSilencedConsole(async () => await waitForCondition(async () => (await modules.getPendingTransactionsAndMessages()).every((pending) => pending.uniqueRequestIdentifier.requestId !== orphan.requestId)))
		// A later registration completes too.
		await openConfirmation(3, SENDER, 3n, websiteTabConnections)
		assert.equal(createdWindows().length, 1, 'one window opened for the new requests')
	})
	assert.deepEqual((await modules.getPendingTransactionsAndMessages()).map((pending) => pending.uniqueRequestIdentifier.requestId), [2, 3])
	assert.deepEqual(getPageResponses(postedMessages, orphan.requestId), [{ error: 4001 }], 'the orphan is rejected once')
	await withSilencedConsole(async () => await waitForCondition(async () => {
		const { getResolutionActivitySize } = await import('../../app/ts/background/requestResolutionState.js')
		return getResolutionActivitySize() === 0
	}))
	await assertNoResolutionBookkeeping()
})

test('closes a resolved request\'s window when the next request, choosing its window while holding the lock, already sees the request removed and opens its own', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const first = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const windowChoice = createGate()
	await withBrowserWindows({}, async ({ liveWindows, createdWindows }) => {
		// Admission reads the pending store before preparation. Hold the following read, which chooses the window under the pending-confirmation lock, and return the store as it stands once released.
		let admissionRead = true
		let armed = true
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			if (!armed || !readsKey(keys, 'pendingTransactionsAndMessages')) return readStoredItems()
			if (admissionRead) {
				admissionRead = false
				return readStoredItems()
			}
			armed = false
			await windowChoice.pass()
			return readStoredItems()
		})
		try {
			const opening = openConfirmation(2, SENDER, 2n, websiteTabConnections)
			await windowChoice.reached
			// The first request is rejected and removed; its window cleanup waits for the lock.
			const rejecting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'reject', uniqueRequestIdentifier: first } }))
			await waitForCondition(async () => (await modules.getPendingTransactionsAndMessages()).length === 0)
			await new Promise((resolve) => setTimeout(resolve, 50))
			assert.deepEqual(liveWindows(), [CONFIRMATION_WINDOW_ID], 'the cleanup waits for the lock')
			windowChoice.open()
			await Promise.all([opening, rejecting])
		} finally {
			windowChoice.open()
			browserMock.setStorageGetHandler(undefined)
		}
		const [second] = await modules.getPendingTransactionsAndMessages()
		assert.equal(createdWindows().length, 1)
		assert.deepEqual(second?.popupOrTabId, { type: 'popup', id: createdWindows()[0] }, 'the second request is in its own window')
		assert.deepEqual(liveWindows(), createdWindows(), 'the first request\'s window, without requests, closed')
	})
	assert.deepEqual(getPageResponses(postedMessages, 1), [{ error: 4001 }])
	await assertNoResolutionBookkeeping()
})

test('closes a resolved request\'s window on the retry of a failed close after the next request opened its own window', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const first = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	let removals = 0
	await withBrowserWindows({
		beforeRemove: async () => {
			removals += 1
			if (removals === 1) throw new Error('transient window removal failure')
		},
	}, async ({ liveWindows, createdWindows }) => {
		await rejectRequest(first, websiteTabConnections)
		// The next request sees no pending request and opens its own window before the retry.
		await openConfirmation(2, SENDER, 2n, websiteTabConnections)
		await withSilencedConsole(async () => await waitForCondition(async () => !liveWindows().includes(CONFIRMATION_WINDOW_ID)))
		const [second] = await modules.getPendingTransactionsAndMessages()
		assert.equal(createdWindows().length, 1)
		assert.deepEqual(second?.popupOrTabId, { type: 'popup', id: createdWindows()[0] })
		assert.deepEqual(liveWindows(), createdWindows(), 'exactly the second request\'s window is open')
	})
	assert.deepEqual(getPageResponses(postedMessages, 1), [{ error: 4001 }])
	await assertNoResolutionBookkeeping()
})

test('rejects a request once when its window closes and the finishing first fails to look up its committed reply', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	browserMock.setLiveWindowIds([])
	// The close checks for a committed reply (the first read), then its finishing looks it up again (the second), which fails.
	const failures = failingCommittedReplyRead(2)
	await withSilencedConsole(async () => {
		await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
		await waitUntilNothingPending()
		await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
	})
	browserMock.setStorageGetHandler(undefined)
	assert.equal(failures(), 1)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
	await withSilencedConsole(async () => await waitForCondition(async () => {
		const { getResolutionActivitySize } = await import('../../app/ts/background/requestResolutionState.js')
		return getResolutionActivitySize() === 0
	}))
	await assertNoResolutionBookkeeping()
})

test('rejects a request once when a close deferred behind a failed accept first fails to look up its committed reply', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const pause = pauseNextStackReadThen()
	const accepting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createReplayableAcceptConfirmation(request)))
	await pause.paused
	try {
		await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	} finally {
		pause.release(true)
	}
	// After the failed accept, its claim release finishes it again (the first read), then the deferred close checks for a committed reply (the second) and finishes (the third), which fails.
	const failures = failingCommittedReplyRead(3)
	await accepting.then(() => undefined, () => undefined)
	await withSilencedConsole(async () => {
		await waitUntilNothingPending()
		await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
	})
	browserMock.setStorageGetHandler(undefined)
	assert.equal(failures(), 1)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
	await withSilencedConsole(async () => await waitForCondition(async () => {
		const { getResolutionActivitySize } = await import('../../app/ts/background/requestResolutionState.js')
		return getResolutionActivitySize() === 0
	}))
	await assertNoResolutionBookkeeping()
})

for (const lookup of ['its committed reply', 'the stack'] as const) {
	test(`rejects a request once when a reject first fails to look up ${ lookup }`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		let failed = 0
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			if (failed > 0 || !readsKey(keys, lookup === 'the stack' ? 'interceptorTransactionStack' : 'pendingTerminalReplies')) return readStoredItems()
			failed += 1
			throw new Error('transient read failure')
		})
		await withSilencedConsole(async () => {
			await rejectRequest(request, websiteTabConnections)
			await waitUntilNothingPending()
			await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
		})
		browserMock.setStorageGetHandler(undefined)
		assert.equal(failed, 1)
		assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
		await waitForNoResolutionBookkeeping()
	})
}

test('rejects a request that is still simulating once when the reject\'s finishing fails first', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: (await modules.getPendingTransactionsAndMessages()).map((pending) => pending.type === 'Transaction' && pending.transactionOrMessageCreationStatus === 'Simulated' ? { ...pending, transactionOrMessageCreationStatus: 'Simulating' as const, transactionToSimulate: pending.transactionToSimulate } : pending) })
	assert.equal((await modules.getPendingTransactionsAndMessages())[0]?.transactionOrMessageCreationStatus, 'Simulating')
	let failed = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (failed > 0 || !readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
		failed += 1
		throw new Error('transient read failure')
	})
	await withSilencedConsole(async () => {
		await rejectRequest(request, websiteTabConnections)
		await waitUntilNothingPending()
		await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
	})
	browserMock.setStorageGetHandler(undefined)
	assert.equal(failed, 1)
	const responses = getPageResponses(postedMessages, request.requestId)
	assert.equal(responses.length, 1, 'one settlement')
	assert.ok(responses.every((response) => 'error' in response), 'a rejection')
	await waitForNoResolutionBookkeeping()
})

for (const acceptOutcome of ['succeeds', 'fails'] as const) {
	test(`settles a request once when a reject competes with an accept that ${ acceptOutcome }`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		const pause = pauseNextStackReadThen()
		const accepting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createReplayableAcceptConfirmation(request)))
		await pause.paused
		try {
			// The reject finds the request claimed by the accept, so its decline waits for the accept.
			assert.equal(await rejectRequest(request, websiteTabConnections), false)
		} finally {
			pause.release(acceptOutcome === 'fails')
		}
		await accepting.then(() => undefined, () => undefined)
		await withSilencedConsole(async () => {
			await waitUntilNothingPending()
			await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
		})
		const responses = getPageResponses(postedMessages, request.requestId)
		const stacked = await getStackedTransactions()
		if (acceptOutcome === 'succeeds') {
			assert.equal(stacked.length, 1)
			assert.deepEqual(responses, [{ result: stacked[0]?.signedTransaction.hash }], 'exactly the accepted hash')
		} else {
			assert.deepEqual(stacked, [])
			assert.deepEqual(responses, [{ error: 4001 }], 'exactly one rejection')
		}
		await waitForNoResolutionBookkeeping()
	})
}

test('stops retrying a close whose lookups keep failing at the limit, leaving no retry bookkeeping', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	let failedLookups = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
		failedLookups += 1
		throw new Error('persistent read failure')
	})
	try {
		await withSilencedConsole(async () => {
			await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
			// The decline and the finishing it starts each retry at most five times, with backoff from 50 ms to 800 ms.
			await waitForNoResolutionBookkeepingWhileFailing()
		})
		const lookupsAtLimit = failedLookups
		await new Promise((resolve) => setTimeout(resolve, 1_000))
		assert.equal(failedLookups, lookupsAtLimit, 'the retries stopped')
		assert.ok(lookupsAtLimit > 1, 'it retried')
		await assertNoResolutionBookkeeping()
	} finally {
		browserMock.setStorageGetHandler(undefined)
	}
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [])
})

test('stops a reject\'s retries at one budget when every committed-reply read is slow and fails', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	let failedReads = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
		await new Promise((resolve) => setTimeout(resolve, 120))
		failedReads += 1
		throw new Error('slow persistent read failure')
	})
	try {
		await withSilencedConsole(async () => {
			await rejectRequest(request, websiteTabConnections)
			await waitForNoResolutionBookkeepingWhileFailing()
		})
		const readsWhenExhausted = failedReads
		await new Promise((resolve) => setTimeout(resolve, 2_000))
		assert.equal(failedReads, readsWhenExhausted, 'nothing retries after the budget is spent')
		assert.ok(readsWhenExhausted <= 6, `one budget of attempts (${ readsWhenExhausted } reads)`)
		await assertNoResolutionBookkeeping()
	} finally {
		browserMock.setStorageGetHandler(undefined)
	}
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [])
	// The reject was stored with the request before its failing lookups, so startup with the window open finishes it.
	assert.deepEqual((await modules.getPendingTransactionsAndMessages())[0]?.resolutionInputs, [{ kind: 'decline', reason: 'reject' }])
	const { beginStartupRecovery, resumeCommittedRequests } = await import('../../app/ts/background/requestResolution.js')
	beginStartupRecovery()
	await withSilencedConsole(async () => {
		await resumeCommittedRequests(testResolutionContext(websiteTabConnections))
		await waitUntilNothingPending()
		await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
	})
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
	await assertNoResolutionBookkeeping()
})

test('finishes a reject whose retries ran out before committing at startup, while its window is still open', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	// Every write of a committed reply fails, so the reject runs out of retries before committing.
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if ('pendingTerminalReplies' in items) throw new Error('persistent reply write failure')
		writeStoredItems()
	})
	try {
		await withSilencedConsole(async () => {
			await rejectRequest(request, websiteTabConnections)
			await waitForNoResolutionBookkeepingWhileFailing()
		})
	} finally {
		browserMock.setStorageSetHandler(undefined)
	}
	const [pending] = await modules.getPendingTransactionsAndMessages()
	assert.deepEqual(pending?.resolutionInputs, [{ kind: 'decline', reason: 'reject' }], 'the reject is stored with the request')
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [])
	// After a restart with the window open, startup finishes it.
	const { beginStartupRecovery, resumeCommittedRequests } = await import('../../app/ts/background/requestResolution.js')
	beginStartupRecovery()
	await withSilencedConsole(async () => {
		await resumeCommittedRequests(testResolutionContext(websiteTabConnections))
		await waitUntilNothingPending()
		await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
	})
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
	await assertNoResolutionBookkeeping()
})

for (const closedWindow of [CONFIRMATION_WINDOW_ID, CONFIRMATION_WINDOW_ID + 1]) {
	test(`declines only the requests of the closed window ${ closedWindow === CONFIRMATION_WINDOW_ID ? 'holding an orphan awaiting its retry' : 'of a later request' }`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		const [orphan] = await modules.getPendingTransactionsAndMessages()
		if (orphan === undefined) throw new Error('Expected the pending request')
		// A later request shown in its own window.
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [orphan, { ...orphan, uniqueRequestIdentifier: { requestId: 2, requestSocket: REQUEST_SOCKET }, transactionIdentifier: 2n, popupOrTabId: { type: 'popup', id: CONFIRMATION_WINDOW_ID + 1 } }] })
		browserMock.setLiveWindowIds([CONFIRMATION_WINDOW_ID + 1])
		// The orphan's decline fails once and waits for its retry.
		let failedReads = 0
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			if (failedReads > 0 || !readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
			failedReads += 1
			throw new Error('transient read failure')
		})
		await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'noResponse', uniqueRequestIdentifier: orphan.uniqueRequestIdentifier } }))
		browserMock.setStorageGetHandler(undefined)
		assert.equal(failedReads, 1)
		await withSilencedConsole(async () => {
			await modules.onCloseWindowOrTab({ type: 'popup', id: closedWindow }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
			// The orphan's retry declines it in any case; the later request only if its window closed.
			await waitForCondition(async () => (await modules.getPendingTransactionsAndMessages()).every((pending) => pending.uniqueRequestIdentifier.requestId !== 1))
			await new Promise((resolve) => setTimeout(resolve, 200))
		})
		const remaining = (await modules.getPendingTransactionsAndMessages()).map((pending) => pending.uniqueRequestIdentifier.requestId)
		assert.deepEqual(remaining, closedWindow === CONFIRMATION_WINDOW_ID ? [2] : [], 'only the closed window\'s requests, and the orphan, are declined')
		assert.equal(getPageResponses(postedMessages, 1).length, 1, 'the orphan settles once')
		assert.deepEqual(getPageResponses(postedMessages, 2), closedWindow === CONFIRMATION_WINDOW_ID ? [] : [{ error: 4001 }])
	})
}

test('stops the startup recovery composition when its committed-reply reads keep failing, with an orphan pending', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	browserMock.setLiveWindowIds([])
	let failedReads = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
		failedReads += 1
		throw new Error('persistent read failure')
	})
	const { createRetriableTerminalStateRecovery } = await import('../../app/ts/background/terminalStateRecovery.js')
	const { beginStartupRecovery, resumeCommittedRequests } = await import('../../app/ts/background/requestResolution.js')
	beginStartupRecovery()
	const recoveryFailures: boolean[] = []
	// As the background composes it at startup.
	const recover = createRetriableTerminalStateRecovery({
		recover: async () => {
			await modules.resolvePendingRequestsForMissingConfirmationWindows(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
			await resumeCommittedRequests(testResolutionContext(websiteTabConnections))
		},
		onFailure: (_error, retrying) => { recoveryFailures.push(retrying) },
	})
	try {
		await withSilencedConsole(async () => {
			await recover()
			const deadline = Date.now() + 8_000
			while (recoveryFailures.at(-1) !== false && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
			await waitForNoResolutionBookkeepingWhileFailing()
		})
		const readsWhenStopped = failedReads
		await new Promise((resolve) => setTimeout(resolve, 1_000))
		assert.equal(recoveryFailures.at(-1), false, 'the recovery gave up')
		assert.ok(recoveryFailures.length <= 6, 'within its attempt limit')
		assert.equal(failedReads, readsWhenStopped, 'nothing retries afterwards')
		await assertNoResolutionBookkeeping()
	} finally {
		browserMock.setStorageGetHandler(undefined)
	}
}, 15_000)

test('rejects only the requests whose own window is gone when another confirmation opens, reusing a live window', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const [orphan] = await modules.getPendingTransactionsAndMessages()
	if (orphan === undefined) throw new Error('Expected the pending request')
	const LIVE_WINDOW_ID = CONFIRMATION_WINDOW_ID + 1
	// The first request's window is gone; the second request is shown in a live window.
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [orphan, { ...orphan, uniqueRequestIdentifier: { requestId: 2, requestSocket: REQUEST_SOCKET }, transactionIdentifier: 2n, popupOrTabId: { type: 'popup', id: LIVE_WINDOW_ID } }] })
	browserMock.setLiveWindowIds([LIVE_WINDOW_ID])
	await withSilencedConsole(async () => await openConfirmation(3, SENDER, 3n, websiteTabConnections))
	await withSilencedConsole(async () => await waitForCondition(async () => (await modules.getPendingTransactionsAndMessages()).every((pending) => pending.uniqueRequestIdentifier.requestId !== 1)))
	const remaining = await modules.getPendingTransactionsAndMessages()
	assert.deepEqual(remaining.map((pending) => pending.uniqueRequestIdentifier.requestId), [2, 3], 'the live window\'s request stays pending')
	assert.deepEqual(remaining.map((pending) => pending.popupOrTabId.id), [LIVE_WINDOW_ID, LIVE_WINDOW_ID], 'the new request reuses the live window')
	assert.deepEqual(getPageResponses(postedMessages, 1), [{ error: 4001 }], 'the orphan is rejected')
	assert.deepEqual(getPageResponses(postedMessages, 2), [], 'the live request is not')
})

for (const acceptStackedBeforeRestart of [false, true]) {
	test(`stores a reject that competes with an accept, so startup after a restart ${ acceptStackedBeforeRestart ? 'answers with the hash the accept stacked' : 'rejects the request' }`, async () => {
		await startSimulationStack(SENDER)
		const firstSessionMessages: unknown[] = []
		const firstSessionConnections = createWebsiteTabConnections(firstSessionMessages)
		const request = await openConfirmation(1, SENDER, 1n, firstSessionConnections)
		const pause = pauseNextStackReadThen()
		const accepting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, firstSessionConnections, await createReplayableAcceptConfirmation(request)))
		await pause.paused
		let storedPending: Awaited<ReturnType<typeof modules.getPendingTransactionsAndMessages>>
		try {
			assert.equal(await rejectRequest(request, firstSessionConnections), false, 'the reject waits for the accept')
			await waitForCondition(async () => (await modules.getPendingTransactionsAndMessages())[0]?.resolutionInputs?.some((input) => input.kind === 'decline' && input.reason === 'reject') === true)
			// The state a restart here leaves: the reject stored with the request, no reply committed.
			storedPending = await modules.getPendingTransactionsAndMessages()
		} finally {
			pause.release(true)
		}
		await accepting.then(() => undefined, () => undefined)
		await withSilencedConsole(async () => await waitUntilNothingPending())

		// The restarted extension starts from that stored state.
		const [pending] = storedPending
		if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected the stored pending transaction')
		const stackedByAccept = toPreSimulationTransaction(pending.transactionToSimulate, pending.simulationHashReservation)
		await modules.updateInterceptorTransactionStack(() => ({ operations: acceptStackedBeforeRestart ? [asOperation(stackedByAccept)] : [] }))
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: storedPending })
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const { beginStartupRecovery, resumeCommittedRequests } = await import('../../app/ts/background/requestResolution.js')
	beginStartupRecovery()
		await withSilencedConsole(async () => {
			await resumeCommittedRequests(testResolutionContext(websiteTabConnections))
			await waitUntilNothingPending()
			await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
		})
		const stacked = await getStackedTransactions()
		if (acceptStackedBeforeRestart) {
			assert.deepEqual(hashesOf(stacked), [stackedByAccept.signedTransaction.hash])
			assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ result: stackedByAccept.signedTransaction.hash }], 'the stacked hash, once')
		} else {
			assert.deepEqual(stacked, [], 'nothing is stacked')
			assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'one rejection')
		}
		await assertNoResolutionBookkeeping()
	})
}

test('stops retrying a connected port\'s reply flush when storage keeps failing, and recovers when the port reconnects', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	await seedCommittedRejection({ delivered: false, withWindow: false })
	// The request was finished but its reply not delivered, so a reconnect flush delivers it.
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	let failedReads = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
		failedReads += 1
		throw new Error('persistent read failure')
	})
	const port = websiteTabConnections.get(REQUEST_SOCKET.tabId)?.connections[modules.websiteSocketToString(REQUEST_SOCKET)]?.port
	if (port === undefined) throw new Error('missing port')
	const { getTerminalReplyBookkeepingSize } = await import('../../app/ts/background/terminalReplyDelivery.js')
	try {
		await withSilencedConsole(async () => {
			await modules.flushPendingTerminalRepliesForConnectedPortWithRetry(websiteTabConnections, REQUEST_SOCKET, port)
			const deadline = Date.now() + 8_000
			while (getTerminalReplyBookkeepingSize() > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
		})
		const readsWhenStopped = failedReads
		await new Promise((resolve) => setTimeout(resolve, 1_000))
		assert.equal(failedReads, readsWhenStopped, 'the retries stopped')
		assert.ok(readsWhenStopped <= 6, `within the budget (${ readsWhenStopped } reads)`)
		assert.equal(getTerminalReplyBookkeepingSize(), 0, 'no retry timer remains')
	} finally {
		browserMock.setStorageGetHandler(undefined)
	}
	assert.deepEqual(getPageResponses(postedMessages, 1), [])
	// The port reconnects once storage works again.
	await modules.flushPendingTerminalRepliesForConnectedPortWithRetry(websiteTabConnections, REQUEST_SOCKET, port)
	assert.deepEqual(getPageResponses(postedMessages, 1), [{ error: 4001 }])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

test('counts concurrent failures of one request against its one retry budget, with one timer that parks on the claim, and cancels it on completion', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const pause = pauseNextStackReadThen()
	const accepting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createReplayableAcceptConfirmation(request)))
	await pause.paused
	// Every write storing the reject on the request fails, as their reports are written slowly.
	let failedIntentWrites = 0
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		const pending = items.pendingTransactionsAndMessages
		if (Array.isArray(pending) && pending.some((entry) => isRecord(entry) && entry.resolutionInputs !== undefined)) {
			failedIntentWrites += 1
			throw new Error('persistent intent write failure')
		}
		if ('interceptorErrorDiagnostics' in items) await new Promise((resolve) => setTimeout(resolve, 30))
		writeStoredItems()
	})
	const { getResolutionActivitySize } = await import('../../app/ts/background/requestResolutionState.js')
	try {
		await withSilencedConsole(async () => {
			// Two rejects at once, each deferred behind the accept's claim with a failing intent write.
			await Promise.all([rejectRequest(request, websiteTabConnections), rejectRequest(request, websiteTabConnections)])
			await waitForCondition(async () => failedIntentWrites >= 2)
			await new Promise((resolve) => setTimeout(resolve, 40))
			// The accept's claim and its deferred decline, with at most one retry timer, which parks on the claim when it comes due.
			assert.ok(getResolutionActivitySize() <= 3, 'at most one retry timer')
			await new Promise((resolve) => setTimeout(resolve, 500))
			assert.equal(getResolutionActivitySize(), 2, 'the retry is parked, not polling')
		})
		assert.equal(failedIntentWrites, 2, 'each failure counted once, and no attempts while the request is claimed')
	} finally {
		browserMock.setStorageSetHandler(undefined)
		pause.release(false)
	}
	// The accept completes, and the request's retries are all gone.
	await accepting
	await withSilencedConsole(async () => await waitUntilNothingPending())
	const stacked = await getStackedTransactions()
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ result: stacked[0]?.signedTransaction.hash }])
	await waitForNoResolutionBookkeeping()
})

for (const recovery of ['a new reject', 'startup'] as const) {
	test(`spends one budget on a reject whose committed-reply reads keep failing while failure reports are slow, then recovers on ${ recovery }`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		let failedReads = 0
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			if (!readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
			failedReads += 1
			throw new Error('persistent read failure')
		})
		// Reporting a failure takes long, so retries come due while the request's claim is still held.
		browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
			if ('interceptorErrorDiagnostics' in items) await new Promise((resolve) => setTimeout(resolve, 1_800))
			writeStoredItems()
		})
		const { getResolutionActivitySize } = await import('../../app/ts/background/requestResolutionState.js')
		try {
			await withSilencedConsole(async () => {
				await rejectRequest(request, websiteTabConnections)
				// Settled once no resolution is in flight or scheduled for a while.
				let quietSince = Date.now()
				const deadline = Date.now() + 40_000
				while (Date.now() - quietSince < 2_500 && Date.now() < deadline) {
					if (getResolutionActivitySize() > 0) quietSince = Date.now()
					await new Promise((resolve) => setTimeout(resolve, 50))
				}
			})
			const readsWhenSettled = failedReads
			await new Promise((resolve) => setTimeout(resolve, 1_000))
			assert.equal(failedReads, readsWhenSettled, 'no later attempts')
			assert.ok(readsWhenSettled <= 6, `at most one budget of attempts (${ readsWhenSettled } reads)`)
		} finally {
			browserMock.setStorageGetHandler(undefined)
			browserMock.setStorageSetHandler(undefined)
		}
		assert.deepEqual(getPageResponses(postedMessages, request.requestId), [])
		await withSilencedConsole(async () => {
			if (recovery === 'a new reject') await rejectRequest(request, websiteTabConnections)
			else {
				const { beginStartupRecovery, resumeCommittedRequests } = await import('../../app/ts/background/requestResolution.js')
				beginStartupRecovery()
				await resumeCommittedRequests(testResolutionContext(websiteTabConnections))
			}
			await waitUntilNothingPending()
			await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
		})
		assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
		await waitForNoResolutionBookkeeping()
	}, 90_000)
}

test('parks a retry that comes due while the request is claimed, without polling, and runs it once the claim is released', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	// The reject's first committed-reply read fails, and reporting that failure is held, so its retry comes due while the reject still holds the claim.
	let failedReads = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (failedReads > 0 || !readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
		failedReads += 1
		throw new Error('transient read failure')
	})
	const report = createGate()
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if ('interceptorErrorDiagnostics' in items) await report.pass()
		writeStoredItems()
	})
	// Counts the timers scheduled while the report is held.
	const realSetTimeout = globalThis.setTimeout
	let schedules = 0
	const countingSetTimeout = (...args: Parameters<typeof setTimeout>) => {
		schedules += 1
		return realSetTimeout(...args)
	}
	try {
		const rejecting = withSilencedConsole(async () => await rejectRequest(request, websiteTabConnections))
		await report.reached
		// The retry comes due within 50 ms and parks.
		await new Promise((resolve) => realSetTimeout(resolve, 100))
		globalThis.setTimeout = Object.assign(countingSetTimeout, realSetTimeout)
		await new Promise((resolve) => realSetTimeout(resolve, 1_000))
		globalThis.setTimeout = realSetTimeout
		assert.equal(schedules, 0, 'nothing is scheduled while the claim is held')
		report.open()
		await rejecting
		await withSilencedConsole(async () => {
			await waitUntilNothingPending()
			await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
		})
	} finally {
		globalThis.setTimeout = realSetTimeout
		browserMock.setStorageGetHandler(undefined)
		browserMock.setStorageSetHandler(undefined)
	}
	assert.equal(failedReads, 1)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'one settlement')
	await waitForNoResolutionBookkeeping()
})
