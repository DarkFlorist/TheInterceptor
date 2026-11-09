import * as assert from 'assert'
import { test } from 'bun:test'
import { createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import { SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import { activeAddress, addressString, browserMock, createSafeAddressBookEntry, createSafeTx, createWebsitePort, fakeRequestHandler, fakeRpcNetwork, fakeSafeContract, getSafeTxHash, isRecord, modules, recipientAddress, safeTestOwnerAccount, safeTestOwnerAddress, safeTxToTypedDataJson, simulator, waitForPendingTransactionsToClear, withSilencedConsole, EIP712Message } from './confirmTransactionTestHarness.js'

// A page chooses its own JSON-RPC request ids, so it can send a new request under the id of one whose popup was just closed.
const pageRequestIdentifier = { requestId: -2, requestSocket: { tabId: 1, connectionName: 0n } }
const pageWebsite = { websiteOrigin: 'https://page.example', icon: undefined, title: undefined }
const SIGNED_TRANSACTION_HASH = `0x${ '11'.repeat(32) }`
const OLD_SIGNATURE = `0x${ '22'.repeat(65) }`

async function startPageConnection(messagesPostedToPage: unknown[], onMessagePostedToPage?: (message: unknown) => void) {
	await modules.seedPendingRequestStorage({ pendingTransactionsAndMessages: [] })
	browserMock.setLiveWindowIds([99])
	browserMock.setLiveTabIds([99])
	const socket = pageRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, messagesPostedToPage, onMessagePostedToPage)
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
async function sendSignerSuccessToPage({ port, connections }: PageConnection, forwardedMethod: 'eth_sendTransaction' | 'eth_signTypedData_v4' | 'personal_sign', reply: string) {
	await modules.signerReply(createTestSimulationServicesOwner({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService }), connections, port, {
		method: 'signer_reply',
		params: [{ success: true, reply, signerProviderGeneration: 1, forwardRequest: { type: 'forwardToSigner', replyWithSignersReply: true, method: forwardedMethod, params: [], requestId: pageRequestIdentifier.requestId } }],
		interceptorRequest: true,
		interceptorInternalRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 1000, requestSocket: pageRequestIdentifier.requestSocket },
	}, 'hasAccess', signerAddress())
}

// Holds the first request for the given RPC method, or for any method, until released, so a test can act while a resolution or refresh is mid-flight.
function pauseFirstRpcRequest(method?: string) {
	const originalJsonRpcRequest = fakeRequestHandler.jsonRpcRequest
	let markReached: () => void = () => undefined
	let release: () => void = () => undefined
	const reached = new Promise<void>((resolve) => { markReached = () => { resolve() } })
	const released = new Promise<void>((resolve) => { release = () => { resolve() } })
	let paused = false
	fakeRequestHandler.jsonRpcRequest = async (rpcRequest) => {
		if (!paused && (method === undefined || rpcRequest.method === method)) {
			paused = true
			markReached()
			await released
		}
		return await originalJsonRpcRequest(rpcRequest)
	}
	return { reached, release, restore: () => { fakeRequestHandler.jsonRpcRequest = originalJsonRpcRequest } }
}

// Captures the next storage read of a matching key and holds it until released, so the reader continues with what was stored when it read.
function holdNextStorageRead(isHeldKey: (key: string) => boolean) {
	let markReached: () => void = () => undefined
	let release: () => void = () => undefined
	const reached = new Promise<void>((resolve) => { markReached = () => { resolve() } })
	const released = new Promise<void>((resolve) => { release = () => { resolve() } })
	let held = false
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		const readKeys = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : []
		if (held || !readKeys.some(isHeldKey)) return readStoredItems()
		held = true
		const storedWhenRead = readStoredItems()
		markReached()
		await released
		return storedWhenRead
	})
	return { reached, release, restore: () => { browserMock.setStorageGetHandler(undefined) } }
}

const holdNextPendingRequestsRead = () => holdNextStorageRead((key) => key === 'pendingTransactionsAndMessages')

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

async function getOnlySimulatedVisualisation() {
	const pending = await getOnlyPendingRequest()
	if (pending.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated' || pending.popupVisualisation.statusCode !== 'success') throw new Error('Expected a successfully simulated pending transaction')
	return { pending, visualisation: pending.popupVisualisation }
}

type SimulatedVisualisation = Awaited<ReturnType<typeof getOnlySimulatedVisualisation>>

// Stores the pending transaction with its visualisation data changed, keeping everything else as stored.
async function storeVisualisationData({ pending, visualisation }: SimulatedVisualisation, data: SimulatedVisualisation['visualisation']['data']) {
	await modules.seedPendingRequestStorage({ pendingTransactionsAndMessages: [{ ...pending, popupVisualisation: { ...visualisation, data } }] })
}

// Clears the visualised address book entries of the stored run, so a test can see whether a metadata refresh stored its re-visualisation of that run.
async function sendTransactionWithClearedAddressBookEntries(page: PageConnection) {
	await sendTransactionFromPage(page)
	const simulated = await getOnlySimulatedVisualisation()
	assert.notDeepEqual(simulated.visualisation.data.addressBookEntries, [], 'the simulation visualises the addresses it touches')
	await storeVisualisationData(simulated, { ...simulated.visualisation.data, addressBookEntries: [] })
	return await getOnlySimulatedVisualisation()
}

test('a metadata refresh stores its re-visualisation of the run it read, which keeps its run id', async () => {
	const page = await startPageConnection([])
	const { visualisation } = await sendTransactionWithClearedAddressBookEntries(page)
	await modules.refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService, undefined)
	const refreshed = await getOnlySimulatedVisualisation()
	assert.equal(refreshed.visualisation.data.simulationRunId, visualisation.data.simulationRunId)
	assert.notDeepEqual(refreshed.visualisation.data.addressBookEntries, [])
})

test('a metadata refresh still stores its re-visualisation when a field of the same run changed while it ran', async () => {
	const page = await startPageConnection([])
	await sendTransactionWithClearedAddressBookEntries(page)
	const pause = pauseFirstRpcRequest('eth_getCode')
	try {
		const refresh = modules.refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService, undefined)
		await pause.reached
		// The run itself is unchanged, but a field stored with it differs from what the refresh read, here the time its simulation state was recorded.
		const stored = await getOnlySimulatedVisualisation()
		const { simulationState } = stored.visualisation.data
		await storeVisualisationData(stored, { ...stored.visualisation.data, simulationState: { ...simulationState, simulationConductedTimestamp: new Date(simulationState.simulationConductedTimestamp.getTime() + 60_000) } })
		pause.release()
		await refresh
	} finally {
		pause.release()
		pause.restore()
	}
	assert.notDeepEqual((await getOnlySimulatedVisualisation()).visualisation.data.addressBookEntries, [])
})

test('a metadata refresh does not store its re-visualisation over a newer run of the same transaction, even one that simulated identically', async () => {
	const page = await startPageConnection([])
	const { visualisation: readRun } = await sendTransactionWithClearedAddressBookEntries(page)
	const pause = pauseFirstRpcRequest('eth_getCode')
	let newerRun: SimulatedVisualisation['visualisation'] | undefined
	try {
		const refresh = modules.refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService, undefined)
		await pause.reached
		// The transaction is simulated again while the refresh visualises the run it read. The newer run is stored as producing exactly what the read run did, so only its run id tells them apart.
		await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
		const stored = await getOnlySimulatedVisualisation()
		await storeVisualisationData(stored, { ...readRun.data, simulationRunId: stored.visualisation.data.simulationRunId })
		newerRun = (await getOnlySimulatedVisualisation()).visualisation
		assert.notEqual(newerRun.data.simulationRunId, readRun.data.simulationRunId)
		pause.release()
		await refresh
	} finally {
		pause.release()
		pause.restore()
	}
	assert.deepEqual((await getOnlySimulatedVisualisation()).visualisation, newerRun)
})

// Terminal replies are the results and errors posted to the page for the request id; forwards to the wallet are not terminal.
const getTerminalRepliesTo = (messagesPostedToPage: readonly unknown[], requestId: number) => messagesPostedToPage.filter((message) => isRecord(message) && message.type === 'result' && message.requestId === requestId)

test('a wallet reply racing a popup close gives the forwarded request one terminal outcome and leaves the request the page sends next under the same id untouched', async () => {
	const messagesPostedToPage: unknown[] = []
	const page = await startPageConnection(messagesPostedToPage)
	await sendPersonalSignFromPage(page, 'first message')
	await approveAndForwardToSigner(page)
	const hold = holdNextPendingRequestsRead()
	try {
		// The reply reads the forwarded request and is held while the user closes the popup and the page then sends a new request under the same id. Resolutions of one request run one at a time, so the close may finish before or after the held reply.
		const reply = sendSignerSuccessToPage(page, 'personal_sign', OLD_SIGNATURE)
		await hold.reached
		const closeThenSendAgain = (async () => {
			await closeConfirmationPopup(page)
			await sendPersonalSignFromPage(page, 'replacement message')
		})()
		await new Promise((resolve) => setTimeout(resolve, 20))
		hold.release()
		await reply
		await closeThenSendAgain

		assert.equal((await getOnlyPendingRequest()).approvalStatus.status, 'WaitingForUser')
		assert.equal(getTerminalRepliesTo(messagesPostedToPage, pageRequestIdentifier.requestId).length, 1)
	} finally {
		hold.restore()
	}
})

test('a wallet reply arriving over another connection in the same tab does not resolve a request forwarded to the signer', async () => {
	const messagesPostedToPage: unknown[] = []
	const page = await startPageConnection(messagesPostedToPage)
	await sendPersonalSignFromPage(page, 'first message')
	await approveAndForwardToSigner(page)
	// Another frame or reloaded document in the tab has its own connection, and the background derives a reply's request socket from the port it arrived on.
	const otherSocket = { tabId: pageRequestIdentifier.requestSocket.tabId, connectionName: 1n }
	const messagesPostedToOtherConnection: unknown[] = []
	const otherPort = createWebsitePort(otherSocket, 1, messagesPostedToOtherConnection)
	const tabConnection = page.connections.get(otherSocket.tabId)
	if (tabConnection === undefined) throw new Error('Missing page tab connection')
	tabConnection.connections[modules.websiteSocketToString(otherSocket)] = { port: otherPort, socket: otherSocket, websiteOrigin: pageWebsite.websiteOrigin, approved: true, wantsToConnect: true }

	await modules.signerReply(createTestSimulationServicesOwner({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService }), page.connections, otherPort, {
		method: 'signer_reply',
		params: [{ success: true, reply: OLD_SIGNATURE, signerProviderGeneration: 1, forwardRequest: { type: 'forwardToSigner', replyWithSignersReply: true, method: 'personal_sign', params: [], requestId: pageRequestIdentifier.requestId } }],
		interceptorRequest: true,
		interceptorInternalRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 1000, requestSocket: otherSocket },
	}, 'hasAccess', signerAddress())

	assert.equal((await getOnlyPendingRequest()).approvalStatus.status, 'WaitingForSigner')
	assert.equal(getTerminalRepliesTo(messagesPostedToPage, pageRequestIdentifier.requestId).length, 0)
	assert.equal(getTerminalRepliesTo(messagesPostedToOtherConnection, pageRequestIdentifier.requestId).length, 0)

	// The reply over the request's own connection still completes it.
	await sendSignerSuccessToPage(page, 'personal_sign', OLD_SIGNATURE)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.equal(getTerminalRepliesTo(messagesPostedToPage, pageRequestIdentifier.requestId).length, 1)
})

// The page replaces the reviewed request with a new instance under the same request id, as after a popup close and resend.
async function replaceWithNewInstance(reviewed: Awaited<ReturnType<typeof getOnlyPendingRequest>>, replacementGas: bigint) {
	if (reviewed.type !== 'Transaction' || reviewed.originalRequestParameters.method !== 'eth_sendTransaction') throw new Error('Expected a pending eth_sendTransaction')
	const originalRequestParameters = { ...reviewed.originalRequestParameters, params: [{ ...reviewed.originalRequestParameters.params[0], gas: replacementGas }] as const }
	await modules.seedPendingRequestStorage({ pendingTransactionsAndMessages: [{ ...reviewed, instanceId: 'replacement instance', originalRequestParameters }] })
	return await getOnlyPendingRequest()
}

test('a gas limit edit whose read raced a replacement request under the same id does not change the replacement', async () => {
	const page = await startPageConnection([])
	await sendTransactionFromPage(page)
	const reviewed = await getOnlyPendingRequest()
	if (reviewed.type !== 'Transaction') throw new Error('Expected a pending transaction')
	const { setGasLimitForTransaction } = await import('../../app/ts/background/windows/confirmTransaction.js')
	const hold = holdNextPendingRequestsRead()
	try {
		// The edit reads the reviewed request and is held while the page replaces it under the same id.
		const edit = setGasLimitForTransaction(reviewed.transactionIdentifier, 99_999n)
		await hold.reached
		const replacement = await replaceWithNewInstance(reviewed, 88_888n)
		hold.release()
		await edit
		assert.deepEqual(await getOnlyPendingRequest(), replacement)
	} finally {
		hold.release()
		hold.restore()
	}
})

test('a simulation refresh that finishes after the page replaced the request under the same id does not overwrite the replacement', async () => {
	const page = await startPageConnection([])
	await sendTransactionFromPage(page)
	const reviewed = await getOnlyPendingRequest()
	const pause = pauseFirstRpcRequest()
	try {
		// The refresh builds and simulates the reviewed request and is held while the page replaces it under the same id.
		const refresh = modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
		await pause.reached
		const replacement = await replaceWithNewInstance(reviewed, 88_888n)
		pause.release()
		await refresh
		assert.deepEqual(await getOnlyPendingRequest(), replacement)
	} finally {
		pause.release()
		pause.restore()
	}
})

// A Gnosis Safe proposal from the page, while the wallet has walletOwner selected.
async function sendSafeProposalFromPage({ connections }: PageConnection, walletOwner: bigint) {
	const safeAddress = signerAddress()
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({ simulationMode: false, rpcNetwork: fakeRpcNetwork, activeSigningSafeAddress: safeAddress })
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeSimulationSignerAddress: safeAddress, safeVersion: '1.4.1' })])
	await modules.updateTabState(pageRequestIdentifier.requestSocket.tabId, (state) => ({ ...state, signerName: 'MetaMask', signerAccounts: [walletOwner], activeSigningAddress: walletOwner, signerChain: fakeRpcNetwork.chainId }))
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(createSafeTx(fakeRpcNetwork.chainId, safeAddress, { to: recipientAddress, value: 0n, input: new Uint8Array() }, 0n)))
	const parameters = SendTransactionParams.parse({ method: 'eth_sendTransaction', params: [{ from: addressString(safeAddress), to: addressString(recipientAddress), value: '0x0', data: '0x', gas: '0x5208' }] })
	const request = { ...parameters, interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: pageRequestIdentifier }
	assert.deepEqual(await modules.openConfirmTransactionDialogForTransaction(simulator.ethereum, simulator.tokenPriceService, request, { kind: 'transaction', parameters }, false, safeAddress, pageWebsite, connections), { type: 'doNotReply' })
}

const approveWithSafeSignerSelection = async ({ connections }: PageConnection, instanceId: string, refreshedSafeSignerSelection?: { readonly selectedSigner: bigint, readonly verificationError: string | undefined }) => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, connections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: pageRequestIdentifier, instanceId } }, refreshedSafeSignerSelection)

const isCloseRejection = (message: unknown) => isRecord(message) && message.type === 'result' && message.requestId === pageRequestIdentifier.requestId && isRecord(message.error) && message.error.code === 4001

test('a Gnosis Safe signer refresh never moves an approval onto a request the page sent under the same id while it ran', async () => {
	const messagesPostedToPage: unknown[] = []
	const page = await startPageConnection(messagesPostedToPage)
	fakeSafeContract.owners = [safeTestOwnerAddress, recipientAddress]
	await sendSafeProposalFromPage(page, recipientAddress)
	const approved = await getOnlyPendingRequest()
	const pause = pauseFirstRpcRequest()
	try {
		// The user approves with another owner selected, so the proposal is rebuilt for that owner, and the rebuild's Safe validation is held.
		const approval = approveWithSafeSignerSelection(page, approved.instanceId, { selectedSigner: safeTestOwnerAddress, verificationError: undefined })
		await pause.reached
		// Meanwhile the user closes the popup and the page sends an identical proposal under the same request id.
		const closeThenSendAgain = (async () => {
			await modules.onCloseWindowOrTab(approved.popupOrTabId, simulator.ethereum, simulator.tokenPriceService, page.connections)
			assert.equal(await modules.appendPendingTransactionOrMessage({ ...approved, instanceId: 'replacement instance' }), true)
		})()
		await new Promise((resolve) => setTimeout(resolve, 20))
		pause.release()
		await approval
		await closeThenSendAgain
	} finally {
		pause.restore()
	}

	const replacement = await getOnlyPendingRequest()
	assert.equal(replacement.instanceId, 'replacement instance')
	assert.equal(replacement.approvalStatus.status, 'WaitingForUser')
})

test('a stale failed Gnosis Safe signer verification does not reset an approval another approval already forwarded, so the wallet reply completes it once', async () => {
	const messagesPostedToPage: unknown[] = []
	const page = await startPageConnection(messagesPostedToPage)
	fakeSafeContract.owners = [safeTestOwnerAddress, recipientAddress]
	await sendSafeProposalFromPage(page, safeTestOwnerAddress)
	const proposal = await getOnlyPendingRequest()
	if (proposal.type !== 'Transaction' || proposal.safeTransaction === undefined) throw new Error('Expected a Gnosis Safe proposal')
	const { instanceId } = proposal
	// The Gnosis Safe owner check reads the tab's wallet state before reporting the failed verification.
	const pause = holdNextStorageRead((key) => key.startsWith('tabState_'))
	try {
		// One approval carries a failed signer verification and is held in its Gnosis Safe owner check, while another approval succeeds.
		const failedApproval = approveWithSafeSignerSelection(page, instanceId, { selectedSigner: recipientAddress, verificationError: 'The wallet account could not be verified.' })
		await pause.reached
		const successfulApproval = approveWithSafeSignerSelection(page, instanceId)
		await new Promise((resolve) => setTimeout(resolve, 20))
		pause.release()
		await failedApproval
		await successfulApproval
	} finally {
		pause.restore()
	}
	assert.equal((await getOnlyPendingRequest()).approvalStatus.status, 'WaitingForSigner')

	// The wallet's owner signature completes the proposal.
	await sendSignerSuccessToPage(page, 'eth_signTypedData_v4', await safeTestOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(proposal.safeTransaction.safeTx))))

	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	const terminalReplies = getTerminalRepliesTo(messagesPostedToPage, pageRequestIdentifier.requestId)
	assert.equal(terminalReplies.length, 1)
	assert.equal(isRecord(terminalReplies[0]) && 'error' in terminalReplies[0], false)
})

for (const cleanup of ['held', 'failing'] as const) {
	test(`a wallet reply after a popup-close rejection was posted (outbox cleanup ${ cleanup }) does not answer the request a second time`, async () => {
		const messagesPostedToPage: unknown[] = []
		let rejectionPosted = false
		const page = await startPageConnection(messagesPostedToPage, (message) => { if (isCloseRejection(message)) rejectionPosted = true })
		await sendPersonalSignFromPage(page, 'first message')
		await approveAndForwardToSigner(page)
		let markCleanupReached: () => void = () => undefined
		let releaseCleanup: () => void = () => undefined
		const cleanupReached = new Promise<void>((resolve) => { markCleanupReached = () => { resolve() } })
		const cleanupReleased = new Promise<void>((resolve) => { releaseCleanup = () => { resolve() } })
		let cleanupIntercepted = false
		// After the rejection is posted, the outbox cleanup reads the queued replies; it is held, or fails once so the no-response retry finishes it.
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			const isOutboxRead = keys === 'pendingTerminalReplies' || (Array.isArray(keys) && keys.includes('pendingTerminalReplies'))
			if (!rejectionPosted || cleanupIntercepted || !isOutboxRead) return readStoredItems()
			cleanupIntercepted = true
			markCleanupReached()
			if (cleanup === 'failing') throw new Error('storage cleanup temporarily unavailable')
			await cleanupReleased
			return readStoredItems()
		})
		try {
			const closing = withSilencedConsole(async () => await modules.onCloseWindowOrTab((await getOnlyPendingRequest()).popupOrTabId, simulator.ethereum, simulator.tokenPriceService, page.connections))
			await cleanupReached
			// The wallet's signature for the forwarded request arrives while the rejection is being delivered, or after its delivery failed and before the retry.
			const walletReply = modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, page.connections, { method: 'popup_confirmDialog', data: { action: 'signerIncluded', signerReply: OLD_SIGNATURE, uniqueRequestIdentifier: pageRequestIdentifier } })
			await new Promise((resolve) => setTimeout(resolve, 20))
			releaseCleanup()
			await closing
			assert.equal(await walletReply, false)
			await waitForPendingTransactionsToClear()
		} finally {
			releaseCleanup()
			browserMock.setStorageGetHandler(undefined)
		}

		const terminalReplies = getTerminalRepliesTo(messagesPostedToPage, pageRequestIdentifier.requestId)
		assert.equal(terminalReplies.length, 1)
		assert.equal(isCloseRejection(terminalReplies[0]), true)
	})
}

const rejectionOf = (pending: Awaited<ReturnType<typeof getOnlyPendingRequest>>) => ({
	...pending.originalRequestParameters,
	type: 'result' as const,
	error: { code: 4001, message: 'User denied transaction signature' },
	uniqueRequestIdentifier: pending.uniqueRequestIdentifier,
})

// Queues a reply while its request stays pending, the state a popup-close rejection is in until it is delivered.
const keepPendingRequest = (pending: Awaited<ReturnType<typeof getOnlyPendingRequest>>) => ({ type: 'store' as const, pending })

// Resolves to 'blocked' when the promise is still waiting on a lock after a moment.
const settledOrBlocked = async <T>(promise: Promise<T>) => await Promise.race([promise, new Promise<'blocked'>((resolve) => { setTimeout(() => { resolve('blocked') }, 200) })])

// A background restart can cut a resolution off after any storage write, so each write has to leave a state the next start can continue from: a reply queued exactly when the request's outcome is decided, which means it left the queue or was claimed by its popup closing.
async function assertEveryStorageWriteKeepsReplyAndRequestConsistent(resolve: () => Promise<unknown>) {
	delete browserMock.storageState.pendingTerminalReplies
	const statesAfterEachWrite: { readonly replyIsQueued: boolean, readonly approvalStatus: string | undefined }[] = []
	browserMock.setStorageSetHandler(async (_items, writeStoredItems) => {
		writeStoredItems()
		// getPendingTransactionsAndMessages takes the pending-request lock only to recover corrupt data, so reading here while a write holds that lock cannot deadlock.
		const [pending] = await modules.getPendingTransactionsAndMessages()
		statesAfterEachWrite.push({ replyIsQueued: (await modules.getPendingTerminalReplies()).length > 0, approvalStatus: pending?.approvalStatus.status })
	})
	try {
		await resolve()
	} finally {
		browserMock.setStorageSetHandler(undefined)
	}
	assert.equal(statesAfterEachWrite.at(-1)?.replyIsQueued, true)
	for (const { replyIsQueued, approvalStatus } of statesAfterEachWrite) {
		assert.equal(replyIsQueued, approvalStatus === undefined || approvalStatus === 'ClosedWithoutResponse', `reply queued: ${ replyIsQueued }, request status: ${ approvalStatus }`)
	}
}

test('a crash after any storage write of a rejection leaves the reply queued exactly when the request left the queue', async () => {
	const page = await startPageConnection([])
	await sendPersonalSignFromPage(page, 'first message')
	const { instanceId } = await getOnlyPendingRequest()
	await assertEveryStorageWriteKeepsReplyAndRequestConsistent(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, new Map(), { method: 'popup_confirmDialog', data: { action: 'reject', errorString: undefined, uniqueRequestIdentifier: pageRequestIdentifier, instanceId } }))
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

test('a crash after any storage write of a wallet reply leaves the reply queued exactly when the request left the queue', async () => {
	const page = await startPageConnection([])
	await sendPersonalSignFromPage(page, 'first message')
	await approveAndForwardToSigner(page)
	await assertEveryStorageWriteKeepsReplyAndRequestConsistent(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, new Map(), { method: 'popup_confirmDialog', data: { action: 'signerIncluded', signerReply: OLD_SIGNATURE, uniqueRequestIdentifier: pageRequestIdentifier } }))
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

test('a crash after any storage write of a popup-close rejection leaves the rejection queued exactly when the request is claimed for it', async () => {
	const page = await startPageConnection([])
	await sendPersonalSignFromPage(page, 'first message')
	const { instanceId } = await getOnlyPendingRequest()
	await assertEveryStorageWriteKeepsReplyAndRequestConsistent(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, new Map(), { method: 'popup_confirmDialog', data: { action: 'noResponse', uniqueRequestIdentifier: pageRequestIdentifier, instanceId } }))
})

test('a failed storage write of a terminal outcome answers nothing and keeps the request, so the decision can be made again', async () => {
	const messagesPostedToPage: unknown[] = []
	const page = await startPageConnection(messagesPostedToPage)
	await sendPersonalSignFromPage(page, 'first message')
	delete browserMock.storageState.pendingTerminalReplies
	const { instanceId } = await getOnlyPendingRequest()
	const reject = async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, page.connections, { method: 'popup_confirmDialog', data: { action: 'reject', errorString: undefined, uniqueRequestIdentifier: pageRequestIdentifier, instanceId } })
	let failuresRemaining = 1
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if (failuresRemaining > 0 && 'pendingTransactionsAndMessages' in items) {
			failuresRemaining -= 1
			throw new Error('storage write failed')
		}
		writeStoredItems()
	})
	try {
		await assert.rejects(reject(), /storage write failed/u)
	} finally {
		browserMock.setStorageSetHandler(undefined)
	}
	assert.equal((await getOnlyPendingRequest()).approvalStatus.status, 'WaitingForUser')
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	assert.equal(getTerminalRepliesTo(messagesPostedToPage, pageRequestIdentifier.requestId).length, 0)

	await reject()
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.equal(getTerminalRepliesTo(messagesPostedToPage, pageRequestIdentifier.requestId).length, 1)
})

test('a terminal reply waiting for the reply outbox does not hold up other pending requests', async () => {
	const page = await startPageConnection([])
	await sendPersonalSignFromPage(page, 'first message')
	const pending = await getOnlyPendingRequest()
	const outboxRead = holdNextStorageRead((key) => key === 'pendingTerminalReplies')
	try {
		// The flush holds the reply delivery lock while its outbox read is held, so the rejection below waits for that lock.
		const flush = modules.flushPendingTerminalRepliesForSocket(page.connections, pageRequestIdentifier.requestSocket)
		await outboxRead.reached
		const rejection = modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, page.connections, { method: 'popup_confirmDialog', data: { action: 'reject', errorString: undefined, uniqueRequestIdentifier: pageRequestIdentifier, instanceId: pending.instanceId } })
		assert.equal(await settledOrBlocked(rejection), 'blocked')
		const unrelatedRequest = { ...pending, uniqueRequestIdentifier: { ...pageRequestIdentifier, requestId: -3 }, instanceId: 'unrelated instance' }
		assert.equal(await settledOrBlocked(modules.appendPendingTransactionOrMessage(unrelatedRequest)), true)
		outboxRead.release()
		await Promise.all([flush, rejection])
	} finally {
		outboxRead.release()
		outboxRead.restore()
	}
	assert.deepEqual((await modules.getPendingTransactionsAndMessages()).map(({ instanceId }) => instanceId), ['unrelated instance'])
})

test('a wallet reply is not queued for a request that left the signer while the reply waited for the reply outbox', async () => {
	const messagesPostedToPage: unknown[] = []
	const page = await startPageConnection(messagesPostedToPage)
	await sendPersonalSignFromPage(page, 'first message')
	await approveAndForwardToSigner(page)
	delete browserMock.storageState.pendingTerminalReplies
	const outboxRead = holdNextStorageRead((key) => key === 'pendingTerminalReplies')
	try {
		const walletReply = modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, page.connections, { method: 'popup_confirmDialog', data: { action: 'signerIncluded', signerReply: OLD_SIGNATURE, uniqueRequestIdentifier: pageRequestIdentifier } })
		await outboxRead.reached
		assert.equal(await settledOrBlocked(modules.updateStoredPendingRequest(pageRequestIdentifier, (pending) => ({ ...pending, approvalStatus: { status: 'SignerError', code: 123, message: 'wallet failed' } }))), true)
		outboxRead.release()
		assert.equal(await walletReply, false)
	} finally {
		outboxRead.release()
		outboxRead.restore()
	}
	assert.equal((await getOnlyPendingRequest()).approvalStatus.status, 'SignerError')
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	assert.equal(getTerminalRepliesTo(messagesPostedToPage, pageRequestIdentifier.requestId).length, 0)
})

test('a terminal reply is stored with its decision only: a decision that leaves the instance alone keeps the outbox as it was', async () => {
	const page = await startPageConnection([])
	await sendPersonalSignFromPage(page, 'first message')
	const pending = await getOnlyPendingRequest()
	const earlierReply = rejectionOf(pending)
	delete browserMock.storageState.pendingTerminalReplies
	await modules.queueTerminalReplyWithPendingRequestDecision(earlierReply, pending, keepPendingRequest)
	const outboxBefore = await modules.getPendingTerminalReplies()
	const reply = { ...earlierReply, error: { code: 4100, message: 'a different reply' } }

	assert.equal(await modules.queueTerminalReplyWithPendingRequestDecision(reply, pending, () => undefined), 'unchanged')
	assert.equal(await modules.queueTerminalReplyWithPendingRequestDecision(reply, { ...pending, instanceId: 'another instance' }, () => ({ type: 'remove' })), 'unchanged')
	assert.deepEqual(await modules.getPendingTerminalReplies(), outboxBefore)
	assert.deepEqual(await getOnlyPendingRequest(), pending)

	assert.equal(await modules.queueTerminalReplyWithPendingRequestDecision(reply, pending, (current) => ({ type: 'store', pending: { ...current, approvalStatus: { status: 'ClosedWithoutResponse' } } })), 'stored')
	assert.equal((await getOnlyPendingRequest()).approvalStatus.status, 'ClosedWithoutResponse')
	assert.equal(await modules.queueTerminalReplyWithPendingRequestDecision(reply, pending, () => ({ type: 'remove' })), 'removed')
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	const queued = await modules.getPendingTerminalReplies()
	assert.equal(queued.length, 1)
	assert.equal(isRecord(queued[0]) && isRecord(queued[0].error) && queued[0].error.code, 4100)
})

test('a decision that queues nothing still finishes an earlier reply delivered while it waited, so the next reply under the id reaches the page', async () => {
	const messagesPostedToPage: unknown[] = []
	const page = await startPageConnection(messagesPostedToPage)
	await sendPersonalSignFromPage(page, 'first message')
	const pending = await getOnlyPendingRequest()
	const earlierReply = rejectionOf(pending)
	delete browserMock.storageState.pendingTerminalReplies
	await modules.queueTerminalReplyWithPendingRequestDecision(earlierReply, pending, keepPendingRequest)
	const outboxRead = holdNextStorageRead((key) => key === 'pendingTerminalReplies')
	try {
		const flush = modules.flushPendingTerminalRepliesForSocket(page.connections, pageRequestIdentifier.requestSocket)
		await outboxRead.reached
		const unchanged = modules.queueTerminalReplyWithPendingRequestDecision(earlierReply, pending, () => undefined)
		outboxRead.release()
		assert.equal(await flush, 1)
		assert.equal(await unchanged, 'unchanged')
	} finally {
		outboxRead.release()
		outboxRead.restore()
	}
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	assert.equal(getTerminalRepliesTo(messagesPostedToPage, pageRequestIdentifier.requestId).length, 1)

	const nextReply = { ...earlierReply, error: { code: 4100, message: 'the next reply' } }
	assert.equal(await modules.queueTerminalReplyWithPendingRequestDecision(nextReply, pending, () => ({ type: 'remove' })), 'removed')
	assert.equal(await modules.attemptQueuedTerminalReplyDelivery(page.connections, nextReply), true)
	assert.equal(getTerminalRepliesTo(messagesPostedToPage, pageRequestIdentifier.requestId).length, 2)
})

test('an instance update reports whether it stored, and a removal whether it removed', async () => {
	const page = await startPageConnection([])
	await sendPersonalSignFromPage(page, 'first message')
	const pending = await getOnlyPendingRequest()
	const anotherInstance = { ...pending, instanceId: 'another instance' }
	const waitingForSigner = (current: typeof pending) => ({ ...current, approvalStatus: { status: 'WaitingForSigner' as const } })

	assert.equal(await modules.updatePendingTransactionOrMessageInstance(pending, () => undefined), false)
	assert.equal(await modules.updatePendingTransactionOrMessageInstance(anotherInstance, waitingForSigner), false)
	assert.equal((await getOnlyPendingRequest()).approvalStatus.status, 'WaitingForUser')
	assert.equal(await modules.updatePendingTransactionOrMessageInstance(pending, waitingForSigner), true)
	assert.equal((await getOnlyPendingRequest()).approvalStatus.status, 'WaitingForSigner')

	assert.equal(await modules.removePendingTransactionOrMessageInstance(pending, () => false), false)
	assert.equal(await modules.removePendingTransactionOrMessageInstance(anotherInstance, () => true), false)
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
	assert.equal(await modules.removePendingTransactionOrMessageInstance(pending, () => true), true)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

test('the confirmation window gets the stored queue from the background without waiting on the RPC', async () => {
	const page = await startPageConnection([])
	await sendPersonalSignFromPage(page, 'first message')
	const pending = await getOnlyPendingRequest()
	// The first RPC request is held for the whole call, so a reply that waited on the RPC would come back as blocked.
	const rpc = pauseFirstRpcRequest()
	try {
		const reply = await settledOrBlocked(modules.requestConfirmTransactionQueue())
		if (reply === 'blocked') throw new Error('The queue reply waited on the RPC')
		assert.equal(reply.method, 'popup_requestConfirmTransactionQueue')
		assert.deepEqual(reply.data.pendingTransactionAndSignableMessages.map(({ uniqueRequestIdentifier, instanceId }) => ({ uniqueRequestIdentifier, instanceId })), [{ uniqueRequestIdentifier: pending.uniqueRequestIdentifier, instanceId: pending.instanceId }])
	} finally {
		rpc.release()
		rpc.restore()
	}
})

test('the write that answers a request stores exactly the pending requests and the reply outbox, under their declared keys', async () => {
	const page = await startPageConnection([])
	await sendPersonalSignFromPage(page, 'first message')
	await approveAndForwardToSigner(page)
	const writtenKeys: string[][] = []
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		writtenKeys.push(Object.keys(items).sort())
		writeStoredItems()
	})
	try {
		await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, new Map(), { method: 'popup_confirmDialog', data: { action: 'signerIncluded', signerReply: OLD_SIGNATURE, uniqueRequestIdentifier: pageRequestIdentifier } })
	} finally {
		browserMock.setStorageSetHandler(undefined)
	}
	assert.deepEqual(writtenKeys.filter((keys) => keys.includes('pendingTerminalReplies')), [['pendingTerminalReplies', 'pendingTransactionsAndMessages']])
})
