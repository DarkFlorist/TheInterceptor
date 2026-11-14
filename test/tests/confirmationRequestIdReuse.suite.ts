import * as assert from 'assert'
import { setSystemTime, test } from 'bun:test'
import { UpdateConfirmTransactionDialogPendingTransactions } from '../../app/ts/types/interceptor-messages.js'
import { PendingRequestInstanceId, type PendingTransactionOrSignableMessage, type PopupPendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import { createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import { activeAddress, browserMock, createWebsitePort, fakeRequestHandler, isRecord, modules, recipientAddress, type RuntimeMessage, simulator } from './confirmTransactionTestHarness.js'

// A page chooses its own JSON-RPC request ids, so it can send a new request under the id of one whose popup was just closed, or of one that is still pending.
const pageRequestIdentifier = { requestId: -2, requestSocket: { tabId: 1, connectionName: 0n } }
const pageWebsite = { websiteOrigin: 'https://page.example', icon: undefined, title: undefined }
const ONE_ETHER = 10n ** 18n
const FIRST_MESSAGE = '0x6669727374'
const REPLACEMENT_MESSAGE = '0x7265706c6163656d656e74'

async function startPageConnection(messagesPostedToPage: unknown[] = []) {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	browserMock.setLiveWindowIds([99])
	browserMock.setLiveTabIds([99])
	const socket = pageRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, messagesPostedToPage)
	return new Map([[socket.tabId, { connections: { [modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: pageWebsite.websiteOrigin, approved: true, wantsToConnect: true } } }]])
}

type PageConnections = Awaited<ReturnType<typeof startPageConnection>>

async function sendTransactionFromPage(connections: PageConnections, value: bigint, simulationMode = false) {
	const parameters = { method: 'eth_sendTransaction' as const, params: [{ from: activeAddress, to: recipientAddress, value, gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, input: new Uint8Array() }] as const }
	const request = { ...parameters, interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: pageRequestIdentifier }
	const reply = await modules.openConfirmTransactionDialogForTransaction(simulator.ethereum, simulator.tokenPriceService, request, { kind: 'transaction', parameters }, simulationMode, activeAddress, pageWebsite, connections)
	assert.deepEqual(reply, { type: 'doNotReply' })
}

async function sendPersonalSignFromPage(connections: PageConnections, message: string, simulationMode = false) {
	const parameters = { method: 'personal_sign' as const, params: [message, activeAddress] as const }
	const request = { ...parameters, interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: pageRequestIdentifier }
	const reply = await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, request, { kind: 'message', parameters }, simulationMode, activeAddress, pageWebsite, connections)
	assert.deepEqual(reply, { type: 'doNotReply' })
}

async function getOnlyPendingRequest() {
	const pending = await modules.getPendingTransactionsAndMessages()
	assert.equal(pending.length, 1)
	const [request] = pending
	if (request === undefined) throw new Error('Expected one pending request')
	return request
}

// In simulation mode an accepted request joins the simulation stack under its transaction or message identifier.
async function acceptPendingRequest(connections: PageConnections) {
	await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, connections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: pageRequestIdentifier } })
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 0)
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

test('a transaction reusing the request id of one already in the simulation stack is shown its own simulation', async () => {
	const connections = await startPageConnection()
	await sendTransactionFromPage(connections, 0n, true)
	await acceptPendingRequest(connections)
	await sendTransactionFromPage(connections, ONE_ETHER, true)
	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)

	const [stacked] = (await modules.getInterceptorTransactionStack()).operations
	const replacement = await getOnlyPendingRequest()
	if (stacked?.type !== 'Transaction' || replacement.type !== 'Transaction' || replacement.transactionOrMessageCreationStatus !== 'Simulated' || replacement.popupVisualisation.statusCode !== 'success') throw new Error('Expected a stacked transaction and a simulated replacement')
	assert.equal(stacked.preSimulationTransaction.signedTransaction.value, 0n)
	const { getResultsForTransaction } = await import('../../app/ts/components/pages/ConfirmTransaction.js')
	const shownSimulation = getResultsForTransaction(replacement.popupVisualisation.data.visualizedSimulationState, replacement.transactionIdentifier)
	assert.equal(shownSimulation?.transaction.value, ONE_ETHER)
	assert.notEqual(replacement.transactionIdentifier, stacked.preSimulationTransaction.transactionIdentifier)
})

test('a message reusing the request id of one already in the simulation stack is removed from the stack on its own', async () => {
	const connections = await startPageConnection()
	await sendPersonalSignFromPage(connections, FIRST_MESSAGE, true)
	await acceptPendingRequest(connections)
	await sendPersonalSignFromPage(connections, REPLACEMENT_MESSAGE, true)
	await acceptPendingRequest(connections)

	const getStackedMessages = async () => (await modules.getInterceptorTransactionStack()).operations.flatMap((operation) => operation.type === 'Message' ? [operation.signedMessageTransaction] : [])
	const [first, second] = await getStackedMessages()
	if (first === undefined || second === undefined) throw new Error('Expected both messages in the simulation stack')
	await modules.removeTransactionOrSignedMessage(simulator.ethereum, simulator.tokenPriceService, { method: 'popup_removeTransactionOrSignedMessage', data: { type: 'Message', messageIdentifier: second.messageIdentifier } })
	assert.deepEqual((await getStackedMessages()).map((message) => message.originalRequestParameters.params[0]), [FIRST_MESSAGE])
	assert.notEqual(second.messageIdentifier, first.messageIdentifier)
})

test('a governance execution request for a closed request does not simulate or answer for a replacement that reused its request id', async () => {
	const connections = await startPageConnection()
	await sendTransactionFromPage(connections, 0n)
	const closed = await getOnlyPendingRequest()
	if (closed.type !== 'Transaction') throw new Error('Expected a pending transaction')
	await closeConfirmationPopup(connections)
	await sendTransactionFromPage(connections, ONE_ETHER)
	const replacement = await getOnlyPendingRequest()
	if (replacement.type !== 'Transaction') throw new Error('Expected a pending transaction')
	const messagesBeforeRequest = browserMock.sentMessages.length

	await assert.rejects(
		modules.simulateGovernanceContractExecutionOnPass(simulator.ethereum, simulator.tokenPriceService, { method: 'popup_simulateGovernanceContractExecution', data: { transactionIdentifier: closed.transactionIdentifier } }),
		/Could not find transactionIdentifier/u,
	)
	assert.notEqual(replacement.transactionIdentifier, closed.transactionIdentifier)
	assert.equal(browserMock.sentMessages.slice(messagesBeforeRequest).some((message) => message.method === 'popup_simulateExecutionReply'), false)
})

test('pending request instance ids parse a string as it is and a missing id from before instance ids existed as the legacy id, and nothing else', () => {
	const instanceId = crypto.randomUUID()
	assert.deepEqual(PendingRequestInstanceId.safeParse(undefined), { success: true, value: 'legacy' })
	assert.deepEqual(PendingRequestInstanceId.safeParse(instanceId), { success: true, value: instanceId })
	for (const invalid of [5, null, { instanceId }]) assert.equal(PendingRequestInstanceId.safeParse(invalid).success, false)
})

const SIGNED_TRANSACTION_HASH = `0x${ '11'.repeat(32) }`
const signerReplies = [
	{ branch: 'success', reply: { success: true, reply: SIGNED_TRANSACTION_HASH } },
	{ branch: 'user rejected', reply: { success: false, error: { code: 4001, message: 'User rejected the request.' } } },
	{ branch: 'error', reply: { success: false, error: { code: -32603, message: 'The wallet failed.' } } },
] as const

async function approveAndForwardToSigner(connections: PageConnections) {
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, connections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: pageRequestIdentifier } }), true)
	assert.equal((await getOnlyPendingRequest()).approvalStatus.status, 'WaitingForSigner')
}

// The wallet's reply to a forwarded 0 ether transaction comes back over the page's connection, naming only the request id; a reply from a port that is no longer the page's connection takes the connection-replaced branch.
async function sendSignerReplyToPage(connections: PageConnections, reply: (typeof signerReplies)[number]['reply'], fromReplacedConnection = false) {
	const socket = pageRequestIdentifier.requestSocket
	const currentPort = connections.get(socket.tabId)?.connections[modules.websiteSocketToString(socket)]?.port
	if (currentPort === undefined) throw new Error('Missing page connection')
	const port = fromReplacedConnection ? createWebsitePort(socket, 0, []) : currentPort
	const forwardedParameters = [{ from: activeAddress, to: recipientAddress, value: 0n, gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, input: new Uint8Array() }]
	await modules.signerReply(createTestSimulationServicesOwner({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService }), connections, port, {
		method: 'signer_reply',
		params: [{ ...reply, signerProviderGeneration: 1, forwardRequest: { type: 'forwardToSigner', replyWithSignersReply: true, method: 'eth_sendTransaction', params: forwardedParameters, requestId: pageRequestIdentifier.requestId } }],
		interceptorRequest: true,
		interceptorInternalRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 1000, requestSocket: socket },
	}, 'hasAccess', activeAddress)
}

const signerReplyCases = [...signerReplies.map((signerReply) => ({ ...signerReply, fromReplacedConnection: false })), { branch: 'connection replaced', reply: signerReplies[0].reply, fromReplacedConnection: true }]

for (const { branch, reply, fromReplacedConnection } of signerReplyCases) {
	test(`a signer reply (${ branch }) for a forwarded request leaves a newer request under the reused request id untouched`, async () => {
		const messagesPostedToPage: unknown[] = []
		const connections = await startPageConnection(messagesPostedToPage)
		await sendTransactionFromPage(connections, 0n)
		await approveAndForwardToSigner(connections)
		await closeConfirmationPopup(connections)
		await sendTransactionFromPage(connections, ONE_ETHER)
		// The newer request is blocked by an error the user has to clear, so each branch shows whether it touched it, including a user-rejected reply that would reset it to waiting for the user.
		await modules.updateStoredPendingRequest(pageRequestIdentifier, async (pending) => ({ ...pending, approvalStatus: { status: 'SignerError' as const, code: -32010, message: 'Select a current Gnosis Safe owner in the signer wallet.' } }))
		const newer = await getOnlyPendingRequest()
		const messagesPostedBeforeReply = messagesPostedToPage.length

		await sendSignerReplyToPage(connections, reply, fromReplacedConnection)

		assert.deepEqual(await getOnlyPendingRequest(), newer)
		assert.deepEqual(messagesPostedToPage.slice(messagesPostedBeforeReply), [])
	})

	test(`a signer reply (${ branch }) still resolves the forwarded request under its request id`, async () => {
		const messagesPostedToPage: unknown[] = []
		const connections = await startPageConnection(messagesPostedToPage)
		await sendTransactionFromPage(connections, 0n)
		await approveAndForwardToSigner(connections)

		await sendSignerReplyToPage(connections, reply, fromReplacedConnection)

		const pending = await modules.getPendingTransactionsAndMessages()
		if (branch === 'success') {
			assert.deepEqual(pending, [])
			assert.equal(messagesPostedToPage.some((message) => isRecord(message) && message.requestId === pageRequestIdentifier.requestId && message.result === SIGNED_TRANSACTION_HASH), true)
			return
		}
		assert.equal(pending[0]?.approvalStatus.status, branch === 'user rejected' ? 'WaitingForUser' : 'SignerError')
	})
}

test('a metadata refresh that finishes after the request was approved keeps it waiting for the signer, so the wallet reply resolves it once', async () => {
	const messagesPostedToPage: unknown[] = []
	const connections = await startPageConnection(messagesPostedToPage)
	await sendTransactionFromPage(connections, 0n)
	const pause = pauseFirstRpcRequest('eth_getCode')
	try {
		const refresh = modules.refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService, undefined)
		await waitUntilReached(pause.reached, refresh, 'reaching the paused RPC request')
		await approveAndForwardToSigner(connections)
		pause.release()
		await refresh
		assert.equal((await getOnlyPendingRequest()).approvalStatus.status, 'WaitingForSigner')

		await sendSignerReplyToPage(connections, signerReplies[0].reply)

		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
		const transactionHashReplies = messagesPostedToPage.filter((message) => isRecord(message) && message.requestId === pageRequestIdentifier.requestId && message.result === SIGNED_TRANSACTION_HASH)
		assert.equal(transactionHashReplies.length, 1)
	} finally {
		pause.restore()
	}
})

test('a metadata refresh does not store its visualisation over a re-simulation of a changed transaction in the same second', async () => {
	// Stored simulation timestamps keep only whole seconds; holding the clock still makes both runs share them.
	setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
	try {
		const connections = await startPageConnection()
		await sendTransactionFromPage(connections, 0n)
		const firstRun = await getOnlyPendingRequest()
		if (firstRun.type !== 'Transaction' || firstRun.transactionOrMessageCreationStatus !== 'Simulated' || firstRun.popupVisualisation.statusCode !== 'success') throw new Error('Expected a simulated transaction')
		const pause = pauseFirstRpcRequest('eth_getCode')
		try {
			const refresh = modules.refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService, undefined)
			await waitUntilReached(pause.reached, refresh, 'reaching the paused RPC request')
			await modules.forceSetGasLimitForTransaction(simulator.ethereum, simulator.tokenPriceService, { method: 'popup_forceSetGasLimitForTransaction', data: { transactionIdentifier: firstRun.transactionIdentifier, gasLimit: 42_000n } })
			const secondRun = await getOnlyPendingRequest()
			if (secondRun.type !== 'Transaction' || secondRun.transactionOrMessageCreationStatus !== 'Simulated' || secondRun.popupVisualisation.statusCode !== 'success') throw new Error('Expected a re-simulated transaction')
			assert.equal(secondRun.popupVisualisation.data.simulationStartedTimestamp.getTime(), firstRun.popupVisualisation.data.simulationStartedTimestamp.getTime())
			assert.equal(secondRun.popupVisualisation.data.simulationState.simulationConductedTimestamp.getTime(), firstRun.popupVisualisation.data.simulationState.simulationConductedTimestamp.getTime())
			pause.release()
			await refresh
		} finally {
			pause.restore()
		}

		const stored = await getOnlyPendingRequest()
		if (stored.type !== 'Transaction' || stored.transactionOrMessageCreationStatus !== 'Simulated' || stored.popupVisualisation.statusCode !== 'success') throw new Error('Expected a simulated transaction')
		assert.equal(stored.transactionToSimulate.transaction.gas, 42_000n)
		const visualisedGas = stored.popupVisualisation.data.visualizedSimulationState.visualizedBlocks.flatMap((block) => block.simulatedAndVisualizedTransactions.map((transaction) => transaction.transaction.gas))
		assert.deepEqual(visualisedGas, [42_000n])
	} finally {
		setSystemTime()
	}
})
