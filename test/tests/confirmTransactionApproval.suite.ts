import * as assert from 'assert'
import { setSystemTime, test } from 'bun:test'
import { Transaction } from 'micro-eth-signer'
import { activeAddress, addressString, browserMock, createDisconnectedPort, createSafeAddressBookEntry, createSafeStackFixture, createSafeTx, createWebsitePort, EIP712Message, fakeRequestHandler, fakeRpcNetwork, fakeSafeContract, getSafeTxHash, isRecord, modules, pendingTransaction, recipientAddress, SAFE_EXECUTION_ABI, safeTestOwnerAccount, safeTestOwnerAddress, safeTestOwnerPrivateKey, safeTxToTypedDataJson, signedTransaction, simulator, uniqueRequestIdentifier, withSilencedConsole } from './confirmTransactionTestHarness.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { createDeferredValue, createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import { CONFIRMATION_RUN_OF_NO_LIFETIME, type ConfirmationRunId, PendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { createPassthroughCompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'
import { showWithCurrentNetworkRefusals } from '../../app/ts/background/transactionNetwork.js'
import { SendRawTransactionParams, SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import { PersonalSignParams } from '../../app/ts/types/jsonRpc-signing-types.js'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../app/ts/utils/constants.js'

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
	const reply = await modules.openConfirmTransactionDialogForTransaction(simulator.ethereum, simulator.tokenPriceService, () => simulator, {
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

// Approves as confirmDialog does, with the owner's getCurrent, or with fixed services where a test installs no owner.
async function approveRequest(websiteTabConnections: TransactionTestConnections, getInstalledServices: () => Pick<typeof simulator, 'ethereum' | 'tokenPriceService'> = () => simulator) {
	return await modules.resolvePendingTransactionOrMessage(getInstalledServices, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	})
}

const getForwardedSignerRequests = (postedMessages: readonly unknown[]) => postedMessages.filter((message) => isRecord(message) && message.type === 'forwardToSigner')

async function expectApprovalToBeInvalidated(websiteTabConnections: TransactionTestConnections, postedMessages: readonly unknown[], getInstalledServices: () => Pick<typeof simulator, 'ethereum' | 'tokenPriceService'> = () => simulator) {
	assert.equal(await approveRequest(websiteTabConnections, getInstalledServices), false)
	assert.deepEqual(getForwardedSignerRequests(postedMessages), [])
	// The refusal is not stored: the request waits for the user, and the window is shown the refusal with the queue sent after the approval.
	const pending = await getPendingTransaction()
	assert.notEqual(pending.approvalStatus.status, 'WaitingForSigner')
	assert.equal(typeof getLastShownNetworkRefusal(), 'string')
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
	await forceSetGasLimitForTransaction(() => simulator, { method: 'popup_forceSetGasLimitForTransaction', data: { transactionIdentifier, gasLimit } })
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
	const reply = await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, () => simulator, {
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
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, () => otherNetworkServices)
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
	await refreshPopupConfirmTransactionSimulation(() => simulator)
	await refreshPopupConfirmTransactionMetadata(() => simulator, undefined)
	assert.deepEqual(await getPendingTransaction(), storedByOlderVersion)

	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages)
	// Written back, it keeps decoding the same way.
	assert.equal((await getPendingTransaction()).requestedChainId, 'unknown')
})

// What the confirmation window last received for the first pending request.
function getLastPublishedFirstRequest() {
	const published = browserMock.sentMessages.filter((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions').at(-1)
	if (!isRecord(published) || !isRecord(published.data) || !Array.isArray(published.data.pendingTransactionAndSignableMessages)) return undefined
	const first: unknown = published.data.pendingTransactionAndSignableMessages[0]
	return isRecord(first) ? first : undefined
}

const getLastPublishedApprovalStatus = () => getLastPublishedFirstRequest()?.approvalStatus
const getLastShownNetworkRefusal = () => getLastPublishedFirstRequest()?.networkRefusal

// A refused approval leaves the request waiting for the user, also when it was handed to the signer before the refusal stopped its posting, and the window is shown the refusal derived when the queue was sent.
async function expectRefusalShownAndNotStored(label?: string) {
	assert.deepEqual((await getPendingTransaction()).approvalStatus, { status: 'WaitingForUser' }, label)
	assert.equal(typeof getLastShownNetworkRefusal(), 'string', label)
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

// The refusal a queue sent now shows for the stored transaction, with the client getInstalledServices returns. It is derived, never stored.
async function getRefusalMessage(getInstalledServices: () => typeof simulator = () => simulator) {
	const pending = await getPendingTransaction()
	return await showWithCurrentNetworkRefusals(getInstalledServices, (getNetworkRefusalMessage) => getNetworkRefusalMessage(pending))
}

// Records the writes of the stored confirmations, to show that a network change lifts a refusal without one.
function recordPendingRequestWrites() {
	const writes: unknown[] = []
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if ('pendingTransactionsAndMessages' in items) writes.push(items.pendingTransactionsAndMessages)
		writeStoredItems()
	})
	return { writes, restore: () => browserMock.setStorageSetHandler(undefined) }
}

// What the confirmation window is sent when it asks for its queue, as it does on a chain update, with the client getInstalledServices returns then, as the handler passes the owner's getCurrent.
async function publishQueueAsAskedByTheWindow(getInstalledServices: () => typeof simulator) {
	const { publishConfirmationQueue } = await import('../../app/ts/background/windows/confirmTransaction.js')
	browserMock.sentMessages.length = 0
	await publishConfirmationQueue(getInstalledServices)
}

test('switching away refuses an approval and shows the refusal without storing it, and switching back lifts it without a stored write', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const { simulationServicesOwner, switchNetwork } = await createNetworkSwitcher()

	await switchNetwork(otherNetwork)
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, simulationServicesOwner.getCurrent)
	assert.equal(getLastShownNetworkRefusal(), NETWORK_CHANGED_REFUSAL)
	assert.deepEqual(await getStoredApprovalStatus(), { status: 'WaitingForUser' })

	const pendingWrites = recordPendingRequestWrites()
	await switchNetwork(fakeRpcNetwork)
	pendingWrites.restore()
	assert.deepEqual(pendingWrites.writes, [])
	await publishQueueAsAskedByTheWindow(simulationServicesOwner.getCurrent)
	assert.equal(getLastShownNetworkRefusal(), undefined)
	assert.deepEqual(getLastPublishedApprovalStatus(), { status: 'WaitingForUser' })
	assert.deepEqual(getForwardedSignerRequests(postedMessages), [])

	assert.equal(await approveRequest(websiteTabConnections), true)
	assert.equal(getForwardedSignerRequests(postedMessages).length, 1)
})

test('switching back does not wait for an RPC of the requested network', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const suspended = createSuspendedServices('eth_blockNumber')
	const { simulationServicesOwner, switchNetwork } = await createNetworkSwitcher(suspended)

	await switchNetwork(otherNetwork)
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, simulationServicesOwner.getCurrent)

	// The change completes, and the queue the window asks for shows no refusal, while the RPC of the requested network has not answered.
	await switchNetwork(fakeRpcNetwork)
	await publishQueueAsAskedByTheWindow(simulationServicesOwner.getCurrent)
	assert.equal(getLastShownNetworkRefusal(), undefined)
	suspended.release()
})

// A settings import stores the requested network without installing its client, so the approval is still refused, as the installed client of the other network would execute the transaction.
async function refuseAndImportRequestedNetwork() {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const networkSwitcher = await createNetworkSwitcher()
	await networkSwitcher.switchNetwork(otherNetwork)
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, networkSwitcher.simulationServicesOwner.getCurrent)
	const { changeSimulationMode } = await import('../../app/ts/background/settings.js')
	await changeSimulationMode({ simulationMode: false, rpcNetwork: fakeRpcNetwork })
	assert.equal(networkSwitcher.simulationServicesOwner.getCurrent().ethereum.getChainId(), otherNetwork.chainId)
	assert.equal(await getRefusalMessage(networkSwitcher.simulationServicesOwner.getCurrent), NETWORK_CHANGED_REFUSAL)
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, networkSwitcher.simulationServicesOwner.getCurrent)
	return { postedMessages, ...networkSwitcher }
}

// The installed client when the window is told to ask for its queue again.
function recordInstalledChainWhenWindowIsTold(simulationServicesOwner: Awaited<ReturnType<typeof createNetworkSwitcher>>['simulationServicesOwner'], methods: readonly string[]) {
	const recorded: bigint[] = []
	browserMock.setRuntimeSendMessageHandler(async (message) => {
		if (methods.includes(message.method)) recorded.push(simulationServicesOwner.getCurrent().ethereum.getChainId())
	})
	return { recorded, restore: () => browserMock.setRuntimeSendMessageHandler(undefined) }
}

test('selecting another endpoint of the stored network after a settings import installs its client, after which the window is told to ask for its queue, which shows no refusal', async () => {
	const { postedMessages, simulationServicesOwner, switchNetwork } = await refuseAndImportRequestedNetwork()
	const told = recordInstalledChainWhenWindowIsTold(simulationServicesOwner, ['popup_settingsUpdated'])
	const pendingWrites = recordPendingRequestWrites()

	await switchNetwork({ ...fakeRpcNetwork, httpsRpc: 'https://other-endpoint.invalid' })
	told.restore()
	pendingWrites.restore()

	assert.deepEqual(told.recorded, [fakeRpcNetwork.chainId])
	await publishQueueAsAskedByTheWindow(simulationServicesOwner.getCurrent)
	assert.equal(getLastShownNetworkRefusal(), undefined)
	assert.deepEqual(pendingWrites.writes, [])
	assert.deepEqual(getForwardedSignerRequests(postedMessages), [])
})

test('an RPC list change that installs the client of the stored network tells the window once it is installed, and the queue then shows no refusal', async () => {
	const { postedMessages, simulationServicesOwner } = await refuseAndImportRequestedNetwork()
	const told = recordInstalledChainWhenWindowIsTold(simulationServicesOwner, ['popup_update_rpc_list'])
	const networkWrites: unknown[] = []
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if ('activeRpcNetwork' in items || 'pendingTransactionsAndMessages' in items) networkWrites.push(items)
		writeStoredItems()
	})

	const { setNewRpcList } = await import('../../app/ts/background/popupMessageHandlers.js')
	const { getSettings } = await import('../../app/ts/background/settings.js')
	await setNewRpcList(simulationServicesOwner, { method: 'popup_set_rpc_list', data: [fakeRpcNetwork, { ...otherNetwork, primary: true }] }, await getSettings())
	browserMock.setStorageSetHandler(undefined)
	told.restore()

	assert.deepEqual(told.recorded, [fakeRpcNetwork.chainId])
	await publishQueueAsAskedByTheWindow(simulationServicesOwner.getCurrent)
	assert.equal(getLastShownNetworkRefusal(), undefined)
	assert.deepEqual(networkWrites, [])
	assert.deepEqual(getForwardedSignerRequests(postedMessages), [])
})

// Holds the next read of the active network alone, the one a queue's refusals are derived from, after it has read the stored value.
function holdNextActiveNetworkRead() {
	const reached = createDeferredValue<undefined>()
	const release = createDeferredValue<undefined>()
	let held = false
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		const items = readStoredItems()
		if (!held && Array.isArray(keys) && keys.length === 1 && keys[0] === 'activeRpcNetwork') {
			held = true
			reached.resolve(undefined)
			await release.promise
		}
		return items
	})
	return { reached: reached.promise, release: () => release.resolve(undefined), restore: () => browserMock.setStorageGetHandler(undefined) }
}

test('a switch back while the queue is being built never pairs the network read before it with the client installed after it', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const { simulationServicesOwner, switchNetwork } = await createNetworkSwitcher()
	await switchNetwork(otherNetwork)
	const { publishConfirmationQueue } = await import('../../app/ts/background/windows/confirmTransaction.js')

	const networkRead = holdNextActiveNetworkRead()
	browserMock.sentMessages.length = 0
	const publication = publishConfirmationQueue(simulationServicesOwner.getCurrent)
	await networkRead.reached
	await switchNetwork(fakeRpcNetwork)
	networkRead.release()
	await publication
	networkRead.restore()

	assert.equal(getLastPublishedFirstRequest() === undefined, false)
	assert.equal(getLastShownNetworkRefusal(), undefined)
})

test('a switch back while the window bootstrap reply is built never pairs the network read before it with the client installed after it', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const { simulationServicesOwner, switchNetwork } = await createNetworkSwitcher()
	await switchNetwork(otherNetwork)
	const { popupReadyAndListening } = await import('../../app/ts/background/popupMessageHandlers.js')

	const networkRead = holdNextActiveNetworkRead()
	const reply = popupReadyAndListening(simulationServicesOwner.getCurrent, websiteTabConnections, 'confirmTransaction')
	await networkRead.reached
	await switchNetwork(fakeRpcNetwork)
	networkRead.release()
	const bootstrap = await reply
	networkRead.restore()

	const shown = bootstrap !== undefined && 'confirmTransactionBootstrap' in bootstrap.data ? bootstrap.data.confirmTransactionBootstrap?.pendingTransactionAndSignableMessages[0] : undefined
	if (shown === undefined || shown.type !== 'Transaction') throw new Error('Missing bootstrapped transaction')
	assert.equal(shown.networkRefusal, undefined)
})

test('the window bootstrap reply builds its queue under the queue lock, so a write waits for it and the reply never pairs an older queue with newer refusals', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const { popupReadyAndListening } = await import('../../app/ts/background/popupMessageHandlers.js')

	const networkRead = holdNextActiveNetworkRead()
	const reply = popupReadyAndListening(() => simulator, websiteTabConnections, 'confirmTransaction')
	await networkRead.reached
	// A write of the stored confirmations queued while the reply derives the refusals of the queue it read.
	let written = false
	const writing = storePendingTransaction((pending) => ({ ...pending, approvalStatus: { status: 'WaitingForSigner' } })).then(() => { written = true })
	await new Promise((resolve) => setTimeout(resolve, 50))
	assert.equal(written, false)
	networkRead.release()
	const bootstrap = await reply
	await writing
	networkRead.restore()

	const shown = bootstrap !== undefined && 'confirmTransactionBootstrap' in bootstrap.data ? bootstrap.data.confirmTransactionBootstrap?.pendingTransactionAndSignableMessages[0] : undefined
	if (shown === undefined) throw new Error('Missing bootstrapped request')
	assert.deepEqual(shown.approvalStatus, { status: 'WaitingForUser' })
	assert.equal((await getStoredApprovalStatus()).status, 'WaitingForSigner')
})

test('a refusal stays while the check still refuses, and approving again still sends nothing', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const { simulationServicesOwner, switchNetwork } = await createNetworkSwitcher()
	const thirdNetwork = { ...fakeRpcNetwork, name: 'Third Test Chain', chainId: 10n }

	await switchNetwork(otherNetwork)
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, simulationServicesOwner.getCurrent)

	await switchNetwork(thirdNetwork)
	assert.equal(await getRefusalMessage(simulationServicesOwner.getCurrent), NETWORK_CHANGED_REFUSAL)
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, simulationServicesOwner.getCurrent)

	// The client of the requested network alone does not lift it: the active network has to match too.
	assert.equal(await getRefusalMessage(() => simulator), NETWORK_CHANGED_REFUSAL)
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages)
})

test('the confirmation window receives a transaction without the background bookkeeping stored with it', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	browserMock.sentMessages.length = 0
	await modules.updateConfirmTransactionView(() => simulator)
	const stored = await getPendingTransaction()

	const first = getLastPublishedFirstRequest()
	if (first === undefined || !isRecord(first.popupVisualisation) || !isRecord(first.popupVisualisation.data)) throw new Error('Missing published transaction')
	assert.equal('requestedChainId' in first, false)
	assert.equal('confirmationRunId' in first.popupVisualisation.data, false)
	assert.equal('networkRefusal' in first, false)
	// Everything else reaches the window unchanged.
	const { toPopupPendingTransactionOrSignableMessage } = await import('../../app/ts/utils/popupPendingRequest.js')
	const { requestedChainId: _requestedChainId, popupVisualisation: storedVisualisation, ...storedRest } = stored
	const { confirmationRunId: _confirmationRunId, ...storedData } = storedVisualisation.data
	assert.deepEqual(toPopupPendingTransactionOrSignableMessage(stored, () => undefined), { ...storedRest, popupVisualisation: { ...storedVisualisation, data: storedData } })
})

test('the queue shows the refusal of each transaction it holds, also of one behind a message, and none for a message', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestPersonalSign(websiteTabConnections)
	const [message] = await modules.getPendingTransactionsAndMessages()
	if (message === undefined) throw new Error('Missing message signing request')
	const transactionIdentifier = { ...uniqueRequestIdentifier, requestId: uniqueRequestIdentifier.requestId + 1 }
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [message, { ...pendingTransaction, uniqueRequestIdentifier: transactionIdentifier }] })
	await modules.browserStorageLocalSet({ activeRpcNetwork: otherNetwork })

	await publishQueueAsAskedByTheWindow(() => simulator)

	const published = browserMock.sentMessages.find((sent) => sent.method === 'popup_update_confirm_transaction_dialog_pending_transactions')
	if (!isRecord(published) || !isRecord(published.data) || !Array.isArray(published.data.pendingTransactionAndSignableMessages)) throw new Error('Nothing was published to the confirmation window')
	const [shownMessage, shownTransaction]: unknown[] = published.data.pendingTransactionAndSignableMessages
	assert.equal(isRecord(shownMessage) && 'networkRefusal' in shownMessage, false)
	assert.equal(isRecord(shownTransaction) ? shownTransaction.networkRefusal : undefined, NETWORK_CHANGED_REFUSAL)
})

test('a network switch during the slow work of a message metadata refresh does not show an outdated refusal for the transaction behind it', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestPersonalSign(websiteTabConnections)
	const [message] = await modules.getPendingTransactionsAndMessages()
	if (message === undefined) throw new Error('Missing message signing request')
	const transactionIdentifier = { ...uniqueRequestIdentifier, requestId: uniqueRequestIdentifier.requestId + 1 }
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [message, { ...pendingTransaction, uniqueRequestIdentifier: transactionIdentifier }] })

	// The other network is active and its client is installed, and the refresh's lookups on that client wait until released.
	const lookupsReached = createDeferredValue<undefined>()
	const releaseLookups = createDeferredValue<undefined>()
	const otherNetworkEthereum = new modules.EthereumClientService({
		...fakeRequestHandler,
		async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
			lookupsReached.resolve(undefined)
			await releaseLookups.promise
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}, async () => undefined, async () => undefined, otherNetwork)
	const otherNetworkServices = { ethereum: otherNetworkEthereum, tokenPriceService: new modules.TokenPriceService(otherNetworkEthereum, 60_000) }
	await modules.browserStorageLocalSet({ activeRpcNetwork: otherNetwork })
	const simulationServicesOwner = createTestSimulationServicesOwner(otherNetworkServices, () => simulator)
	const { refreshPopupConfirmTransactionMetadata } = await import('../../app/ts/background/popupMessageHandlers.js')
	const refresh = refreshPopupConfirmTransactionMetadata(simulationServicesOwner.getCurrent, undefined)
	await lookupsReached.promise

	// The user switches back to the requested network while the lookups run.
	await modules.browserStorageLocalSet({ activeRpcNetwork: fakeRpcNetwork })
	simulationServicesOwner.reset(fakeRpcNetwork)
	browserMock.sentMessages.length = 0
	releaseLookups.resolve(undefined)
	await refresh

	const published = browserMock.sentMessages.filter((sent) => sent.method === 'popup_update_confirm_transaction_dialog_pending_transactions').at(-1)
	if (!isRecord(published) || !isRecord(published.data) || !Array.isArray(published.data.pendingTransactionAndSignableMessages)) throw new Error('The refresh published nothing to the confirmation window')
	const shownTransaction: unknown = published.data.pendingTransactionAndSignableMessages[1]
	if (!isRecord(shownTransaction)) throw new Error('Missing transaction behind the message')
	assert.equal('networkRefusal' in shownTransaction, false)
})

test('a window update derives the refusal and changes nothing stored', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const before = await modules.getPendingTransactionsAndMessages()
	const pendingWrites = recordPendingRequestWrites()

	await modules.browserStorageLocalSet({ activeRpcNetwork: otherNetwork })
	browserMock.sentMessages.length = 0
	await modules.updateConfirmTransactionView(() => simulator)
	assert.equal(getLastShownNetworkRefusal(), NETWORK_CHANGED_REFUSAL)

	await modules.browserStorageLocalSet({ activeRpcNetwork: fakeRpcNetwork })
	browserMock.sentMessages.length = 0
	await modules.updateConfirmTransactionView(() => simulator)
	assert.equal(getLastShownNetworkRefusal(), undefined)
	pendingWrites.restore()

	assert.deepEqual(pendingWrites.writes, [])
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), before)
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
	const { simulationServicesOwner, switchNetwork } = await createNetworkSwitcher()

	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages)
	assert.equal(getLastShownNetworkRefusal(), OLDER_VERSION_REFUSAL)

	await switchNetwork(otherNetwork)
	await switchNetwork(fakeRpcNetwork)
	assert.equal(await getRefusalMessage(simulationServicesOwner.getCurrent), OLDER_VERSION_REFUSAL)
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages)
	assert.equal(getLastShownNetworkRefusal(), OLDER_VERSION_REFUSAL)
})

test('a delivery that does not finish holds no lock over the stored confirmations', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const { publishConfirmationView } = await import('../../app/ts/background/windows/confirmTransaction.js')
	const deliveryStarted = createDeferredValue<undefined>()
	const releaseDelivery = createDeferredValue<undefined>()
	browserMock.setRuntimeSendMessageHandler(async (message) => {
		if (message.method !== 'popup_update_confirm_transaction_dialog_pending_transactions') return
		deliveryStarted.resolve(undefined)
		await releaseDelivery.promise
	})

	const publishing = publishConfirmationView(() => simulator, { currentBlockNumber: 1n, rpcConnectionStatus: undefined, visualizedSimulatorState: createPassthroughCompleteVisualizedSimulation() })
	await deliveryStarted.promise
	const written = await Promise.race([storePendingTransaction((pending) => ({ ...pending, approvalStatus: { status: 'WaitingForSigner' } })).then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))])
	releaseDelivery.resolve(undefined)
	assert.equal(await publishing, true)
	browserMock.setRuntimeSendMessageHandler(undefined)

	assert.equal(written, true)
})

test('a push whose read overlaps a write reaches the windows before that write is announced', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const { publishConfirmationView } = await import('../../app/ts/background/windows/confirmTransaction.js')
	const { sendPopupMessageToOpenWindows } = await import('../../app/ts/background/backgroundUtils.js')
	const readStarted = createDeferredValue<undefined>()
	const releaseRead = createDeferredValue<undefined>()
	let holdNextRead = true
	// Holds the publisher's read of the stored confirmations, which it takes under their writers' lock.
	browserMock.setStorageGetHandler(async (keys, read) => {
		const stored = read()
		if (holdNextRead && JSON.stringify(keys ?? null).includes('pendingTransactionsAndMessages')) {
			holdNextRead = false
			readStarted.resolve(undefined)
			await releaseRead.promise
		}
		return stored
	})

	const publishing = publishConfirmationView(() => simulator, { currentBlockNumber: 1n, rpcConnectionStatus: undefined, visualizedSimulatorState: createPassthroughCompleteVisualizedSimulation() })
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

	const refresh = refreshPopupConfirmTransactionMetadata(() => suspended, undefined)
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

	const refresh = refreshPopupConfirmTransactionMetadata(() => suspended, undefined)
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

	const ready = popupReadyAndListening(() => suspended, websiteTabConnections, 'confirmTransaction')
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
	await refreshPopupConfirmTransactionSimulation(() => otherNetworkServices)
	await refreshPopupConfirmTransactionMetadata(() => otherNetworkServices, undefined)
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
	await expectRefusalShownAndNotStored()
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

	const metadataRefresh = refreshPopupConfirmTransactionMetadata(() => suspended, undefined)
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

	const metadataRefresh = refreshPopupConfirmTransactionMetadata(() => suspended, undefined)
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
	const { isConfirmationVisualisationCurrent } = await import('../../app/ts/background/confirmationRun.js')
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

	await modules.refreshPopupConfirmTransactionSimulation(() => simulator)

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
	const { refreshConfirmTransactionSimulation, reserveConfirmationRun } = await import('../../app/ts/background/confirmTransactionSimulation.js')
	const { isConfirmationVisualisationCurrent } = await import('../../app/ts/background/confirmationRun.js')
	const pending = await getPendingTransaction()
	const earlierRun = await refreshConfirmTransactionSimulation(reserveConfirmationRun(), simulator.ethereum, simulator.tokenPriceService, pending.activeAddress, false, uniqueRequestIdentifier, pending.transactionToSimulate)
	if (earlierRun === undefined) throw new Error('The earlier run did not complete')

	await modules.refreshPopupConfirmTransactionSimulation(() => simulator)

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

	const earlierRefresh = modules.refreshPopupConfirmTransactionSimulation(() => simulator)
	await earlierRefreshRead.reached
	await modules.refreshPopupConfirmTransactionSimulation(() => simulator)
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

	const earlierRefresh = modules.refreshPopupConfirmTransactionSimulation(() => simulator)
	await earlierRunTabStateRead.reached
	const suspended = createSuspendedServices('eth_simulateV1')
	const laterRefresh = modules.refreshPopupConfirmTransactionSimulation(() => suspended)
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
		const laterRefresh = modules.refreshPopupConfirmTransactionSimulation(() => simulator)
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
	assert.equal(await wasLaterPopupRefreshAborted(async () => await modules.refreshPendingSafeSignerSelectionErrors(() => simulator, socket.tabId), (keys) => keys === `tabState_${ socket.tabId }`), false)
})

test('a Gnosis Safe approval that started before a popup refresh does not abort that refresh with its rebuild', async () => {
	const { safeSignerAddress, websiteTabConnections } = await openDirectSafeExecutionAwaitingSignerRefresh()
	const approval = async () => await modules.resolvePendingTransactionOrMessage(() => simulator, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } }, { refreshedSafeSignerSelection: { selectedSigner: safeSignerAddress, verificationError: undefined } })
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
		await modules.refreshPopupConfirmTransactionSimulation(() => simulator)
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
	const otherRequestOpening = modules.openConfirmTransactionDialogForTransaction(simulator.ethereum, simulator.tokenPriceService, () => simulator, { interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: otherRequest, method: transactionParams.method, params: transactionParams.params }, { kind: 'transaction', parameters: transactionParams }, false, activeAddress, website, websiteTabConnections)
	await otherRequestTabStateRead.reached
	await modules.refreshPopupConfirmTransactionSimulation(() => simulator)
	const suspended = createSuspendedServices('eth_simulateV1')
	const laterRefresh = modules.refreshPopupConfirmTransactionSimulation(() => suspended)
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
	await modules.refreshPopupConfirmTransactionSimulation(() => simulator)
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
		await modules.refreshPopupConfirmTransactionSimulation(() => simulator)
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
		const laterRefresh = modules.refreshPopupConfirmTransactionSimulation(() => suspended)
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

	const edit = forceSetGasLimitForTransaction(() => simulator, { method: 'popup_forceSetGasLimitForTransaction', data: { transactionIdentifier, gasLimit: 30_000n } })
	await editRead.reached
	await modules.refreshPopupConfirmTransactionSimulation(() => simulator)
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
		const simulationRefresh = modules.refreshPopupConfirmTransactionSimulation(() => suspended)
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
		const staleRefresh = modules.refreshPopupConfirmTransactionSimulation(() => suspended)
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
	const request = modules.openConfirmTransactionDialogForTransaction(suspended.ethereum, suspended.tokenPriceService, () => suspended, {
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

test('the first simulation is not stored onto a transaction whose gas limit changed while it ran, and the next refresh simulates the stored gas limit', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const suspended = createSuspendedServices('eth_simulateV1')
	const request = modules.openConfirmTransactionDialogForTransaction(suspended.ethereum, suspended.tokenPriceService, () => suspended, {
		interceptorRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		method: transactionParams.method,
		params: transactionParams.params,
	}, { kind: 'transaction', parameters: transactionParams }, false, activeAddress, website, websiteTabConnections)
	await suspended.reached
	while ((await modules.getPendingTransactionsAndMessages())[0]?.transactionOrMessageCreationStatus !== 'Simulating') await new Promise((resolve) => setTimeout(resolve, 5))
	const simulating = (await modules.getPendingTransactionsAndMessages())[0]
	if (simulating?.type !== 'Transaction') throw new Error('Missing transaction confirmation')

	// Stored the way a gas limit edit or a Gnosis Safe signer change stores new inputs, without a run of its own.
	const { setGasLimitForTransaction } = await import('../../app/ts/background/windows/confirmTransaction.js')
	await setGasLimitForTransaction(simulating.transactionIdentifier, 30_000n)
	suspended.release()
	await request

	const afterFirstRun = (await modules.getPendingTransactionsAndMessages())[0]
	assert.equal(afterFirstRun?.transactionOrMessageCreationStatus, 'Simulating')

	const { refreshPopupConfirmTransactionSimulation } = await import('../../app/ts/background/popupMessageHandlers.js')
	await refreshPopupConfirmTransactionSimulation(() => simulator)
	const pending = await getPendingTransaction()
	assert.equal(getRequestedGasLimit(pending), 30_000n)
	assert.equal(pending.transactionToSimulate.transaction.gas, 30_000n)
	assert.equal(pending.popupVisualisation.data.transactionToSimulate.success ? pending.popupVisualisation.data.transactionToSimulate.transaction.gas : undefined, 30_000n)
})

test('a Gnosis Safe signer change on another network does not rebuild the proposal for that network', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestSafeProposal(websiteTabConnections)
	const otherNetworkServices = createOtherNetworkServices()
	await selectWalletAccount(safeTestOwnerAddress)
	const requestedNetworkSafeTxHash = fakeSafeContract.transactionHash

	// The same Safe exists with the same owners on the other network, where it reports the hash of a proposal for that network.
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(createSafeTx(otherNetwork.chainId, activeAddress, { to: recipientAddress, value: 2n, input: new Uint8Array() }, 0n)))
	await modules.refreshPendingSafeSignerSelectionErrors(() => otherNetworkServices, socket.tabId)
	assert.deepEqual(otherNetworkServices.requestedRpcMethods.filter((method) => method !== 'eth_blockNumber'), [])
	const notRebuilt = await getPendingTransaction()
	assert.equal(notRebuilt.safeTransaction?.safeTx.domain.chainId, fakeRpcNetwork.chainId)
	assert.equal(notRebuilt.safeTransaction?.safeSignerAddress, recipientAddress)

	fakeSafeContract.transactionHash = requestedNetworkSafeTxHash
	await modules.refreshPendingSafeSignerSelectionErrors(() => simulator, socket.tabId)
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
	await modules.refreshPendingSafeSignerSelectionErrors(() => simulator, socket.tabId)
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

	const approval = approveRequest(websiteTabConnections, () => suspended)
	await suspended.reached
	await modules.browserStorageLocalSet({ activeRpcNetwork: otherNetwork })
	suspended.release()

	assert.equal(await approval, false)
	assert.deepEqual(getForwardedSignerRequests(postedMessages), [])
	await expectRefusalShownAndNotStored()
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
	await expectRefusalShownAndNotStored()
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
	const resolve = async (services: typeof otherNetworkServices | typeof simulator, data: { readonly action: 'addToSafeStack' } | { readonly action: 'signerIncluded', readonly signerReply: unknown }) => await modules.resolvePendingTransactionOrMessage(() => services, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { ...data, uniqueRequestIdentifier },
	})
	const expectNotStored = async () => {
		assert.deepEqual(await modules.getSafeTransactionStacks(), [])
		await expectRefusalShownAndNotStored()
	}

	// A network without an Interceptor RPC is active, while the client of the requested network is still installed.
	await modules.browserStorageLocalSet({ activeRpcNetwork: otherNetwork })
	assert.equal(await resolve(simulator, { action: 'addToSafeStack' }), false)
	await expectNotStored()

	// After a switch to a network with an Interceptor RPC, its client is installed and resolves with it.
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
	assert.equal(await modules.resolvePendingTransactionOrMessage(() => simulator, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', uniqueRequestIdentifier, signerReply: transactionHash },
	}), true)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'result' && message.result === transactionHash), true)
})

// A transaction whose latest run did not produce a preview: still crafting, still simulating, or failed.
function getTransactionsWithoutPreview() {
	const { popupVisualisation, transactionToSimulate, ...base } = pendingTransaction
	const failedTransaction = { website: transactionToSimulate.website, created: transactionToSimulate.created, originalRequestParameters: transactionToSimulate.originalRequestParameters, transactionIdentifier: transactionToSimulate.transactionIdentifier, success: false as const, error: { code: -32000, message: 'simulation failed' } }
	const failedVisualisation = {
		statusCode: 'failed' as const,
		data: {
			activeAddress: popupVisualisation.data.activeAddress,
			simulationMode: false,
			simulationStartedTimestamp: popupVisualisation.data.simulationStartedTimestamp,
			uniqueRequestIdentifier,
			transactionToSimulate: failedTransaction,
			signerName: popupVisualisation.data.signerName,
			confirmationRunId: popupVisualisation.data.confirmationRunId,
			error: { code: -32000, message: 'simulation failed', decodedErrorMessage: 'simulation failed' },
			simulationState: { blockNumber: 1n, simulationConductedTimestamp: popupVisualisation.data.simulationStartedTimestamp },
		},
	}
	return {
		Crafting: { ...base, simulationMode: false, transactionOrMessageCreationStatus: 'Crafting' as const },
		Simulating: { ...base, simulationMode: false, transactionToSimulate, transactionOrMessageCreationStatus: 'Simulating' as const },
		FailedToSimulate: { ...base, simulationMode: false, transactionToSimulate: failedTransaction, popupVisualisation: failedVisualisation, transactionOrMessageCreationStatus: 'FailedToSimulate' as const },
	}
}

for (const [status, transaction] of Object.entries(getTransactionsWithoutPreview())) {
	test(`an approval of a transaction that is ${ status } is refused and forwards nothing`, async () => {
		const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [transaction] })
		const before = await modules.getPendingTransactionsAndMessages()
		assert.equal(before[0]?.transactionOrMessageCreationStatus, status)

		assert.equal(await approveRequest(websiteTabConnections), false)

		assert.deepEqual(getForwardedSignerRequests(postedMessages), [])
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), before)
	})
}

const replyFromSigner = async (websiteTabConnections: TransactionTestConnections, signerReply: unknown) => await modules.resolvePendingTransactionOrMessage(() => simulator, websiteTabConnections, {
	method: 'popup_confirmDialog',
	data: { action: 'signerIncluded', uniqueRequestIdentifier, signerReply },
})

const getWebsiteResults = (postedMessages: readonly unknown[]) => postedMessages.filter((message) => isRecord(message) && message.type === 'result')

test('a signer reply for a request still awaiting the user in signing mode does nothing', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const before = await modules.getPendingTransactionsAndMessages()
	assert.equal(before[0]?.approvalStatus.status, 'WaitingForUser')

	assert.equal(await replyFromSigner(websiteTabConnections, modules.EthereumBytes32.serialize(0x1234n)), false)

	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), before)
	assert.deepEqual(getWebsiteResults(postedMessages), [])
})

test('a signer reply for a Gnosis Safe proposal still awaiting the user does nothing', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	const { safePending, signature } = await setUpSafeProposal()
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [safePending] })
	const before = await modules.getPendingTransactionsAndMessages()

	assert.equal(await replyFromSigner(websiteTabConnections, signature), false)

	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), before)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
	assert.deepEqual(getWebsiteResults(postedMessages), [])
})

test('a signer reply whose request stops waiting for the signer while the reply is validated does nothing', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	const { safePending, signature } = await setUpSafeProposal()
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{ ...safePending, approvalStatus: { status: 'WaitingForSigner' } }] })
	const validation = holdSafeValidation()
	const resolution = replyFromSigner(websiteTabConnections, signature)
	await validation.reached
	// Stands in for any writer that hands the request back to the user meanwhile; the commit reads the stored request again.
	await storePendingTransaction((pending) => ({ ...pending, approvalStatus: { status: 'WaitingForUser' } }))
	validation.release()

	assert.equal(await resolution, false)
	assert.equal((await getPendingTransaction()).approvalStatus.status, 'WaitingForUser')
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
	assert.deepEqual(getWebsiteResults(postedMessages), [])
})

// For calling the forwarder directly, with a request nothing can reject meanwhile.
const commitWithoutRejection = async <T>(commit: () => Promise<T>) => ({ stored: true as const, result: await commit() })

// A Gnosis Safe proposal requested on the fake network with the wallet's signature for it, and a Safe that accepts it.
async function setUpSafeProposal() {
	fakeSafeContract.owners = [safeTestOwnerAddress]
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeSignerAddresses: [safeTestOwnerAddress] })])
	await modules.updateTabState(socket.tabId, (state) => ({ ...state, signerAccounts: [safeTestOwnerAddress], activeSigningAddress: safeTestOwnerAddress, signerChain: fakeRpcNetwork.chainId }))
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
	return { safePending, signature: await safeTestOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx))) }
}

// Suspends the next Gnosis Safe validation at its read of the contract version, which comes after the first network check.
function holdSafeValidation() {
	const reached = createDeferredValue<undefined>()
	const release = createDeferredValue<undefined>()
	fakeSafeContract.beforeVersionResponse = async () => {
		reached.resolve(undefined)
		await release.promise
	}
	return { reached: reached.promise, release: () => release.resolve(undefined) }
}

// Whether the window was sent the stored queue, which the background sends without waiting for an RPC.
const wasWindowToldOfStoredState = () => browserMock.sentMessages.some((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions')

test('a signed Gnosis Safe proposal that resumes after a switch back is refused, and the refusal clears without any RPC', async () => {
	const { postedMessages } = await setUpTransactionApprovalTest(false)
	const { safePending, signature } = await setUpSafeProposal()
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{ ...safePending, approvalStatus: { status: 'WaitingForSigner' } }] })
	await modules.browserStorageLocalSet({ activeRpcNetwork: otherNetwork })
	const { changeActiveAddressAndChain } = await import('../../app/ts/background/activeSettings.js')
	const otherNetworkServices = createOtherNetworkServices()
	const installedServices = createSuspendedServices('eth_blockNumber')
	const simulationServicesOwner = createTestSimulationServicesOwner(otherNetworkServices, (network) => network.chainId === otherNetwork.chainId ? otherNetworkServices : installedServices)
	const port = createWebsitePort(socket, 0, postedMessages)
	const signerConnections = new Map([[socket.tabId, {
		signerStateOwner: { connectionName: socket.connectionName, confirmed: true, generation: 3, providerGeneration: 8 },
		connections: { [modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: website.websiteOrigin, approved: true, wantsToConnect: true } },
	}]])
	const validation = holdSafeValidation()

	const reply = modules.signerReply(simulationServicesOwner, signerConnections, port, {
		method: 'signer_reply',
		params: [{
			success: true,
			signerProviderGeneration: 8,
			forwardRequest: { type: 'forwardToSigner', replyWithSignersReply: true, method: safePending.originalRequestParameters.method, params: safePending.originalRequestParameters.params, requestId: uniqueRequestIdentifier.requestId },
			reply: signature,
		}],
		interceptorRequest: true,
		interceptorInternalRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: uniqueRequestIdentifier.requestId + 1, requestSocket: socket },
	}, 'hasAccess', activeAddress)
	await validation.reached
	await changeActiveAddressAndChain(simulationServicesOwner, new Map(), { simulationMode: false, rpcNetwork: fakeRpcNetwork })
	browserMock.sentMessages.length = 0
	validation.release()
	await reply

	// The installed network's block number has not been answered, and nothing was stored or forwarded.
	assert.deepEqual((await getPendingTransaction()).approvalStatus, { status: 'WaitingForUser' })
	assert.equal(wasWindowToldOfStoredState(), true)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
	assert.deepEqual(getForwardedSignerRequests(postedMessages), [])
	installedServices.release()
})

test('an unsigned Gnosis Safe proposal refused after a network switch tells the window through the same step', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	const { safePending } = await setUpSafeProposal()
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [safePending] })
	const validation = holdSafeValidation()

	const resolution = modules.resolvePendingTransactionOrMessage(() => simulator, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'addToSafeStack', uniqueRequestIdentifier } })
	await validation.reached
	await modules.browserStorageLocalSet({ activeRpcNetwork: otherNetwork })
	browserMock.sentMessages.length = 0
	validation.release()

	assert.equal(await resolution, false)
	assert.equal(wasWindowToldOfStoredState(), true)
	assert.equal(await getRefusalMessage(), NETWORK_CHANGED_REFUSAL)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
})

for (const action of ['reject', 'noResponse'] as const) {
	test(`after a refusal, ${ action } reaches the website while the block number is unanswered`, async () => {
		const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
		await requestTransaction(websiteTabConnections, false)
		const stalled = createSuspendedServices('eth_blockNumber')
		// The approval runs with these installed services, whose block number the view update after the refusal waits for.
		await modules.browserStorageLocalSet({ activeRpcNetwork: otherNetwork })
		const stillWaiting = async () => await new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 500))

		// The reply to the approval is what re-enables the reject button in the window, so it does not wait for the RPC either.
		const approval = approveRequest(websiteTabConnections, () => stalled)
		await stalled.reached
		const approvalOutcome = await Promise.race([approval.then(() => 'answered'), stillWaiting()])
		const resolution = modules.resolvePendingTransactionOrMessage(() => simulator, websiteTabConnections, { method: 'popup_confirmDialog', data: { action, uniqueRequestIdentifier } })
		const resolutionOutcome = await Promise.race([resolution.then(() => 'answered'), stillWaiting()])
		const pendingBeforeRpcAnswers = await modules.getPendingTransactionsAndMessages()
		const rejectionsBeforeRpcAnswers = postedMessages.filter((message) => isRecord(message) && isRecord(message.error) && message.error.code === METAMASK_ERROR_USER_REJECTED_REQUEST)
		stalled.release()
		await Promise.all([approval, resolution])

		assert.equal(approvalOutcome, 'answered')
		assert.equal(resolutionOutcome, 'answered')
		assert.deepEqual(pendingBeforeRpcAnswers, [])
		assert.equal(rejectionsBeforeRpcAnswers.length, 1)
		assert.deepEqual(getForwardedSignerRequests(postedMessages), [])
	})
}

// Whether a resolution answered while an RPC is held, which a resolution that awaits a view update under its resolution lock does not.
const answersWithoutTheRpc = async (resolution: Promise<unknown>) => await Promise.race([resolution.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))])

const getRejections = (postedMessages: readonly unknown[]) => postedMessages.filter((message) => isRecord(message) && isRecord(message.error) && message.error.code === METAMASK_ERROR_USER_REJECTED_REQUEST)

test('a valid approval reaches the wallet while the block number is unanswered, after the window was told it waits for the signer', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const stalled = createSuspendedServices('eth_blockNumber')
	const toldToWindow: { readonly status: unknown, readonly forwarded: number }[] = []
	browserMock.setRuntimeSendMessageHandler(async (message) => {
		if (message.method === 'popup_update_confirm_transaction_dialog_pending_transactions') toldToWindow.push({ status: (await getPendingTransaction()).approvalStatus.status, forwarded: getForwardedSignerRequests(postedMessages).length })
	})

	const approval = approveRequest(websiteTabConnections, () => stalled)
	const answered = await answersWithoutTheRpc(approval)
	const forwarded = getForwardedSignerRequests(postedMessages).length
	browserMock.setRuntimeSendMessageHandler(undefined)
	stalled.release()
	await approval

	assert.equal(answered, true)
	assert.equal(forwarded, 1)
	assert.deepEqual(toldToWindow, [{ status: 'WaitingForSigner', forwarded: 0 }])
})

test('a second approval queued behind a first one is answered while the first one\'s window update waits for the block number', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const stalled = createSuspendedServices('eth_blockNumber')

	// The second approval waits for the first under the resolution lock, so it answers only if the first released the lock without waiting for its view update.
	const approvals = Promise.all([approveRequest(websiteTabConnections, () => stalled), approveRequest(websiteTabConnections, () => stalled)])
	const answered = await answersWithoutTheRpc(approvals)
	stalled.release()

	assert.equal(answered, true)
	assert.deepEqual(await approvals, [true, false])
	assert.equal(getForwardedSignerRequests(postedMessages).length, 1)
})

test('closing the window during a valid approval delivers the rejection while the block number is unanswered', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const stalled = createSuspendedServices('eth_blockNumber')

	const approval = approveRequest(websiteTabConnections, () => stalled)
	const closing = modules.resolvePendingTransactionOrMessage(() => simulator, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'noResponse', uniqueRequestIdentifier } })
	const answered = await answersWithoutTheRpc(closing)
	const rejections = getRejections(postedMessages).length
	const pending = await modules.getPendingTransactionsAndMessages()
	stalled.release()
	await Promise.all([approval, closing])

	assert.equal(answered, true)
	assert.equal(rejections, 1)
	assert.deepEqual(pending, [])
})

test('an interrupted forward shows its error, and closing the window delivers the rejection, while the block number is unanswered', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const stalled = createSuspendedServices('eth_blockNumber')

	const approval = modules.resolvePendingTransactionOrMessage(() => stalled, new Map(), { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } })
	const answered = await answersWithoutTheRpc(approval)
	const status = (await getPendingTransaction()).approvalStatus.status
	const closing = modules.resolvePendingTransactionOrMessage(() => simulator, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'noResponse', uniqueRequestIdentifier } })
	const closed = await answersWithoutTheRpc(closing)
	const rejections = getRejections(postedMessages).length
	stalled.release()
	await Promise.all([approval, closing])

	assert.equal(answered, true)
	assert.equal(status, 'SignerError')
	assert.equal(closed, true)
	assert.equal(rejections, 1)
})

for (const safeReturn of ['blocked', 'error'] as const) {
	test(`a Gnosis Safe ${ safeReturn } return shows its status, and closing the window delivers the rejection, while the block number is unanswered`, async () => {
		const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
		const { safePending } = await setUpSafeProposal()
		// Gnosis Safe validation reads the block number itself, which belongs under the resolution lock of the approval and not under the commit lock, so the error used here is the one found before any RPC: a proposal with no signer.
		const { safeSignerAddress: _safeSignerAddress, ...safeTransactionWithoutSigner } = safePending.safeTransaction
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [safeReturn === 'error' ? { ...safePending, safeTransaction: safeTransactionWithoutSigner, approvalStatus: { status: 'WaitingForSigner' } } : safePending] })
		const stalled = createSuspendedServices('eth_blockNumber')
		browserMock.sentMessages.length = 0

		const resolution = safeReturn === 'error'
			? modules.resolvePendingTransactionOrMessage(() => stalled, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'signerIncluded', signerReply: '0x1234', uniqueRequestIdentifier } })
			: modules.resolvePendingTransactionOrMessage(() => stalled, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } }, { refreshedSafeSignerSelection: { selectedSigner: undefined, verificationError: 'The connected signer wallet is unavailable.' } })
		const answered = await answersWithoutTheRpc(resolution)
		const status = (await getPendingTransaction()).approvalStatus.status
		const told = wasWindowToldOfStoredState()
		const closing = modules.resolvePendingTransactionOrMessage(() => simulator, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'noResponse', uniqueRequestIdentifier } })
		const closed = await answersWithoutTheRpc(closing)
		const rejections = getRejections(postedMessages).length
		stalled.release()
		await Promise.all([resolution, closing])

		assert.equal(answered, true)
		assert.equal(status, 'SignerError')
		assert.equal(told, true)
		assert.equal(closed, true)
		assert.equal(rejections, 1)
		assert.deepEqual(getForwardedSignerRequests(postedMessages), [])
	})
}

const getRepliesToRequest = (postedMessages: readonly unknown[], requestId: number) => postedMessages.filter((message) => isRecord(message) && message.requestId === requestId && ('error' in message || 'result' in message) && message.type !== 'forwardToSigner')

const cancelRequest = async (websiteTabConnections: TransactionTestConnections, action: 'reject' | 'noResponse', identifier = uniqueRequestIdentifier) => await modules.resolvePendingTransactionOrMessage(() => simulator, websiteTabConnections, {
	method: 'popup_confirmDialog',
	data: action === 'reject' ? { action, errorString: undefined, uniqueRequestIdentifier: identifier } : { action, uniqueRequestIdentifier: identifier },
})

for (const action of ['reject', 'noResponse'] as const) {
	for (const preparing of ['accept', 'addToSafeStack', 'signerIncluded'] as const) {
		test(`${ action } during the Gnosis Safe validation of ${ preparing } answers the website at once, and the preparation then stores and forwards nothing`, async () => {
			const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
			const { safePending, signature } = await setUpSafeProposal()
			await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{ ...safePending, approvalStatus: { status: preparing === 'signerIncluded' ? 'WaitingForSigner' : 'WaitingForUser' } }] })
			const validation = holdSafeValidation()

			const resolution = preparing === 'accept'
				? modules.resolvePendingTransactionOrMessage(() => simulator, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } }, { refreshedSafeSignerSelection: { selectedSigner: safeTestOwnerAddress, verificationError: undefined } })
				: modules.resolvePendingTransactionOrMessage(() => simulator, websiteTabConnections, { method: 'popup_confirmDialog', data: preparing === 'signerIncluded' ? { action: preparing, signerReply: signature, uniqueRequestIdentifier } : { action: preparing, uniqueRequestIdentifier } })
			await validation.reached
			const cancellation = cancelRequest(websiteTabConnections, action)
			const answered = await answersWithoutTheRpc(cancellation)
			const rejections = getRejections(postedMessages).length
			const pending = await modules.getPendingTransactionsAndMessages()
			validation.release()
			await Promise.all([resolution, cancellation])

			assert.equal(answered, true)
			assert.equal(rejections, 1)
			assert.deepEqual(pending, [])
			assert.deepEqual(getForwardedSignerRequests(postedMessages), [])
			assert.equal(getRepliesToRequest(postedMessages, uniqueRequestIdentifier.requestId).length, 1)
			assert.deepEqual(await modules.getSafeTransactionStacks(), [])
		})
	}
}

test('a Gnosis Safe approval that nothing cancels reaches the wallet after its validation', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	const { safePending } = await setUpSafeProposal()
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [safePending] })
	const validation = holdSafeValidation()

	const resolution = modules.resolvePendingTransactionOrMessage(() => simulator, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } }, { refreshedSafeSignerSelection: { selectedSigner: safeTestOwnerAddress, verificationError: undefined } })
	await validation.reached
	validation.release()

	assert.equal(await resolution, true)
	assert.equal(getForwardedSignerRequests(postedMessages).length, 1)
})

test('a rejection after the status change but before the post keeps the request from the wallet', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	let cancellation: Promise<unknown> | undefined
	browserMock.setRuntimeSendMessageHandler(async (message) => {
		if (message.method !== 'popup_update_confirm_transaction_dialog_pending_transactions' || cancellation !== undefined) return
		cancellation = cancelRequest(websiteTabConnections, 'noResponse')
		await cancellation
	})

	await approveRequest(websiteTabConnections)
	browserMock.setRuntimeSendMessageHandler(undefined)
	await cancellation

	assert.deepEqual(getForwardedSignerRequests(postedMessages), [])
	assert.equal(getRejections(postedMessages).length, 1)
	assert.equal(getRepliesToRequest(postedMessages, uniqueRequestIdentifier.requestId).length, 1)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

test('an approval whose final commit wins gives the only reply, and the rejection waiting for that commit finds nothing to do', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(true)
	await requestTransaction(websiteTabConnections, true)
	const commitReached = createDeferredValue<undefined>()
	const releaseCommit = createDeferredValue<undefined>()
	browserMock.setStorageSetHandler(async (items, write) => {
		if ('interceptorTransactionStack' in items) {
			commitReached.resolve(undefined)
			await releaseCommit.promise
		}
		write()
	})

	const approval = approveRequest(websiteTabConnections)
	await commitReached.promise
	const cancellation = cancelRequest(websiteTabConnections, 'reject')
	const rejectionWaited = !(await answersWithoutTheRpc(cancellation))
	releaseCommit.resolve(undefined)
	await Promise.all([approval, cancellation])
	browserMock.setStorageSetHandler(undefined)

	assert.equal(rejectionWaited, true)
	assert.equal(getRejections(postedMessages).length, 0)
	assert.equal(getRepliesToRequest(postedMessages, uniqueRequestIdentifier.requestId).length, 1)
	assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 1)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

test('a final commit that wins keeps WaitingForSigner, and a rejection then behaves as it does for any forwarded request', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)

	assert.equal(await approveRequest(websiteTabConnections), true)
	assert.equal((await getPendingTransaction()).approvalStatus.status, 'WaitingForSigner')
	await cancelRequest(websiteTabConnections, 'reject')

	assert.equal(getForwardedSignerRequests(postedMessages).length, 1)
	assert.equal(getRejections(postedMessages).length, 1)
	assert.equal(getRepliesToRequest(postedMessages, uniqueRequestIdentifier.requestId).length, 1)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

test('closing a window answers every request sharing it while the block number and a Gnosis Safe validation are unanswered', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	const { safePending } = await setUpSafeProposal()
	const secondIdentifier = { ...uniqueRequestIdentifier, requestId: uniqueRequestIdentifier.requestId + 1 }
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [safePending, { ...pendingTransaction, simulationMode: false, approvalStatus: { status: 'WaitingForUser' }, uniqueRequestIdentifier: secondIdentifier, transactionIdentifier: 2n }] })
	const { onCloseWindowOrTab } = await import('../../app/ts/background/windows/confirmTransaction.js')
	const stalled = createSuspendedServices('eth_blockNumber')
	const validation = holdSafeValidation()
	const approval = modules.resolvePendingTransactionOrMessage(() => simulator, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'addToSafeStack', uniqueRequestIdentifier } })
	await validation.reached

	const closing = onCloseWindowOrTab(safePending.popupOrTabId, () => stalled, websiteTabConnections)
	await answersWithoutTheRpc(closing)
	const rejections = getRejections(postedMessages).map((message) => isRecord(message) ? message.requestId : undefined)
	stalled.release()
	validation.release()
	await Promise.all([approval, closing])

	assert.deepEqual(rejections, [uniqueRequestIdentifier.requestId, secondIdentifier.requestId])
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
})

test('a network switch while a Gnosis Safe proposal is validated keeps it out of the Gnosis Safe stack', async () => {
	const { websiteTabConnections } = await setUpTransactionApprovalTest(false)
	const { safePending, signature } = await setUpSafeProposal()
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

		const resolution = modules.resolvePendingTransactionOrMessage(() => simulator, websiteTabConnections, { method: 'popup_confirmDialog', data: persistence.data })
		await contractLookup.promise
		await modules.browserStorageLocalSet({ activeRpcNetwork: otherNetwork })
		release.resolve(undefined)

		assert.equal(await resolution, false, persistence.data.action)
		assert.deepEqual(await modules.getSafeTransactionStacks(), [], persistence.data.action)
		await expectRefusalShownAndNotStored(persistence.data.action)
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
	await expectRefusalShownAndNotStored()
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
	const forwarding = await forwardToSignerOnRequestedNetwork(websiteTabConnections, simulator.ethereum, pendingWithWorkAfterCheck(async () => { checkWorkRan = true }), { ...pendingTransaction.originalRequestParameters, type: 'forwardToSigner', uniqueRequestIdentifier }, commitWithoutRejection)
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
	assert.equal(stackUpdate.committed ? undefined : typeof stackUpdate.refusal.message, 'string')
	assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])

	await modules.browserStorageLocalSet({ activeRpcNetwork: fakeRpcNetwork })
	await switchNetworkAfterNetworkRead(1)
	const stateUpdate = await updateTransactionStateOnRequestedNetwork(simulator.ethereum, pendingTransaction, (previousState) => ({ ...previousState, safeTransactionStacks: [createSafeStackFixture([])] }))
	assert.equal(stateUpdate.committed ? undefined : typeof stateUpdate.refusal.message, 'string')
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
})

test('a network switch right after the network was read keeps the first delivery to the signer from being posted', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	const { forwardToSignerOnRequestedNetwork } = await import('../../app/ts/background/requestedNetworkForwarding.js')

	await switchNetworkAfterNetworkRead(1)
	const forwarding = await forwardToSignerOnRequestedNetwork(websiteTabConnections, simulator.ethereum, pendingTransaction, { ...pendingTransaction.originalRequestParameters, type: 'forwardToSigner', uniqueRequestIdentifier }, commitWithoutRejection)

	assert.equal(forwarding.committed ? undefined : typeof forwarding.refusal.message, 'string')
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
	const forwarding = await forwardToSignerOnRequestedNetwork(websiteTabConnections, simulator.ethereum, pendingTransaction, { ...pendingTransaction.originalRequestParameters, type: 'forwardToSigner', uniqueRequestIdentifier }, commitWithoutRejection)

	assert.equal(disconnectedPort.getPostAttempts(), 1)
	assert.equal(forwarding.committed ? undefined : typeof forwarding.refusal.message, 'string')
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

	assert.equal(stackUpdate.committed ? undefined : typeof stackUpdate.refusal.message, 'string')
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
	const { changeSimulationMode } = await import('../../app/ts/background/settings.js')
	const { repairCorruptActiveNetwork } = await import('../../app/ts/background/activeNetworkStorage.js')
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

	// The startup repair of the corrupt active network to the default network is held open while a valid network is selected.
	browserMock.storageState.activeRpcNetwork = { corrupt: true }
	const repairingRead = withSilencedConsole(async () => await repairCorruptActiveNetwork())
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

	assert.equal(stackUpdate.committed ? undefined : typeof stackUpdate.refusal.message, 'string')
	assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
})

test('a repair of a corrupt active network read before a network switch committed leaves the switched network stored', async () => {
	const { changeSimulationMode, getSettings } = await import('../../app/ts/background/settings.js')
	const { repairCorruptActiveNetwork } = await import('../../app/ts/background/activeNetworkStorage.js')
	await setUpTransactionApprovalTest(false)
	const networkWrites: unknown[] = []
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if ('activeRpcNetwork' in items) networkWrites.push(items.activeRpcNetwork)
		writeStoredItems()
	})
	// The startup repair reads the corrupt network, and then waits before acting on it until a network switch has committed.
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
	const repairingRead = withSilencedConsole(async () => await repairCorruptActiveNetwork())
	await corruptNetworkRead.promise
	await changeSimulationMode({ simulationMode: false, rpcNetwork: otherNetwork })
	networkSwitchCommitted.resolve(undefined)

	// The stale repair does not write the default network over the switch.
	await repairingRead
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
	const pageRead = withSilencedConsole(async () => await popupSettings.getActiveRpcNetwork())
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

test('reading a corrupt active network never writes, and only the startup repair stores the default network, which makes an earlier read stale', async () => {
	const { defaultRpcs, getSettings } = await import('../../app/ts/background/settings.js')
	const { readActiveNetworkSnapshot, repairCorruptActiveNetwork } = await import('../../app/ts/background/activeNetworkStorage.js')
	await setUpTransactionApprovalTest(false)
	const keysRead: unknown[] = []
	const networkWrites: unknown[] = []
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		keysRead.push(keys)
		return readStoredItems()
	})
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if ('activeRpcNetwork' in items) networkWrites.push(items.activeRpcNetwork)
		writeStoredItems()
	})

	const snapshot = await readActiveNetworkSnapshot()
	assert.deepEqual(keysRead, [['activeRpcNetwork']])
	assert.equal(snapshot.activeRpcNetwork.chainId, fakeRpcNetwork.chainId)
	assert.equal(snapshot.isStillCurrent(), true)

	browserMock.storageState.activeRpcNetwork = { corrupt: true }
	const corruptSnapshot = await readActiveNetworkSnapshot()
	assert.equal(corruptSnapshot.activeRpcNetwork.chainId, defaultRpcs[0]?.chainId)
	assert.equal((await getSettings()).activeRpcNetwork.chainId, defaultRpcs[0]?.chainId)
	assert.deepEqual(networkWrites, [])
	assert.equal(corruptSnapshot.isStillCurrent(), true)

	await withSilencedConsole(async () => await repairCorruptActiveNetwork())
	assert.equal(networkWrites.length, 1)
	assert.equal(corruptSnapshot.isStillCurrent(), false)
	const repairedSnapshot = await readActiveNetworkSnapshot()
	assert.equal(repairedSnapshot.activeRpcNetwork.chainId, defaultRpcs[0]?.chainId)
	assert.equal(repairedSnapshot.isStillCurrent(), true)
	// A valid stored network is left alone.
	await repairCorruptActiveNetwork()
	assert.equal(networkWrites.length, 1)
})
