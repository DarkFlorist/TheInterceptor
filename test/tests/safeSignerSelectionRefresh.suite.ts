import * as assert from 'node:assert'
import { test } from 'bun:test'
import { prepareSafeTransactionConfirmation } from '../../app/ts/background/safeTransactionConfirmation.js'
import { SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import { getLatestUnexpectedError } from '../../app/ts/utils/unexpectedErrorStorage.js'
import { createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import { acceptConfirmation, activeAddress, addressString, connectWebsite, createConfirmedSignerStateOwner, createEthAccountsReply, createInterceptedRequest, createPendingSafeProposal, createSafeAddressBookEntry, createSafeTransactionRequest, createSafeTxToRecipient, enableSafeSigningMode, ethereum, fakeRpcNetwork, fakeSafeContract, getSafeTxHash, hasForwardedSignerRequest, hasPostedMethod, interceptStorageGet, isPostedMethod, modules, pendingTransaction, recipientAddress, safeTestOwnerAddress, setWalletAccounts, simulator, uniqueRequestIdentifier, withSafeOwnerLookupFailure } from './confirmTransactionTestHarness.js'

// The owner the user reviewed the proposal with, and the other current owner the wallet switches to.
const reviewedOwner = recipientAddress
const selectedOwner = safeTestOwnerAddress

const createTransferToRecipientParams = () => SendTransactionParams.parse({
	method: 'eth_sendTransaction',
	params: [{
		from: addressString(activeAddress),
		to: addressString(recipientAddress),
		value: '0x0',
		data: '0x',
		gas: '0x5208',
	}],
})

const refreshSignerSelection = async () => await modules.refreshPendingSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, uniqueRequestIdentifier.requestSocket.tabId)

// Stores a proposal reviewed with reviewedOwner while the wallet has already switched to selectedOwner.
async function storeProposalReviewedWithAnotherOwner({ threshold, safeTx = createSafeTxToRecipient() }: { readonly threshold: bigint, readonly safeTx?: ReturnType<typeof createSafeTxToRecipient> }) {
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(safeTx))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [createPendingSafeProposal(createSafeTransactionRequest({
			safeTx,
			safeSignerAddress: reviewedOwner,
			threshold,
			reviewedOwners: [reviewedOwner, selectedOwner],
			executionGasLimit: 21_000n,
		}))],
	})
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	await setWalletAccounts([selectedOwner])
}

// Pauses the signer refresh at its live Safe version read, applies concurrentUpdate there, then lets the refresh finish.
async function refreshSignerSelectionAround(concurrentUpdate: () => Promise<unknown>) {
	const refreshStarted = Promise.withResolvers<void>()
	const refreshCanContinue = Promise.withResolvers<void>()
	fakeSafeContract.beforeVersionResponse = async () => {
		refreshStarted.resolve()
		await refreshCanContinue.promise
	}
	try {
		const refresh = refreshSignerSelection()
		await refreshStarted.promise
		await concurrentUpdate()
		refreshCanContinue.resolve()
		await refresh
	} finally {
		fakeSafeContract.beforeVersionResponse = undefined
		refreshCanContinue.resolve()
	}
}

test('maps signer account refresh replies into Safe confirmation selections', () => {
	const walletError = Object.assign(new Error('Wallet account verification failed.'), { code: 4001 })
	assert.deepEqual(modules.getSafeSignerSelectionFromAccountRefresh({ accounts: [safeTestOwnerAddress], error: undefined }), {
		selectedSigner: safeTestOwnerAddress,
		verificationError: undefined,
	})
	assert.deepEqual(modules.getSafeSignerSelectionFromAccountRefresh({ accounts: [], error: walletError }), {
		selectedSigner: undefined,
		verificationError: walletError.message,
	})
	assert.deepEqual(modules.getSafeSignerSelectionFromAccountRefresh(undefined), {
		selectedSigner: undefined,
		verificationError: 'The connected signer wallet is unavailable.',
	})
})

test('recovers a Safe proposal after the wallet switches from a non-owner to a current owner', async () => {
	fakeSafeContract.owners = [safeTestOwnerAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await enableSafeSigningMode()
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSimulationSignerAddress: activeAddress,
		safeVersion: '1.4.1',
	})])
	await setWalletAccounts([recipientAddress], { signerName: 'MetaMask', signerChain: fakeRpcNetwork.chainId })
	const transactionParams = createTransferToRecipientParams()
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(createSafeTxToRecipient()))
	const { postedMessages, websiteTabConnections } = connectWebsite()

	assert.deepEqual(await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		createInterceptedRequest(transactionParams),
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
	assert.equal(pendingProposal?.type === 'Transaction' ? pendingProposal.safeTransaction?.safeSignerAddress : undefined, recipientAddress)
	assert.equal(await modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		acceptConfirmation,
		{ selectedSigner: recipientAddress, verificationError: undefined },
	), false)
	assert.equal(hasForwardedSignerRequest(postedMessages), false)

	await setWalletAccounts([safeTestOwnerAddress])
	await refreshSignerSelection()
	const [recoveredProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(recoveredProposal?.approvalStatus.status, 'WaitingForUser')
	assert.equal(recoveredProposal?.type === 'Transaction' ? recoveredProposal.safeTransaction?.safeSignerAddress : undefined, safeTestOwnerAddress)

	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, acceptConfirmation), true)
	assert.equal(hasForwardedSignerRequest(postedMessages), true)

	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => modules.defaultActiveAddresses)
})

test('keeps a disconnected Safe proposal reviewable and attaches the owner after wallet connection', async () => {
	fakeSafeContract.owners = [safeTestOwnerAddress]
	await modules.updateSafeTransactionStacks(() => [])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	await setWalletAccounts([], { signerChain: fakeRpcNetwork.chainId })
	const transactionParams = createTransferToRecipientParams()
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(createSafeTxToRecipient()))
	const preparation = await prepareSafeTransactionConfirmation(simulator.ethereum, { kind: 'transaction', parameters: transactionParams }, false, activeAddress, undefined)
	const website = { websiteOrigin: 'https://disconnected-safe.example', icon: undefined, title: 'Disconnected Safe' }
	const { effectiveTransactionParams } = preparation
	if (effectiveTransactionParams.method !== 'eth_sendTransaction') throw new Error('Expected the Safe proposal to keep its eth_sendTransaction parameters')
	const transactionToSimulate = await modules.formEthSendTransaction(
		simulator.ethereum,
		undefined,
		preparation.transactionExecutor,
		website,
		effectiveTransactionParams,
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
	if (!finalized.transactionToSimulate.success) throw new Error('Missing simulated unsigned Safe proposal')
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			transactionToSimulate: finalized.transactionToSimulate,
			safeTransaction: finalized.safeTransaction,
			approvalStatus: finalized.approvalStatus ?? { status: 'WaitingForUser' },
		}],
	})

	await setWalletAccounts([safeTestOwnerAddress])
	await refreshSignerSelection()
	const [recoveredProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(recoveredProposal?.approvalStatus.status, 'WaitingForUser')
	assert.equal(recoveredProposal?.type === 'Transaction' ? recoveredProposal.safeTransaction?.safeSignerAddress : undefined, safeTestOwnerAddress)
})

test('does not turn unexpected signer-selection storage or RPC failures into Safe signer errors', async () => {
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSimulationSignerAddress: recipientAddress,
		safeVersion: '1.4.1',
	})])
	const safePending = createPendingSafeProposal(createSafeTransactionRequest({ threshold: 1n, reviewedOwners: [recipientAddress], executionGasLimit: 21_000n }))
	const signerSelection = { selectedSigner: recipientAddress, verificationError: undefined }
	const tabStateKey = `tabState_${ uniqueRequestIdentifier.requestSocket.tabId }`
	const restoreStorageGet = interceptStorageGet(async (keys, readStoredItems) => {
		if (keys === tabStateKey) throw new Error('tab state unavailable')
		return await readStoredItems()
	})

	try {
		await assert.rejects(
			modules.resolveSafeConfirmation(ethereum, safePending, 'accept', signerSelection),
			/tab state unavailable/u,
		)
	} finally {
		restoreStorageGet()
	}

	await withSafeOwnerLookupFailure('unexpected', async () => {
		await assert.rejects(
			modules.resolveSafeConfirmation(ethereum, safePending, 'accept', signerSelection),
			/Unexpected Safe owner decoder failure/u,
		)
	})
	const expectedFailure = await withSafeOwnerLookupFailure('expected', async () => await modules.resolveSafeConfirmation(ethereum, safePending, 'accept', signerSelection))
	assert.equal(expectedFailure.status, 'blocked')
	assert.match(expectedFailure.status === 'blocked' ? expectedFailure.approvalStatus.message : '', /Safe owner lookup unavailable/u)
})

test('rebuilds an ordinary Safe proposal when the wallet switches between current owners', async () => {
	fakeSafeContract.owners = [reviewedOwner, selectedOwner]
	fakeSafeContract.threshold = 2n
	fakeSafeContract.nonce = 0n
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeVersion: '1.4.1',
	})])
	await modules.updateSafeTransactionStacks(() => [])
	const safeTx = createSafeTxToRecipient()
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(safeTx))
	const safePending = createPendingSafeProposal(createSafeTransactionRequest({
		safeTx,
		safeSignerAddress: reviewedOwner,
		reviewedOwners: [reviewedOwner, selectedOwner],
		executionGasLimit: 21_000n,
	}))
	const signerSelection = { selectedSigner: selectedOwner, verificationError: undefined }
	await withSafeOwnerLookupFailure('unexpected', async () => {
		await assert.rejects(
			modules.resolveSafeConfirmation(simulator.ethereum, safePending, 'accept', signerSelection),
			/Unexpected Safe owner decoder failure/u,
		)
	})

	const resolution = await modules.resolveSafeConfirmation(simulator.ethereum, safePending, 'accept', signerSelection)
	assert.equal(resolution.status, 'ready')
	if (resolution.status !== 'ready') throw new Error('The current Safe owner did not recover the proposal')
	assert.equal(resolution.pendingChanged, true)
	assert.equal(resolution.pending.type === 'Transaction' ? resolution.pending.safeTransaction?.safeSignerAddress : undefined, selectedOwner)
	assert.equal(resolution.signerFacingRequest?.params[0], selectedOwner)

	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [safePending] })
	await setWalletAccounts([selectedOwner])
	await refreshSignerSelection()
	const [refreshedPending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedPending?.approvalStatus.status, 'WaitingForUser')
	assert.equal(refreshedPending?.type === 'Transaction' ? refreshedPending.safeTransaction?.safeSignerAddress : undefined, selectedOwner)
})

test('does not overwrite a request forwarded while its Safe signer refresh is in flight', async () => {
	fakeSafeContract.owners = [reviewedOwner, selectedOwner]
	fakeSafeContract.threshold = 2n
	await storeProposalReviewedWithAnotherOwner({ threshold: 2n })

	await refreshSignerSelectionAround(async () => await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (current) => ({
		...current,
		approvalStatus: { status: 'WaitingForSigner' as const },
	})))

	const [forwardedPending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(forwardedPending?.approvalStatus.status, 'WaitingForSigner')
	assert.equal(forwardedPending?.type === 'Transaction' ? forwardedPending.safeTransaction?.safeSignerAddress : undefined, reviewedOwner)
})

test('does not overwrite a newer Safe proposal while signer refresh is in flight', async () => {
	fakeSafeContract.owners = [reviewedOwner, selectedOwner]
	const newerSafeTx = createSafeTxToRecipient({ nonce: 1n, value: 1n })
	await storeProposalReviewedWithAnotherOwner({ threshold: 1n })

	await refreshSignerSelectionAround(async () => await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (current) => current.type !== 'Transaction' || current.safeTransaction === undefined
		? current
		: {
			...current,
			safeTransaction: {
				...current.safeTransaction,
				safeTx: newerSafeTx,
				safeTxHash: BigInt(getSafeTxHash(newerSafeTx)),
			},
		}))

	const [newerPending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(newerPending?.type === 'Transaction' ? newerPending.safeTransaction?.safeTx.message.nonce : undefined, 1n)
	assert.equal(newerPending?.type === 'Transaction' ? newerPending.safeTransaction?.safeTx.message.value : undefined, 1n)
	assert.equal(newerPending?.type === 'Transaction' ? newerPending.safeTransaction?.safeSignerAddress : undefined, reviewedOwner)
})

test('does not overwrite an edited Safe proposal request while signer refresh is in flight', async () => {
	fakeSafeContract.owners = [reviewedOwner, selectedOwner]
	fakeSafeContract.threshold = 1n
	await storeProposalReviewedWithAnotherOwner({ threshold: 1n })

	await refreshSignerSelectionAround(async () => await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (current) => current.type !== 'Transaction'
		|| current.originalRequestParameters.method !== 'eth_sendTransaction'
		? current
		: {
			...current,
			originalRequestParameters: {
				...current.originalRequestParameters,
				params: [{ ...current.originalRequestParameters.params[0], gas: 99_999n }],
			},
		}))

	const [editedPending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(editedPending?.type === 'Transaction' && editedPending.originalRequestParameters.method === 'eth_sendTransaction'
		? editedPending.originalRequestParameters.params[0].gas
		: undefined, 99_999n)
	assert.equal(editedPending?.type === 'Transaction' ? editedPending.safeTransaction?.safeSignerAddress : undefined, reviewedOwner)
})

test('blocks signer refresh when the reviewed Safe owner set changed', async () => {
	fakeSafeContract.owners = [selectedOwner]
	fakeSafeContract.threshold = 1n
	await storeProposalReviewedWithAnotherOwner({ threshold: 1n })

	await refreshSignerSelection()

	const [blockedPending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(blockedPending?.approvalStatus.status, 'SignerError')
	if (blockedPending?.approvalStatus.status !== 'SignerError') throw new Error('Missing changed-owner signer refresh error')
	assert.match(blockedPending.approvalStatus.message, /owner set changed/u)
	assert.equal(blockedPending.type === 'Transaction' ? blockedPending.safeTransaction?.safeSignerAddress : undefined, reviewedOwner)
})

test('keeps signer refresh failures visible in the Safe proposal instead of aborting the refresh loop', async () => {
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
			...createPendingSafeProposal(createSafeTransactionRequest({ safeSignerAddress: reviewedOwner, threshold: 1n, reviewedOwners: [reviewedOwner, selectedOwner] })),
			transactionOrMessageCreationStatus: 'FailedToSimulate' as const,
			transactionToSimulate: failedTransaction,
		}],
	})
	await setWalletAccounts([selectedOwner])

	await refreshSignerSelection()

	const [failedProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(failedProposal?.approvalStatus.status, 'SignerError')
	assert.equal(failedProposal?.approvalStatus.status === 'SignerError' ? failedProposal.approvalStatus.code : undefined, -32010)
	assert.match(failedProposal?.approvalStatus.status === 'SignerError' ? failedProposal.approvalStatus.message : '', /missing its execution gas limit/u)
	assert.equal(await getLatestUnexpectedError(), undefined)
})

test('refreshes the selected signer and uses services installed during the wallet wait', async () => {
	const configuredSigner = recipientAddress
	const freshlySelectedSigner = activeAddress
	fakeSafeContract.owners = [configuredSigner]
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSimulationSignerAddress: configuredSigner,
	})])
	await setWalletAccounts([configuredSigner], { signerName: 'MetaMask', signerChain: fakeRpcNetwork.chainId })
	const safeTx = createSafeTxToRecipient()
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(safeTx))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [createPendingSafeProposal(createSafeTransactionRequest({ safeTx, safeSignerAddress: configuredSigner, reviewedOwners: [configuredSigner] }))],
	})
	const accountRequestEntered = Promise.withResolvers<void>()
	const releaseAccountReply = Promise.withResolvers<void>()
	let retiredClientRequests = 0
	const rejectRetiredClientRequest = async (): Promise<never> => {
		retiredClientRequests++
		throw new Error('Confirmation used services captured before the wallet refresh')
	}
	const retiredEthereum = new modules.EthereumClientService({
		rpcUrl: fakeRpcNetwork.httpsRpc,
		clearCache() { return undefined },
		getChainId: rejectRetiredClientRequest,
		jsonRpcRequest: rejectRetiredClientRequest,
	}, async () => undefined, async () => undefined, fakeRpcNetwork)
	const owner = createTestSimulationServicesOwner({
		ethereum: retiredEthereum,
		tokenPriceService: new modules.TokenPriceService(retiredEthereum, 60_000),
	}, () => simulator)
	let accountReply: Promise<unknown> | undefined
	const website = connectWebsite({
		signerStateOwner: createConfirmedSignerStateOwner(uniqueRequestIdentifier.requestSocket, 1, 1),
		onPostMessage: (message) => {
			if (!isPostedMethod(message, 'request_signer_to_eth_accounts')) return
			accountRequestEntered.resolve()
			accountReply = releaseAccountReply.promise.then(async () => await modules.ethAccountsReply(
				createTestSimulationServicesOwner(simulator),
				website.websiteTabConnections,
				website.port,
				createEthAccountsReply([freshlySelectedSigner]),
				'hasAccess',
				activeAddress,
			))
		},
	})

	const confirmation = modules.confirmDialog(owner, website.websiteTabConnections, acceptConfirmation)
	await accountRequestEntered.promise
	owner.reset(fakeRpcNetwork)
	releaseAccountReply.resolve()
	await confirmation
	await accountReply
	assert.equal(retiredClientRequests, 0)

	assert.equal(hasPostedMethod(website.postedMessages, 'request_signer_to_eth_accounts'), true)
	assert.equal(hasForwardedSignerRequest(website.postedMessages), false)
	const [refreshedMismatch] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedMismatch?.approvalStatus.status, 'SignerError')
	if (refreshedMismatch?.approvalStatus.status !== 'SignerError') throw new Error('Missing refreshed Safe signer mismatch')
	assert.match(refreshedMismatch.approvalStatus.message.toLowerCase(), new RegExp(addressString(freshlySelectedSigner).toLowerCase(), 'u'))

	await modules.ethAccountsReply(
		createTestSimulationServicesOwner(simulator),
		website.websiteTabConnections,
		website.port,
		createEthAccountsReply([configuredSigner]),
		'hasAccess',
		activeAddress,
	)
	const [readyAfterAccountChange] = await modules.getPendingTransactionsAndMessages()
	assert.equal(readyAfterAccountChange?.approvalStatus.status, 'WaitingForUser')
})
