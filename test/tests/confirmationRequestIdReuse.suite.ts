import * as assert from 'assert'
import { test } from 'bun:test'
import { UpdateConfirmTransactionDialogPendingTransactions } from '../../app/ts/types/interceptor-messages.js'
import type { PendingTransactionOrSignableMessage, PopupPendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import { activeAddress, browserMock, createWebsitePort, fakeRequestHandler, modules, recipientAddress, type RuntimeMessage, simulator } from './confirmTransactionTestHarness.js'

// A page chooses its own JSON-RPC request ids, so it can send a new request under the id of one whose popup was just closed, or of one that is still pending.
const pageRequestIdentifier = { requestId: -2, requestSocket: { tabId: 1, connectionName: 0n } }
const pageWebsite = { websiteOrigin: 'https://page.example', icon: undefined, title: undefined }
const ONE_ETHER = 10n ** 18n
const FIRST_MESSAGE = '0x6669727374'
const REPLACEMENT_MESSAGE = '0x7265706c6163656d656e74'

async function startPageConnection() {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	browserMock.setLiveWindowIds([99])
	browserMock.setLiveTabIds([99])
	const socket = pageRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, [])
	return new Map([[socket.tabId, { connections: { [modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: pageWebsite.websiteOrigin, approved: true, wantsToConnect: true } } }]])
}

type PageConnections = Awaited<ReturnType<typeof startPageConnection>>

async function sendTransactionFromPage(connections: PageConnections, value: bigint) {
	const parameters = { method: 'eth_sendTransaction' as const, params: [{ from: activeAddress, to: recipientAddress, value, gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, input: new Uint8Array() }] as const }
	const request = { ...parameters, interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: pageRequestIdentifier }
	const reply = await modules.openConfirmTransactionDialogForTransaction(simulator.ethereum, simulator.tokenPriceService, request, { kind: 'transaction', parameters }, false, activeAddress, pageWebsite, connections)
	assert.deepEqual(reply, { type: 'doNotReply' })
}

async function sendPersonalSignFromPage(connections: PageConnections, message: string) {
	const parameters = { method: 'personal_sign' as const, params: [message, activeAddress] as const }
	const request = { ...parameters, interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: pageRequestIdentifier }
	const reply = await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, request, { kind: 'message', parameters }, false, activeAddress, pageWebsite, connections)
	assert.deepEqual(reply, { type: 'doNotReply' })
}

async function getOnlyPendingRequest() {
	const pending = await modules.getPendingTransactionsAndMessages()
	assert.equal(pending.length, 1)
	const [request] = pending
	if (request === undefined) throw new Error('Expected one pending request')
	return request
}

async function closeConfirmationPopup(connections: PageConnections) {
	const pending = await getOnlyPendingRequest()
	await modules.onCloseWindowOrTab(pending.popupOrTabId, simulator.ethereum, simulator.tokenPriceService, connections)
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 0)
}

// Holds the first request for the given RPC method, made while shouldPause holds, until released, so a test can replace the pending request while a refresh is mid-flight.
function pauseFirstRpcRequest(method: string, shouldPause: () => boolean = () => true) {
	const originalJsonRpcRequest = fakeRequestHandler.jsonRpcRequest
	let markReached: () => void = () => undefined
	let release: () => void = () => undefined
	const reached = new Promise<void>((resolve) => { markReached = () => { resolve() } })
	const released = new Promise<void>((resolve) => { release = () => { resolve() } })
	let paused = false
	fakeRequestHandler.jsonRpcRequest = async (rpcRequest) => {
		if (!paused && rpcRequest.method === method && shouldPause()) {
			paused = true
			markReached()
			await released
		}
		return await originalJsonRpcRequest(rpcRequest)
	}
	return { reached, release, restore: () => { fakeRequestHandler.jsonRpcRequest = originalJsonRpcRequest } }
}

function watchPendingRequestsWrites() {
	let hasWritten = false
	let markWritten: () => void = () => undefined
	const written = new Promise<void>((resolve) => { markWritten = () => { resolve() } })
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		writeStoredItems()
		if (!('pendingTransactionsAndMessages' in items)) return
		hasWritten = true
		markWritten()
	})
	return { written, hasWritten: () => hasWritten }
}

// Fails instead of hanging when the work finishes before reaching the step a test waits for.
async function waitUntilReached(step: Promise<void>, work: Promise<unknown>, stepDescription: string) {
	await Promise.race([step, work.then(() => { throw new Error(`The work finished before ${ stepDescription }`) })])
}

const getRequestedValue = (pending: PendingTransactionOrSignableMessage) => {
	if (pending.originalRequestParameters.method !== 'eth_sendTransaction') throw new Error('Expected an eth_sendTransaction request')
	return pending.originalRequestParameters.params[0].value
}

const getSimulatedValues = (pending: PendingTransactionOrSignableMessage | PopupPendingTransactionOrSignableMessage) => {
	if (pending.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated' || pending.popupVisualisation.statusCode !== 'success') throw new Error('Expected a simulated transaction')
	return {
		transactionToSimulate: pending.transactionToSimulate.transaction.value,
		visualised: pending.popupVisualisation.data.visualizedSimulationState.visualizedBlocks.flatMap((block) => block.simulatedAndVisualizedTransactions.map((transaction) => transaction.transaction.value)),
	}
}

const getPendingRequestsSentToDialog = (sentMessages: readonly RuntimeMessage[]) => sentMessages.flatMap((message) => {
	if (message.method !== 'popup_update_confirm_transaction_dialog_pending_transactions') return []
	return [UpdateConfirmTransactionDialogPendingTransactions.parse({ method: message.method, data: message.data }).data.pendingTransactionAndSignableMessages]
})

test('a simulation refresh that outlives its request does not store into a replacement under the same request id', async () => {
	const connections = await startPageConnection()
	await sendTransactionFromPage(connections, 0n)
	const pause = pauseFirstRpcRequest('eth_getTransactionCount')
	try {
		const refresh = modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
		await waitUntilReached(pause.reached, refresh, 'reaching the paused RPC request')
		await closeConfirmationPopup(connections)
		await sendTransactionFromPage(connections, ONE_ETHER)
		const replacement = await getOnlyPendingRequest()
		const dialogUpdatesBeforeRefreshFinished = browserMock.sentMessages.length
		pause.release()
		await refresh

		const stored = await getOnlyPendingRequest()
		assert.equal(stored.instanceId, replacement.instanceId)
		assert.equal(getRequestedValue(stored), ONE_ETHER)
		assert.deepEqual(getSimulatedValues(stored), { transactionToSimulate: ONE_ETHER, visualised: [ONE_ETHER] })
		for (const pendingRequests of getPendingRequestsSentToDialog(browserMock.sentMessages.slice(dialogUpdatesBeforeRefreshFinished))) {
			for (const pending of pendingRequests) assert.deepEqual(getSimulatedValues(pending), { transactionToSimulate: ONE_ETHER, visualised: [ONE_ETHER] })
		}
	} finally {
		pause.restore()
	}
})

test('a simulation refresh that stored its result shows the dialog only a replacement sent under the same request id before its dialog update', async () => {
	const connections = await startPageConnection()
	await sendTransactionFromPage(connections, 0n)
	const replaced = await getOnlyPendingRequest()
	const pendingRequestsWrites = watchPendingRequestsWrites()
	const pause = pauseFirstRpcRequest('eth_blockNumber', pendingRequestsWrites.hasWritten)
	try {
		const refresh = modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
		await waitUntilReached(pause.reached, refresh, 'updating the dialog after storing its result')
		browserMock.setStorageSetHandler(undefined)
		await closeConfirmationPopup(connections)
		await sendTransactionFromPage(connections, ONE_ETHER)
		const replacement = await getOnlyPendingRequest()
		const dialogUpdatesBeforeRefreshFinished = browserMock.sentMessages.length
		pause.release()
		await refresh

		assert.notEqual(replacement.instanceId, replaced.instanceId)
		assert.equal((await getOnlyPendingRequest()).instanceId, replacement.instanceId)
		const shownPendingRequests = getPendingRequestsSentToDialog(browserMock.sentMessages.slice(dialogUpdatesBeforeRefreshFinished))
		assert.equal(shownPendingRequests.length, 1)
		const shown = shownPendingRequests.flat()
		assert.deepEqual(shown.map((pending) => pending.type === 'Transaction' ? pending.instanceId : undefined), [replacement.instanceId])
		for (const pending of shown) assert.deepEqual(getSimulatedValues(pending), { transactionToSimulate: ONE_ETHER, visualised: [ONE_ETHER] })
	} finally {
		browserMock.setStorageSetHandler(undefined)
		pause.restore()
	}
})

test('a simulation refresh that stored its result does not show the dialog its request once that request is resolved before its dialog update', async () => {
	const connections = await startPageConnection()
	await sendTransactionFromPage(connections, 0n)
	const pendingRequestsWrites = watchPendingRequestsWrites()
	const pause = pauseFirstRpcRequest('eth_blockNumber', pendingRequestsWrites.hasWritten)
	try {
		const refresh = modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
		await waitUntilReached(pause.reached, refresh, 'updating the dialog after storing its result')
		browserMock.setStorageSetHandler(undefined)
		await closeConfirmationPopup(connections)
		const dialogUpdatesBeforeRefreshFinished = browserMock.sentMessages.length
		pause.release()
		await refresh

		assert.equal((await modules.getPendingTransactionsAndMessages()).length, 0)
		assert.deepEqual(getPendingRequestsSentToDialog(browserMock.sentMessages.slice(dialogUpdatesBeforeRefreshFinished)), [])
	} finally {
		browserMock.setStorageSetHandler(undefined)
		pause.restore()
	}
})

test('a confirmation dialog bootstrap carries only a replacement sent under the same request id while it awaited', async () => {
	const connections = await startPageConnection()
	await sendTransactionFromPage(connections, 0n)
	const replaced = await getOnlyPendingRequest()
	const pause = pauseFirstRpcRequest('eth_blockNumber')
	try {
		const bootstrap = modules.popupReadyAndListening(simulator.ethereum, connections, 'confirmTransaction')
		await waitUntilReached(pause.reached, bootstrap, 'reaching the paused RPC request')
		await closeConfirmationPopup(connections)
		await sendTransactionFromPage(connections, ONE_ETHER)
		const replacement = await getOnlyPendingRequest()
		pause.release()
		const reply = await bootstrap

		assert.notEqual(replacement.instanceId, replaced.instanceId)
		const bootstrapped = reply?.data.confirmTransactionBootstrap?.pendingTransactionAndSignableMessages ?? []
		assert.deepEqual(bootstrapped.map((pending) => pending.type === 'Transaction' ? pending.instanceId : undefined), [replacement.instanceId])
	} finally {
		pause.restore()
	}
})

test('a transaction metadata refresh that outlives its request does not store into a replacement under the same request id', async () => {
	const connections = await startPageConnection()
	await sendTransactionFromPage(connections, 0n)
	const replaced = await getOnlyPendingRequest()
	const pause = pauseFirstRpcRequest('eth_getCode')
	try {
		const refresh = modules.refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService, undefined)
		await waitUntilReached(pause.reached, refresh, 'reaching the paused RPC request')
		await closeConfirmationPopup(connections)
		await sendTransactionFromPage(connections, ONE_ETHER)
		const replacement = await getOnlyPendingRequest()
		const dialogUpdatesBeforeRefreshFinished = browserMock.sentMessages.length
		pause.release()
		await refresh

		const stored = await getOnlyPendingRequest()
		assert.equal(stored.instanceId, replacement.instanceId)
		assert.equal(getRequestedValue(stored), ONE_ETHER)
		assert.deepEqual(getSimulatedValues(stored), { transactionToSimulate: ONE_ETHER, visualised: [ONE_ETHER] })
		const shownInstanceIds = getPendingRequestsSentToDialog(browserMock.sentMessages.slice(dialogUpdatesBeforeRefreshFinished)).flat().map((pending) => pending.type === 'Transaction' ? pending.instanceId : undefined)
		assert.equal(shownInstanceIds.includes(replaced.instanceId), false)
	} finally {
		pause.restore()
	}
})

test('a transaction metadata refresh sends the dialog the pending requests stored after its awaits, not the request it stored into before that request was replaced', async () => {
	const connections = await startPageConnection()
	await sendTransactionFromPage(connections, 0n)
	const replaced = await getOnlyPendingRequest()
	const pause = pauseFirstRpcRequest('eth_blockNumber')
	try {
		const pendingRequestsWrites = watchPendingRequestsWrites()
		const refresh = modules.refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService, undefined)
		await waitUntilReached(pause.reached, refresh, 'reaching the paused RPC request')
		await waitUntilReached(pendingRequestsWrites.written, refresh, 'storing its visualisation')
		browserMock.setStorageSetHandler(undefined)
		await closeConfirmationPopup(connections)
		await sendTransactionFromPage(connections, ONE_ETHER)
		const replacement = await getOnlyPendingRequest()
		const dialogUpdatesBeforeRefreshFinished = browserMock.sentMessages.length
		pause.release()
		await refresh

		const shownPendingRequests = getPendingRequestsSentToDialog(browserMock.sentMessages.slice(dialogUpdatesBeforeRefreshFinished))
		assert.equal(shownPendingRequests.length, 1)
		const shownInstanceIds = shownPendingRequests.flat().map((pending) => pending.type === 'Transaction' ? pending.instanceId : undefined)
		assert.deepEqual(shownInstanceIds, [replacement.instanceId])
		assert.notEqual(replacement.instanceId, replaced.instanceId)
	} finally {
		browserMock.setStorageSetHandler(undefined)
		pause.restore()
	}
})

test('a message metadata refresh that outlives its request does not show the dialog the old message in place of a replacement under the same request id', async () => {
	const connections = await startPageConnection()
	await sendPersonalSignFromPage(connections, FIRST_MESSAGE)
	const pause = pauseFirstRpcRequest('eth_blockNumber')
	try {
		const refresh = modules.refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService, undefined)
		await waitUntilReached(pause.reached, refresh, 'reaching the paused RPC request')
		await closeConfirmationPopup(connections)
		await sendPersonalSignFromPage(connections, REPLACEMENT_MESSAGE)
		const dialogUpdatesBeforeRefreshFinished = browserMock.sentMessages.length
		pause.release()
		await refresh

		const shownMessages = getPendingRequestsSentToDialog(browserMock.sentMessages.slice(dialogUpdatesBeforeRefreshFinished)).flat().map((pending) => pending.originalRequestParameters.params[0])
		assert.equal(shownMessages.includes(FIRST_MESSAGE), false)
		const stored = await getOnlyPendingRequest()
		assert.equal(stored.originalRequestParameters.params[0], REPLACEMENT_MESSAGE)
	} finally {
		pause.restore()
	}
})

test('a second request under a still-pending request id does not store its simulation into the first request', async () => {
	const connections = await startPageConnection()
	await sendTransactionFromPage(connections, ONE_ETHER)
	await sendTransactionFromPage(connections, 0n)

	const [first, second] = await modules.getPendingTransactionsAndMessages()
	if (first === undefined || second === undefined) throw new Error('Expected both requests to be pending')
	assert.notEqual(first.instanceId, second.instanceId)
	assert.equal(getRequestedValue(first), ONE_ETHER)
	assert.deepEqual(getSimulatedValues(first), { transactionToSimulate: ONE_ETHER, visualised: [ONE_ETHER] })
	assert.equal(getRequestedValue(second), 0n)
	assert.deepEqual(getSimulatedValues(second), { transactionToSimulate: 0n, visualised: [0n] })
})
