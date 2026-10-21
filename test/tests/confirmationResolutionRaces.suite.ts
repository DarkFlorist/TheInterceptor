import * as assert from 'assert'
import { test } from 'bun:test'
import { createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import { activeAddress, browserMock, createWebsitePort, fakeRequestHandler, isRecord, modules, recipientAddress, simulator } from './confirmTransactionTestHarness.js'

// A page chooses its own JSON-RPC request ids, so it can send a new request under the id of one whose popup was just closed.
const pageRequestIdentifier = { requestId: -2, requestSocket: { tabId: 1, connectionName: 0n } }
const pageWebsite = { websiteOrigin: 'https://page.example', icon: undefined, title: undefined }
const SIGNED_TRANSACTION_HASH = `0x${ '11'.repeat(32) }`
const OLD_SIGNATURE = `0x${ '22'.repeat(65) }`

async function startPageConnection(messagesPostedToPage: unknown[]) {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	browserMock.setLiveWindowIds([99])
	browserMock.setLiveTabIds([99])
	const socket = pageRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, messagesPostedToPage)
	return { port, connections: new Map([[socket.tabId, { connections: { [modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: pageWebsite.websiteOrigin, approved: true, wantsToConnect: true } } }]]) }
}

type PageConnection = Awaited<ReturnType<typeof startPageConnection>>

const signerAddress = () => {
	if (activeAddress === undefined) throw new Error('Missing default active address')
	return activeAddress
}

async function sendTransactionFromPage({ connections }: PageConnection) {
	const parameters = { method: 'eth_sendTransaction' as const, params: [{ from: signerAddress(), to: recipientAddress, value: 0n, gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, input: new Uint8Array() }] as const }
	const request = { ...parameters, interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: pageRequestIdentifier }
	assert.deepEqual(await modules.openConfirmTransactionDialogForTransaction(simulator.ethereum, simulator.tokenPriceService, request, { kind: 'transaction', parameters }, false, signerAddress(), pageWebsite, connections), { type: 'doNotReply' })
}

async function sendPersonalSignFromPage({ connections }: PageConnection, message: string) {
	const parameters = { method: 'personal_sign' as const, params: [message, signerAddress()] as const }
	const request = { ...parameters, interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: pageRequestIdentifier }
	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, request, { kind: 'message', parameters }, false, signerAddress(), pageWebsite, connections), { type: 'doNotReply' })
}

async function getOnlyPendingRequest() {
	const pending = await modules.getPendingTransactionsAndMessages()
	assert.equal(pending.length, 1)
	const [request] = pending
	if (request === undefined) throw new Error('Expected one pending request')
	return request
}

async function approveAndForwardToSigner({ connections }: PageConnection) {
	const { instanceId } = await getOnlyPendingRequest()
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, connections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: pageRequestIdentifier, instanceId } }), true)
	assert.equal((await getOnlyPendingRequest()).approvalStatus.status, 'WaitingForSigner')
}

async function closeConfirmationPopup({ connections }: PageConnection) {
	const pending = await getOnlyPendingRequest()
	await modules.onCloseWindowOrTab(pending.popupOrTabId, simulator.ethereum, simulator.tokenPriceService, connections)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
}

// The wallet's successful reply to a forwarded request comes back over the page's connection, naming only the request id.
async function sendSignerSuccessToPage({ port, connections }: PageConnection, forwardedMethod: 'eth_sendTransaction' | 'personal_sign', reply: string) {
	await modules.signerReply(createTestSimulationServicesOwner({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService }), connections, port, {
		method: 'signer_reply',
		params: [{ success: true, reply, signerProviderGeneration: 1, forwardRequest: { type: 'forwardToSigner', replyWithSignersReply: true, method: forwardedMethod, params: [], requestId: pageRequestIdentifier.requestId } }],
		interceptorRequest: true,
		interceptorInternalRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 1000, requestSocket: pageRequestIdentifier.requestSocket },
	}, 'hasAccess', signerAddress())
}

// Holds the first request for the given RPC method until released, so a test can approve while a refresh is mid-flight.
function pauseFirstRpcRequest(method: string) {
	const originalJsonRpcRequest = fakeRequestHandler.jsonRpcRequest
	let markReached: () => void = () => undefined
	let release: () => void = () => undefined
	const reached = new Promise<void>((resolve) => { markReached = () => { resolve() } })
	const released = new Promise<void>((resolve) => { release = () => { resolve() } })
	let paused = false
	fakeRequestHandler.jsonRpcRequest = async (rpcRequest) => {
		if (!paused && rpcRequest.method === method) {
			paused = true
			markReached()
			await released
		}
		return await originalJsonRpcRequest(rpcRequest)
	}
	return { reached, release, restore: () => { fakeRequestHandler.jsonRpcRequest = originalJsonRpcRequest } }
}

// Captures the next read of the pending requests and holds it until released, so the reader continues with what was stored when it read.
function holdNextPendingRequestsRead() {
	let markReached: () => void = () => undefined
	let release: () => void = () => undefined
	const reached = new Promise<void>((resolve) => { markReached = () => { resolve() } })
	const released = new Promise<void>((resolve) => { release = () => { resolve() } })
	let held = false
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		const isPendingRequestsRead = keys === 'pendingTransactionsAndMessages' || (Array.isArray(keys) && keys.includes('pendingTransactionsAndMessages'))
		if (held || !isPendingRequestsRead) return readStoredItems()
		held = true
		const storedWhenRead = readStoredItems()
		markReached()
		await released
		return storedWhenRead
	})
	return { reached, release, restore: () => { browserMock.setStorageGetHandler(undefined) } }
}

test('a metadata refresh that finishes after the request was approved keeps it waiting for the signer, so the wallet reply resolves it once', async () => {
	const messagesPostedToPage: unknown[] = []
	const page = await startPageConnection(messagesPostedToPage)
	await sendTransactionFromPage(page)
	const pause = pauseFirstRpcRequest('eth_getCode')
	try {
		const refresh = modules.refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService, undefined)
		await pause.reached
		await approveAndForwardToSigner(page)
		pause.release()
		await refresh
		assert.equal((await getOnlyPendingRequest()).approvalStatus.status, 'WaitingForSigner')

		await sendSignerSuccessToPage(page, 'eth_sendTransaction', SIGNED_TRANSACTION_HASH)

		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
		const transactionHashReplies = messagesPostedToPage.filter((message) => isRecord(message) && message.requestId === pageRequestIdentifier.requestId && message.result === SIGNED_TRANSACTION_HASH)
		assert.equal(transactionHashReplies.length, 1)
	} finally {
		pause.restore()
	}
})

test('a wallet reply that raced a popup close neither clears nor answers the request the page sent next under the same request id', async () => {
	const messagesPostedToPage: unknown[] = []
	const page = await startPageConnection(messagesPostedToPage)
	await sendPersonalSignFromPage(page, 'first message')
	await approveAndForwardToSigner(page)
	const hold = holdNextPendingRequestsRead()
	try {
		// The reply reads the forwarded request, then waits while the user closes the popup and the page sends a new request under the same id.
		const staleReply = sendSignerSuccessToPage(page, 'personal_sign', OLD_SIGNATURE)
		await hold.reached
		await closeConfirmationPopup(page)
		await sendPersonalSignFromPage(page, 'replacement message')
		const replacement = await getOnlyPendingRequest()
		assert.equal(replacement.approvalStatus.status, 'WaitingForUser')
		hold.release()
		await staleReply

		assert.deepEqual(await getOnlyPendingRequest(), replacement)
		assert.equal(messagesPostedToPage.some((message) => isRecord(message) && message.result === OLD_SIGNATURE), false)
	} finally {
		hold.restore()
	}
})
