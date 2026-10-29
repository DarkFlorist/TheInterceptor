import * as assert from 'assert'
import { test } from 'bun:test'
import { personalEcRecover } from '../../app/ts/background/personalEcRecoverRpc.js'
import { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { PendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import { TransactionConfirmation } from '../../app/ts/types/interceptor-messages.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { decodePersonalSignMessage } from '../../app/ts/utils/personalSignMessage.js'
import { hashMessage } from '../../app/ts/utils/ethereumPrimitives.js'
import { createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import { activeAddress, browserMock, createWebsitePort, isRecord, modules, simulator, uniqueRequestIdentifier as defaultUniqueRequestIdentifier, getPendingInstanceId } from './confirmTransactionTestHarness.js'

const plainTextMessage = 'Hello world'
const website = { websiteOrigin: 'https://plain-text.example', icon: undefined, title: 'Plain text' }

const openPlainTextPersonalSign = async (simulationMode: boolean, postedMessages: unknown[], requestId = defaultUniqueRequestIdentifier.requestId) => {
	if (activeAddress === undefined) throw new Error('Missing default active address')
	const uniqueRequestIdentifier = { ...defaultUniqueRequestIdentifier, requestId }
	const signRequest = { method: 'personal_sign' as const, params: [plainTextMessage, activeAddress] as const }
	const request = { interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier, ...signRequest }
	const websiteTabConnections = new Map([[uniqueRequestIdentifier.requestSocket.tabId, { connections: {
		[modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)]: {
			port: createWebsitePort(uniqueRequestIdentifier.requestSocket, 0, postedMessages),
			socket: uniqueRequestIdentifier.requestSocket,
			websiteOrigin: website.websiteOrigin,
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, request, { kind: 'message', parameters: signRequest }, simulationMode, activeAddress, website, websiteTabConnections), { type: 'doNotReply' })

	const [pendingMessage] = await modules.getPendingTransactionsAndMessages()
	if (pendingMessage?.type !== 'SignableMessage' || pendingMessage.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Missing visualized plain-text personal_sign request')
	const visualized = pendingMessage.visualizedPersonalSignRequest
	assert.equal(visualized.type, 'NotParsed')
	assert.equal(visualized.message, plainTextMessage)
	assert.equal(visualized.messageHash, hashMessage(plainTextMessage))
	const accept = async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier, instanceId: await getPendingInstanceId(uniqueRequestIdentifier) },
	})
	// A popup decision names the pending request instance the user saw.
	const decide = async (decision: { readonly action: 'accept' | 'addToSafeStack' | 'noResponse' } | { readonly action: 'reject', readonly errorString: undefined }, instanceId: string) => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { ...decision, uniqueRequestIdentifier, instanceId },
	})
	return { signerAddress: activeAddress, accept, decide, instanceId: pendingMessage.instanceId, pendingMessage, websiteTabConnections }
}

test('forwards an accepted plain-text personal_sign request to the signer with its original parameters', async () => {
	const postedMessages: unknown[] = []
	const { signerAddress, accept } = await openPlainTextPersonalSign(false, postedMessages)

	assert.equal(await accept(), true)
	const forwarded = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(forwarded)) throw new Error('Missing forwarded personal_sign request')
	assert.equal(forwarded.method, 'personal_sign')
	assert.deepEqual(forwarded.params, [plainTextMessage, addressString(signerAddress)])
})

test('answers an accepted plain-text personal_sign request in simulation mode with a signature personal_ecRecover maps to the simulated signer', async () => {
	const postedMessages: unknown[] = []
	const { signerAddress, accept } = await openPlainTextPersonalSign(true, postedMessages)

	assert.equal(await accept(), true)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const reply = postedMessages.find((message) => isRecord(message) && message.method === 'personal_sign' && typeof message.result === 'string')
	if (!isRecord(reply) || typeof reply.result !== 'string') throw new Error('Missing simulated personal_sign signature')

	const stackMessages = (await modules.getInterceptorTransactionStack()).operations.flatMap((operation) => operation.type === 'Message' ? [operation.signedMessageTransaction] : [])
	const ecRecoverRequest = EthereumJsonRpcRequest.parse({ method: 'personal_ecRecover', params: [plainTextMessage, reply.result] })
	if (ecRecoverRequest.method !== 'personal_ecRecover') throw new Error('Expected a personal_ecRecover request')
	assert.deepEqual(await personalEcRecover(ecRecoverRequest, stackMessages, website.websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: signerAddress })
})

test('requires every popup decision to name the request instance it decides on', () => {
	const uniqueRequestIdentifier = { requestId: 1, requestSocket: { tabId: 1, connectionName: '0x0' } }
	const decisions = [{ action: 'accept' }, { action: 'addToSafeStack' }, { action: 'noResponse' }, { action: 'reject', errorString: undefined }]
	for (const decision of decisions) {
		assert.equal(TransactionConfirmation.safeParse({ method: 'popup_confirmDialog', data: { ...decision, uniqueRequestIdentifier } }).success, false, decision.action)
		assert.equal(TransactionConfirmation.safeParse({ method: 'popup_confirmDialog', data: { ...decision, uniqueRequestIdentifier, instanceId: 'reviewed instance' } }).success, true, decision.action)
	}
	// The wallet's reply arrives over the page's own connection and is not bound to an instance.
	assert.equal(TransactionConfirmation.safeParse({ method: 'popup_confirmDialog', data: { action: 'signerIncluded', signerReply: '0x', uniqueRequestIdentifier } }).success, true)
})

test('ignores a popup decision made for another instance of the same request id', async () => {
	const postedMessages: unknown[] = []
	const { signerAddress, decide, instanceId } = await openPlainTextPersonalSign(false, postedMessages)

	// The page can reuse a request id, so a decision on a replaced request must not resolve the request now pending under that id.
	for (const decision of [{ action: 'accept' as const }, { action: 'addToSafeStack' as const }, { action: 'noResponse' as const }, { action: 'reject' as const, errorString: undefined }]) {
		assert.equal(await decide(decision, 'replaced instance'), false, decision.action)
	}
	const [stillPending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(stillPending?.instanceId, instanceId)
	assert.equal(stillPending?.approvalStatus.status, 'WaitingForUser')
	assert.equal(postedMessages.some((message) => isRecord(message) && (message.type === 'forwardToSigner' || message.method === 'personal_sign')), false)

	assert.equal(await decide({ action: 'accept' }, instanceId), true)
	const forwarded = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(forwarded)) throw new Error('Missing forwarded personal_sign request')
	assert.deepEqual(forwarded.params, [plainTextMessage, addressString(signerAddress)])
})

const isForwardToSigner = (message: unknown) => isRecord(message) && message.type === 'forwardToSigner'
const waitUntil = async (condition: () => boolean) => {
	const deadline = Date.now() + 2_000
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for the test condition')
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

test('resolves popup decisions on a request stored before instance ids existed', async () => {
	for (const decision of [{ action: 'accept' as const }, { action: 'reject' as const, errorString: undefined }]) {
		const postedMessages: unknown[] = []
		const { pendingMessage, decide, websiteTabConnections } = await openPlainTextPersonalSign(false, postedMessages)
		// Pending storage written before this change has no instance id.
		const storedPending = browserMock.storageState.pendingTransactionsAndMessages
		if (!Array.isArray(storedPending) || !isRecord(storedPending[0])) throw new Error('Missing stored pending request')
		delete storedPending[0].instanceId

		// Startup recovery keeps the request because its confirmation window is still open, then the popup is refreshed.
		browserMock.setLiveWindowIds([pendingMessage.popupOrTabId.id])
		browserMock.setLiveTabIds([pendingMessage.popupOrTabId.id])
		await modules.resolvePendingRequestsForMissingConfirmationWindows(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
		browserMock.sentMessages.length = 0
		await modules.updateConfirmTransactionView(simulator.ethereum, simulator.tokenPriceService)
		const popupUpdate = browserMock.sentMessages.find((message) => isRecord(message) && message.method === 'popup_update_confirm_transaction_dialog_pending_transactions')
		const displayedRequests = isRecord(popupUpdate) && isRecord(popupUpdate.data) ? popupUpdate.data.pendingTransactionAndSignableMessages : undefined
		const displayedInstanceId = Array.isArray(displayedRequests) && isRecord(displayedRequests[0]) ? displayedRequests[0].instanceId : undefined
		if (typeof displayedInstanceId !== 'string') throw new Error('Missing displayed instance id')

		const resolution = await decide(decision, displayedInstanceId)
		if (decision.action === 'accept') {
			assert.equal(resolution, true)
			assert.equal(postedMessages.some(isForwardToSigner), true)
			continue
		}
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
		assert.equal(postedMessages.some((message) => isRecord(message) && message.method === 'personal_sign' && 'error' in message), true)
	}
})

test('parses only a missing pending request instance id as the legacy id and rejects other non-string instance ids', async () => {
	await openPlainTextPersonalSign(false, [])
	const storedPending = browserMock.storageState.pendingTransactionsAndMessages
	if (!Array.isArray(storedPending) || !isRecord(storedPending[0])) throw new Error('Missing stored pending request')
	const stored = storedPending[0]
	const parseInstanceId = (pending: Record<string, unknown>) => {
		const parsed = PendingTransactionOrSignableMessage.safeParse(pending)
		return parsed.success ? { success: true, instanceId: parsed.value.instanceId } : { success: false }
	}

	assert.deepEqual(parseInstanceId(Object.fromEntries(Object.entries(stored).filter(([key]) => key !== 'instanceId'))), { success: true, instanceId: 'legacy' })
	const uuid = '0b6f1c9e-3d4a-4f6b-9c2e-7a8d5e1f2b3c'
	assert.deepEqual(parseInstanceId({ ...stored, instanceId: uuid }), { success: true, instanceId: uuid })
	for (const instanceId of [5, null, {}]) {
		assert.deepEqual(parseInstanceId({ ...stored, instanceId }), { success: false }, JSON.stringify(instanceId))
	}
})

test('forwards the approved request, not a replacement that reuses its request id while the approval is held', async () => {
	const postedMessages: unknown[] = []
	const { signerAddress, pendingMessage, decide, instanceId, websiteTabConnections } = await openPlainTextPersonalSign(false, postedMessages, -2)
	let waitingForSignerWritten = false
	let approvalPaused = false
	let resumeApproval: () => void = () => undefined
	const approvalResumed = new Promise<undefined>((resolve) => { resumeApproval = () => resolve(undefined) })
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		writeStoredItems()
		const stored = items.pendingTransactionsAndMessages
		if (Array.isArray(stored) && stored.some((pending) => isRecord(pending) && isRecord(pending.approvalStatus) && pending.approvalStatus.status === 'WaitingForSigner')) waitingForSignerWritten = true
	})
	// Holds the first storage read after approval marked the request as waiting for the signer, which is the popup update just before forwarding.
	browserMock.setStorageGetHandler(async (_keys, readStoredItems) => {
		if (waitingForSignerWritten && !approvalPaused) {
			approvalPaused = true
			await approvalResumed
		}
		return readStoredItems()
	})
	try {
		const approval = decide({ action: 'accept' }, instanceId)
		await waitUntil(() => approvalPaused)

		// The user closes the confirmation window, which rejects the approved request, and the page then sends a different message under the same id. Resolutions of one request run one at a time, so the close may finish before or after the held approval.
		const replacementParameters = { method: 'personal_sign' as const, params: ['Replacement message', signerAddress] as const }
		const closeThenReplace = (async () => {
			await modules.onCloseWindowOrTab(pendingMessage.popupOrTabId, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
			await modules.appendPendingTransactionOrMessage({ ...pendingMessage, instanceId: 'replacement instance', originalRequestParameters: replacementParameters, signedMessageTransaction: { ...pendingMessage.signedMessageTransaction, originalRequestParameters: replacementParameters } })
		})()
		await new Promise((resolve) => setTimeout(resolve, 20))
		resumeApproval()
		await approval
		await closeThenReplace

		const forwardedParameters = postedMessages.filter(isForwardToSigner).map((message) => isRecord(message) ? message.params : undefined)
		assert.ok(forwardedParameters.length > 0)
		for (const parameters of forwardedParameters) assert.deepEqual(parameters, [plainTextMessage, addressString(signerAddress)])
	} finally {
		resumeApproval()
		browserMock.setStorageGetHandler(undefined)
		browserMock.setStorageSetHandler(undefined)
	}
})

const SIGNATURE = `0x${ '11'.repeat(65) }`
const signerReplies = [
	{ branch: 'success', reply: { success: true, reply: SIGNATURE } },
	{ branch: 'user rejected', reply: { success: false, error: { code: 4001, message: 'User rejected the request.' } } },
	{ branch: 'error', reply: { success: false, error: { code: -32603, message: 'The wallet failed.' } } },
] as const
type SignerReplyOutcome = (typeof signerReplies)[number]['reply']
const signerReplyCases = [...signerReplies.map((signerReply) => ({ ...signerReply, fromReplacedConnection: false })), { branch: 'connection replaced', reply: signerReplies[0].reply, fromReplacedConnection: true }]

// Opens personal_sign requests through the real creation path on one website connection.
const createPersonalSignRequester = (postedMessages: unknown[]) => {
	if (activeAddress === undefined) throw new Error('Missing default active address')
	const signerAddress = activeAddress
	const socket = defaultUniqueRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, postedMessages)
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: website.websiteOrigin, approved: true, wantsToConnect: true },
	} }]])
	const requestSignature = async (message: string, requestId: number) => {
		const signRequest = { method: 'personal_sign' as const, params: [message, signerAddress] as const }
		const uniqueRequestIdentifier = { requestId, requestSocket: socket }
		return await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, { interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier, ...signRequest }, { kind: 'message', parameters: signRequest }, false, signerAddress, website, websiteTabConnections)
	}
	const decide = async (decision: { readonly action: 'accept' } | { readonly action: 'reject', readonly errorString: undefined }, requestId: number, instanceId: string) => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { ...decision, uniqueRequestIdentifier: { requestId, requestSocket: socket }, instanceId },
	})
	// The confirmation window the mock opens stays open, so later requests join it instead of resolving the earlier ones as abandoned.
	browserMock.setLiveWindowIds([99])
	browserMock.setLiveTabIds([99])
	const getPendingMessages = async () => (await modules.getPendingTransactionsAndMessages()).flatMap((pending) => pending.type === 'SignableMessage' && pending.transactionOrMessageCreationStatus === 'Simulated' && pending.visualizedPersonalSignRequest.type === 'NotParsed' ? [{ instanceId: pending.instanceId, visualized: pending.visualizedPersonalSignRequest }] : [])
	// The wallet's reply to a forwarded personal_sign comes back over the page's connection naming only the request id; a reply from a port that is no longer the page's connection takes the connection-replaced branch.
	const sendSignerReply = async (requestId: number, reply: SignerReplyOutcome, fromReplacedConnection: boolean) => await modules.signerReply(createTestSimulationServicesOwner({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService }), websiteTabConnections, fromReplacedConnection ? createWebsitePort(socket, 0, []) : port, {
		method: 'signer_reply',
		params: [{ ...reply, signerProviderGeneration: 1, forwardRequest: { type: 'forwardToSigner', replyWithSignersReply: true, method: 'personal_sign', params: [plainTextMessage, addressString(signerAddress)], requestId } }],
		interceptorRequest: true,
		interceptorInternalRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 1000, requestSocket: socket },
	}, 'hasAccess', signerAddress)
	const closeConfirmationPopup = async () => {
		const [pending] = await modules.getPendingTransactionsAndMessages()
		if (pending === undefined) throw new Error('Missing pending request')
		await modules.onCloseWindowOrTab(pending.popupOrTabId, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
	}
	return { signerAddress, requestSignature, decide, getPendingMessages, sendSignerReply, closeConfirmationPopup }
}

const duplicateIdError = { type: 'result', error: { code: -32600, message: 'A request with this id is already awaiting confirmation.' } }
// Unprefixed hex that MetaMask signs as the bytes of 'Sign all assets away', so signing mode flags it and shows it as written.
const walletDependentMessage = '5369676e20616c6c206173736574732061776179'

test('refuses a second request under a pending request id, so the reviewed message, its warnings and the forwarded request stay together', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const postedMessages: unknown[] = []
	const { signerAddress, requestSignature, decide, getPendingMessages } = createPersonalSignRequester(postedMessages)
	assert.deepEqual(await requestSignature(walletDependentMessage, -2), { type: 'doNotReply' })
	assert.deepEqual(await requestSignature(plainTextMessage, -2), duplicateIdError)

	const [reviewed, ...otherPending] = await getPendingMessages()
	if (reviewed === undefined) throw new Error('Missing reviewed request')
	assert.deepEqual(otherPending, [])
	assert.equal(reviewed.visualized.message, walletDependentMessage)
	assert.equal(decodePersonalSignMessage(reviewed.visualized.message, reviewed.visualized.simulationMode), walletDependentMessage)
	assert.equal(reviewed.visualized.quarantine, true)

	assert.equal(await decide({ action: 'accept' }, -2, reviewed.instanceId), true)
	const forwarded = postedMessages.filter(isForwardToSigner)
	assert.deepEqual(forwarded.map((message) => isRecord(message) ? message.params : undefined), [[walletDependentMessage, addressString(signerAddress)]])
})

test('accepts a request id again once the request pending under it is resolved', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const postedMessages: unknown[] = []
	const { requestSignature, decide, getPendingMessages } = createPersonalSignRequester(postedMessages)
	assert.deepEqual(await requestSignature(walletDependentMessage, -3), { type: 'doNotReply' })
	assert.deepEqual(await requestSignature(plainTextMessage, -3), duplicateIdError)
	const [first] = await getPendingMessages()
	if (first === undefined) throw new Error('Missing first request')
	await decide({ action: 'reject', errorString: undefined }, -3, first.instanceId)

	assert.deepEqual(await requestSignature(plainTextMessage, -3), { type: 'doNotReply' })
	const pendingAfterReuse = await getPendingMessages()
	assert.deepEqual(pendingAfterReuse.map(({ visualized }) => [visualized.message, visualized.quarantine]), [[plainTextMessage, false]])
})

test('flags a 0x-prefixed message with invalid hex digits, shows it as written without a hash and requires an acknowledgement', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const { requestSignature } = createPersonalSignRequester([])
	// A permissive hex converter could sign this as the bytes 0x686900 while a strict wallet signs its text.
	const malformedHexMessage = '0x6869zz'
	assert.deepEqual(await requestSignature(malformedHexMessage, -4), { type: 'doNotReply' })

	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending?.type !== 'SignableMessage' || pending.transactionOrMessageCreationStatus !== 'Simulated' || pending.visualizedPersonalSignRequest.type !== 'NotParsed') throw new Error('Missing visualized personal_sign request')
	const visualized = pending.visualizedPersonalSignRequest
	assert.equal(visualized.quarantine, true)
	assert.equal(visualized.messageHash, undefined)
	assert.equal(decodePersonalSignMessage(visualized.message, visualized.simulationMode), malformedHexMessage)
	const { getApprovalAcknowledgement } = await import('../../app/ts/components/pages/ConfirmTransaction.js')
	assert.notEqual(getApprovalAcknowledgement(pending), undefined)
})

const getPendingRequests = async () => await modules.getPendingTransactionsAndMessages()
// Blocks the request with an error the user has to clear, so each reply branch shows whether it touched it, including a user-rejected reply that would reset it to waiting for the user.
const blockWithUserFacingError = async (requestId: number) => {
	await modules.updatePendingTransactionOrMessage({ requestId, requestSocket: defaultUniqueRequestIdentifier.requestSocket }, async (pending) => ({ ...pending, approvalStatus: { status: 'SignerError' as const, code: -32010, message: 'Select a current Gnosis Safe owner in the signer wallet.' } }))
	return await getPendingRequests()
}

for (const { branch, reply, fromReplacedConnection } of signerReplyCases) {
	test(`a signer reply (${ branch }) for a request the user has not approved resolves and resets nothing`, async () => {
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
		const postedMessages: unknown[] = []
		const { requestSignature, sendSignerReply } = createPersonalSignRequester(postedMessages)
		assert.deepEqual(await requestSignature(plainTextMessage, -5), { type: 'doNotReply' })
		const notApproved = await blockWithUserFacingError(-5)
		const messagesPostedBeforeReply = postedMessages.length

		await sendSignerReply(-5, reply, fromReplacedConnection)

		assert.deepEqual(await getPendingRequests(), notApproved)
		assert.deepEqual(postedMessages.slice(messagesPostedBeforeReply), [])
	})

	test(`a signer reply (${ branch }) for a forwarded request leaves a newer request under the reused request id untouched`, async () => {
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
		const postedMessages: unknown[] = []
		const { requestSignature, decide, getPendingMessages, sendSignerReply, closeConfirmationPopup } = createPersonalSignRequester(postedMessages)
		assert.deepEqual(await requestSignature(plainTextMessage, -6), { type: 'doNotReply' })
		const [forwarded] = await getPendingMessages()
		if (forwarded === undefined) throw new Error('Missing forwarded request')
		assert.equal(await decide({ action: 'accept' }, -6, forwarded.instanceId), true)
		// The user closes the popup while the wallet is still signing, and the page sends a new request under the same id.
		await closeConfirmationPopup()
		assert.deepEqual(await requestSignature(plainTextMessage, -6), { type: 'doNotReply' })
		const newer = await blockWithUserFacingError(-6)
		const messagesPostedBeforeReply = postedMessages.length

		await sendSignerReply(-6, reply, fromReplacedConnection)

		assert.deepEqual(await getPendingRequests(), newer)
		assert.deepEqual(postedMessages.slice(messagesPostedBeforeReply), [])
	})

	test(`a signer reply (${ branch }) still resolves the forwarded request under its request id`, async () => {
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
		const postedMessages: unknown[] = []
		const { requestSignature, decide, getPendingMessages, sendSignerReply } = createPersonalSignRequester(postedMessages)
		assert.deepEqual(await requestSignature(plainTextMessage, -7), { type: 'doNotReply' })
		const [forwarded] = await getPendingMessages()
		if (forwarded === undefined) throw new Error('Missing forwarded request')
		assert.equal(await decide({ action: 'accept' }, -7, forwarded.instanceId), true)

		await sendSignerReply(-7, reply, fromReplacedConnection)

		const pending = await getPendingRequests()
		if (branch === 'success') {
			assert.deepEqual(pending, [])
			assert.equal(postedMessages.some((message) => isRecord(message) && message.requestId === -7 && message.result === SIGNATURE), true)
			return
		}
		assert.equal(pending[0]?.approvalStatus.status, branch === 'user rejected' ? 'WaitingForUser' : 'SignerError')
	})
}
