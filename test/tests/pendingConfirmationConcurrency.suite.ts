import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { PendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import { activeAddress, connectWebsite, createConfirmedSignerStateOwner, createEthAccountsReply, createSafeAddressBookEntry, createSafeTxToRecipient, fakeSafeContract, findWebsiteReplies, getSafeTxHash, getSentPendingTransactionDialogUpdates, hasForwardedSignerRequest, interceptStorageGet, isForwardedSignerRequest, isPostedMethod, modules, pendingTransaction, popupVisualisation, recipientAddress, safeTestOwnerAddress, simulator, uniqueRequestIdentifier, type StorageKeys } from './confirmTransactionTestHarness.js'
import { requireDefined } from '../harness/assertions.js'
import { createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'

const newerSimulationTimestamp = new Date('2024-01-02T00:00:00.000Z')
const popupVisualisationFromNewerSimulation = {
	...popupVisualisation,
	data: {
		...popupVisualisation.data,
		simulationStartedTimestamp: newerSimulationTimestamp,
		simulationState: { ...popupVisualisation.data.simulationState, simulationConductedTimestamp: newerSimulationTimestamp },
	},
}

const readsPendingRequests = (keys: StorageKeys) => Array.isArray(keys) ? keys.includes('pendingTransactionsAndMessages') : keys === 'pendingTransactionsAndMessages'

// Commits `concurrentUpdate` just before the refresh's write reads the pending requests, i.e. after the refresh took its snapshot.
function commitBeforePendingRead(readNumber: number, concurrentUpdate: (pending: PendingTransactionOrSignableMessage) => PendingTransactionOrSignableMessage) {
	let pendingReads = 0
	interceptStorageGet(async (keys, readStoredItems) => {
		if (readsPendingRequests(keys)) {
			pendingReads += 1
			if (pendingReads === readNumber) {
				const [stored] = await modules.getPendingTransactionsAndMessages()
				if (stored === undefined) throw new Error('Missing pending request')
				await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [concurrentUpdate(stored)] })
			}
		}
		return await readStoredItems()
	})
}

describe('confirm transaction metadata refresh', () => {
	test('keeps an accept that lands while the metadata is visualized', async () => {
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{ ...pendingTransaction, simulationMode: false }] })
		commitBeforePendingRead(2, (stored) => ({ ...stored, approvalStatus: { status: 'WaitingForSigner' } }))

		await modules.refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService, undefined)

		const [stored] = await modules.getPendingTransactionsAndMessages()
		assert.equal(stored?.approvalStatus.status, 'WaitingForSigner')
		const [dialogUpdate] = getSentPendingTransactionDialogUpdates()
		const publishedRequest = requireDefined(dialogUpdate?.data.pendingTransactionAndSignableMessages[0], 'published pending request')
		assert.equal(publishedRequest.approvalStatus.status, 'WaitingForSigner')
	})

	test('does not replace a newer simulation stored while the metadata is visualized', async () => {
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{ ...pendingTransaction, simulationMode: false }] })
		commitBeforePendingRead(2, (stored) => ({ ...stored, popupVisualisation: popupVisualisationFromNewerSimulation }))

		await modules.refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService, undefined)

		const [stored] = await modules.getPendingTransactionsAndMessages()
		assert.equal(stored?.type === 'Transaction' && 'popupVisualisation' in stored ? stored.popupVisualisation.data.simulationState.simulationConductedTimestamp.getTime() : undefined, newerSimulationTimestamp.getTime())
		assert.equal(getSentPendingTransactionDialogUpdates().length, 0)
	})
})

// Stores a signing-mode Safe proposal reviewed with nonce 1 while the Safe's next nonce is 0, so accepting it rebases the proposal and asks for a new confirmation.
async function storeSafeProposalNeedingNonceRebase() {
	fakeSafeContract.owners = [safeTestOwnerAddress]
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeSignerAddresses: [safeTestOwnerAddress] })])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [safeTestOwnerAddress],
		activeSigningAddress: safeTestOwnerAddress,
	}))
	const reviewedSafeTx = createSafeTxToRecipient({ nonce: 1n })
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(createSafeTxToRecipient()))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: safeTestOwnerAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [safeTestOwnerAddress], threshold: 2n },
				safeTxHash: BigInt(getSafeTxHash(reviewedSafeTx)),
				safeTx: reviewedSafeTx,
			},
		}],
	})
}

describe('pending request resolution claim', () => {
	test('appends and replies once when a simulated accept is confirmed twice at the same time', async () => {
		const { postedMessages, websiteTabConnections } = connectWebsite()
		const accept = { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } } as const

		await Promise.all([
			modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, accept),
			modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, accept),
		])

		const stack = await modules.getInterceptorTransactionStack()
		assert.equal(stack.operations.filter((operation) => operation.type === 'Transaction').length, 1)
		assert.equal(findWebsiteReplies(postedMessages, { requestId: uniqueRequestIdentifier.requestId }).filter((reply) => 'result' in reply).length, 1)
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	})

	test('forwards a signing accept to the wallet once when it is confirmed repeatedly', async () => {
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{ ...pendingTransaction, simulationMode: false }] })
		const { postedMessages, websiteTabConnections } = connectWebsite()
		const accept = { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } } as const
		const forwardedRequests = () => postedMessages.filter(isForwardedSignerRequest)

		const results = await Promise.all([
			modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, accept),
			modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, accept),
		])
		assert.deepEqual(results, [true, false])
		assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, accept), false)

		assert.equal(forwardedRequests().length, 1)
		const [stored] = await modules.getPendingTransactionsAndMessages()
		assert.equal(stored?.approvalStatus.status, 'WaitingForSigner')
	})

	test('an accept queued behind a Safe nonce rebase does not approve the rebased proposal the user has not reviewed', async () => {
		await storeSafeProposalNeedingNonceRebase()
		const { postedMessages, websiteTabConnections } = connectWebsite()
		const accept = { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } } as const

		// Two accepts of the nonce-1 proposal, like a double click: the first rebases it and asks for a new confirmation, the second must not approve the rebase.
		const results = await Promise.all([
			modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, accept),
			modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, accept),
		])

		assert.deepEqual(results, [false, false])
		assert.equal(hasForwardedSignerRequest(postedMessages), false)
		const [stored] = await modules.getPendingTransactionsAndMessages()
		assert.equal(stored?.type === 'Transaction' ? stored.safeTransaction?.safeTx.message.nonce : undefined, 0n)
	})

	test('an accept whose signer account refresh finishes after a Safe nonce rebase does not approve the rebased proposal', async () => {
		await storeSafeProposalNeedingNonceRebase()
		const servicesOwner = createTestSimulationServicesOwner(simulator)
		const accountRequestsAnswered: Promise<unknown>[] = []
		const firstConfirmationDone = Promise.withResolvers<void>()
		const website = connectWebsite({
			signerStateOwner: createConfirmedSignerStateOwner(uniqueRequestIdentifier.requestSocket, 1, 1),
			onPostMessage: (message) => {
				if (!isPostedMethod(message, 'request_signer_to_eth_accounts')) return
				// The first accept's account refresh is answered at once; the second accept's refresh only after the first accept rebased the proposal.
				const answerAfter = accountRequestsAnswered.length === 0 ? Promise.resolve() : firstConfirmationDone.promise
				accountRequestsAnswered.push(answerAfter.then(async () => await modules.ethAccountsReply(servicesOwner, website.websiteTabConnections, website.port, createEthAccountsReply([safeTestOwnerAddress]), 'hasAccess', activeAddress)))
			},
		})
		const accept = { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } } as const

		// Both accepts are made on the nonce-1 proposal; the second one's account refresh is still running when the first rebases it.
		const first = modules.confirmDialog(servicesOwner, website.websiteTabConnections, accept)
		const second = modules.confirmDialog(servicesOwner, website.websiteTabConnections, accept)
		await first
		firstConfirmationDone.resolve()
		await second
		await Promise.all(accountRequestsAnswered)

		assert.equal(hasForwardedSignerRequest(website.postedMessages), false)
		const [stored] = await modules.getPendingTransactionsAndMessages()
		assert.equal(stored?.type === 'Transaction' ? stored.safeTransaction?.safeTx.message.nonce : undefined, 0n)
	})

	test('forgets the review revision once a refreshed request is rejected', async () => {
		await storeSafeProposalNeedingNonceRebase()
		const { websiteTabConnections } = connectWebsite()

		assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } }), false)
		assert.equal(modules.getReviewRevision(websiteTabConnections, uniqueRequestIdentifier), 1)
		await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'reject', errorString: undefined, uniqueRequestIdentifier } })

		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
		assert.equal(modules.getReviewRevision(websiteTabConnections, uniqueRequestIdentifier), 0)
	})

	test('a Safe nonce refresh keeps a newer simulation stored while it ran', async () => {
		await storeSafeProposalNeedingNonceRebase()
		let simulationReplaced = false
		fakeSafeContract.beforeVersionResponse = async () => {
			if (simulationReplaced) return
			simulationReplaced = true
			await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (stored) => ({ ...stored, popupVisualisation: popupVisualisationFromNewerSimulation }))
		}
		const { postedMessages, websiteTabConnections } = connectWebsite()

		assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
			method: 'popup_confirmDialog',
			data: { action: 'accept', uniqueRequestIdentifier },
		}), false)

		assert.equal(simulationReplaced, true)
		assert.equal(hasForwardedSignerRequest(postedMessages), false)
		const [stored] = await modules.getPendingTransactionsAndMessages()
		assert.equal(stored?.type === 'Transaction' ? stored.safeTransaction?.safeTx.message.nonce : undefined, 0n)
		assert.equal(stored?.type === 'Transaction' && 'popupVisualisation' in stored ? stored.popupVisualisation.data.simulationState.simulationConductedTimestamp.getTime() : undefined, newerSimulationTimestamp.getTime())
	})
})

describe('Safe refresh persistence', () => {
	const reviewedSafeTx = createSafeTxToRecipient()
	const reviewedSafeTransaction = {
		safeAddress: activeAddress,
		safeSignerAddress: safeTestOwnerAddress,
		safeVersion: '1.4.1',
		threshold: 2n,
		safeTxHash: BigInt(getSafeTxHash(reviewedSafeTx)),
		safeTx: reviewedSafeTx,
	}
	const proposal = { ...pendingTransaction, simulationMode: false, safeTransaction: reviewedSafeTransaction }
	const directExecution = {
		...pendingTransaction,
		simulationMode: false,
		safeExecutionOriginalRequestParameters: pendingTransaction.originalRequestParameters,
		safeExecutionSignerAddress: safeTestOwnerAddress,
		safeExecutionReviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [safeTestOwnerAddress], threshold: 1n },
	}

	test('skips a refresh whose Safe request changed after the refresh started', async () => {
		const { applySafeRefreshToStoredPending } = await import('../../app/ts/background/safeSignerSelectionRefresh.js')
		const storedAfterAnotherRefresh = { ...proposal, safeTransaction: { ...reviewedSafeTransaction, safeSignerAddress: recipientAddress } }
		assert.equal(applySafeRefreshToStoredPending(storedAfterAnotherRefresh, proposal, proposal), undefined)
	})

	test('keeps a newer stored simulation unless the refresh re-simulated', async () => {
		const { applySafeRefreshToStoredPending } = await import('../../app/ts/background/safeSignerSelectionRefresh.js')
		const storedWithNewerSimulation = { ...directExecution, popupVisualisation: popupVisualisationFromNewerSimulation }
		const routeRefresh = { ...directExecution, safeExecutionSignerAddress: recipientAddress }
		const keptSimulation = applySafeRefreshToStoredPending(storedWithNewerSimulation, directExecution, routeRefresh)
		assert.equal(keptSimulation?.type === 'Transaction' ? keptSimulation.safeExecutionSignerAddress : undefined, recipientAddress)
		assert.equal(keptSimulation !== undefined && 'popupVisualisation' in keptSimulation ? keptSimulation.popupVisualisation : undefined, popupVisualisationFromNewerSimulation)

		const resimulatedRefresh = { ...routeRefresh, popupVisualisation: { ...popupVisualisationFromNewerSimulation } }
		const replacedSimulation = applySafeRefreshToStoredPending(storedWithNewerSimulation, directExecution, resimulatedRefresh)
		assert.equal(replacedSimulation !== undefined && 'popupVisualisation' in replacedSimulation ? replacedSimulation.popupVisualisation : undefined, resimulatedRefresh.popupVisualisation)
	})
})
