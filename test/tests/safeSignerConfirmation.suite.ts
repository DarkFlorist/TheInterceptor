import * as assert from 'assert'
import { test } from 'bun:test'
import { activeAddress, addressString, browserMock, createSafeAddressBookEntry, createSafeTx, createWebsitePort, EIP712Message, fakeRpcNetwork, fakeSafeContract, getSafeTxHash, isRecord, modules, pendingTransaction, recipientAddress, safeTestOwnerAccount, safeTestOwnerAddress, safeTxToTypedDataJson, simulator, uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'

test('recovers a Safe proposal after the wallet switches from a non-owner to a current owner', async () => {
	fakeSafeContract.owners = [safeTestOwnerAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({
		simulationMode: false,
		rpcNetwork: fakeRpcNetwork,
	})
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSimulationSignerAddress: activeAddress,
		safeVersion: '1.4.1',
	})])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerName: 'MetaMask',
		signerAccounts: [recipientAddress],
		activeSigningAddress: recipientAddress,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			value: '0x0',
			data: '0x',
			gas: '0x5208',
		}],
	})
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(safeTx))
	const postedMessages: unknown[] = []
	const port = createWebsitePort(uniqueRequestIdentifier.requestSocket, 0, postedMessages)
	const websiteTabConnections = new Map([[uniqueRequestIdentifier.requestSocket.tabId, {
		connections: {
			[modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)]: {
				port,
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		method: transactionParams.method,
		params: transactionParams.params,
	}

	assert.deepEqual(await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		transactionParams,
		false,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [pendingProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingProposal?.transactionOrMessageCreationStatus, 'Simulated')
	assert.equal(pendingProposal?.approvalStatus.status, 'SignerError')
	assert.equal(pendingProposal?.approvalStatus.status === 'SignerError' ? pendingProposal.approvalStatus.code : undefined, -32010)
	assert.equal(pendingProposal?.safeTransaction?.safeSignerAddress, recipientAddress)
	assert.equal(await modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		{
			method: 'popup_confirmDialog',
			data: { action: 'accept', uniqueRequestIdentifier },
		},
		{ selectedSigner: recipientAddress, verificationError: undefined },
	), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)

	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [safeTestOwnerAddress],
		activeSigningAddress: safeTestOwnerAddress,
	}))
	await modules.refreshPendingSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, uniqueRequestIdentifier.requestSocket.tabId)
	const [recoveredProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(recoveredProposal?.approvalStatus.status, 'WaitingForUser')
	assert.equal(recoveredProposal?.safeTransaction?.safeSignerAddress, safeTestOwnerAddress)

	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	}), true)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), true)

	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => modules.defaultActiveAddresses)
})

test('keeps a disconnected Safe proposal reviewable and attaches the owner after wallet connection', async () => {
	fakeSafeContract.owners = [safeTestOwnerAddress]
	await modules.updateSafeTransactionStacks(() => [])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [],
		activeSigningAddress: undefined,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const { prepareSafeTransactionConfirmation } = await import('../../app/ts/background/safeTransactionConfirmation.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			value: '0x0',
			data: '0x',
			gas: '0x5208',
		}],
	})
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(safeTx))
	const preparation = await prepareSafeTransactionConfirmation(simulator.ethereum, transactionParams, false, activeAddress, undefined)
	const website = { websiteOrigin: 'https://disconnected-safe.example', icon: undefined, title: 'Disconnected Safe' }
	const transactionToSimulate = await modules.formEthSendTransaction(
		simulator.ethereum,
		undefined,
		preparation.transactionExecutor,
		website,
		preparation.effectiveTransactionParams,
		new Date(),
		1n,
		false,
		preparation.gasPayment,
	)
	const finalized = await preparation.finalize(transactionToSimulate, uniqueRequestIdentifier.requestSocket.tabId)
	assert.equal(finalized.transactionToSimulate.success, true)
	assert.equal(finalized.safeTransaction?.safeSignerAddress, undefined)
	assert.equal(finalized.approvalStatus?.status, 'SignerError')
	if (finalized.safeTransaction === undefined) throw new Error('Missing unsigned Safe proposal review')
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			transactionToSimulate: finalized.transactionToSimulate,
			safeTransaction: finalized.safeTransaction,
			approvalStatus: finalized.approvalStatus ?? { status: 'WaitingForUser' as const },
		}],
	})

	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [safeTestOwnerAddress],
		activeSigningAddress: safeTestOwnerAddress,
	}))
	await modules.refreshPendingSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, uniqueRequestIdentifier.requestSocket.tabId)
	const [recoveredProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(recoveredProposal?.approvalStatus.status, 'WaitingForUser')
	assert.equal(recoveredProposal?.type === 'Transaction' ? recoveredProposal.safeTransaction?.safeSignerAddress : undefined, safeTestOwnerAddress)
})

test('does not turn unexpected signer-selection storage failures into Safe signer errors', async () => {
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSimulationSignerAddress: recipientAddress,
		safeVersion: '1.4.1',
	})])
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const reviewedSafeState = {
		version: '1.4.1',
		nonce: 0n,
		owners: [recipientAddress],
		threshold: 1n,
	}
	const safePending = {
		...pendingTransaction,
		simulationMode: false,
		safeTransaction: {
			safeAddress: activeAddress,
			safeSignerAddress: recipientAddress,
			safeVersion: reviewedSafeState.version,
			threshold: reviewedSafeState.threshold,
			reviewedSafeState,
			safeTxHash: BigInt(getSafeTxHash(safeTx)),
			safeTx,
			executionGasLimit: 21_000n,
		},
	} as const
	const tabStateKey = `tabState_${ uniqueRequestIdentifier.requestSocket.tabId }`
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (keys === tabStateKey) throw new Error('tab state unavailable')
		return readStoredItems()
	})

	try {
		await assert.rejects(
			modules.resolveSafeConfirmation(simulator.ethereum, safePending, 'accept'),
			/tab state unavailable/u,
		)
	} finally {
		browserMock.setStorageGetHandler(undefined)
	}
})

test('rebuilds an ordinary Safe proposal when the wallet switches between current owners', async () => {
	const reviewedOwner = recipientAddress
	const selectedOwner = safeTestOwnerAddress
	fakeSafeContract.owners = [reviewedOwner, selectedOwner]
	fakeSafeContract.threshold = 2n
	fakeSafeContract.nonce = 0n
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeVersion: '1.4.1',
	})])
	await modules.updateSafeTransactionStacks(() => [])
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(safeTx))
	const safePending = {
		...pendingTransaction,
		simulationMode: false,
		approvalStatus: { status: 'WaitingForUser' as const },
		safeTransaction: {
			safeAddress: activeAddress,
			safeSignerAddress: reviewedOwner,
			safeVersion: '1.4.1',
			threshold: 2n,
			reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [reviewedOwner, selectedOwner], threshold: 2n },
			safeTxHash: BigInt(getSafeTxHash(safeTx)),
			safeTx,
			executionGasLimit: 21_000n,
		},
	} as const

	const resolution = await modules.resolveSafeConfirmation(
		simulator.ethereum,
		safePending,
		'accept',
		{ selectedSigner: selectedOwner, verificationError: undefined },
	)
	assert.equal(resolution.status, 'ready')
	if (resolution.status !== 'ready') throw new Error('The current Safe owner did not recover the proposal')
	assert.equal(resolution.pendingChanged, true)
	assert.equal(resolution.pending.type === 'Transaction' ? resolution.pending.safeTransaction?.safeSignerAddress : undefined, selectedOwner)
	assert.equal(resolution.signerFacingRequest?.params[0], selectedOwner)

	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [safePending] })
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [selectedOwner],
		activeSigningAddress: selectedOwner,
	}))
	await modules.refreshPendingSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, uniqueRequestIdentifier.requestSocket.tabId)
	const [refreshedPending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedPending?.approvalStatus.status, 'WaitingForUser')
	assert.equal(refreshedPending?.safeTransaction?.safeSignerAddress, selectedOwner)
})

test('keeps signer refresh failures visible in the Safe proposal instead of aborting the refresh loop', async () => {
	const reviewedOwner = recipientAddress
	const selectedOwner = safeTestOwnerAddress
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const failedTransaction = {
		website: pendingTransaction.website,
		created: pendingTransaction.created,
		originalRequestParameters: pendingTransaction.originalRequestParameters,
		transactionIdentifier: pendingTransaction.transactionIdentifier,
		success: false as const,
		error: { code: -32_000, message: 'Previous simulation failed.' },
	}
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			transactionOrMessageCreationStatus: 'FailedToSimulate' as const,
			transactionToSimulate: failedTransaction,
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: reviewedOwner,
				safeVersion: '1.4.1',
				threshold: 1n,
				reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [reviewedOwner, selectedOwner], threshold: 1n },
				safeTxHash: BigInt(getSafeTxHash(safeTx)),
				safeTx,
			},
		}],
	})
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [selectedOwner],
		activeSigningAddress: selectedOwner,
	}))

	await modules.refreshPendingSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, uniqueRequestIdentifier.requestSocket.tabId)

	const [failedProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(failedProposal?.approvalStatus.status, 'SignerError')
	assert.equal(failedProposal?.approvalStatus.status === 'SignerError' ? failedProposal.approvalStatus.code : undefined, -32010)
	assert.match(failedProposal?.approvalStatus.status === 'SignerError' ? failedProposal.approvalStatus.message : '', /missing its execution gas limit/u)
})

test('refreshes the selected signer before forwarding a Safe transaction', async () => {
	const configuredSigner = recipientAddress
	const freshlySelectedSigner = activeAddress
	fakeSafeContract.owners = [configuredSigner]
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSimulationSignerAddress: configuredSigner,
	})])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerName: 'MetaMask',
		signerAccounts: [configuredSigner],
		activeSigningAddress: configuredSigner,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(safeTx))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: configuredSigner,
				safeVersion: '1.4.1',
				threshold: 2n,
				reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [], threshold: 2n },
				safeTxHash: BigInt(getSafeTxHash(safeTx)),
				safeTx,
			},
		}],
	})
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	let accountReply: Promise<unknown> | undefined
	let websiteTabConnections: Map<number, {
		signerStateOwner: {
			connectionName: bigint
			confirmed: boolean
			generation: number
			providerGeneration: number
		}
		connections: Record<string, {
			port: browser.runtime.Port
			socket: typeof socket
			websiteOrigin: string
			approved: boolean
			wantsToConnect: boolean
		}>
	}>
	let port: browser.runtime.Port
	port = createWebsitePort(socket, 0, postedMessages, (message) => {
		if (!isRecord(message) || message.method !== 'request_signer_to_eth_accounts') return
		accountReply = modules.ethAccountsReply(
			simulator.ethereum,
			simulator.tokenPriceService,
			() => undefined,
			websiteTabConnections,
			port,
			{
				method: 'eth_accounts_reply',
				params: [{
					signerProviderGeneration: 1,
					type: 'success',
					accounts: [addressString(freshlySelectedSigner)],
					requestAccounts: false,
				}],
			},
			'hasAccess',
			activeAddress,
		)
	})
	websiteTabConnections = new Map([[socket.tabId, {
		signerStateOwner: {
			connectionName: socket.connectionName,
			confirmed: true,
			generation: 1,
			providerGeneration: 1,
		},
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])

	await modules.confirmDialog(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	})
	await accountReply

	assert.equal(postedMessages.some((message) => isRecord(message) && message.method === 'request_signer_to_eth_accounts'), true)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [refreshedMismatch] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedMismatch?.approvalStatus.status, 'SignerError')
	if (refreshedMismatch?.approvalStatus.status !== 'SignerError') throw new Error('Missing refreshed Safe signer mismatch')
	assert.match(refreshedMismatch.approvalStatus.message.toLowerCase(), new RegExp(addressString(freshlySelectedSigner).toLowerCase(), 'u'))

	await modules.ethAccountsReply(
		simulator.ethereum,
		simulator.tokenPriceService,
		() => undefined,
		websiteTabConnections,
		port,
		{
			method: 'eth_accounts_reply',
			params: [{
				signerProviderGeneration: 1,
				type: 'success',
				accounts: [addressString(configuredSigner)],
				requestAccounts: false,
			}],
		},
		'hasAccess',
		activeAddress,
	)
	const [readyAfterAccountChange] = await modules.getPendingTransactionsAndMessages()
	assert.equal(readyAfterAccountChange?.approvalStatus.status, 'WaitingForUser')
})

test('rebases a later pending Safe proposal after an earlier nonce is rejected', async () => {
	const ownerAccount = safeTestOwnerAccount
	const safeSignerAddress = safeTestOwnerAddress
	fakeSafeContract.owners = [safeSignerAddress]
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSignerAddresses: [safeSignerAddress],
	})])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress],
		activeSigningAddress: safeSignerAddress,
	}))
	const firstIdentifier = { requestId: 31, requestSocket: uniqueRequestIdentifier.requestSocket }
	const secondIdentifier = { requestId: 32, requestSocket: uniqueRequestIdentifier.requestSocket }
	const firstSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const rebasedSafeTx = firstSafeTx
	const secondSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 1n)
	const rebasedSafeTxHash = BigInt(getSafeTxHash(rebasedSafeTx))
	fakeSafeContract.transactionHash = rebasedSafeTxHash
	const makePendingSafeTransaction = (requestIdentifier: typeof firstIdentifier, safeTx: typeof firstSafeTx, transactionIdentifier: bigint) => ({
		...pendingTransaction,
		uniqueRequestIdentifier: requestIdentifier,
		transactionIdentifier,
		simulationMode: false as const,
		approvalStatus: { status: 'WaitingForUser' as const },
		safeTransaction: {
			safeAddress: activeAddress,
			safeSignerAddress,
			safeVersion: '1.4.1',
			threshold: 2n,
			reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [safeSignerAddress], threshold: 2n },
			safeTxHash: BigInt(getSafeTxHash(safeTx)),
			safeTx,
		},
	})
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [
			makePendingSafeTransaction(firstIdentifier, firstSafeTx, 31n),
			makePendingSafeTransaction(secondIdentifier, secondSafeTx, 32n),
		],
	})

	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, new Map(), {
		method: 'popup_confirmDialog',
		data: { action: 'reject', errorString: undefined, uniqueRequestIdentifier: firstIdentifier },
	}), false)

	const postedMessages: unknown[] = []
	const socket = secondIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, postedMessages)
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier: secondIdentifier },
	}), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [refreshedProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedProposal?.safeTransaction?.safeTx.message.nonce, 0n)
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier: secondIdentifier },
	}), true)
	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing rebased Safe signer request')
	const typedData = EIP712Message.parse(signerRequest.params[1])
	assert.equal(typedData.message.nonce, 0n)

	const signature = await ownerAccount.signTypedData(typedData)
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: signature, uniqueRequestIdentifier: secondIdentifier },
	}), true)
	const [safeStack] = await modules.getSafeTransactionStacks()
	assert.equal(safeStack?.baseNonce, 0n)
	assert.equal(safeStack?.transactions[0]?.safeTxHash, rebasedSafeTxHash)
})

test('rejects a stale forwarded Safe nonce before persistence and rebases it when retried', async () => {
	const ownerAccount = safeTestOwnerAccount
	const safeSignerAddress = safeTestOwnerAddress
	fakeSafeContract.owners = [safeSignerAddress]
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSignerAddresses: [safeSignerAddress],
	})])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress],
		activeSigningAddress: safeSignerAddress,
	}))
	const requestIdentifier = { requestId: 33, requestSocket: uniqueRequestIdentifier.requestSocket }
	const staleSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 1n)
	const rebasedSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(rebasedSafeTx))
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			uniqueRequestIdentifier: requestIdentifier,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress,
					safeVersion: '1.4.1',
					threshold: 2n,
					reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [safeSignerAddress], threshold: 2n },
					safeTxHash: BigInt(getSafeTxHash(staleSafeTx)),
				safeTx: staleSafeTx,
			},
		}],
	})
	const staleSignature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(staleSafeTx)))

	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, new Map(), {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: staleSignature, uniqueRequestIdentifier: requestIdentifier },
	}), false)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
	const [stalePending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(stalePending?.approvalStatus.status, 'SignerError')
	if (stalePending?.approvalStatus.status !== 'SignerError') throw new Error('Missing stale Safe nonce signer error')
	assert.match(stalePending.approvalStatus.message, /next available nonce is 0/u)

	const postedMessages: unknown[] = []
	const socket = requestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, postedMessages)
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier: requestIdentifier },
	}), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [refreshedPending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedPending?.safeTransaction?.safeTx.message.nonce, 0n)
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier: requestIdentifier },
	}), true)
	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing retried Safe signer request')
	assert.equal(EIP712Message.parse(signerRequest.params[1]).message.nonce, 0n)
})

test('persists and simulates a valid Safe owner signature before replying with the canonical Safe hash', async () => {
	const ownerAccount = safeTestOwnerAccount
	const safeSignerAddress = safeTestOwnerAddress
	fakeSafeContract.owners = [safeSignerAddress]
	const safeAddressBookEntry = createSafeAddressBookEntry({ safeSimulationSignerAddress: safeSignerAddress })
	await modules.updateUserAddressBookEntries(() => [safeAddressBookEntry])
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	const signature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, postedMessages)
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({
		simulationMode: false,
		rpcNetwork: fakeRpcNetwork,
	})
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				reviewedSafeState: {
					version: '1.4.1',
					nonce: 0n,
					owners: [safeSignerAddress],
					threshold: 2n,
				},
				safeTxHash,
				safeTx,
			},
		}],
	})

	await modules.updateUserAddressBookEntries(() => [{ ...safeAddressBookEntry, safeSimulationSignerAddress: recipientAddress }])
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: signature, uniqueRequestIdentifier },
	}), true)

	const safeStacks = await modules.getSafeTransactionStacks()
	assert.equal(safeStacks.length, 1)
	assert.equal(safeStacks[0]?.transactions[0]?.safeTxHash, safeTxHash)
	assert.equal(safeStacks[0]?.transactions[0]?.signatures[0]?.signer, safeSignerAddress)
	const interceptorStack = await modules.getInterceptorTransactionStack()
	const optimisticTransaction = interceptorStack.operations.find((operation) =>
		operation.type === 'Transaction' && operation.preSimulationTransaction.safeTransaction?.safeTxHash === safeTxHash
	)
	assert.notEqual(optimisticTransaction, undefined)
	if (optimisticTransaction?.type !== 'Transaction') throw new Error('Missing optimistic Safe transaction')
	assert.equal(optimisticTransaction.preSimulationTransaction.signedTransaction.type, '1559')
	if (optimisticTransaction.preSimulationTransaction.signedTransaction.type !== '1559') throw new Error('Safe simulation transaction is not EIP-1559')
	assert.equal(optimisticTransaction.preSimulationTransaction.signedTransaction.maxFeePerGas, 0n)
	assert.equal(optimisticTransaction.preSimulationTransaction.signedTransaction.maxPriorityFeePerGas, 0n)
	assert.deepEqual(optimisticTransaction.preSimulationTransaction.simulationOptions, {
		requiredChainId: fakeRpcNetwork.chainId,
		simulateWithZeroBaseFee: true,
	})
	const simulationInput = await (await import('../../app/ts/background/simulationUpdating.js')).getCurrentSimulationInput()
	const safeSimulationBlock = simulationInput.find((block) => block.transactions.some((transaction) =>
		transaction.safeTransaction?.safeTxHash === safeTxHash
	))
	assert.equal(safeSimulationBlock?.simulateWithZeroBaseFee, true)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	const dappReply = postedMessages.find((message) =>
		isRecord(message) && message.method === 'eth_sendTransaction' && message.requestId === uniqueRequestIdentifier.requestId
	)
	if (!isRecord(dappReply)) throw new Error('Missing Safe transaction dapp reply')
	assert.equal(dappReply.result, modules.EthereumBytes32.serialize(safeTxHash))
})

test('invalid Safe owner signatures retain the request as a signer error without creating a Safe stack', async () => {
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	await modules.updateSafeTransactionStacks(() => [])
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: recipientAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				safeTxHash: BigInt(getSafeTxHash(safeTx)),
				safeTx,
			},
		}],
	})

	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, new Map(), {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: '0x1234', uniqueRequestIdentifier },
	}), false)

	const retainedRequests = await modules.getPendingTransactionsAndMessages()
	assert.equal(retainedRequests.length, 1)
	const retainedRequest = retainedRequests[0]
	assert.equal(retainedRequest?.approvalStatus.status, 'SignerError')
	if (retainedRequest?.approvalStatus.status !== 'SignerError') throw new Error('missing Safe signature error')
	assert.match(retainedRequest.approvalStatus.message, /owner signature was rejected/u)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
})
