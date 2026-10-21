import * as assert from 'assert'
import { setSystemTime, test } from 'bun:test'
import { activeAddress, addressString, browserMock, createDisconnectedPort, createSafeAddressBookEntry, createSafeStackFixture, createSafeTx, createWebsitePort, EIP712Message, fakeRequestHandler, fakeRpcNetwork, fakeSafeContract, getSafeTxHash, isRecord, modules, pendingTransaction, recipientAddress, safeTestOwnerAccount, safeTestOwnerAddress, safeTxToTypedDataJson, signedTransaction, simulator, uniqueRequestIdentifier, withSilencedConsole } from './confirmTransactionTestHarness.js'
import { createDeferredValue } from './backgroundEthAccountsTestHarness.js'
import type { PendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import { SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
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

async function requestTransaction(websiteTabConnections: TransactionTestConnections, simulationMode: boolean) {
	const reply = await modules.openConfirmTransactionDialogForTransaction(simulator.ethereum, simulator.tokenPriceService, {
		interceptorRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		method: transactionParams.method,
		params: transactionParams.params,
	}, { kind: 'transaction', parameters: transactionParams }, simulationMode, activeAddress, website, websiteTabConnections)
	assert.deepEqual(reply, { type: 'doNotReply' })
}

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

test('concurrent approvals forward a message signing request to the signer only once', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	const personalSignParams = PersonalSignParams.parse({ method: 'personal_sign', params: ['0x68656c6c6f', addressString(activeAddress)] })
	const reply = await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, {
		interceptorRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		method: personalSignParams.method,
		params: personalSignParams.params,
	}, { kind: 'message', parameters: personalSignParams }, false, activeAddress, website, websiteTabConnections)
	assert.deepEqual(reply, { type: 'doNotReply' })

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

test('a confirmation stored without its requested network cannot be approved', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	await requestTransaction(websiteTabConnections, false)
	const { requestedChainId: _requestedChainId, ...storedByOlderVersion } = await getPendingTransaction()
	await storePendingTransaction(() => storedByOlderVersion)

	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages)
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
	// Suspends the second settings read of the approval, which is its final network check, if the approval makes one.
	const finalNetworkCheck = createDeferredValue<undefined>()
	const release = createDeferredValue<undefined>()
	let settingsReads = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (Array.isArray(keys) && keys.includes('activeRpcNetwork')) {
			settingsReads += 1
			if (settingsReads === 2) {
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

// Switches the active network right after the given settings read captured its snapshot, before the reader's check runs, through the settings writer every network change uses, so the check sees the network from before the switch unless it notices the write.
async function switchNetworkAfterSettingsRead(settingsReadNumber: number, rpcNetwork = otherNetwork) {
	const { changeSimulationMode } = await import('../../app/ts/background/settings.js')
	let settingsReads = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		const items = readStoredItems()
		if (Array.isArray(keys) && keys.includes('activeRpcNetwork')) {
			settingsReads += 1
			if (settingsReads === settingsReadNumber) queueMicrotask(() => { void changeSimulationMode({ simulationMode: false, rpcNetwork }) })
		}
		return items
	})
}

test('a network switch right after the network was read keeps the guarded stack and state writes from committing', async () => {
	const { updateInterceptorTransactionStackOnRequestedNetwork, updateTransactionStateOnRequestedNetwork } = await import('../../app/ts/background/transactionNetwork.js')
	await setUpTransactionApprovalTest(false)
	const stackOperation = { type: 'Transaction' as const, preSimulationTransaction: { ...pendingTransaction.transactionToSimulate, signedTransaction } }

	await switchNetworkAfterSettingsRead(1)
	const stackUpdate = await updateInterceptorTransactionStackOnRequestedNetwork(simulator.ethereum, pendingTransaction, () => ({ operations: [stackOperation] }))
	assert.equal(stackUpdate.committed ? undefined : stackUpdate.refusal.code, METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN)
	assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])

	await modules.browserStorageLocalSet({ activeRpcNetwork: fakeRpcNetwork })
	await switchNetworkAfterSettingsRead(1)
	const stateUpdate = await updateTransactionStateOnRequestedNetwork(simulator.ethereum, pendingTransaction, (previousState) => ({ ...previousState, safeTransactionStacks: [createSafeStackFixture([])] }))
	assert.equal(stateUpdate.committed ? undefined : stateUpdate.refusal.code, METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
})

test('a network switch right after the network was read keeps the first delivery to the signer from being posted', async () => {
	const { postedMessages, websiteTabConnections } = await setUpTransactionApprovalTest(false)
	const { forwardToSignerOnRequestedNetwork } = await import('../../app/ts/background/requestedNetworkForwarding.js')

	await switchNetworkAfterSettingsRead(1)
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
	await switchNetworkAfterSettingsRead(2)
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
	await switchNetworkAfterSettingsRead(1, fakeRpcNetwork)

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

test('a page context reads a corrupt active network without writing it, so a guarded write commits only on the network that stays stored', async () => {
	const { updateInterceptorTransactionStackOnRequestedNetwork } = await import('../../app/ts/background/transactionNetwork.js')
	const backgroundSettings = await import('../../app/ts/background/settings.js')
	// A popup bundle runs its own copy of the settings module, sharing only storage with the background.
	const popupSettingsModule = '../../app/ts/background/settings.js?popup'
	const popupSettings: typeof backgroundSettings = await import(popupSettingsModule)
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
