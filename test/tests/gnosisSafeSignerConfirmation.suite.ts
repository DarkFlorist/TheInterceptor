import { createDeferredValue, createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import * as assert from 'assert'
import { test } from 'bun:test'
import { getLatestUnexpectedError } from '../../app/ts/background/storageVariables.js'
import { getCreatedGnosisSafeProposal } from '../../app/ts/gnosisSafe/gnosisSafePendingFlow.js'
import { activeAddress, addressString, browserMock, createGnosisSafeAddressBookEntry, createGnosisSafeTx, createWebsitePort, EIP712Message, ethereum, fakeRequestHandler, fakeRpcNetwork, fakeGnosisSafeContract, getPendingGnosisSafeProposal, getGnosisSafeTxHash, isRecord, modules, pendingTransaction, recipientAddress, gnosisSafeTestOwnerAccount, gnosisSafeTestOwnerAddress, gnosisSafeTxToTypedDataJson, simulator, uniqueRequestIdentifier, createAcceptConfirmation, withSimulatedTransactionResult } from './confirmTransactionTestHarness.js'

test('maps signer account refresh replies into Gnosis Safe confirmation selections', () => {
	const walletError = Object.assign(new Error('Wallet account verification failed.'), { code: 4001 })
	assert.deepEqual(modules.getGnosisSafeSignerSelectionFromAccountRefresh({ accounts: [gnosisSafeTestOwnerAddress], error: undefined }), {
		selectedSigner: gnosisSafeTestOwnerAddress,
		verificationError: undefined,
	})
	assert.deepEqual(modules.getGnosisSafeSignerSelectionFromAccountRefresh({ accounts: [], error: walletError }), {
		selectedSigner: undefined,
		verificationError: walletError.message,
	})
	assert.deepEqual(modules.getGnosisSafeSignerSelectionFromAccountRefresh(undefined), {
		selectedSigner: undefined,
		verificationError: 'The connected signer wallet is unavailable.',
	})
})

test('recovers a Gnosis Safe proposal after the wallet switches from a non-owner to a current owner', async () => {
	fakeGnosisSafeContract.owners = [gnosisSafeTestOwnerAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({
		simulationMode: false,
		rpcNetwork: fakeRpcNetwork,
		activeSigningSafeAddress: activeAddress,
	})
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({
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
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeGnosisSafeContract.transactionHash = BigInt(getGnosisSafeTxHash(safeTx))
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
		{ kind: 'transaction', parameters: transactionParams },
		false,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [pendingProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingProposal?.transactionOrMessageCreationStatus, 'Simulated')
	assert.equal(pendingProposal?.approvalStatus.status, 'SignerError')
	assert.equal(pendingProposal?.approvalStatus.status === 'SignerError' ? pendingProposal.approvalStatus.code : undefined, -32010)
	assert.equal(getPendingGnosisSafeProposal(pendingProposal)?.safeSignerAddress, recipientAddress)
	assert.equal(await modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		await createAcceptConfirmation(),
		{ selectedSigner: recipientAddress, verificationError: undefined },
	), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)

	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [gnosisSafeTestOwnerAddress],
		activeSigningAddress: gnosisSafeTestOwnerAddress,
	}))
	await modules.refreshPendingGnosisSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, uniqueRequestIdentifier.requestSocket.tabId)
	const [recoveredProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(recoveredProposal?.approvalStatus.status, 'WaitingForUser')
	assert.equal(getPendingGnosisSafeProposal(recoveredProposal)?.safeSignerAddress, gnosisSafeTestOwnerAddress)

	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createAcceptConfirmation()), true)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), true)

	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => modules.defaultActiveAddresses)
})

test('keeps a disconnected Gnosis Safe proposal reviewable and attaches the owner after wallet connection', async () => {
	fakeGnosisSafeContract.owners = [gnosisSafeTestOwnerAddress]
	await modules.updateSafeTransactionStacks(() => [])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [],
		activeSigningAddress: undefined,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const { prepareGnosisSafeTransactionConfirmation } = await import('../../app/ts/background/gnosisSafeTransactionConfirmation.js')
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
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeGnosisSafeContract.transactionHash = BigInt(getGnosisSafeTxHash(safeTx))
	const preparation = await prepareGnosisSafeTransactionConfirmation(simulator.ethereum, { kind: 'transaction', parameters: transactionParams }, false, activeAddress, undefined)
	const website = { websiteOrigin: 'https://disconnected-safe.example', icon: undefined, title: 'Disconnected Gnosis Safe' }
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
	assert.equal(getCreatedGnosisSafeProposal(finalized.safeFlow)?.safeSignerAddress, undefined)
	assert.equal(finalized.approvalStatus?.status, 'SignerError')
	if (getCreatedGnosisSafeProposal(finalized.safeFlow) === undefined) throw new Error('Missing unsigned Gnosis Safe proposal review')
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			transactionToSimulate: finalized.transactionToSimulate,
			safeFlow: finalized.safeFlow,
			approvalStatus: finalized.approvalStatus ?? { status: 'WaitingForUser' as const },
		}],
	})

	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [gnosisSafeTestOwnerAddress],
		activeSigningAddress: gnosisSafeTestOwnerAddress,
	}))
	await modules.refreshPendingGnosisSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, uniqueRequestIdentifier.requestSocket.tabId)
	const [recoveredProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(recoveredProposal?.approvalStatus.status, 'WaitingForUser')
	assert.equal(recoveredProposal?.type === 'Transaction' ? getPendingGnosisSafeProposal(recoveredProposal)?.safeSignerAddress : undefined, gnosisSafeTestOwnerAddress)
})

test('does not turn unexpected signer-selection storage or RPC failures into Gnosis Safe signer errors', async () => {
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({
		safeSimulationSignerAddress: recipientAddress,
		safeVersion: '1.4.1',
	})])
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
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
		safeFlow: { kind: 'proposal', state: 'created', safeTransaction: {
			safeAddress: activeAddress,
			safeSignerAddress: recipientAddress,
			safeVersion: reviewedSafeState.version,
			threshold: reviewedSafeState.threshold,
			reviewedSafeState,
			safeTxHash: BigInt(getGnosisSafeTxHash(safeTx)),
			safeTx,
			executionGasLimit: 21_000n,
		} },
	} as const
	const tabStateKey = `tabState_${ uniqueRequestIdentifier.requestSocket.tabId }`
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (keys === tabStateKey) throw new Error('tab state unavailable')
		return readStoredItems()
	})

	try {
		await assert.rejects(
			modules.resolveGnosisSafeConfirmation(ethereum, safePending, 'accept', { selectedSigner: recipientAddress, verificationError: undefined }),
			/tab state unavailable/u,
		)
	} finally {
		browserMock.setStorageGetHandler(undefined)
	}

	fakeGnosisSafeContract.safeOwnerLookupFailure = 'unexpected'
	try {
		await assert.rejects(
			modules.resolveGnosisSafeConfirmation(ethereum, safePending, 'accept', { selectedSigner: recipientAddress, verificationError: undefined }),
			/Unexpected Gnosis Safe owner decoder failure/u,
		)
	} finally {
		fakeGnosisSafeContract.safeOwnerLookupFailure = undefined
	}
	fakeGnosisSafeContract.safeOwnerLookupFailure = 'expected'
	try {
		const expectedFailure = await modules.resolveGnosisSafeConfirmation(ethereum, safePending, 'accept', { selectedSigner: recipientAddress, verificationError: undefined })
		assert.equal(expectedFailure.status, 'blocked')
		assert.match(expectedFailure.status === 'blocked' ? expectedFailure.approvalStatus.message : '', /Gnosis Safe owner lookup unavailable/u)
	} finally {
		fakeGnosisSafeContract.safeOwnerLookupFailure = undefined
	}
})

test('rebuilds an ordinary Gnosis Safe proposal when the wallet switches between current owners', async () => {
	const reviewedOwner = recipientAddress
	const selectedOwner = gnosisSafeTestOwnerAddress
	fakeGnosisSafeContract.owners = [reviewedOwner, selectedOwner]
	fakeGnosisSafeContract.threshold = 2n
	fakeGnosisSafeContract.nonce = 0n
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({
		safeVersion: '1.4.1',
	})])
	await modules.updateSafeTransactionStacks(() => [])
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeGnosisSafeContract.transactionHash = BigInt(getGnosisSafeTxHash(safeTx))
	const safePending = {
		...pendingTransaction,
		simulationMode: false,
		approvalStatus: { status: 'WaitingForUser' as const },
		safeFlow: { kind: 'proposal', state: 'created', safeTransaction: {
			safeAddress: activeAddress,
			safeSignerAddress: reviewedOwner,
			safeVersion: '1.4.1',
			threshold: 2n,
			reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [reviewedOwner, selectedOwner], threshold: 2n },
			safeTxHash: BigInt(getGnosisSafeTxHash(safeTx)),
			safeTx,
			executionGasLimit: 21_000n,
		} },
	} as const
	fakeGnosisSafeContract.safeOwnerLookupFailure = 'unexpected'
	try {
		await assert.rejects(
			modules.resolveGnosisSafeConfirmation(
				simulator.ethereum,
				safePending,
				'accept',
				{ selectedSigner: selectedOwner, verificationError: undefined },
			),
			/Unexpected Gnosis Safe owner decoder failure/u,
		)
	} finally {
		fakeGnosisSafeContract.safeOwnerLookupFailure = undefined
	}

	const resolution = await modules.resolveGnosisSafeConfirmation(
		simulator.ethereum,
		safePending,
		'accept',
		{ selectedSigner: selectedOwner, verificationError: undefined },
	)
	assert.equal(resolution.status, 'ready')
	if (resolution.status !== 'ready') throw new Error('The current Gnosis Safe owner did not recover the proposal')
	assert.equal(resolution.pendingChanged, true)
	assert.equal(resolution.pending.type === 'Transaction' ? getPendingGnosisSafeProposal(resolution.pending)?.safeSignerAddress : undefined, selectedOwner)
	assert.equal(resolution.signerFacingRequest?.params[0], selectedOwner)

	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [safePending] })
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [selectedOwner],
		activeSigningAddress: selectedOwner,
	}))
	await modules.refreshPendingGnosisSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, uniqueRequestIdentifier.requestSocket.tabId)
	const [refreshedPending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedPending?.approvalStatus.status, 'WaitingForUser')
	assert.equal(getPendingGnosisSafeProposal(refreshedPending)?.safeSignerAddress, selectedOwner)
})

test('does not overwrite a request forwarded while its Gnosis Safe signer refresh is in flight', async () => {
	const reviewedOwner = recipientAddress
	const selectedOwner = gnosisSafeTestOwnerAddress
	fakeGnosisSafeContract.owners = [reviewedOwner, selectedOwner]
	fakeGnosisSafeContract.threshold = 2n
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeGnosisSafeContract.transactionHash = BigInt(getGnosisSafeTxHash(safeTx))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForUser' as const },
			safeFlow: { kind: 'proposal', state: 'created', safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: reviewedOwner,
				safeVersion: '1.4.1',
				threshold: 2n,
				reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [reviewedOwner, selectedOwner], threshold: 2n },
				safeTxHash: BigInt(getGnosisSafeTxHash(safeTx)),
				safeTx,
				executionGasLimit: 21_000n,
			} },
		}],
	})
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [selectedOwner],
		activeSigningAddress: selectedOwner,
	}))
	let allowRefreshToContinue: (() => void) | undefined
	const refreshCanContinue = new Promise<void>((resolve) => { allowRefreshToContinue = resolve })
	let markRefreshStarted: (() => void) | undefined
	const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve })
	fakeGnosisSafeContract.beforeVersionResponse = async () => {
		markRefreshStarted?.()
		await refreshCanContinue
	}

	try {
		const refresh = modules.refreshPendingGnosisSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, uniqueRequestIdentifier.requestSocket.tabId)
		await refreshStarted
		await modules.updateStoredPendingRequest(uniqueRequestIdentifier, async (current) => ({
			...current,
			approvalStatus: { status: 'WaitingForSigner' as const },
		}))
		allowRefreshToContinue?.()
		await refresh
	} finally {
		fakeGnosisSafeContract.beforeVersionResponse = undefined
		allowRefreshToContinue?.()
	}

	const [forwardedPending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(forwardedPending?.approvalStatus.status, 'WaitingForSigner')
	assert.equal(forwardedPending?.type === 'Transaction' ? getPendingGnosisSafeProposal(forwardedPending)?.safeSignerAddress : undefined, reviewedOwner)
})

test('does not overwrite a newer Gnosis Safe proposal while signer refresh is in flight', async () => {
	const reviewedOwner = recipientAddress
	const selectedOwner = gnosisSafeTestOwnerAddress
	fakeGnosisSafeContract.owners = [reviewedOwner, selectedOwner]
	const originalSafeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const newerSafeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 1n,
		input: new Uint8Array(),
	}, 1n)
	fakeGnosisSafeContract.transactionHash = BigInt(getGnosisSafeTxHash(originalSafeTx))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForUser' as const },
			safeFlow: { kind: 'proposal', state: 'created', safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: reviewedOwner,
				safeVersion: '1.4.1',
				threshold: 1n,
				reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [reviewedOwner, selectedOwner], threshold: 1n },
				safeTxHash: BigInt(getGnosisSafeTxHash(originalSafeTx)),
				safeTx: originalSafeTx,
				executionGasLimit: 21_000n,
			} },
		}],
	})
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [selectedOwner],
		activeSigningAddress: selectedOwner,
	}))
	let allowRefreshToContinue: (() => void) | undefined
	const refreshCanContinue = new Promise<void>((resolve) => { allowRefreshToContinue = resolve })
	let markRefreshStarted: (() => void) | undefined
	const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve })
	fakeGnosisSafeContract.beforeVersionResponse = async () => {
		markRefreshStarted?.()
		await refreshCanContinue
	}

	try {
		const refresh = modules.refreshPendingGnosisSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, uniqueRequestIdentifier.requestSocket.tabId)
		await refreshStarted
		await modules.updateStoredPendingRequest(uniqueRequestIdentifier, async (current) => current.type !== 'Transaction' || current.safeFlow.kind !== 'proposal' || current.safeFlow.state !== 'created'
			? current
			: {
				...current,
				safeFlow: { kind: 'proposal', state: 'created', safeTransaction: {
					...current.safeFlow.safeTransaction,
					safeTx: newerSafeTx,
					safeTxHash: BigInt(getGnosisSafeTxHash(newerSafeTx)),
				} },
			})
		allowRefreshToContinue?.()
		await refresh
	} finally {
		fakeGnosisSafeContract.beforeVersionResponse = undefined
		allowRefreshToContinue?.()
	}

	const [newerPending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(newerPending?.type === 'Transaction' ? getPendingGnosisSafeProposal(newerPending)?.safeTx.message.nonce : undefined, 1n)
	assert.equal(newerPending?.type === 'Transaction' ? getPendingGnosisSafeProposal(newerPending)?.safeTx.message.value : undefined, 1n)
	assert.equal(newerPending?.type === 'Transaction' ? getPendingGnosisSafeProposal(newerPending)?.safeSignerAddress : undefined, reviewedOwner)
})

test('does not overwrite an edited Gnosis Safe proposal request while signer refresh is in flight', async () => {
	const reviewedOwner = recipientAddress
	const selectedOwner = gnosisSafeTestOwnerAddress
	fakeGnosisSafeContract.owners = [reviewedOwner, selectedOwner]
	fakeGnosisSafeContract.threshold = 1n
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeGnosisSafeContract.transactionHash = BigInt(getGnosisSafeTxHash(safeTx))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForUser' as const },
			safeFlow: { kind: 'proposal', state: 'created', safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: reviewedOwner,
				safeVersion: '1.4.1',
				threshold: 1n,
				reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [reviewedOwner, selectedOwner], threshold: 1n },
				safeTxHash: BigInt(getGnosisSafeTxHash(safeTx)),
				safeTx,
				executionGasLimit: 21_000n,
			} },
		}],
	})
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [selectedOwner],
		activeSigningAddress: selectedOwner,
	}))
	let allowRefreshToContinue: (() => void) | undefined
	const refreshCanContinue = new Promise<void>((resolve) => { allowRefreshToContinue = resolve })
	let markRefreshStarted: (() => void) | undefined
	const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve })
	fakeGnosisSafeContract.beforeVersionResponse = async () => {
		markRefreshStarted?.()
		await refreshCanContinue
	}

	try {
		const refresh = modules.refreshPendingGnosisSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, uniqueRequestIdentifier.requestSocket.tabId)
		await refreshStarted
		await modules.updateStoredPendingRequest(uniqueRequestIdentifier, async (current) => current.type !== 'Transaction'
			|| current.originalRequestParameters.method !== 'eth_sendTransaction'
			? current
			: {
				...current,
				originalRequestParameters: {
					...current.originalRequestParameters,
					params: [{ ...current.originalRequestParameters.params[0], gas: 99_999n }],
				},
			})
		allowRefreshToContinue?.()
		await refresh
	} finally {
		fakeGnosisSafeContract.beforeVersionResponse = undefined
		allowRefreshToContinue?.()
	}

	const [editedPending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(editedPending?.type === 'Transaction' && editedPending.originalRequestParameters.method === 'eth_sendTransaction'
		? editedPending.originalRequestParameters.params[0].gas
		: undefined, 99_999n)
	assert.equal(editedPending?.type === 'Transaction' ? getPendingGnosisSafeProposal(editedPending)?.safeSignerAddress : undefined, reviewedOwner)
})

test('blocks signer refresh when the reviewed Gnosis Safe owner set changed', async () => {
	const reviewedOwner = recipientAddress
	const selectedOwner = gnosisSafeTestOwnerAddress
	fakeGnosisSafeContract.owners = [selectedOwner]
	fakeGnosisSafeContract.threshold = 1n
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeGnosisSafeContract.transactionHash = BigInt(getGnosisSafeTxHash(safeTx))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForUser' as const },
			safeFlow: { kind: 'proposal', state: 'created', safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: reviewedOwner,
				safeVersion: '1.4.1',
				threshold: 1n,
				reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [reviewedOwner, selectedOwner], threshold: 1n },
				safeTxHash: BigInt(getGnosisSafeTxHash(safeTx)),
				safeTx,
				executionGasLimit: 21_000n,
			} },
		}],
	})
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [selectedOwner],
		activeSigningAddress: selectedOwner,
	}))

	await modules.refreshPendingGnosisSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, uniqueRequestIdentifier.requestSocket.tabId)

	const [blockedPending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(blockedPending?.approvalStatus.status, 'SignerError')
	if (blockedPending?.approvalStatus.status !== 'SignerError') throw new Error('Missing changed-owner signer refresh error')
	assert.match(blockedPending.approvalStatus.message, /owner set changed/u)
	assert.equal(blockedPending.type === 'Transaction' ? getPendingGnosisSafeProposal(blockedPending)?.safeSignerAddress : undefined, reviewedOwner)
})

test('keeps signer refresh failures visible in the Gnosis Safe proposal instead of aborting the refresh loop', async () => {
	const reviewedOwner = recipientAddress
	const selectedOwner = gnosisSafeTestOwnerAddress
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
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
			safeFlow: { kind: 'proposal', state: 'created', safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: reviewedOwner,
				safeVersion: '1.4.1',
				threshold: 1n,
				reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [reviewedOwner, selectedOwner], threshold: 1n },
				safeTxHash: BigInt(getGnosisSafeTxHash(safeTx)),
				safeTx,
			} },
		}],
	})
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [selectedOwner],
		activeSigningAddress: selectedOwner,
	}))

	await modules.refreshPendingGnosisSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, uniqueRequestIdentifier.requestSocket.tabId)

	const [failedProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(failedProposal?.approvalStatus.status, 'SignerError')
	assert.equal(failedProposal?.approvalStatus.status === 'SignerError' ? failedProposal.approvalStatus.code : undefined, -32010)
	assert.match(failedProposal?.approvalStatus.status === 'SignerError' ? failedProposal.approvalStatus.message : '', /missing its execution gas limit/u)
	assert.equal(await getLatestUnexpectedError(), undefined)
})

test('refreshes the selected signer and uses services installed during the wallet wait', async () => {
	const configuredSigner = recipientAddress
	const freshlySelectedSigner = activeAddress
	fakeGnosisSafeContract.owners = [configuredSigner]
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({
		safeSimulationSignerAddress: configuredSigner,
	})])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerName: 'MetaMask',
		signerAccounts: [configuredSigner],
		activeSigningAddress: configuredSigner,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeGnosisSafeContract.transactionHash = BigInt(getGnosisSafeTxHash(safeTx))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...withSimulatedTransactionResult(pendingTransaction),
			simulationMode: false,
			safeFlow: { kind: 'proposal', state: 'created', safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: configuredSigner,
				safeVersion: '1.4.1',
				threshold: 2n,
				reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [configuredSigner], threshold: 2n },
				safeTxHash: BigInt(getGnosisSafeTxHash(safeTx)),
				safeTx,
			} },
		}],
	})
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const accountRequestEntered = createDeferredValue<void>()
	const releaseAccountReply = createDeferredValue<void>()
	let retiredClientRequests = 0
	const retiredNetwork = { ...fakeRpcNetwork, httpsRpc: 'https://retired.example' }
	const retiredEthereum = new modules.EthereumClientService({
		rpcUrl: retiredNetwork.httpsRpc,
		clearCache() { return undefined },
		async jsonRpcRequest() {
			retiredClientRequests++
			throw new Error('Confirmation used services captured before the wallet refresh')
		},
	}, async () => undefined, async () => undefined, retiredNetwork)
	const owner = createTestSimulationServicesOwner({
		ethereum: retiredEthereum,
		tokenPriceService: new modules.TokenPriceService(retiredEthereum, 60_000),
	}, () => simulator)
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
		accountRequestEntered.resolve(undefined)
		accountReply = releaseAccountReply.promise.then(async () => await modules.ethAccountsReply(
			createTestSimulationServicesOwner({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService }),
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
		))
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

	const confirmation = modules.confirmDialog(owner, websiteTabConnections, await createAcceptConfirmation())
	await accountRequestEntered.promise
	owner.ensureNetwork(fakeRpcNetwork)
	releaseAccountReply.resolve(undefined)
	await confirmation
	await accountReply
	assert.equal(retiredClientRequests, 0)

	assert.equal(postedMessages.some((message) => isRecord(message) && message.method === 'request_signer_to_eth_accounts'), true)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [refreshedMismatch] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedMismatch?.approvalStatus.status, 'SignerError')
	if (refreshedMismatch?.approvalStatus.status !== 'SignerError') throw new Error('Missing refreshed Gnosis Safe signer mismatch')
	assert.match(refreshedMismatch.approvalStatus.message.toLowerCase(), new RegExp(addressString(freshlySelectedSigner).toLowerCase(), 'u'))

	await modules.ethAccountsReply(
		createTestSimulationServicesOwner({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService }),
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

test('rebases a later pending Gnosis Safe proposal after an earlier nonce is rejected', async () => {
	// Approvals of requests created in signing mode are only forwarded while the Interceptor is still in signing mode.
	await modules.changeSimulationMode({ simulationMode: false })
	const ownerAccount = gnosisSafeTestOwnerAccount
	const safeSignerAddress = gnosisSafeTestOwnerAddress
	fakeGnosisSafeContract.owners = [safeSignerAddress]
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({
		safeSignerAddresses: [safeSignerAddress],
	})])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress],
		activeSigningAddress: safeSignerAddress,
	}))
	const firstIdentifier = { requestId: 31, requestSocket: uniqueRequestIdentifier.requestSocket }
	const secondIdentifier = { requestId: 32, requestSocket: uniqueRequestIdentifier.requestSocket }
	const firstSafeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const rebasedSafeTx = firstSafeTx
	const secondSafeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 1n)
	const rebasedSafeTxHash = BigInt(getGnosisSafeTxHash(rebasedSafeTx))
	fakeGnosisSafeContract.transactionHash = rebasedSafeTxHash
	const makePendingGnosisSafeTransaction = (requestIdentifier: typeof firstIdentifier, safeTx: typeof firstSafeTx, transactionIdentifier: bigint) => ({
		...withSimulatedTransactionResult({ ...pendingTransaction, transactionIdentifier }),
		uniqueRequestIdentifier: requestIdentifier,
		simulationMode: false as const,
		approvalStatus: { status: 'WaitingForUser' as const },
		safeFlow: { kind: 'proposal', state: 'created', safeTransaction: {
			safeAddress: activeAddress,
			safeSignerAddress,
			safeVersion: '1.4.1',
			threshold: 2n,
			reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [safeSignerAddress], threshold: 2n },
			safeTxHash: BigInt(getGnosisSafeTxHash(safeTx)),
			safeTx,
		} },
	})
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [
			makePendingGnosisSafeTransaction(firstIdentifier, firstSafeTx, 31n),
			makePendingGnosisSafeTransaction(secondIdentifier, secondSafeTx, 32n),
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
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createAcceptConfirmation(secondIdentifier)), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [refreshedProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(getPendingGnosisSafeProposal(refreshedProposal)?.safeTx.message.nonce, 0n)
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createAcceptConfirmation(secondIdentifier)), true)
	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing rebased Gnosis Safe signer request')
	const typedData = EIP712Message.parse(signerRequest.params[1])
	assert.equal(typedData.message.nonce, 0n)

	const signature = await ownerAccount.signTypedData(typedData)
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: signature, uniqueRequestIdentifier: secondIdentifier },
	}), true)
	const [gnosisSafeStack] = await modules.getGnosisSafeTransactionStacks()
	assert.equal(gnosisSafeStack?.baseNonce, 0n)
	assert.equal(gnosisSafeStack?.transactions[0]?.safeTxHash, rebasedSafeTxHash)
})

test('rejects a stale forwarded Gnosis Safe nonce before persistence and rebases it when retried', async () => {
	// Approvals of requests created in signing mode are only forwarded while the Interceptor is still in signing mode.
	await modules.changeSimulationMode({ simulationMode: false })
	const ownerAccount = gnosisSafeTestOwnerAccount
	const safeSignerAddress = gnosisSafeTestOwnerAddress
	fakeGnosisSafeContract.owners = [safeSignerAddress]
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({
		safeSignerAddresses: [safeSignerAddress],
	})])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress],
		activeSigningAddress: safeSignerAddress,
	}))
	const requestIdentifier = { requestId: 33, requestSocket: uniqueRequestIdentifier.requestSocket }
	const staleSafeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 1n)
	const rebasedSafeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeGnosisSafeContract.transactionHash = BigInt(getGnosisSafeTxHash(rebasedSafeTx))
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...withSimulatedTransactionResult(pendingTransaction),
			uniqueRequestIdentifier: requestIdentifier,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
			safeFlow: { kind: 'proposal', state: 'created', safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress,
					safeVersion: '1.4.1',
					threshold: 2n,
					reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [safeSignerAddress], threshold: 2n },
					safeTxHash: BigInt(getGnosisSafeTxHash(staleSafeTx)),
				safeTx: staleSafeTx,
			} },
		}],
	})
	const staleSignature = await ownerAccount.signTypedData(EIP712Message.parse(gnosisSafeTxToTypedDataJson(staleSafeTx)))

	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, new Map(), {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: staleSignature, uniqueRequestIdentifier: requestIdentifier },
	}), false)
	assert.deepEqual(await modules.getGnosisSafeTransactionStacks(), [])
	const [stalePending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(stalePending?.approvalStatus.status, 'SignerError')
	if (stalePending?.approvalStatus.status !== 'SignerError') throw new Error('Missing stale Gnosis Safe nonce signer error')
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
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createAcceptConfirmation(requestIdentifier)), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [refreshedPending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(getPendingGnosisSafeProposal(refreshedPending)?.safeTx.message.nonce, 0n)
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createAcceptConfirmation(requestIdentifier)), true)
	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing retried Gnosis Safe signer request')
	assert.equal(EIP712Message.parse(signerRequest.params[1]).message.nonce, 0n)
})

test('persists and simulates a valid Gnosis Safe owner signature before replying with the canonical Gnosis Safe hash', async () => {
	const ownerAccount = gnosisSafeTestOwnerAccount
	const safeSignerAddress = gnosisSafeTestOwnerAddress
	fakeGnosisSafeContract.owners = [safeSignerAddress]
	const safeAddressBookEntry = createGnosisSafeAddressBookEntry({ safeSimulationSignerAddress: safeSignerAddress })
	await modules.updateUserAddressBookEntries(() => [safeAddressBookEntry])
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const safeTxHash = BigInt(getGnosisSafeTxHash(safeTx))
	const signature = await ownerAccount.signTypedData(EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx)))
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
		activeSigningSafeAddress: activeAddress,
	})
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
			safeFlow: { kind: 'proposal', state: 'created', safeTransaction: {
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
			} },
		}],
	})

	await modules.updateUserAddressBookEntries(() => [{ ...safeAddressBookEntry, safeSimulationSignerAddress: recipientAddress }])
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: signature, uniqueRequestIdentifier },
	}), true)

	const safeStacks = await modules.getGnosisSafeTransactionStacks()
	assert.equal(safeStacks.length, 1)
	assert.equal(safeStacks[0]?.transactions[0]?.safeTxHash, safeTxHash)
	assert.equal(safeStacks[0]?.transactions[0]?.signatures[0]?.signer, safeSignerAddress)
	const interceptorStack = await modules.getInterceptorTransactionStack()
	const optimisticTransaction = interceptorStack.operations.find((operation) =>
		operation.type === 'Transaction' && operation.preSimulationTransaction.safeTransaction?.safeTxHash === safeTxHash
	)
	assert.notEqual(optimisticTransaction, undefined)
	if (optimisticTransaction?.type !== 'Transaction') throw new Error('Missing optimistic Gnosis Safe transaction')
	assert.equal(optimisticTransaction.preSimulationTransaction.signedTransaction.type, '1559')
	if (optimisticTransaction.preSimulationTransaction.signedTransaction.type !== '1559') throw new Error('Gnosis Safe simulation transaction is not EIP-1559')
	assert.equal(optimisticTransaction.preSimulationTransaction.signedTransaction.maxFeePerGas, 0n)
	assert.equal(optimisticTransaction.preSimulationTransaction.signedTransaction.maxPriorityFeePerGas, 0n)
	assert.deepEqual(optimisticTransaction.preSimulationTransaction.simulationOptions, { requiredChainId: fakeRpcNetwork.chainId })
	assert.equal((await (await import('../../app/ts/background/settings.js')).getSettings()).activeSigningSafeAddress, activeAddress)
	const simulationInput = await (await import('../../app/ts/background/simulationUpdating.js')).getCurrentSimulationInput()
	const safeSimulationBlock = simulationInput.find((block) => block.transactions.some((transaction) =>
		transaction.safeTransaction?.safeTxHash === safeTxHash
	))
	assert.equal(safeSimulationBlock?.simulateWithZeroBaseFee, false, 'the Gnosis Safe\'s executor pays the real base fee')
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	const dappReply = postedMessages.find((message) =>
		isRecord(message) && message.method === 'eth_sendTransaction' && message.requestId === uniqueRequestIdentifier.requestId
	)
	if (!isRecord(dappReply)) throw new Error('Missing Gnosis Safe transaction dapp reply')
	assert.equal(dappReply.result, modules.EthereumBytes32.serialize(safeTxHash))
})

test('adds an unsigned Gnosis Safe proposal and merges a later owner signature into both stack representations', async () => {
	const safeSignerAddress = gnosisSafeTestOwnerAddress
	fakeGnosisSafeContract.owners = [safeSignerAddress]
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const safeTxHash = BigInt(getGnosisSafeTxHash(safeTx))
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
		activeSigningSafeAddress: activeAddress,
	})
	const safePending = {
		...pendingTransaction,
		simulationMode: false as const,
		approvalStatus: { status: 'WaitingForUser' as const },
		safeFlow: { kind: 'proposal', state: 'created', safeTransaction: {
			safeAddress: activeAddress,
			safeSignerAddress,
			safeVersion: '1.4.1',
			threshold: 2n,
			reviewedSafeState: {
				version: '1.4.1' as const,
				nonce: 0n,
				owners: [safeSignerAddress],
				threshold: 2n,
			},
			safeTxHash,
			safeTx,
		} },
	}
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [safePending],
	})

	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'addToSafeStack', uniqueRequestIdentifier },
	}), true)

	const [storedStack] = await modules.getGnosisSafeTransactionStacks()
	assert.equal(storedStack?.transactions[0]?.safeTxHash, safeTxHash)
	assert.deepEqual(storedStack?.transactions[0]?.signatures, [])
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const dappReply = postedMessages.find((message) =>
		isRecord(message) && message.method === 'eth_sendTransaction' && message.requestId === uniqueRequestIdentifier.requestId
	)
	if (!isRecord(dappReply)) throw new Error('Missing unsigned Gnosis Safe transaction dapp reply')
	assert.equal(dappReply.result, modules.EthereumBytes32.serialize(safeTxHash))

	const signature = await gnosisSafeTestOwnerAccount.signTypedData(EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx)))
	const signedResolution = await modules.resolveGnosisSafeSignerReply(
		simulator.ethereum,
		{ ...safePending, approvalStatus: { status: 'WaitingForSigner' } },
		signature,
	)
	assert.equal(signedResolution.status, 'success')
	const [signedStack] = await modules.getGnosisSafeTransactionStacks()
	assert.equal(signedStack?.transactions[0]?.signatures[0]?.signer, safeSignerAddress)
	const mirroredProposal = (await modules.getInterceptorTransactionStack()).operations.find((operation) =>
		operation.type === 'Transaction' && operation.preSimulationTransaction.safeTransaction?.safeTxHash === safeTxHash
	)
	if (mirroredProposal?.type !== 'Transaction') throw new Error('Missing optimistic Gnosis Safe transaction mirror')
	assert.equal(mirroredProposal.preSimulationTransaction.safeTransaction?.signatures[0]?.signer, safeSignerAddress)
})

test('invalid Gnosis Safe owner signatures retain the request as a signer error without creating a Gnosis Safe stack', async () => {
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
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
			safeFlow: { kind: 'proposal', state: 'created', safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: recipientAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				safeTxHash: BigInt(getGnosisSafeTxHash(safeTx)),
				safeTx,
			} },
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
	if (retainedRequest?.approvalStatus.status !== 'SignerError') throw new Error('missing Gnosis Safe signature error')
	assert.match(retainedRequest.approvalStatus.message, /owner signature was rejected/u)
	assert.deepEqual(await modules.getGnosisSafeTransactionStacks(), [])
})

test('propagates unexpected Gnosis Safe signer-reply RPC and storage failures', async () => {
	const ownerAccount = gnosisSafeTestOwnerAccount
	const safeSignerAddress = gnosisSafeTestOwnerAddress
	fakeGnosisSafeContract.owners = [safeSignerAddress]
	fakeGnosisSafeContract.threshold = 2n
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const signature = await ownerAccount.signTypedData(EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx)))
	const safePending = {
		...pendingTransaction,
		simulationMode: false,
		approvalStatus: { status: 'WaitingForSigner' as const },
		safeFlow: { kind: 'proposal', state: 'created', safeTransaction: {
			safeAddress: activeAddress,
			safeSignerAddress,
			safeVersion: '1.4.1',
			threshold: 2n,
			reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [safeSignerAddress], threshold: 2n },
			safeTxHash: BigInt(getGnosisSafeTxHash(safeTx)),
			safeTx,
		} },
	} as const

	fakeGnosisSafeContract.safeOwnerLookupFailure = 'unexpected'
	try {
		await assert.rejects(
			modules.resolveGnosisSafeSignerReply(ethereum, safePending, signature),
			/Unexpected Gnosis Safe owner decoder failure/u,
		)
	} finally {
		fakeGnosisSafeContract.safeOwnerLookupFailure = undefined
	}
	fakeGnosisSafeContract.safeOwnerLookupFailure = 'expected'
	try {
		const expectedFailure = await modules.resolveGnosisSafeSignerReply(ethereum, safePending, signature)
		assert.equal(expectedFailure.status, 'error')
		assert.match(expectedFailure.status === 'error' ? expectedFailure.approvalStatus.message : '', /Gnosis Safe owner lookup unavailable/u)
	} finally {
		fakeGnosisSafeContract.safeOwnerLookupFailure = undefined
	}

	browserMock.setStorageSetHandler(async () => {
		throw new Error('Gnosis Safe stack storage unavailable')
	})
	try {
		await assert.rejects(
			modules.resolveGnosisSafeSignerReply(ethereum, safePending, signature),
			/Gnosis Safe stack storage unavailable/u,
		)
	} finally {
		browserMock.setStorageSetHandler(undefined)
	}
})

const otherChainRpcNetwork = { ...fakeRpcNetwork, name: 'Other Test Chain', chainId: 1338n }

// Services for a second chain on which the Safe has the same address, owners, and nonce as on fakeRpcNetwork, so only the chain differs.
function createOtherChainSimulator(rpcNetwork = otherChainRpcNetwork) {
	const otherChainEthereum = new modules.EthereumClientService(fakeRequestHandler, async () => undefined, async () => undefined, rpcNetwork)
	return { ethereum: otherChainEthereum, tokenPriceService: new modules.TokenPriceService(otherChainEthereum, 60_000) }
}

async function prepareGnosisSafeProposalFromFakeRpcNetwork(approvalStatus: { readonly status: 'WaitingForUser' } | { readonly status: 'WaitingForSigner' }, safeOwners: readonly bigint[] = [gnosisSafeTestOwnerAddress], proposalChainId = fakeRpcNetwork.chainId) {
	const safeSignerAddress = gnosisSafeTestOwnerAddress
	fakeGnosisSafeContract.owners = [...safeOwners]
	await modules.updateUserAddressBookEntries(() => [proposalChainId, otherChainRpcNetwork.chainId].map((chainId) => createGnosisSafeAddressBookEntry({ chainId, safeSignerAddresses: [safeSignerAddress] })))
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress],
		activeSigningAddress: safeSignerAddress,
	}))
	const safeTx = createGnosisSafeTx(proposalChainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const safeTxHash = BigInt(getGnosisSafeTxHash(safeTx))
	fakeGnosisSafeContract.transactionHash = safeTxHash
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...withSimulatedTransactionResult(pendingTransaction),
			simulationMode: false,
			approvalStatus,
			safeFlow: { kind: 'proposal', state: 'created', safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: safeOwners, threshold: 2n },
				safeTxHash,
				safeTx,
			} },
		}],
	})
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
	return { safeTx, postedMessages, websiteTabConnections }
}

test('refuses to forward a Gnosis Safe proposal prepared on another chain after the network switches', async () => {
	const { postedMessages, websiteTabConnections } = await prepareGnosisSafeProposalFromFakeRpcNetwork({ status: 'WaitingForUser' })
	const otherChainSimulator = createOtherChainSimulator()

	assert.equal(await modules.resolvePendingTransactionOrMessage(otherChainSimulator.ethereum, otherChainSimulator.tokenPriceService, websiteTabConnections, await createAcceptConfirmation()), false)

	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [refusedProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refusedProposal?.approvalStatus.status, 'SignerError')
	if (refusedProposal?.approvalStatus.status !== 'SignerError') throw new Error('Missing Gnosis Safe proposal chain mismatch error')
	assert.match(refusedProposal.approvalStatus.message, /prepared for chain 1337, but the connected network is chain 1338\. Prepare it again on the current network\./u)
	assert.equal(getPendingGnosisSafeProposal(refusedProposal)?.safeTx.domain.chainId, fakeRpcNetwork.chainId)
	assert.deepEqual(await modules.getGnosisSafeTransactionStacks(), [])
})

test('does not store a Gnosis Safe proposal signed for another chain after the network switches', async () => {
	const { safeTx, postedMessages, websiteTabConnections } = await prepareGnosisSafeProposalFromFakeRpcNetwork({ status: 'WaitingForSigner' })
	const signature = await gnosisSafeTestOwnerAccount.signTypedData(EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx)))
	const otherChainSimulator = createOtherChainSimulator()

	assert.equal(await modules.resolvePendingTransactionOrMessage(otherChainSimulator.ethereum, otherChainSimulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: signature, uniqueRequestIdentifier },
	}), false)

	assert.deepEqual(await modules.getGnosisSafeTransactionStacks(), [])
	assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
	assert.equal(postedMessages.some((message) => isRecord(message) && message.requestId === uniqueRequestIdentifier.requestId && 'result' in message), false)
	const [rejectedProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(rejectedProposal?.approvalStatus.status, 'SignerError')
	if (rejectedProposal?.approvalStatus.status !== 'SignerError') throw new Error('Missing Gnosis Safe proposal chain mismatch error')
	assert.match(rejectedProposal.approvalStatus.message, /prepared for chain 1337, but the connected network is chain 1338/u)
})

test('does not add an unsigned Gnosis Safe proposal prepared on another chain to the Gnosis Safe stack', async () => {
	const { postedMessages, websiteTabConnections } = await prepareGnosisSafeProposalFromFakeRpcNetwork({ status: 'WaitingForUser' })
	const otherChainSimulator = createOtherChainSimulator()

	assert.equal(await modules.resolvePendingTransactionOrMessage(otherChainSimulator.ethereum, otherChainSimulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'addToSafeStack', uniqueRequestIdentifier },
	}), false)

	assert.deepEqual(await modules.getGnosisSafeTransactionStacks(), [])
	assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
	assert.equal(postedMessages.some((message) => isRecord(message) && message.requestId === uniqueRequestIdentifier.requestId && 'result' in message), false)
	const [rejectedProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(rejectedProposal?.approvalStatus.status, 'SignerError')
	if (rejectedProposal?.approvalStatus.status !== 'SignerError') throw new Error('Missing Gnosis Safe proposal chain mismatch error')
	assert.match(rejectedProposal.approvalStatus.message, /prepared for chain 1337, but the connected network is chain 1338/u)
})

test('does not move a Gnosis Safe proposal to the connected chain when the wallet switches owners after the network switches', async () => {
	const otherOwner = recipientAddress
	const { postedMessages, websiteTabConnections } = await prepareGnosisSafeProposalFromFakeRpcNetwork({ status: 'WaitingForUser' }, [gnosisSafeTestOwnerAddress, otherOwner])
	// The Safe on the other chain would hash a rebuilt proposal with that chain's domain.
	fakeGnosisSafeContract.transactionHash = BigInt(getGnosisSafeTxHash(createGnosisSafeTx(otherChainRpcNetwork.chainId, activeAddress, { to: recipientAddress, value: 0n, input: new Uint8Array() }, 0n)))
	const otherChainSimulator = createOtherChainSimulator()

	assert.equal(await modules.resolvePendingTransactionOrMessage(otherChainSimulator.ethereum, otherChainSimulator.tokenPriceService, websiteTabConnections, await createAcceptConfirmation(), { selectedSigner: otherOwner, verificationError: undefined }), false)

	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [refusedProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(getPendingGnosisSafeProposal(refusedProposal)?.safeTx.domain.chainId, fakeRpcNetwork.chainId)
	assert.equal(refusedProposal?.approvalStatus.status, 'SignerError')
	if (refusedProposal?.approvalStatus.status !== 'SignerError') throw new Error('Missing Gnosis Safe proposal chain mismatch error')
	assert.match(refusedProposal.approvalStatus.message, /prepared for chain 1337, but the connected network is chain 1338/u)
})

test('refuses a Gnosis Safe proposal whose domain chain and connected chain are both the missing chain ID 0', async () => {
	const missingChainIdRpcNetwork = { ...fakeRpcNetwork, name: 'Missing Chain ID', chainId: 0n }
	const { postedMessages, websiteTabConnections } = await prepareGnosisSafeProposalFromFakeRpcNetwork({ status: 'WaitingForUser' }, [gnosisSafeTestOwnerAddress], missingChainIdRpcNetwork.chainId)
	const missingChainIdSimulator = createOtherChainSimulator(missingChainIdRpcNetwork)

	assert.equal(await modules.resolvePendingTransactionOrMessage(missingChainIdSimulator.ethereum, missingChainIdSimulator.tokenPriceService, websiteTabConnections, await createAcceptConfirmation()), false)

	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [refusedProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refusedProposal?.approvalStatus.status, 'SignerError')
	if (refusedProposal?.approvalStatus.status !== 'SignerError') throw new Error('Missing Gnosis Safe proposal missing-chain-ID error')
	assert.match(refusedProposal.approvalStatus.message, /Gnosis Safe transactions require a chain ID\./u)
	assert.deepEqual(await modules.getGnosisSafeTransactionStacks(), [])
})
