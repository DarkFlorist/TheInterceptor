import * as assert from 'assert'
import { test } from 'bun:test'
import { activeAddress, addressString, browserMock, createDisconnectedPort, createWebsitePort, isRecord, modules, pendingTransaction, simulator, uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'

const SIMULATION_MODE_ENABLED_AFTER_REQUEST_MESSAGE = 'The Interceptor switched to simulation mode after this request was made. Reject this request and send it again.'
const socket = uniqueRequestIdentifier.requestSocket
const signingModeTransaction = { ...pendingTransaction, simulationMode: false, approvalStatus: { status: 'WaitingForUser' } } as const

const websiteTabConnection = (port: browser.runtime.Port) => ({ connections: {
	[modules.websiteSocketToString(socket)]: { socket, port, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true },
} })

const connectWebsite = (port: browser.runtime.Port) => new Map([[socket.tabId, websiteTabConnection(port)]])

async function setUpSigningModeRequest() {
	await modules.changeSimulationMode({ simulationMode: false })
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [signingModeTransaction] })
	const postedMessages: unknown[] = []
	return { postedMessages, websiteTabConnections: connectWebsite(createWebsitePort(socket, 0, postedMessages)) }
}

// Creates a signable message the way a website's personal_sign request does while the Interceptor is in signing mode.
async function setUpSigningModeMessage() {
	await modules.changeSimulationMode({ simulationMode: false })
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const postedMessages: unknown[] = []
	const websiteTabConnections = connectWebsite(createWebsitePort(socket, 0, postedMessages))
	const parameters = { method: 'personal_sign' as const, params: ['0x48656c6c6f', activeAddress] as const }
	const request = { method: parameters.method, params: ['0x48656c6c6f', addressString(activeAddress)], interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier }
	const website = { websiteOrigin: 'https://example.com', icon: undefined, title: undefined }
	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, request, { kind: 'message', parameters }, false, activeAddress, website, websiteTabConnections), { type: 'doNotReply' })
	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending?.type !== 'SignableMessage' || pending.transactionOrMessageCreationStatus !== 'Simulated' || pending.simulationMode) throw new Error('missing signing-mode message review')
	return { postedMessages, websiteTabConnections }
}

async function resolve(websiteTabConnections: ReturnType<typeof connectWebsite>, action: 'accept' | 'reject') {
	const data = action === 'accept' ? { action, uniqueRequestIdentifier } : { action, errorString: undefined, uniqueRequestIdentifier }
	return await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data })
}

const isForwardToSigner = (message: unknown) => isRecord(message) && message.type === 'forwardToSigner'

async function assertRefusedAndStillPending(postedMessages: readonly unknown[]) {
	assert.equal(postedMessages.some(isForwardToSigner), false)
	const [retained, ...others] = await modules.getPendingTransactionsAndMessages()
	assert.equal(others.length, 0)
	assert.deepEqual(retained?.approvalStatus, { status: 'SignerError', code: -32603, message: SIMULATION_MODE_ENABLED_AFTER_REQUEST_MESSAGE })
	assert.equal(browserMock.storageState.latestUnexpectedError, undefined)
	assert.equal(browserMock.sentMessages.some((message) => message.method === 'popup_UnexpectedErrorOccured'), false)
	const pendingUpdates = browserMock.sentMessages.filter((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions')
	const finalUpdateData = pendingUpdates.at(-1)?.data
	if (!isRecord(finalUpdateData) || !Array.isArray(finalUpdateData.pendingTransactionAndSignableMessages)) throw new Error('missing popup redraw after the refused approval')
	const redrawnRequest = finalUpdateData.pendingTransactionAndSignableMessages[0]
	if (!isRecord(redrawnRequest) || !isRecord(redrawnRequest.approvalStatus)) throw new Error('missing approval status in the popup redraw')
	assert.equal(redrawnRequest.approvalStatus.message, SIMULATION_MODE_ENABLED_AFTER_REQUEST_MESSAGE)
}

async function assertRejectable(websiteTabConnections: ReturnType<typeof connectWebsite>, postedMessages: readonly unknown[]) {
	await resolve(websiteTabConnections, 'reject')
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.equal(postedMessages.some(isForwardToSigner), false)
	const rejection = postedMessages.at(-1)
	if (!isRecord(rejection) || !isRecord(rejection.error)) throw new Error('missing website rejection')
	assert.equal(rejection.error.code, 4001)
}

test('approving a signing-mode transaction forwards it to the signer when simulation mode did not change', async () => {
	const { postedMessages, websiteTabConnections } = await setUpSigningModeRequest()
	assert.equal(await resolve(websiteTabConnections, 'accept'), true)
	assert.deepEqual(postedMessages.filter(isForwardToSigner).map((message) => isRecord(message) ? message.method : undefined), ['eth_sendTransaction'])
	assert.equal((await modules.getPendingTransactionsAndMessages())[0]?.approvalStatus.status, 'WaitingForSigner')
})

test('approving a signing-mode transaction after simulation mode was enabled refuses the forward and keeps the request rejectable', async () => {
	const { postedMessages, websiteTabConnections } = await setUpSigningModeRequest()
	await modules.changeSimulationMode({ simulationMode: true })
	assert.equal(await resolve(websiteTabConnections, 'accept'), false)
	await assertRefusedAndStillPending(postedMessages)
	await assertRejectable(websiteTabConnections, postedMessages)
})

test('approving a signing-mode signable message after simulation mode was enabled refuses the forward and keeps the request rejectable', async () => {
	const { postedMessages, websiteTabConnections } = await setUpSigningModeMessage()
	await modules.changeSimulationMode({ simulationMode: true })
	assert.equal(await resolve(websiteTabConnections, 'accept'), false)
	await assertRefusedAndStillPending(postedMessages)
	await assertRejectable(websiteTabConnections, postedMessages)
})

test('approving a signing-mode signable message forwards it to the signer when simulation mode did not change', async () => {
	const { postedMessages, websiteTabConnections } = await setUpSigningModeMessage()
	assert.equal(await resolve(websiteTabConnections, 'accept'), true)
	assert.deepEqual(postedMessages.filter(isForwardToSigner).map((message) => isRecord(message) ? message.method : undefined), ['personal_sign'])
})

test('simulation mode enabled while the approval is marked as waiting for the signer refuses the forward', async () => {
	const { postedMessages, websiteTabConnections } = await setUpSigningModeRequest()
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if ('pendingTransactionsAndMessages' in items) {
			browserMock.setStorageSetHandler(undefined)
			await modules.changeSimulationMode({ simulationMode: true })
		}
		writeStoredItems()
	})
	assert.equal(await resolve(websiteTabConnections, 'accept'), false)
	await assertRefusedAndStillPending(postedMessages)
})

test('an enabling simulation mode write still in flight when the forward is posted refuses the forward', async () => {
	const { postedMessages, websiteTabConnections } = await setUpSigningModeRequest()
	let releaseEnablingWrite: (() => void) | undefined
	const enablingWriteReleased = new Promise<void>((resolve) => { releaseEnablingWrite = resolve })
	let enabling: Promise<void> | undefined
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if ('pendingTransactionsAndMessages' in items && enabling === undefined) enabling = modules.changeSimulationMode({ simulationMode: true })
		// The enabling write is held until the approval finished, so storage still reads signing mode when the forward is attempted.
		if (items.simulationMode === true) await enablingWriteReleased
		writeStoredItems()
	})
	const accepted = await resolve(websiteTabConnections, 'accept')
	assert.equal(browserMock.storageState.simulationMode, false)
	releaseEnablingWrite?.()
	await enabling
	browserMock.setStorageSetHandler(undefined)
	assert.equal(accepted, false)
	await assertRefusedAndStillPending(postedMessages)
})

async function acceptAcrossManifestV2Reconnect(onReconnectRequested?: () => Promise<void>) {
	await modules.changeSimulationMode({ simulationMode: false })
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [signingModeTransaction] })
	const disconnectedPort = createDisconnectedPort()
	const postedMessages: unknown[] = []
	const websiteTabConnections = connectWebsite(disconnectedPort.port)
	browserMock.setManifestVersion(2)
	browserMock.setTabMessageHandler(async () => {
		await onReconnectRequested?.()
		websiteTabConnections.set(socket.tabId, websiteTabConnection(createWebsitePort(socket, 0, postedMessages)))
		return { reconnected: true }
	})
	try {
		const accepted = await resolve(websiteTabConnections, 'accept')
		return { accepted, postedMessages, postAttemptsBeforeReconnect: disconnectedPort.getPostAttempts() }
	} finally {
		browserMock.setManifestVersion(3)
		browserMock.setTabMessageHandler(undefined)
	}
}

test('a Manifest V2 reconnect without a mode change still forwards the approval on the replacement connection', async () => {
	const { accepted, postedMessages, postAttemptsBeforeReconnect } = await acceptAcrossManifestV2Reconnect()
	assert.equal(postAttemptsBeforeReconnect, 1)
	assert.equal(accepted, true)
	assert.equal(postedMessages.filter(isForwardToSigner).length, 1)
})

test('simulation mode enabled during the Manifest V2 reconnect wait refuses the retried forward', async () => {
	const { accepted, postedMessages, postAttemptsBeforeReconnect } = await acceptAcrossManifestV2Reconnect(async () => await modules.changeSimulationMode({ simulationMode: true }))
	assert.equal(postAttemptsBeforeReconnect, 1)
	assert.equal(accepted, false)
	await assertRefusedAndStillPending(postedMessages)
})
