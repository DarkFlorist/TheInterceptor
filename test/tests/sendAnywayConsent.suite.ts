import * as assert from 'assert'
import { test } from 'bun:test'
import { activeAddress, addressString, createAcceptConfirmation, createSafeAddressBookEntry, createSafeTx, createWebsitePort, created, EIP712Message, fakeRpcNetwork, fakeSafeContract, getSafeTxHash, isRecord, modules, pendingTransaction, popupVisualisation, recipientAddress, safeTestOwnerAddress, safeTxToTypedDataJson, signedTransaction, simulator, uniqueRequestIdentifier, unsignedTransaction } from './confirmTransactionTestHarness.js'

type TransactionOutcome = { transactionStatus: 'Transaction Succeeded' } | { transactionStatus: 'Transaction Failed', error: { code: number, message: string, decodedErrorMessage: string } }

const succeeded: TransactionOutcome = { transactionStatus: 'Transaction Succeeded' }
const reverted: TransactionOutcome = { transactionStatus: 'Transaction Failed', error: { code: -32000, message: 'execution reverted', decodedErrorMessage: 'execution reverted' } }

const contact = (name: string, address: bigint) => ({ type: 'contact' as const, name, address, entrySource: 'User' as const, chainId: fakeRpcNetwork.chainId })

// A signing-mode transaction whose simulated result has the given outcome and quarantine flag.
function makeReviewedTransaction(outcome: TransactionOutcome, quarantine: boolean, simulationConductedTimestamp = popupVisualisation.data.simulationState.simulationConductedTimestamp) {
	const visualizedTransaction = {
		website: pendingTransaction.website,
		created,
		parsedInputData: { type: 'NonParsed' as const, input: new Uint8Array() },
		transactionIdentifier: pendingTransaction.transactionIdentifier,
		originalRequestParameters: pendingTransaction.originalRequestParameters,
		tokenBalancesAfter: [],
		tokenPriceEstimates: [],
		tokenPriceQuoteToken: undefined,
		gasSpent: 21_000n,
		realizedGasPrice: 1n,
		quarantine,
		quarantineReasons: quarantine ? ['The recipient is a known scam address.'] : [],
		events: [],
		transaction: { ...unsignedTransaction, from: contact('Sender', activeAddress), to: contact('Recipient', recipientAddress), rpcNetwork: fakeRpcNetwork, hash: signedTransaction.hash },
		...outcome,
	}
	return {
		...pendingTransaction,
		simulationMode: false,
		popupVisualisation: {
			...popupVisualisation,
			data: {
				...popupVisualisation.data,
				simulationState: { ...popupVisualisation.data.simulationState, simulationConductedTimestamp },
				visualizedSimulationState: {
					success: true as const,
					visualizedBlocks: [{
						simulatedAndVisualizedTransactions: [visualizedTransaction],
						visualizedPersonalSignRequests: [],
						blockTimeManipulation: { type: 'AddToTimestamp' as const, deltaToAdd: 0n, deltaUnit: 'Seconds' as const },
					}],
				},
			},
		},
	}
}

function createSignerConnection() {
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port: createWebsitePort(socket, 0, postedMessages),
				socket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	const getSignerRequest = () => postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	const wasForwardedToSigner = () => getSignerRequest() !== undefined
	const getForwardedSigner = () => {
		const signerRequest = getSignerRequest()
		return isRecord(signerRequest) && Array.isArray(signerRequest.params) ? signerRequest.params[0] : undefined
	}
	return { websiteTabConnections, wasForwardedToSigner, getForwardedSigner }
}

type AcceptConfirmation = Awaited<ReturnType<typeof createAcceptConfirmation>>
const resolveAccept = async (websiteTabConnections: ReturnType<typeof createSignerConnection>['websiteTabConnections'], accept: AcceptConfirmation, selectedSigner?: bigint) => {
	const refreshedSafeSignerSelection = selectedSigner === undefined ? undefined : { selectedSigner, verificationError: undefined }
	return await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, accept, refreshedSafeSignerSelection)
}

function prepareSafeWithTwoOwners(reviewedOwner: bigint, selectedOwner: bigint) {
	fakeSafeContract.owners = [reviewedOwner, selectedOwner]
	fakeSafeContract.threshold = 2n
	fakeSafeContract.nonce = 0n
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, { to: recipientAddress, value: 0n, input: new Uint8Array() }, 0n)
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(safeTx))
	return safeTx
}

async function getStoredRequest() {
	const [stored] = await modules.getPendingTransactionsAndMessages()
	if (stored === undefined) throw new Error('Expected the request to stay pending')
	return stored
}

test('keeps the result revision for approval-status updates and identical writes, and bumps it when the stored result changes', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [makeReviewedTransaction(succeeded, false)] })
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({ ...pending, approvalStatus: { status: 'WaitingForSigner' as const } }))
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({ ...pending, approvalStatus: { status: 'WaitingForUser' as const } }))
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => pending)
	assert.equal((await getStoredRequest()).resultRevision, 0)

	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async () => makeReviewedTransaction(reverted, false))
	assert.equal((await getStoredRequest()).resultRevision, 1)
})

test('refuses an accept that names a stale result revision and keeps the request pending', async () => {
	const { websiteTabConnections, wasForwardedToSigner } = createSignerConnection()
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [makeReviewedTransaction(succeeded, false)] })
	const acceptForReviewedResult = await createAcceptConfirmation()
	// A new block re-simulates the request after the user clicked but before the background handled the accept.
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async () => makeReviewedTransaction(succeeded, false, new Date('2024-01-01T00:00:12.000Z')))

	assert.equal(await resolveAccept(websiteTabConnections, acceptForReviewedResult), false)
	assert.equal(wasForwardedToSigner(), false)
	assert.equal((await getStoredRequest()).approvalStatus.status, 'WaitingForUser')

	assert.equal(await resolveAccept(websiteTabConnections, await createAcceptConfirmation()), true)
	assert.equal(wasForwardedToSigner(), true)
})

test('requires the send-anyway override for failing and quarantined transactions', async () => {
	for (const reviewed of [makeReviewedTransaction(reverted, false), makeReviewedTransaction(succeeded, true)]) {
		const { websiteTabConnections, wasForwardedToSigner } = createSignerConnection()
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [reviewed] })

		assert.equal(await resolveAccept(websiteTabConnections, await createAcceptConfirmation()), false)
		assert.equal(wasForwardedToSigner(), false)
		assert.equal((await getStoredRequest()).approvalStatus.status, 'WaitingForUser')

		assert.equal(await resolveAccept(websiteTabConnections, await createAcceptConfirmation(uniqueRequestIdentifier, true)), true)
		assert.equal(wasForwardedToSigner(), true)
	}
})

test('requires the send-anyway override for a quarantined signature request', async () => {
	const { websiteTabConnections, wasForwardedToSigner } = createSignerConnection()
	const signRequest = { method: 'personal_sign' as const, params: ['0x68656c6c6f', activeAddress] as const }
	const request = { ...signRequest, interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier }
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, request, { kind: 'message', parameters: signRequest }, false, activeAddress, pendingTransaction.website, websiteTabConnections), { type: 'doNotReply' })
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => {
		if (pending.type !== 'SignableMessage' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected a simulated signature request')
		return { ...pending, visualizedPersonalSignRequest: { ...pending.visualizedPersonalSignRequest, quarantine: true, quarantineReasons: ['The message targets a known scam contract.'] } }
	})

	assert.equal(await resolveAccept(websiteTabConnections, await createAcceptConfirmation()), false)
	assert.equal(wasForwardedToSigner(), false)
	assert.equal((await getStoredRequest()).approvalStatus.status, 'WaitingForUser')

	assert.equal(await resolveAccept(websiteTabConnections, await createAcceptConfirmation(uniqueRequestIdentifier, true)), true)
	assert.equal(wasForwardedToSigner(), true)
})

test('refuses a Safe proposal accept when the signer refresh during resolution changes the reviewed owner', async () => {
	const reviewedOwner = recipientAddress
	const selectedOwner = safeTestOwnerAddress
	const safeTx = prepareSafeWithTwoOwners(reviewedOwner, selectedOwner)
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	await modules.updateSafeTransactionStacks(() => [])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{
		...pendingTransaction,
		simulationMode: false,
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
	}] })
	const { websiteTabConnections, wasForwardedToSigner, getForwardedSigner } = createSignerConnection()
	const acceptForReviewedOwner = await createAcceptConfirmation()

	assert.equal(await resolveAccept(websiteTabConnections, acceptForReviewedOwner, selectedOwner), false)
	assert.equal(wasForwardedToSigner(), false)
	const refreshed = await getStoredRequest()
	assert.equal(refreshed.type === 'Transaction' ? refreshed.safeTransaction?.safeSignerAddress : undefined, selectedOwner)
	assert.equal(refreshed.resultRevision, acceptForReviewedOwner.data.resultRevision + 1)

	assert.equal(await resolveAccept(websiteTabConnections, await createAcceptConfirmation(), selectedOwner), true)
	assert.equal(getForwardedSigner(), addressString(selectedOwner))
})

test('refuses a Safe co-signing accept when the signer refresh during resolution changes the reviewed owner', async () => {
	const reviewedOwner = recipientAddress
	const selectedOwner = safeTestOwnerAddress
	const safeTx = prepareSafeWithTwoOwners(reviewedOwner, selectedOwner)
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	await modules.updateSafeTransactionStacks(() => [])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({ ...state, signerAccounts: [reviewedOwner], activeSigningAddress: reviewedOwner, signerChain: fakeRpcNetwork.chainId }))
	const { websiteTabConnections, wasForwardedToSigner, getForwardedSigner } = createSignerConnection()
	const signRequest = { method: 'eth_signTypedData_v4' as const, params: [activeAddress, EIP712Message.parse(safeTxToTypedDataJson(safeTx))] as const }
	const request = { ...signRequest, interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier }
	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, request, { kind: 'message', parameters: signRequest }, false, activeAddress, pendingTransaction.website, websiteTabConnections), { type: 'doNotReply' })
	const reviewed = await getStoredRequest()
	assert.equal(reviewed.type === 'SignableMessage' ? reviewed.safeMessageCoSignSnapshot?.safeSignerAddress : undefined, reviewedOwner)
	const acceptForReviewedOwner = await createAcceptConfirmation()

	assert.equal(await resolveAccept(websiteTabConnections, acceptForReviewedOwner, selectedOwner), false)
	assert.equal(wasForwardedToSigner(), false)
	const refreshed = await getStoredRequest()
	assert.equal(refreshed.type === 'SignableMessage' ? refreshed.safeMessageCoSignSnapshot?.safeSignerAddress : undefined, selectedOwner)
	assert.equal(refreshed.resultRevision, acceptForReviewedOwner.data.resultRevision + 1)

	assert.equal(await resolveAccept(websiteTabConnections, await createAcceptConfirmation(), selectedOwner), true)
	assert.equal(getForwardedSigner(), addressString(selectedOwner))
})
