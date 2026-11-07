import * as assert from 'assert'
import { setSystemTime, test } from 'bun:test'
import { Transaction } from 'micro-eth-signer'
import { activeAddress, addressString, browserMock, createDisconnectedPort, createSafeAddressBookEntry, createSafeStackFixture, createSafeTx, createWebsitePort, EIP712Message, fakeRequestHandler, fakeRpcNetwork, fakeSafeContract, getSafeTxHash, isRecord, modules, pendingTransaction, recipientAddress, SAFE_EXECUTION_ABI, safeTestOwnerAccount, safeTestOwnerAddress, safeTestOwnerPrivateKey, safeTxToTypedDataJson, signedTransaction, simulator, uniqueRequestIdentifier, withSilencedConsole } from './confirmTransactionTestHarness.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { createDeferredValue, createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import { CONFIRMATION_RUN_OF_NO_LIFETIME, type ConfirmationRunId, PendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { createPassthroughCompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'
import { SendRawTransactionParams, SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import { PersonalSignParams } from '../../app/ts/types/jsonRpc-signing-types.js'
import { METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN } from '../../app/ts/utils/constants.js'

const website = { websiteOrigin: 'https://example.com', icon: undefined, title: undefined }
const socket = uniqueRequestIdentifier.requestSocket
const otherNetwork = { ...fakeRpcNetwork, name: 'Other Test Chain', chainId: 8453n }

const transactionParams = SendTransactionParams.parse({
	method: 'eth_sendTransaction',
	params: [{ from: addressString(activeAddress), to: addressString(recipientAddress), value: '0x2', data: '0x', gas: '0x5208' }],
})

async function setUpTransactionApprovalTest(simulationMode: boolean) {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.browserStorageLocalSet({ simulationMode, activeRpcNetwork: fakeRpcNetwork })
	const postedMessages: unknown[] = []
	const port = createWebsitePort(socket, 0, postedMessages)
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: website.websiteOrigin, approved: true, wantsToConnect: true },
		},
	}]])
	return { postedMessages, websiteTabConnections }
}

type TransactionTestConnections = Awaited<ReturnType<typeof setUpTransactionApprovalTest>>['websiteTabConnections']

async function requestTransaction(websiteTabConnections: TransactionTestConnections, simulationMode: boolean, requestParams: SendTransactionParams | SendRawTransactionParams = transactionParams) {
	const reply = await modules.openConfirmTransactionDialogForTransaction(simulator.ethereum, simulator.tokenPriceService, {
		interceptorRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		method: requestParams.method,
		params: requestParams.params,
	}, { kind: 'transaction', parameters: requestParams }, simulationMode, activeAddress, website, websiteTabConnections)
	assert.deepEqual(reply, { type: 'doNotReply' })
}

// An eth_sendRawTransaction whose chain id is fixed by the signature of the website's sender, not by the Interceptor.
const signRawTransaction = (chainId: bigint) => SendRawTransactionParams.parse({
	method: 'eth_sendRawTransaction',
	params: [Transaction.prepare({ type: 'eip1559', chainId, nonce: 0n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gasLimit: 21_000n, to: addressString(recipientAddress), value: 2n, data: '0x', accessList: [] }, false).signBy(safeTestOwnerPrivateKey).toHex()],
})

async function getPendingTransaction() {
	const pending = (await modules.getPendingTransactionsAndMessages()).find((entry) => entry.type === 'Transaction')
	if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Missing simulated transaction confirmation')
	return pending
}

async function approveRequest(websiteTabConnections: TransactionTestConnections, ethereum = simulator.ethereum, tokenPriceService = simulator.tokenPriceService) {
	return await modules.resolvePendingTransactionOrMessage(ethereum, tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	})
}

const getForwardedSignerRequests = (postedMessages: readonly unknown[]) => postedMessages.filter((message) => isRecord(message) && message.type === 'forwardToSigner')

async function expectApprovalToBeInvalidated(websiteTabConnections: TransactionTestConnections, postedMessages: readonly unknown[], ethereum = simulator.ethereum, tokenPriceService = simulator.tokenPriceService) {
	assert.equal(await approveRequest(websiteTabConnections, ethereum, tokenPriceService), false)
	assert.deepEqual(getForwardedSignerRequests(postedMessages), [])
	const pending = await getPendingTransaction()
	if (pending.approvalStatus.status !== 'SignerError') throw new Error(`Expected an invalidated approval, got ${ pending.approvalStatus.status }`)
	assert.equal(pending.approvalStatus.code, METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN)
}

// Services for another network that record their RPC requests, so a test can tell whether a transaction preview was produced on that network.
function createOtherNetworkServices() {
	const requestedRpcMethods: string[] = []
	const otherNetworkEthereum = new modules.EthereumClientService({
		...fakeRequestHandler,
		async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
			requestedRpcMethods.push(rpcRequest.method)
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}, async () => undefined, async () => undefined, otherNetwork)
	return { requestedRpcMethods, ethereum: otherNetworkEthereum, tokenPriceService: new modules.TokenPriceService(otherNetworkEthereum, 60_000) }
}

const getPreviewChainIds = (pending: Awaited<ReturnType<typeof getPendingTransaction>>) => ({
	transaction: pending.transactionToSimulate.transaction.chainId,
	visualization: pending.popupVisualisation.statusCode === 'success' ? pending.popupVisualisation.data.simulationState.rpcNetwork.chainId : undefined,
})

async function storePendingTransaction(update: (pending: PendingTransactionOrSignableMessage) => PendingTransactionOrSignableMessage) {
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => update(pending))
}

// Services for the requested network whose matching RPC requests wait until released, so a test can suspend a refresh or an approval at its first such request.
function createSuspendedServices(suspendedMethod?: string) {
	const reached = createDeferredValue<undefined>()
	const release = createDeferredValue<undefined>()
	const ethereum = new modules.EthereumClientService({
		...fakeRequestHandler,
		async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
			if (suspendedMethod === undefined || rpcRequest.method === suspendedMethod) {
				reached.resolve(undefined)
				await release.promise
			}
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}, async () => undefined, async () => undefined, fakeRpcNetwork)
	return { ethereum, tokenPriceService: new modules.TokenPriceService(ethereum, 60_000), reached: reached.promise, release: () => release.resolve(undefined) }
}

const getRequestedGasLimit = (pending: Awaited<ReturnType<typeof getPendingTransaction>>) => pending.originalRequestParameters.method === 'eth_sendTransaction' ? pending.originalRequestParameters.params[0].gas : undefined

async function changeGasLimit(gasLimit: bigint) {
	const { forceSetGasLimitForTransaction } = await import('../../app/ts/background/popupMessageHandlers.js')
	const { transactionIdentifier } = await getPendingTransaction()
	await forceSetGasLimitForTransaction(simulator.ethereum, simulator.tokenPriceService, { method: 'popup_forceSetGasLimitForTransaction', data: { transactionIdentifier, gasLimit } })
}

// Runs later than the stored simulation, so its timestamps are newer, as when a slow refresh finishes after a newer one.
const advanceClock = () => setSystemTime(new Date(Date.now() + 60_000))

async function selectWalletAccount(account: bigint) {
	await modules.updateTabState(socket.tabId, (state) => ({ ...state, signerName: 'MetaMask', signerAccounts: [account], activeSigningAddress: account, signerChain: fakeRpcNetwork.chainId }))
}

// A Gnosis Safe proposal reviewed while the wallet has a non-owner selected, so a later account change rebuilds it.
async function requestSafeProposal(websiteTabConnections: TransactionTestConnections) {
	fakeSafeContract.owners = [safeTestOwnerAddress]
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(createSafeTx(fakeRpcNetwork.chainId, activeAddress, { to: recipientAddress, value: 2n, input: new Uint8Array() }, 0n)))
	await modules.updateSafeTransactionStacks(() => [])
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({ simulationMode: false, rpcNetwork: fakeRpcNetwork, activeSigningSafeAddress: activeAddress })
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeSimulationSignerAddress: activeAddress, safeVersion: '1.4.1' })])
	await selectWalletAccount(recipientAddress)
	await requestTransaction(websiteTabConnections, false)
	assert.equal((await getPendingTransaction()).safeTransaction?.safeSignerAddress, recipientAddress)
}

test('concurrent approvals forward a transaction to the signer only once', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)

	const approvals = await Promise.all([approveRequest(websiteTabConnections), approveRequest(websiteTabConnections)])

	assert.deepEqual(approvals, [true, false])
	assert.equal(getForwardedSignerRequests(postedMessages).length, 1)
	assert.equal((await getPendingTransaction()).approvalStatus.status, 'WaitingForSigner')
})

test('concurrent approvals add a simulation-mode transaction to the simulation stack only once', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(true)
	await requestTransaction(websiteTabConnections, true)

	const approvals = await Promise.all([approveRequest(websiteTabConnections), approveRequest(websiteTabConnections)])

	assert.deepEqual(approvals, [true, undefined])
	assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 1)
	assert.equal(postedMessages.filter((message) => isRecord(message) && message.type === 'result' && message.method === 'eth_sendTransaction').length, 1)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

async function requestPersonalSign(websiteTabConnections: TransactionTestConnections) {
	const personalSignParams = PersonalSignParams.parse({ method: 'personal_sign', params: ['0x68656c6c6f', addressString(activeAddress)] })
	const reply = await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, {
		interceptorRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		method: personalSignParams.method,
		params: personalSignParams.params,
	}, { kind: 'message', parameters: personalSignParams }, false, activeAddress, website, websiteTabConnections)
	assert.deepEqual(reply, { type: 'doNotReply' })
}

test('concurrent approvals forward a message signing request to the signer only once', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestPersonalSign(websiteTabConnections)

	const approvals = await Promise.all([approveRequest(websiteTabConnections), approveRequest(websiteTabConnections)])

	assert.deepEqual(approvals, [true, false])
	assert.equal(getForwardedSignerRequests(postedMessages).length, 1)
	assert.equal((await modules.getPendingTransactionsAndMessages())[0]?.approvalStatus.status, 'WaitingForSigner')
})

test('a network change after the transaction was requested invalidates its approval', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const otherNetworkServices = createOtherNetworkServices()

	// A network without an Interceptor RPC changes the active network but keeps the previous client installed.
	await modules.browserStorageLocalSet({ activeRpcNetwork: otherNetwork })
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages)

	// After a switch to a network with an Interceptor RPC, approval runs with that network's client.
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, otherNetworkServices.ethereum, otherNetworkServices.tokenPriceService)
})

// Rewrites the stored confirmations as a version that recorded neither the requested network nor the simulation run stored them.
async function storePendingTransactionsAsOlderVersion() {
	const { pendingTransactionsAndMessages } = await browser.storage.local.get('pendingTransactionsAndMessages')
	if (!Array.isArray(pendingTransactionsAndMessages)) throw new Error('Missing stored confirmations')
	const storedByOlderVersion = pendingTransactionsAndMessages.map((pending) => {
		if (!isRecord(pending) || !isRecord(pending.popupVisualisation) || !isRecord(pending.popupVisualisation.data)) throw new Error('Unexpected stored confirmation')
		const { requestedChainId: _requestedChainId, ...pendingWithoutRequestedChainId } = pending
		const { confirmationRunId: _confirmationRunId, ...dataWithoutRunId } = pending.popupVisualisation.data
		return { ...pendingWithoutRequestedChainId, popupVisualisation: { ...pending.popupVisualisation, data: dataWithoutRunId } }
	})
	await browser.storage.local.set({ pendingTransactionsAndMessages: storedByOlderVersion })
}

test('a confirmation cannot be serialized without its requested network or simulation run, and one stored without them decodes with stand-ins', () => {
	const { requestedChainId: _requestedChainId, ...withoutRequestedChainId } = pendingTransaction
	assert.throws(() => serialize(PendingTransactionOrSignableMessage, withoutRequestedChainId))
	const { confirmationRunId: _confirmationRunId, ...dataWithoutRunId } = pendingTransaction.popupVisualisation.data
	assert.throws(() => serialize(PendingTransactionOrSignableMessage, { ...pendingTransaction, popupVisualisation: { ...pendingTransaction.popupVisualisation, data: dataWithoutRunId } }))

	const { requestedChainId: _storedChainId, ...storedWithoutRequestedChainId } = serialize(PendingTransactionOrSignableMessage, pendingTransaction)
	if (!isRecord(storedWithoutRequestedChainId.popupVisualisation) || !isRecord(storedWithoutRequestedChainId.popupVisualisation.data)) throw new Error('Unexpected serialized confirmation')
	const { confirmationRunId: _storedRunId, ...storedDataWithoutRunId } = storedWithoutRequestedChainId.popupVisualisation.data
	const decoded = PendingTransactionOrSignableMessage.parse({ ...storedWithoutRequestedChainId, popupVisualisation: { ...storedWithoutRequestedChainId.popupVisualisation, data: storedDataWithoutRunId } })
	if (decoded.type !== 'Transaction' || !('popupVisualisation' in decoded)) throw new Error('Expected a simulated transaction')
	assert.equal(decoded.requestedChainId, 'unknown')
	assert.deepEqual(decoded.popupVisualisation.data.confirmationRunId, CONFIRMATION_RUN_OF_NO_LIFETIME)
	assert.deepEqual(PendingTransactionOrSignableMessage.parse(serialize(PendingTransactionOrSignableMessage, decoded)), decoded)
})

test('a confirmation stored without its requested network decodes as requested on an unknown network and cannot be approved', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	await storePendingTransactionsAsOlderVersion()

	const storedByOlderVersion = await getPendingTransaction()
	assert.equal(storedByOlderVersion.requestedChainId, 'unknown')
	assert.deepEqual(storedByOlderVersion.popupVisualisation.data.confirmationRunId, CONFIRMATION_RUN_OF_NO_LIFETIME)

	// Neither refresh touches its preview, as no client is on its requested network.
	const { refreshPopupConfirmTransactionMetadata, refreshPopupConfirmTransactionSimulation } = await import('../../app/ts/background/popupMessageHandlers.js')
	await refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	await refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService, undefined)
	assert.deepEqual(await getPendingTransaction(), storedByOlderVersion)

	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages)
	// Written back, it keeps decoding the same way.
	assert.equal((await getPendingTransaction()).requestedChainId, 'unknown')
})

// What the confirmation window last received for the first pending request.
function getLastPublishedApprovalStatus() {
	const published = browserMock.sentMessages.filter((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions').at(-1)
	if (!isRecord(published) || !isRecord(published.data) || !Array.isArray(published.data.pendingTransactionAndSignableMessages)) return undefined
	const first: unknown = published.data.pendingTransactionAndSignableMessages[0]
	return isRecord(first) ? first.approvalStatus : undefined
}

const NETWORK_CHANGED_REFUSAL = 'The active network changed after this transaction was requested. Reject this transaction and send the request again.'
const OLDER_VERSION_REFUSAL = 'This transaction was requested with an older version of The Interceptor. Reject this transaction and send the request again.'

// The network changes run through the real settings transition, with the services of the requested network and of otherNetwork, and a third network that has no services of its own.
async function createNetworkSwitcher(requestedNetworkServices: Pick<typeof simulator, 'ethereum' | 'tokenPriceService'> = simulator) {
	const { changeActiveAddressAndChain } = await import('../../app/ts/background/activeSettings.js')
	const otherNetworkServices = createOtherNetworkServices()
	const simulationServicesOwner = createTestSimulationServicesOwner(simulator, (network) => network.chainId === otherNetwork.chainId ? otherNetworkServices : requestedNetworkServices)
	return {
		simulationServicesOwner,
		switchNetwork: async (rpcNetwork: typeof fakeRpcNetwork) => await changeActiveAddressAndChain(simulationServicesOwner, new Map(), { simulationMode: false, rpcNetwork }),
	}
}

const getStoredApprovalStatus = async () => (await getPendingTransaction()).approvalStatus

const getRefusalMessage = async () => {
	const approvalStatus = await getStoredApprovalStatus()
	return approvalStatus.status === 'SignerError' ? approvalStatus.message : undefined
}

// Records the stored approval status at each chain update, which is what a confirmation window reads from storage when that message reaches it.
function recordApprovalStatusAtChainUpdates() {
	const recorded: unknown[] = []
	const sendMessage = browser.runtime.sendMessage
	browser.runtime.sendMessage = async (message: Parameters<typeof sendMessage>[0]) => {
		if (isRecord(message) && message.method === 'popup_chain_update') recorded.push(await getStoredApprovalStatus())
		return await sendMessage(message)
	}
	return { recorded, restore: () => { browser.runtime.sendMessage = sendMessage } }
}

test('a refusal is lifted as soon as the network is back on the requested network, before the windows are told', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const { simulationServicesOwner, switchNetwork } = await createNetworkSwitcher()

	await switchNetwork(otherNetwork)
	const { ethereum, tokenPriceService } = simulationServicesOwner.getCurrent()
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, ethereum, tokenPriceService)
	assert.equal(await getRefusalMessage(), NETWORK_CHANGED_REFUSAL)

	const chainUpdates = recordApprovalStatusAtChainUpdates()
	await switchNetwork(fakeRpcNetwork)
	chainUpdates.restore()
	assert.deepEqual(await getStoredApprovalStatus(), { status: 'WaitingForUser' })
	assert.deepEqual(chainUpdates.recorded, [{ status: 'WaitingForUser' }])
	assert.deepEqual(getForwardedSignerRequests(postedMessages), [])

	assert.equal(await approveRequest(websiteTabConnections), true)
	assert.equal(getForwardedSignerRequests(postedMessages).length, 1)
})

test('lifting a refusal does not hold back the network change behind an RPC of the requested network', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const suspended = createSuspendedServices('eth_blockNumber')
	const { simulationServicesOwner, switchNetwork } = await createNetworkSwitcher(suspended)

	await switchNetwork(otherNetwork)
	const { ethereum, tokenPriceService } = simulationServicesOwner.getCurrent()
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, ethereum, tokenPriceService)

	// The change completes and the refusal is gone while the RPC of the requested network has not answered.
	await switchNetwork(fakeRpcNetwork)
	assert.deepEqual(await getStoredApprovalStatus(), { status: 'WaitingForUser' })
	suspended.release()
})

test('a refusal stays while the check still refuses, and approving again still sends nothing', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const { simulationServicesOwner, switchNetwork } = await createNetworkSwitcher()
	const thirdNetwork = { ...fakeRpcNetwork, name: 'Third Test Chain', chainId: 10n }

	await switchNetwork(otherNetwork)
	const { ethereum, tokenPriceService } = simulationServicesOwner.getCurrent()
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, ethereum, tokenPriceService)

	await switchNetwork(thirdNetwork)
	assert.equal(await getRefusalMessage(), NETWORK_CHANGED_REFUSAL)
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, ethereum, tokenPriceService)

	// The client of the requested network alone does not lift it: the active network has to match too.
	await modules.updateConfirmTransactionView(simulator.ethereum, simulator.tokenPriceService)
	assert.equal(await getRefusalMessage(), NETWORK_CHANGED_REFUSAL)
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages)
})

test('an error reported by the wallet is not lifted by the requested network, even with the same error code', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const walletError = { status: 'SignerError' as const, code: METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN, message: 'The wallet is not connected to this chain.' }
	await storePendingTransaction((pending) => ({ ...pending, approvalStatus: walletError }))

	await modules.updateConfirmTransactionView(simulator.ethereum, simulator.tokenPriceService)
	assert.deepEqual(await getStoredApprovalStatus(), walletError)
})

test('updating the confirmation window never refuses a request that was not refused', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const { switchNetwork } = await createNetworkSwitcher()

	await switchNetwork(otherNetwork)
	assert.deepEqual(await getStoredApprovalStatus(), { status: 'WaitingForUser' })
})

test('a confirmation stored by an older version is told so, and its refusal never lifts', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	await storePendingTransactionsAsOlderVersion()
	const { switchNetwork } = await createNetworkSwitcher()

	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages)
	assert.equal(await getRefusalMessage(), OLDER_VERSION_REFUSAL)

	await switchNetwork(otherNetwork)
	await switchNetwork(fakeRpcNetwork)
	assert.equal(await getRefusalMessage(), OLDER_VERSION_REFUSAL)
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages)
	assert.equal(await getRefusalMessage(), OLDER_VERSION_REFUSAL)
})

test('a push whose read overlaps a write reaches the windows before that write is announced', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const { publishConfirmationView } = await import('../../app/ts/background/windows/confirmTransaction.js')
	const { sendPopupMessageToOpenWindows } = await import('../../app/ts/background/backgroundUtils.js')
	const readStarted = createDeferredValue<undefined>()
	const releaseRead = createDeferredValue<undefined>()
	let holdNextRead = true
	browserMock.setStorageGetHandler(async (_keys, read) => {
		const stored = read()
		if (holdNextRead) {
			holdNextRead = false
			readStarted.resolve(undefined)
			await releaseRead.promise
		}
		return stored
	})

	const publishing = publishConfirmationView({ currentBlockNumber: 1n, rpcConnectionStatus: undefined, visualizedSimulatorState: createPassthroughCompleteVisualizedSimulation() })
	await readStarted.promise
	browserMock.sentMessages.length = 0
	const writing = storePendingTransaction((pending) => ({ ...pending, approvalStatus: { status: 'WaitingForSigner' } })).then(async () => await sendPopupMessageToOpenWindows({ method: 'popup_chain_update' }))
	await new Promise((resolve) => setTimeout(resolve, 10))
	releaseRead.resolve(undefined)
	await Promise.all([publishing, writing])
	browserMock.setStorageGetHandler(undefined)

	const methods = browserMock.sentMessages.map((message) => message.method)
	assert.ok(methods.indexOf('popup_update_confirm_transaction_dialog_pending_transactions') >= 0)
	assert.ok(methods.indexOf('popup_update_confirm_transaction_dialog_pending_transactions') < methods.indexOf('popup_chain_update'))
})

test('a metadata refresh of a transaction publishes the approval as it is stored when it publishes', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const { refreshPopupConfirmTransactionMetadata } = await import('../../app/ts/background/popupMessageHandlers.js')
	const suspended = createSuspendedServices('eth_blockNumber')

	const refresh = refreshPopupConfirmTransactionMetadata(suspended.ethereum, suspended.tokenPriceService, undefined)
	await suspended.reached
	await new Promise((resolve) => setTimeout(resolve, 25))
	await storePendingTransaction((pending) => ({ ...pending, approvalStatus: { status: 'WaitingForSigner' } }))
	suspended.release()
	await refresh

	assert.deepEqual(getLastPublishedApprovalStatus(), { status: 'WaitingForSigner' })
})

test('a metadata refresh of a message publishes the approval as it is stored when it publishes', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestPersonalSign(websiteTabConnections)
	const { refreshPopupConfirmTransactionMetadata } = await import('../../app/ts/background/popupMessageHandlers.js')
	const suspended = createSuspendedServices('eth_blockNumber')

	const refresh = refreshPopupConfirmTransactionMetadata(suspended.ethereum, suspended.tokenPriceService, undefined)
	await suspended.reached
	await storePendingTransaction((pending) => ({ ...pending, approvalStatus: { status: 'WaitingForSigner' } }))
	suspended.release()
	await refresh

	assert.deepEqual(getLastPublishedApprovalStatus(), { status: 'WaitingForSigner' })
})

test('a confirmation window that starts during slow lookups starts from what is stored after them', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const { popupReadyAndListening } = await import('../../app/ts/background/popupMessageHandlers.js')
	const suspended = createSuspendedServices('eth_blockNumber')

	const ready = popupReadyAndListening(suspended.ethereum, websiteTabConnections, 'confirmTransaction')
	await suspended.reached
	await storePendingTransaction((pending) => ({ ...pending, approvalStatus: { status: 'WaitingForSigner' } }))
	suspended.release()

	assert.equal((await ready)?.data.confirmTransactionBootstrap?.pendingTransactionAndSignableMessages[0]?.approvalStatus.status, 'WaitingForSigner')
})

test('a network round trip keeps the transaction preview of the network the transaction was requested for', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const otherNetworkServices = createOtherNetworkServices()
	const { refreshPopupConfirmTransactionMetadata, refreshPopupConfirmTransactionSimulation } = await import('../../app/ts/background/popupMessageHandlers.js')

	await modules.browserStorageLocalSet({ activeRpcNetwork: otherNetwork })
	await refreshPopupConfirmTransactionSimulation(otherNetworkServices.ethereum, otherNetworkServices.tokenPriceService)
	await refreshPopupConfirmTransactionMetadata(otherNetworkServices.ethereum, otherNetworkServices.tokenPriceService, undefined)
	await modules.browserStorageLocalSet({ activeRpcNetwork: fakeRpcNetwork })

	// The metadata refresh still reads the other network's block number for the popup, but nothing about the transaction is prepared, simulated or visualized there.
	assert.deepEqual(otherNetworkServices.requestedRpcMethods.filter((method) => method !== 'eth_blockNumber'), [])
	assert.deepEqual(getPreviewChainIds(await getPendingTransaction()), { transaction: fakeRpcNetwork.chainId, visualization: fakeRpcNetwork.chainId })
	assert.equal(await approveRequest(websiteTabConnections), true)
	assert.equal(getForwardedSignerRequests(postedMessages).length, 1)
})

test('a transaction preview from another network cannot be approved', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const original = await getPendingTransaction()
	const storePreview = async (preview: Partial<Pick<typeof original, 'transactionToSimulate' | 'popupVisualisation'>>) => await storePendingTransaction(() => ({ ...original, ...preview, approvalStatus: { status: 'WaitingForUser' } }))
	if (original.popupVisualisation.statusCode !== 'success') throw new Error('Missing transaction simulation')
	const originalVisualization = original.popupVisualisation

	await storePreview({ transactionToSimulate: { ...original.transactionToSimulate, transaction: { ...original.transactionToSimulate.transaction, chainId: otherNetwork.chainId } } })
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages)

	await storePreview({ popupVisualisation: { ...originalVisualization, data: { ...originalVisualization.data, simulationState: { ...originalVisualization.data.simulationState, rpcNetwork: otherNetwork } } } })
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages)

	await storePreview({})
	assert.equal(await approveRequest(websiteTabConnections), true)
	assert.equal(getForwardedSignerRequests(postedMessages).length, 1)
})

test('a raw transaction signed for the requested network can be approved', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false, signRawTransaction(fakeRpcNetwork.chainId))

	assert.deepEqual(getPreviewChainIds(await getPendingTransaction()), { transaction: fakeRpcNetwork.chainId, visualization: fakeRpcNetwork.chainId })
	assert.equal(await approveRequest(websiteTabConnections), true)
	assert.deepEqual(getForwardedSignerRequests(postedMessages).map((message) => isRecord(message) ? message.method : undefined), ['eth_sendRawTransaction'])
})

test('a raw transaction signed for another network cannot be approved', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false, signRawTransaction(otherNetwork.chainId))

	// The simulation runs on the requested network, so only the signed chain id tells that the transaction would be broadcast on another one.
	assert.deepEqual(getPreviewChainIds(await getPendingTransaction()), { transaction: otherNetwork.chainId, visualization: fakeRpcNetwork.chainId })
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages)
})

test('a raw transaction signed for another network is not added to the simulation stack', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(true)
	await requestTransaction(websiteTabConnections, true, signRawTransaction(otherNetwork.chainId))

	assert.equal(await approveRequest(websiteTabConnections), false)
	assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
	const pending = await getPendingTransaction()
	if (pending.approvalStatus.status !== 'SignerError') throw new Error(`Expected an invalidated approval, got ${ pending.approvalStatus.status }`)
	assert.equal(pending.approvalStatus.code, METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN)
})

test('a legacy raw transaction without a chain id never becomes a pending confirmation', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	// The pre-EIP-155 deployment transaction of the deterministic deployment proxy, valid on every network because it signs no chain id.
	const preEip155Transaction = SendRawTransactionParams.parse({ method: 'eth_sendRawTransaction', params: ['0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf31ba02222222222222222222222222222222222222222222222222222222222222222a02222222222222222222222222222222222222222222222222222222222222222'] })

	await assert.rejects(requestTransaction(websiteTabConnections, false, preEip155Transaction), /Unsupported transaction type legacy/)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(getForwardedSignerRequests(postedMessages), [])
})

test('a metadata refresh that finishes after the transaction was approved keeps it waiting for the signer', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const suspended = createSuspendedServices()
	const { refreshPopupConfirmTransactionMetadata } = await import('../../app/ts/background/popupMessageHandlers.js')

	const metadataRefresh = refreshPopupConfirmTransactionMetadata(suspended.ethereum, suspended.tokenPriceService, undefined)
	await suspended.reached
	assert.equal(await approveRequest(websiteTabConnections), true)
	suspended.release()
	await metadataRefresh

	assert.equal((await getPendingTransaction()).approvalStatus.status, 'WaitingForSigner')
	assert.equal(await approveRequest(websiteTabConnections), false)
	assert.equal(getForwardedSignerRequests(postedMessages).length, 1)
})

test('a metadata refresh of an older simulation run keeps the newer run and gas limit stored meanwhile', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const suspended = createSuspendedServices()
	const { refreshPopupConfirmTransactionMetadata } = await import('../../app/ts/background/popupMessageHandlers.js')

	const metadataRefresh = refreshPopupConfirmTransactionMetadata(suspended.ethereum, suspended.tokenPriceService, undefined)
	await suspended.reached
	await changeGasLimit(30_000n)
	suspended.release()
	await metadataRefresh

	const pending = await getPendingTransaction()
	assert.equal(getRequestedGasLimit(pending), 30_000n)
	assert.equal(pending.popupVisualisation.data.transactionToSimulate.success ? pending.popupVisualisation.data.transactionToSimulate.transaction.gas : undefined, 30_000n)
})

// Whether the run came after the earlier run in the same background lifetime.
const isLaterRunOfSameLifetime = (run: ConfirmationRunId, earlier: ConfirmationRunId) => run.lifetime === earlier.lifetime && run.sequence > earlier.sequence

test('a confirmation visualisation is stored over one of an earlier run of its lifetime or of another lifetime, and a re-visualisation only over its own run', async () => {
	const { isConfirmationVisualisationCurrent } = await import('../../app/ts/background/confirmTransactionSimulation.js')
	const run = (lifetime: string, sequence: number) => ({ data: { confirmationRunId: { lifetime, sequence } } })
	assert.equal(isConfirmationVisualisationCurrent(undefined, run('current', 5), 'new run'), true)
	assert.equal(isConfirmationVisualisationCurrent(run('current', 5), run('current', 6), 'new run'), true)
	assert.equal(isConfirmationVisualisationCurrent(run('current', 6), run('current', 5), 'new run'), false)
	assert.equal(isConfirmationVisualisationCurrent(run('previous', 1000), run('current', 1), 'new run'), true)
	assert.equal(isConfirmationVisualisationCurrent({ data: { confirmationRunId: CONFIRMATION_RUN_OF_NO_LIFETIME } }, run('current', 1), 'new run'), true)
	assert.equal(isConfirmationVisualisationCurrent(run('current', 5), run('current', 5), 're-visualised run'), true)
	assert.equal(isConfirmationVisualisationCurrent(run('previous', 5), run('current', 5), 're-visualised run'), false)
	assert.equal(isConfirmationVisualisationCurrent(run('current', 6), run('current', 5), 're-visualised run'), false)
	assert.equal(isConfirmationVisualisationCurrent(undefined, run('current', 5), 're-visualised run'), false)
})

// Stores the preview as one of a run of a previous background lifetime, which a fresh copy of the run id module stands in for, late in that lifetime.
async function storePreviewOfPreviousLifetime() {
	const previousLifetimeModule = '../../app/ts/background/confirmTransactionSimulation.js?previousLifetime'
	const previousLifetime: typeof import('../../app/ts/background/confirmTransactionSimulation.js') = await import(previousLifetimeModule)
	for (let reservation = 0; reservation < 1000; reservation++) previousLifetime.reserveConfirmationRun()
	const runOfPreviousLifetime = previousLifetime.reserveConfirmationRun()
	await storePendingTransaction((pending) => {
		if (pending.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Missing simulated transaction confirmation')
		return { ...pending, popupVisualisation: { ...pending.popupVisualisation, data: { ...pending.popupVisualisation.data, confirmationRunId: runOfPreviousLifetime } } }
	})
	return runOfPreviousLifetime
}

test('a preview stored by a previous background lifetime is replaced by the first new run of this lifetime', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const thisLifetime = (await getPendingTransaction()).popupVisualisation.data.confirmationRunId.lifetime
	const runOfPreviousLifetime = await storePreviewOfPreviousLifetime()
	assert.notEqual(runOfPreviousLifetime.lifetime, thisLifetime)

	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)

	assert.equal((await getPendingTransaction()).popupVisualisation.data.confirmationRunId.lifetime, thisLifetime)
})

test('after a background restart, the first refresh of a gas limit edit stores a preview of the requested gas limit', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	await storePreviewOfPreviousLifetime()

	await changeGasLimit(30_000n)

	const pending = await getPendingTransaction()
	const visualisedTransaction = pending.popupVisualisation.data.transactionToSimulate
	assert.equal(getRequestedGasLimit(pending), 30_000n)
	assert.equal(pending.transactionToSimulate.transaction.gas, 30_000n)
	assert.equal(visualisedTransaction.success ? visualisedTransaction.transaction.gas : undefined, 30_000n)
})

test('a run that started before a later run was stored is still not stored over it', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const { isConfirmationVisualisationCurrent, refreshConfirmTransactionSimulation, reserveConfirmationRun } = await import('../../app/ts/background/confirmTransactionSimulation.js')
	const pending = await getPendingTransaction()
	const earlierRun = await refreshConfirmTransactionSimulation(reserveConfirmationRun(), simulator.ethereum, simulator.tokenPriceService, pending.activeAddress, false, uniqueRequestIdentifier, pending.transactionToSimulate)
	if (earlierRun === undefined) throw new Error('The earlier run did not complete')

	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)

	const storedLaterRun = (await getPendingTransaction()).popupVisualisation
	assert.ok(isLaterRunOfSameLifetime(storedLaterRun.data.confirmationRunId, earlierRun.data.confirmationRunId))
	assert.equal(isConfirmationVisualisationCurrent(storedLaterRun, earlierRun, 'new run'), false)
})

// Holds the first storage read of the given key until released, and tells when it was reached.
function holdFirstStorageRead(isHeldRead: (keys: unknown) => boolean) {
	const reached = createDeferredValue<undefined>()
	const release = createDeferredValue<undefined>()
	let held = false
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!held && isHeldRead(keys)) {
			held = true
			reached.resolve(undefined)
			await release.promise
		}
		return readStoredItems()
	})
	return { reached: reached.promise, release: () => release.resolve(undefined) }
}

test('of two overlapping simulation refreshes, the one requested first cannot replace the preview of the later one, even if its first read is slow', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const initialRunId = (await getPendingTransaction()).popupVisualisation.data.confirmationRunId
	const earlierRefreshRead = holdFirstStorageRead((keys) => Array.isArray(keys) && keys.includes('pendingTransactionsAndMessages'))

	const earlierRefresh = modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	await earlierRefreshRead.reached
	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	const laterRunId = (await getPendingTransaction()).popupVisualisation.data.confirmationRunId
	earlierRefreshRead.release()
	await earlierRefresh

	assert.ok(isLaterRunOfSameLifetime(laterRunId, initialRunId))
	assert.deepEqual((await getPendingTransaction()).popupVisualisation.data.confirmationRunId, laterRunId)
})

test('a simulation refresh that resumes after a later refresh started simulating does not abort it', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const initialRunId = (await getPendingTransaction()).popupVisualisation.data.confirmationRunId
	const { getInFlightConfirmationRunAbortController } = await import('../../app/ts/background/confirmTransactionSimulation.js')
	// The first tab state read of a refresh is the one its simulation makes after its run id was allocated.
	const earlierRunTabStateRead = holdFirstStorageRead((keys) => keys === `tabState_${ socket.tabId }`)

	const earlierRefresh = modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	await earlierRunTabStateRead.reached
	const suspended = createSuspendedServices('eth_simulateV1')
	const laterRefresh = modules.refreshPopupConfirmTransactionSimulation(suspended.ethereum, suspended.tokenPriceService)
	await suspended.reached
	const laterRunAbortController = getInFlightConfirmationRunAbortController(uniqueRequestIdentifier)
	if (laterRunAbortController === undefined) throw new Error('The later run is not in flight')
	earlierRunTabStateRead.release()
	await earlierRefresh

	assert.equal(laterRunAbortController.signal.aborted, false)
	suspended.release()
	await laterRefresh
	assert.ok(isLaterRunOfSameLifetime((await getPendingTransaction()).popupVisualisation.data.confirmationRunId, initialRunId))
})

// Opens a direct Gnosis Safe execution while no wallet account is connected, then connects the Safe signer, so the next Gnosis Safe signer refresh rebuilds and simulates it.
async function openDirectSafeExecutionAwaitingSignerRefresh() {
	const safeSignerAddress = recipientAddress
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, { to: recipientAddress, value: 0n, input: new Uint8Array() }, fakeSafeContract.nonce)
	const existingSignature = await safeTestOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	fakeSafeContract.owners = [safeTestOwnerAddress, safeSignerAddress]
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeSignerAddresses: [safeSignerAddress] })])
	await modules.updateTabState(socket.tabId, (state) => ({ ...state, signerAccounts: [], activeSigningAddress: undefined, signerChain: fakeRpcNetwork.chainId }))
	const executionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			value: '0x0',
			data: encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [addressString(recipientAddress), 0n, '0x', 0n, 0n, 0n, 0n, addressString(0n), addressString(0n), existingSignature]),
		}],
	})
	// Its simulation fails against the fake Gnosis Safe, which is reported.
	await withSilencedConsole(async () => await requestTransaction(websiteTabConnections, false, executionParams))
	await modules.updateTabState(socket.tabId, (state) => ({ ...state, signerAccounts: [safeSignerAddress], activeSigningAddress: safeSignerAddress }))
	return { safeSignerAddress, websiteTabConnections }
}

// Starts an earlier Gnosis Safe rebuild entry, holds it at its first matching storage read, starts a popup refresh and holds it once it installed its abort controller, then releases the earlier entry, which ends as an aborted rebuild does. Returns whether the popup refresh's abort controller was aborted.
async function wasLaterPopupRefreshAborted(startEarlierEntry: () => Promise<unknown>, isEarlierEntryHeldRead: (keys: unknown) => boolean) {
	const { getInFlightConfirmationRunAbortController } = await import('../../app/ts/background/confirmTransactionSimulation.js')
	const earlierEntryReadReached = createDeferredValue<undefined>()
	const releaseEarlierEntryRead = createDeferredValue<undefined>()
	const laterRunSimulationInputReached = createDeferredValue<undefined>()
	const releaseLaterRunSimulationInput = createDeferredValue<undefined>()
	let holdEarlierEntryRead = true
	let laterRunStage: 'not started' | 'preparing' | 'simulating' | 'held' = 'not started'
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (holdEarlierEntryRead && isEarlierEntryHeldRead(keys)) {
			holdEarlierEntryRead = false
			earlierEntryReadReached.resolve(undefined)
			await releaseEarlierEntryRead.promise
		} else if (laterRunStage === 'preparing' && keys === `tabState_${ socket.tabId }`) {
			// The later run reads tab state right before it installs its abort controller.
			laterRunStage = 'simulating'
		} else if (laterRunStage === 'simulating' && Array.isArray(keys) && keys.includes('preSimulationBlockTimeManipulation')) {
			// Read for its simulation input, after it installed its abort controller.
			laterRunStage = 'held'
			laterRunSimulationInputReached.resolve(undefined)
			await releaseLaterRunSimulationInput.promise
		}
		return readStoredItems()
	})

	return await withSilencedConsole(async () => {
		const earlierEntry = startEarlierEntry()
		await earlierEntryReadReached.promise
		laterRunStage = 'preparing'
		const laterRefresh = modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
		await laterRunSimulationInputReached.promise
		const laterRunAbortController = getInFlightConfirmationRunAbortController(uniqueRequestIdentifier)
		if (laterRunAbortController === undefined) throw new Error('The later run is not in flight')
		releaseEarlierEntryRead.resolve(undefined)
		await assert.rejects(earlierEntry, /The refreshed Gnosis Safe execution simulation did not complete/)
		const abortedBeforeLaterRunFinished = laterRunAbortController.signal.aborted
		releaseLaterRunSimulationInput.resolve(undefined)
		await laterRefresh
		return abortedBeforeLaterRunFinished || laterRunAbortController.signal.aborted
	})
}

test('a Gnosis Safe signer refresh that started before a popup refresh does not abort that refresh', async () => {
	await openDirectSafeExecutionAwaitingSignerRefresh()
	// The signer refresh first reads the tab state, before its rebuild.
	assert.equal(await wasLaterPopupRefreshAborted(async () => await modules.refreshPendingSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, socket.tabId), (keys) => keys === `tabState_${ socket.tabId }`), false)
})

test('a Gnosis Safe approval that started before a popup refresh does not abort that refresh with its rebuild', async () => {
	const { safeSignerAddress, websiteTabConnections } = await openDirectSafeExecutionAwaitingSignerRefresh()
	const approval = async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } }, { selectedSigner: safeSignerAddress, verificationError: undefined })
	// The approval reads the active network for its network check before its rebuild.
	assert.equal(await wasLaterPopupRefreshAborted(approval, (keys) => Array.isArray(keys) && keys.length === 1 && keys[0] === 'activeRpcNetwork'), false)
})

test('a Gnosis Safe rebuild is not persisted over the preview of a popup refresh that started after it', async () => {
	const { safeSignerAddress } = await openDirectSafeExecutionAwaitingSignerRefresh()
	const { refreshAndPersistSafeSignerSelection } = await import('../../app/ts/background/safeSignerSelectionRefresh.js')
	const [beforeRebuild] = await modules.getPendingTransactionsAndMessages()
	if (beforeRebuild?.type !== 'Transaction' || !('popupVisualisation' in beforeRebuild)) throw new Error('Missing simulated direct Safe execution')

	// The rebuild returns a preview of a run older than the popup refresh that stores its preview while the rebuild runs.
	const persistence = await withSilencedConsole(async () => await refreshAndPersistSafeSignerSelection(simulator.ethereum, beforeRebuild, safeSignerAddress, async (rebuilt) => {
		await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
		return rebuilt
	}))

	const [afterRebuild] = await modules.getPendingTransactionsAndMessages()
	if (afterRebuild?.type !== 'Transaction' || !('popupVisualisation' in afterRebuild)) throw new Error('Missing simulated direct Safe execution')
	assert.equal(persistence.persisted, false)
	assert.ok(isLaterRunOfSameLifetime(afterRebuild.popupVisualisation.data.confirmationRunId, beforeRebuild.popupVisualisation.data.confirmationRunId))
	assert.equal(afterRebuild.safeExecutionSignerAddress, beforeRebuild.safeExecutionSignerAddress)
})

test('a confirmation whose first simulation started before a refresh of another confirmation still completes it, and neither cancels the other', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const { getInFlightConfirmationRunAbortController } = await import('../../app/ts/background/confirmTransactionSimulation.js')
	const otherRequest = { ...uniqueRequestIdentifier, requestId: uniqueRequestIdentifier.requestId + 1 }
	const otherRequestTabStateRead = holdFirstStorageRead((keys) => keys === `tabState_${ socket.tabId }`)

	// The other confirmation reserves its first run before the refresh below, then waits on its first read.
	const otherRequestOpening = modules.openConfirmTransactionDialogForTransaction(simulator.ethereum, simulator.tokenPriceService, { interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: otherRequest, method: transactionParams.method, params: transactionParams.params }, { kind: 'transaction', parameters: transactionParams }, false, activeAddress, website, websiteTabConnections)
	await otherRequestTabStateRead.reached
	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	const suspended = createSuspendedServices('eth_simulateV1')
	const laterRefresh = modules.refreshPopupConfirmTransactionSimulation(suspended.ethereum, suspended.tokenPriceService)
	await suspended.reached
	const laterRunAbortController = getInFlightConfirmationRunAbortController(uniqueRequestIdentifier)
	if (laterRunAbortController === undefined) throw new Error('The later run is not in flight')
	otherRequestTabStateRead.release()
	assert.deepEqual(await otherRequestOpening, { type: 'doNotReply' })

	assert.equal(laterRunAbortController.signal.aborted, false)
	suspended.release()
	await laterRefresh
	const otherPending = (await modules.getPendingTransactionsAndMessages()).find((pending) => pending.uniqueRequestIdentifier.requestId === otherRequest.requestId)
	assert.equal(otherPending?.type === 'Transaction' ? otherPending.transactionOrMessageCreationStatus : undefined, 'Simulated')
	// Once the first confirmation is gone, the other one is the one refreshed.
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: (await modules.getPendingTransactionsAndMessages()).filter((pending) => pending.uniqueRequestIdentifier.requestId === otherRequest.requestId) })
	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	const [refreshedOther] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedOther?.type === 'Transaction' ? refreshedOther.transactionOrMessageCreationStatus : undefined, 'Simulated')
})

// Holds a gas limit edit at its check whether the simulation visualizer is open, which comes after the new gas limit was stored.
function holdGasLimitEditAfterItsWrite() {
	const reached = createDeferredValue<undefined>()
	const release = createDeferredValue<undefined>()
	const sendMessage = browser.runtime.sendMessage
	let held = false
	browser.runtime.sendMessage = async (message: Parameters<typeof sendMessage>[0]) => {
		if (!held && isRecord(message) && message.method === 'popup_isSimulationVisualizerOpen') {
			held = true
			reached.resolve(undefined)
			await release.promise
		}
		return await sendMessage(message)
	}
	return { reached: reached.promise, release: () => release.resolve(undefined), restore: () => { browser.runtime.sendMessage = sendMessage } }
}

test('a refresh that starts after a gas limit edit was stored keeps its preview over the refresh of the edit', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const editHold = holdGasLimitEditAfterItsWrite()
	try {
		const edit = changeGasLimit(30_000n)
		await editHold.reached
		await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
		const laterRunId = (await getPendingTransaction()).popupVisualisation.data.confirmationRunId
		editHold.release()
		await edit

		const pending = await getPendingTransaction()
		assert.deepEqual(pending.popupVisualisation.data.confirmationRunId, laterRunId)
		assert.equal(pending.transactionToSimulate.transaction.gas, 30_000n)
	} finally {
		editHold.restore()
	}
})

test('a refresh that starts after a gas limit edit was stored is not aborted by the refresh of the edit', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const { getInFlightConfirmationRunAbortController } = await import('../../app/ts/background/confirmTransactionSimulation.js')
	const editHold = holdGasLimitEditAfterItsWrite()
	try {
		const edit = changeGasLimit(30_000n)
		await editHold.reached
		const suspended = createSuspendedServices('eth_simulateV1')
		const laterRefresh = modules.refreshPopupConfirmTransactionSimulation(suspended.ethereum, suspended.tokenPriceService)
		await suspended.reached
		const laterRunAbortController = getInFlightConfirmationRunAbortController(uniqueRequestIdentifier)
		if (laterRunAbortController === undefined) throw new Error('The later run is not in flight')
		editHold.release()
		await edit

		assert.equal(laterRunAbortController.signal.aborted, false)
		suspended.release()
		await laterRefresh
		assert.equal((await getPendingTransaction()).transactionToSimulate.transaction.gas, 30_000n)
	} finally {
		editHold.restore()
	}
})

test('a refresh that read the transaction before a gas limit edit does not keep its preview over the refresh of the edit', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const { forceSetGasLimitForTransaction } = await import('../../app/ts/background/popupMessageHandlers.js')
	const { transactionIdentifier } = await getPendingTransaction()
	// Holds the edit at its own first read, after it started but before it stores the new gas limit.
	const editRead = holdFirstStorageRead((keys) => Array.isArray(keys) && keys.includes('pendingTransactionsAndMessages'))

	const edit = forceSetGasLimitForTransaction(simulator.ethereum, simulator.tokenPriceService, { method: 'popup_forceSetGasLimitForTransaction', data: { transactionIdentifier, gasLimit: 30_000n } })
	await editRead.reached
	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	assert.equal((await getPendingTransaction()).transactionToSimulate.transaction.gas, 21_000n)
	editRead.release()
	await edit

	const pending = await getPendingTransaction()
	assert.equal(getRequestedGasLimit(pending), 30_000n)
	assert.equal(pending.transactionToSimulate.transaction.gas, 30_000n)
})

test('a simulation refresh that finishes after the transaction was approved keeps the approved preview', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const approvedPreview = (await getPendingTransaction()).popupVisualisation.data.simulationStartedTimestamp.getTime()
	const suspended = createSuspendedServices()

	try {
		const simulationRefresh = modules.refreshPopupConfirmTransactionSimulation(suspended.ethereum, suspended.tokenPriceService)
		await suspended.reached
		assert.equal(await approveRequest(websiteTabConnections), true)
		advanceClock()
		suspended.release()
		await simulationRefresh
	} finally {
		setSystemTime()
	}

	const pending = await getPendingTransaction()
	assert.equal(pending.approvalStatus.status, 'WaitingForSigner')
	assert.equal(pending.popupVisualisation.data.simulationStartedTimestamp.getTime(), approvedPreview)
})

test('a simulation refresh prepared before a gas limit change is not stored over the new gas limit', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const suspended = createSuspendedServices()

	try {
		const staleRefresh = modules.refreshPopupConfirmTransactionSimulation(suspended.ethereum, suspended.tokenPriceService)
		await suspended.reached
		await changeGasLimit(30_000n)
		advanceClock()
		suspended.release()
		await staleRefresh
	} finally {
		setSystemTime()
	}

	const pending = await getPendingTransaction()
	assert.equal(getRequestedGasLimit(pending), 30_000n)
	assert.equal(pending.transactionToSimulate.transaction.gas, 30_000n)
})

test('a gas limit change after the transaction was approved keeps the request forwarded to the signer', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	assert.equal(await approveRequest(websiteTabConnections), true)

	await changeGasLimit(30_000n)

	const pending = await getPendingTransaction()
	assert.equal(pending.approvalStatus.status, 'WaitingForSigner')
	assert.equal(getRequestedGasLimit(pending), 21_000n)
})

test('the first simulation of a transaction approved before it finished keeps the approved preview', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const suspended = createSuspendedServices('eth_simulateV1')
	const request = modules.openConfirmTransactionDialogForTransaction(suspended.ethereum, suspended.tokenPriceService, {
		interceptorRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		method: transactionParams.method,
		params: transactionParams.params,
	}, { kind: 'transaction', parameters: transactionParams }, false, activeAddress, website, websiteTabConnections)
	await suspended.reached
	while ((await modules.getPendingTransactionsAndMessages())[0]?.transactionOrMessageCreationStatus !== 'Simulating') await new Promise((resolve) => setTimeout(resolve, 5))

	// Stands in for another path that stored a simulation the user approved while the first simulation was still running.
	const approvedPreview = { ...pendingTransaction, simulationMode: false, approvalStatus: { status: 'WaitingForSigner' as const } }
	await storePendingTransaction(() => approvedPreview)
	suspended.release()
	await request

	const pending = await getPendingTransaction()
	assert.equal(pending.approvalStatus.status, 'WaitingForSigner')
	assert.equal(pending.popupVisualisation.data.simulationStartedTimestamp.getTime(), pendingTransaction.popupVisualisation.data.simulationStartedTimestamp.getTime())
})

test('a Gnosis Safe signer change on another network does not rebuild the proposal for that network', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestSafeProposal(websiteTabConnections)
	const otherNetworkServices = createOtherNetworkServices()
	await selectWalletAccount(safeTestOwnerAddress)
	const requestedNetworkSafeTxHash = fakeSafeContract.transactionHash

	// The same Safe exists with the same owners on the other network, where it reports the hash of a proposal for that network.
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(createSafeTx(otherNetwork.chainId, activeAddress, { to: recipientAddress, value: 2n, input: new Uint8Array() }, 0n)))
	await modules.refreshPendingSafeSignerSelectionErrors(otherNetworkServices.ethereum, otherNetworkServices.tokenPriceService, socket.tabId)
	assert.deepEqual(otherNetworkServices.requestedRpcMethods.filter((method) => method !== 'eth_blockNumber'), [])
	const notRebuilt = await getPendingTransaction()
	assert.equal(notRebuilt.safeTransaction?.safeTx.domain.chainId, fakeRpcNetwork.chainId)
	assert.equal(notRebuilt.safeTransaction?.safeSignerAddress, recipientAddress)

	fakeSafeContract.transactionHash = requestedNetworkSafeTxHash
	await modules.refreshPendingSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, socket.tabId)
	const rebuilt = await getPendingTransaction()
	assert.equal(rebuilt.safeTransaction?.safeSignerAddress, safeTestOwnerAddress)
	assert.equal(rebuilt.safeTransaction?.safeTx.domain.chainId, fakeRpcNetwork.chainId)
	assert.equal(await approveRequest(websiteTabConnections), true)
	assert.equal(getForwardedSignerRequests(postedMessages).length, 1)
})

test('a Gnosis Safe proposal signed for another network cannot be approved', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestSafeProposal(websiteTabConnections)
	await selectWalletAccount(safeTestOwnerAddress)
	await modules.refreshPendingSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, socket.tabId)
	const proposal = await getPendingTransaction()
	const { safeTransaction } = proposal
	if (safeTransaction === undefined) throw new Error('Missing Gnosis Safe proposal')

	await storePendingTransaction(() => ({ ...proposal, safeTransaction: { ...safeTransaction, safeTx: { ...safeTransaction.safeTx, domain: { ...safeTransaction.safeTx.domain, chainId: otherNetwork.chainId } } } }))

	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages)
})

test('a network switch while a signing-mode approval is suspended keeps the transaction from reaching the signer', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	// The approval asks this client for the block number while it updates the confirmation window, after its first network check.
	const suspended = createSuspendedServices('eth_blockNumber')

	const approval = approveRequest(websiteTabConnections, suspended.ethereum, suspended.tokenPriceService)
	await suspended.reached
	await modules.browserStorageLocalSet({ activeRpcNetwork: otherNetwork })
	suspended.release()

	assert.equal(await approval, false)
	assert.deepEqual(getForwardedSignerRequests(postedMessages), [])
	const pending = await getPendingTransaction()
	if (pending.approvalStatus.status !== 'SignerError') throw new Error(`Expected an invalidated approval, got ${ pending.approvalStatus.status }`)
	assert.equal(pending.approvalStatus.code, METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN)
})

test('a network switch while a simulation-mode approval is suspended keeps the transaction out of the simulation stack', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(true)
	await requestTransaction(websiteTabConnections, true)
	// Suspends the approval's second read of the active network, which is its final network check, if the approval makes one.
	const finalNetworkCheck = createDeferredValue<undefined>()
	const release = createDeferredValue<undefined>()
	let networkReads = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (Array.isArray(keys) && keys.includes('activeRpcNetwork')) {
			networkReads += 1
			if (networkReads === 2) {
				finalNetworkCheck.resolve(undefined)
				await release.promise
			}
		}
		return readStoredItems()
	})

	const approval = approveRequest(websiteTabConnections)
	await Promise.race([finalNetworkCheck.promise, approval])
	await modules.browserStorageLocalSet({ activeRpcNetwork: otherNetwork })
	release.resolve(undefined)

	assert.equal(await approval, false)
	assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
	const pending = await getPendingTransaction()
	if (pending.approvalStatus.status !== 'SignerError') throw new Error(`Expected an invalidated approval, got ${ pending.approvalStatus.status }`)
	assert.equal(pending.approvalStatus.code, METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN)
})

test('a Gnosis Safe proposal is only stored in the Gnosis Safe stack of its own network', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	fakeSafeContract.owners = [safeTestOwnerAddress]
	await modules.updateSafeTransactionStacks(() => [])
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({ simulationMode: false, rpcNetwork: fakeRpcNetwork, activeSigningSafeAddress: activeAddress })
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, { to: recipientAddress, value: 0n, input: new Uint8Array() }, 0n)
	const safePending = {
		...pendingTransaction,
		simulationMode: false,
		approvalStatus: { status: 'WaitingForUser' as const },
		safeTransaction: {
			safeAddress: activeAddress,
			safeSignerAddress: safeTestOwnerAddress,
			safeVersion: '1.4.1' as const,
			threshold: 2n,
			reviewedSafeState: { version: '1.4.1' as const, nonce: 0n, owners: [safeTestOwnerAddress], threshold: 2n },
			safeTxHash: BigInt(getSafeTxHash(safeTx)),
			safeTx,
		},
	}
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [safePending] })
	const otherNetworkServices = createOtherNetworkServices()
	const resolve = async (services: typeof otherNetworkServices | typeof simulator, data: { readonly action: 'addToSafeStack' } | { readonly action: 'signerIncluded', readonly signerReply: unknown }) => await modules.resolvePendingTransactionOrMessage(services.ethereum, services.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { ...data, uniqueRequestIdentifier },
	})
	const expectNotStored = async () => {
		assert.deepEqual(await modules.getSafeTransactionStacks(), [])
		const pending = await getPendingTransaction()
		if (pending.approvalStatus.status !== 'SignerError') throw new Error(`Expected a rejected Gnosis Safe proposal, got ${ pending.approvalStatus.status }`)
		assert.equal(pending.approvalStatus.code, METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN)
	}

	// A network without an Interceptor RPC is active, while the client of the requested network is still installed.
	await modules.browserStorageLocalSet({ activeRpcNetwork: otherNetwork })
	assert.equal(await resolve(simulator, { action: 'addToSafeStack' }), false)
	await expectNotStored()

	await modules.browserStorageLocalSet({ activeRpcNetwork: fakeRpcNetwork })
	await storePendingTransaction(() => safePending)
	assert.equal(await resolve(otherNetworkServices, { action: 'addToSafeStack' }), false)
	await expectNotStored()

	// The wallet signed the proposal for its own network, but the Interceptor now runs on another one.
	await storePendingTransaction(() => ({ ...safePending, approvalStatus: { status: 'WaitingForSigner' } }))
	const signature = await safeTestOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	assert.equal(await resolve(otherNetworkServices, { action: 'signerIncluded', signerReply: signature }), false)
	await expectNotStored()
})

test('a signer reply after a network switch is still delivered to the website', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	assert.equal(await approveRequest(websiteTabConnections), true)
	await modules.browserStorageLocalSet({ activeRpcNetwork: otherNetwork })

	// The wallet already sent the transaction, so the network rule never holds back its result.
	const transactionHash = modules.EthereumBytes32.serialize(0x1234n)
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', uniqueRequestIdentifier, signerReply: transactionHash },
	}), true)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'result' && message.result === transactionHash), true)
})

test('a network switch while a Gnosis Safe proposal is validated keeps it out of the Gnosis Safe stack', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	fakeSafeContract.owners = [safeTestOwnerAddress]
	await modules.updateSafeTransactionStacks(() => [])
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({ simulationMode: false, rpcNetwork: fakeRpcNetwork, activeSigningSafeAddress: activeAddress })
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, { to: recipientAddress, value: 0n, input: new Uint8Array() }, 0n)
	const safePending = {
		...pendingTransaction,
		simulationMode: false,
		approvalStatus: { status: 'WaitingForUser' as const },
		safeTransaction: {
			safeAddress: activeAddress,
			safeSignerAddress: safeTestOwnerAddress,
			safeVersion: '1.4.1' as const,
			threshold: 2n,
			reviewedSafeState: { version: '1.4.1' as const, nonce: 0n, owners: [safeTestOwnerAddress], threshold: 2n },
			safeTxHash: BigInt(getSafeTxHash(safeTx)),
			safeTx,
		},
	}
	const signature = await safeTestOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	const persistences = [
		{ approvalStatus: { status: 'WaitingForUser' as const }, data: { action: 'addToSafeStack' as const, uniqueRequestIdentifier } },
		{ approvalStatus: { status: 'WaitingForSigner' as const }, data: { action: 'signerIncluded' as const, signerReply: signature, uniqueRequestIdentifier } },
	]

	for (const persistence of persistences) {
		await modules.browserStorageLocalSet({ activeRpcNetwork: fakeRpcNetwork })
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{ ...safePending, approvalStatus: persistence.approvalStatus }] })
		// Validating the proposal reads the Safe contract version before it is stored, after the first network check.
		const contractLookup = createDeferredValue<undefined>()
		const release = createDeferredValue<undefined>()
		fakeSafeContract.beforeVersionResponse = async () => {
			contractLookup.resolve(undefined)
			await release.promise
		}

		const resolution = modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: persistence.data })
		await contractLookup.promise
		await modules.browserStorageLocalSet({ activeRpcNetwork: otherNetwork })
		release.resolve(undefined)

		assert.equal(await resolution, false, persistence.data.action)
		assert.deepEqual(await modules.getSafeTransactionStacks(), [], persistence.data.action)
		const pending = await getPendingTransaction()
		if (pending.approvalStatus.status !== 'SignerError') throw new Error(`Expected a rejected Gnosis Safe proposal, got ${ pending.approvalStatus.status }`)
		assert.equal(pending.approvalStatus.code, METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN, persistence.data.action)
	}
})

test('a network switch while the website connection is re-established keeps the transaction from reaching the signer', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const socketKey = modules.websiteSocketToString(socket)
	const connectPort = (port: browser.runtime.Port) => websiteTabConnections.set(socket.tabId, { connections: { [socketKey]: { port, socket, websiteOrigin: website.websiteOrigin, approved: true, wantsToConnect: true } } })
	const disconnectedPort = createDisconnectedPort()
	const replacementPortMessages: unknown[] = []
	connectPort(disconnectedPort.port)
	// Manifest V2 retries the delivery once the content script reconnects its port, and the network changes while it reconnects.
	browserMock.setManifestVersion(2)
	browserMock.setTabMessageHandler(async () => {
		await modules.browserStorageLocalSet({ activeRpcNetwork: otherNetwork })
		connectPort(createWebsitePort(socket, 0, replacementPortMessages))
		return { reconnected: true }
	})

	assert.equal(await approveRequest(websiteTabConnections), false)
	assert.equal(disconnectedPort.getPostAttempts(), 1)
	assert.deepEqual(getForwardedSignerRequests(replacementPortMessages), [])
	const pending = await getPendingTransaction()
	if (pending.approvalStatus.status !== 'SignerError') throw new Error(`Expected an invalidated approval, got ${ pending.approvalStatus.status }`)
	assert.equal(pending.approvalStatus.code, METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN)
})

test('every guarded write and delivery starts in the same synchronous step as its network check', async () => {
	const { updateInterceptorTransactionStackOnRequestedNetwork, updateTransactionStateOnRequestedNetwork } = await import('../../app/ts/background/transactionNetwork.js')
	const { forwardToSignerOnRequestedNetwork } = await import('../../app/ts/background/requestedNetworkForwarding.js')
	await setUpTransactionApprovalTest(false)
	let workAfterCheck: Promise<unknown> = Promise.resolve()
	// The network check reads the requested network, so this queues work right after the check, which only runs after the write or delivery if that started in the same synchronous step.
	const pendingWithWorkAfterCheck = (work: () => Promise<unknown>) => ({ ...pendingTransaction, get requestedChainId() {
		queueMicrotask(() => { workAfterCheck = work() })
		return fakeRpcNetwork.chainId
	} })

	// A stack reset queued right after the check, like the one of a network switch, is applied after the guarded update.
	const stackOperation = { type: 'Transaction' as const, preSimulationTransaction: { ...pendingTransaction.transactionToSimulate, signedTransaction } }
	const stackUpdate = await updateInterceptorTransactionStackOnRequestedNetwork(simulator.ethereum, pendingWithWorkAfterCheck(async () => await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))), () => ({ operations: [stackOperation] }))
	await workAfterCheck
	assert.equal(stackUpdate.committed, true)
	assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])

	const stateUpdate = await updateTransactionStateOnRequestedNetwork(simulator.ethereum, pendingWithWorkAfterCheck(async () => await modules.updateSafeTransactionStacks(() => [])), (previousState) => ({ ...previousState, safeTransactionStacks: [createSafeStackFixture([])] }))
	await workAfterCheck
	assert.equal(stateUpdate.committed, true)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])

	let checkWorkRan = false
	let postedAfterCheckWork: boolean | undefined
	const port = createWebsitePort(socket, 0, [], () => { postedAfterCheckWork = checkWorkRan })
	const websiteTabConnections = new Map([[socket.tabId, { connections: { [modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: website.websiteOrigin, approved: true, wantsToConnect: true } } }]])
	const forwarding = await forwardToSignerOnRequestedNetwork(websiteTabConnections, simulator.ethereum, pendingWithWorkAfterCheck(async () => { checkWorkRan = true }), { ...pendingTransaction.originalRequestParameters, type: 'forwardToSigner', uniqueRequestIdentifier })
	await workAfterCheck
	assert.deepEqual(forwarding, { committed: true, result: true })
	assert.equal(postedAfterCheckWork, false)
})

// Switches the active network right after the given read of it captured its snapshot, before the reader's check runs, through the settings writer every network change uses, so the check sees the network from before the switch unless it notices the write.
async function switchNetworkAfterNetworkRead(networkReadNumber: number, rpcNetwork = otherNetwork) {
	const { changeSimulationMode } = await import('../../app/ts/background/settings.js')
	let networkReads = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		const items = readStoredItems()
		if (Array.isArray(keys) && keys.includes('activeRpcNetwork')) {
			networkReads += 1
			if (networkReads === networkReadNumber) queueMicrotask(() => { void changeSimulationMode({ simulationMode: false, rpcNetwork }) })
		}
		return items
	})
}

test('a network switch right after the network was read keeps the guarded stack and state writes from committing', async () => {
	const { updateInterceptorTransactionStackOnRequestedNetwork, updateTransactionStateOnRequestedNetwork } = await import('../../app/ts/background/transactionNetwork.js')
	await setUpTransactionApprovalTest(false)
	const stackOperation = { type: 'Transaction' as const, preSimulationTransaction: { ...pendingTransaction.transactionToSimulate, signedTransaction } }

	await switchNetworkAfterNetworkRead(1)
	const stackUpdate = await updateInterceptorTransactionStackOnRequestedNetwork(simulator.ethereum, pendingTransaction, () => ({ operations: [stackOperation] }))
	assert.equal(stackUpdate.committed ? undefined : stackUpdate.refusal.code, METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN)
	assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])

	await modules.browserStorageLocalSet({ activeRpcNetwork: fakeRpcNetwork })
	await switchNetworkAfterNetworkRead(1)
	const stateUpdate = await updateTransactionStateOnRequestedNetwork(simulator.ethereum, pendingTransaction, (previousState) => ({ ...previousState, safeTransactionStacks: [createSafeStackFixture([])] }))
	assert.equal(stateUpdate.committed ? undefined : stateUpdate.refusal.code, METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
})

test('a network switch right after the network was read keeps the first delivery to the signer from being posted', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	const { forwardToSignerOnRequestedNetwork } = await import('../../app/ts/background/requestedNetworkForwarding.js')

	await switchNetworkAfterNetworkRead(1)
	const forwarding = await forwardToSignerOnRequestedNetwork(websiteTabConnections, simulator.ethereum, pendingTransaction, { ...pendingTransaction.originalRequestParameters, type: 'forwardToSigner', uniqueRequestIdentifier })

	assert.equal(forwarding.committed ? undefined : forwarding.refusal.code, METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN)
	assert.deepEqual(getForwardedSignerRequests(postedMessages), [])
})

test('a network switch right after the network was read keeps the retried delivery to the signer from being posted', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	const { forwardToSignerOnRequestedNetwork } = await import('../../app/ts/background/requestedNetworkForwarding.js')
	const socketKey = modules.websiteSocketToString(socket)
	const connectPort = (port: browser.runtime.Port) => websiteTabConnections.set(socket.tabId, { connections: { [socketKey]: { port, socket, websiteOrigin: website.websiteOrigin, approved: true, wantsToConnect: true } } })
	const disconnectedPort = createDisconnectedPort()
	const replacementPortMessages: unknown[] = []
	connectPort(disconnectedPort.port)
	browserMock.setManifestVersion(2)
	browserMock.setTabMessageHandler(async () => {
		connectPort(createWebsitePort(socket, 0, replacementPortMessages))
		return { reconnected: true }
	})

	// The first attempt reads the network once and fails on the disconnected port; the retry after the reconnect reads it again.
	await switchNetworkAfterNetworkRead(2)
	const forwarding = await forwardToSignerOnRequestedNetwork(websiteTabConnections, simulator.ethereum, pendingTransaction, { ...pendingTransaction.originalRequestParameters, type: 'forwardToSigner', uniqueRequestIdentifier })

	assert.equal(disconnectedPort.getPostAttempts(), 1)
	assert.equal(forwarding.committed ? undefined : forwarding.refusal.code, METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN)
	assert.deepEqual(getForwardedSignerRequests(replacementPortMessages), [])
})

test('a network write still running when the network was read keeps the guarded write from committing', async () => {
	const { updateInterceptorTransactionStackOnRequestedNetwork } = await import('../../app/ts/background/transactionNetwork.js')
	const { changeSimulationMode } = await import('../../app/ts/background/settings.js')
	await setUpTransactionApprovalTest(false)
	const stackOperation = { type: 'Transaction' as const, preSimulationTransaction: { ...pendingTransaction.transactionToSimulate, signedTransaction } }
	// The network write waits until the guarded write has read the network, so that read sees the network from before the switch.
	const networkRead = createDeferredValue<undefined>()
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if ('activeRpcNetwork' in items) await networkRead.promise
		writeStoredItems()
	})
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		const items = readStoredItems()
		if (Array.isArray(keys) && keys.includes('activeRpcNetwork')) networkRead.resolve(undefined)
		return items
	})

	const networkSwitch = changeSimulationMode({ simulationMode: false, rpcNetwork: otherNetwork })
	const stackUpdate = await updateInterceptorTransactionStackOnRequestedNetwork(simulator.ethereum, pendingTransaction, () => ({ operations: [stackOperation] }))
	await networkSwitch

	assert.equal(stackUpdate.committed ? undefined : stackUpdate.refusal.code, METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN)
	assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
})

test('an approval whose first network read is overtaken by a switch back to the requested network proceeds once', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	await modules.browserStorageLocalSet({ activeRpcNetwork: otherNetwork })
	await switchNetworkAfterNetworkRead(1, fakeRpcNetwork)

	assert.equal(await approveRequest(websiteTabConnections), true)
	assert.equal(getForwardedSignerRequests(postedMessages).length, 1)
	assert.equal((await getPendingTransaction()).approvalStatus.status, 'WaitingForSigner')
})

test('a repair of a corrupt active network still running when the network is read keeps the guarded write from committing', async () => {
	const { updateInterceptorTransactionStackOnRequestedNetwork } = await import('../../app/ts/background/transactionNetwork.js')
	const { changeSimulationMode, getSettings } = await import('../../app/ts/background/settings.js')
	await setUpTransactionApprovalTest(false)
	const stackOperation = { type: 'Transaction' as const, preSimulationTransaction: { ...pendingTransaction.transactionToSimulate, signedTransaction } }
	const repairStarted = createDeferredValue<undefined>()
	const repairReleased = createDeferredValue<undefined>()
	let networkWrites = 0
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if ('activeRpcNetwork' in items) {
			networkWrites += 1
			if (networkWrites === 1) {
				repairStarted.resolve(undefined)
				await repairReleased.promise
			}
		}
		writeStoredItems()
	})

	// Reading the corrupt active network starts its repair to the default network, which is held open while a valid network is selected.
	browserMock.storageState.activeRpcNetwork = { corrupt: true }
	const repairingRead = withSilencedConsole(async () => await getSettings())
	await repairStarted.promise
	await changeSimulationMode({ simulationMode: false, rpcNetwork: fakeRpcNetwork })
	// The repair completes right after the guarded write read the network.
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		const items = readStoredItems()
		if (Array.isArray(keys) && keys.includes('activeRpcNetwork')) repairReleased.resolve(undefined)
		return items
	})
	const stackUpdate = await updateInterceptorTransactionStackOnRequestedNetwork(simulator.ethereum, pendingTransaction, () => ({ operations: [stackOperation] }))
	await repairingRead

	assert.equal(stackUpdate.committed ? undefined : stackUpdate.refusal.code, METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN)
	assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
})

test('a repair of a corrupt active network read before a network switch committed leaves the switched network stored', async () => {
	const { changeSimulationMode, getSettings, defaultRpcs } = await import('../../app/ts/background/settings.js')
	await setUpTransactionApprovalTest(false)
	const networkWrites: unknown[] = []
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if ('activeRpcNetwork' in items) networkWrites.push(items.activeRpcNetwork)
		writeStoredItems()
	})
	// The settings read gets the corrupt network, and then waits before acting on it until a network switch has committed.
	const corruptNetworkRead = createDeferredValue<undefined>()
	const networkSwitchCommitted = createDeferredValue<undefined>()
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		const items = readStoredItems()
		if (Array.isArray(keys) && keys.includes('activeRpcNetwork')) {
			browserMock.setStorageGetHandler(undefined)
			corruptNetworkRead.resolve(undefined)
			await networkSwitchCommitted.promise
		}
		return items
	})

	browserMock.storageState.activeRpcNetwork = { corrupt: true }
	const repairingRead = withSilencedConsole(async () => await getSettings())
	await corruptNetworkRead.promise
	await changeSimulationMode({ simulationMode: false, rpcNetwork: otherNetwork })
	networkSwitchCommitted.resolve(undefined)

	// The stale read still reports the default network it read, but does not write it over the switch.
	assert.equal((await repairingRead).activeRpcNetwork.chainId, defaultRpcs[0]?.chainId)
	assert.equal(networkWrites.length, 1)
	assert.equal((await getSettings()).activeRpcNetwork.chainId, otherNetwork.chainId)
})

test('a page context reads a corrupt active network without writing it, so a guarded write commits only on the network that stays stored', async () => {
	const { updateInterceptorTransactionStackOnRequestedNetwork } = await import('../../app/ts/background/transactionNetwork.js')
	const backgroundSettings = await import('../../app/ts/background/settings.js')
	// A popup bundle runs its own copy of the page-safe settings module, sharing only storage with the background.
	const popupSettingsModule = '../../app/ts/utils/pageSafeSettings.js?popup'
	const popupSettings: typeof import('../../app/ts/utils/pageSafeSettings.js') = await import(popupSettingsModule)
	await setUpTransactionApprovalTest(false)
	const stackOperation = { type: 'Transaction' as const, preSimulationTransaction: { ...pendingTransaction.transactionToSimulate, signedTransaction } }
	const guardReadNetwork = createDeferredValue<undefined>()
	const networkWritesOtherThanTheSelection: unknown[] = []
	// Any write of the active network besides the background's selection is held until the guarded write read the network, like a delayed repair.
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if ('activeRpcNetwork' in items && !(isRecord(items.activeRpcNetwork) && items.activeRpcNetwork.chainId === `0x${ fakeRpcNetwork.chainId.toString(16) }`)) {
			networkWritesOtherThanTheSelection.push(items.activeRpcNetwork)
			await guardReadNetwork.promise
		}
		writeStoredItems()
	})

	browserMock.storageState.activeRpcNetwork = { corrupt: true }
	const pageRead = withSilencedConsole(async () => await popupSettings.getActiveRpcNetworkWithoutRepair())
	await backgroundSettings.changeSimulationMode({ simulationMode: false, rpcNetwork: fakeRpcNetwork })
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		const items = readStoredItems()
		if (Array.isArray(keys) && keys.includes('activeRpcNetwork')) guardReadNetwork.resolve(undefined)
		return items
	})
	const stackUpdate = await updateInterceptorTransactionStackOnRequestedNetwork(simulator.ethereum, pendingTransaction, () => ({ operations: [stackOperation] }))
	guardReadNetwork.resolve(undefined)

	assert.equal((await pageRead).chainId, backgroundSettings.defaultRpcs[0]?.chainId)
	assert.deepEqual(networkWritesOtherThanTheSelection, [])
	assert.equal(stackUpdate.committed, true)
	assert.equal((await backgroundSettings.getSettings()).activeRpcNetwork.chainId, fakeRpcNetwork.chainId)
})

test('a network snapshot reads only the active network, and a repair of a corrupt one makes it read again', async () => {
	const { defaultRpcs } = await import('../../app/ts/background/settings.js')
	const { readActiveNetworkSnapshot } = await import('../../app/ts/background/activeNetworkStorage.js')
	await setUpTransactionApprovalTest(false)
	const keysRead: unknown[] = []
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		keysRead.push(keys)
		return readStoredItems()
	})

	const snapshot = await readActiveNetworkSnapshot()
	assert.deepEqual(keysRead, [['activeRpcNetwork']])
	assert.equal(snapshot.activeRpcNetwork.chainId, fakeRpcNetwork.chainId)
	assert.equal(snapshot.isStillCurrent(), true)

	// The repair during the read writes the network, so that read is not current, but the next one is.
	browserMock.storageState.activeRpcNetwork = { corrupt: true }
	const repairedSnapshot = await withSilencedConsole(async () => await readActiveNetworkSnapshot())
	assert.equal(repairedSnapshot.activeRpcNetwork.chainId, defaultRpcs[0]?.chainId)
	assert.equal(repairedSnapshot.isStillCurrent(), false)
	const nextSnapshot = await readActiveNetworkSnapshot()
	assert.equal(nextSnapshot.activeRpcNetwork.chainId, defaultRpcs[0]?.chainId)
	assert.equal(nextSnapshot.isStillCurrent(), true)
})
