import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { PendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import { activeAddress, connectWebsite, createSafeAddressBookEntry, createSafeTxToRecipient, fakeSafeContract, findWebsiteReplies, getSafeTxHash, getSentPendingTransactionDialogUpdates, hasForwardedSignerRequest, interceptStorageGet, isForwardedSignerRequest, modules, pendingTransaction, popupVisualisation, recipientAddress, safeTestOwnerAddress, simulator, uniqueRequestIdentifier, type StorageKeys } from './confirmTransactionTestHarness.js'
import { requireDefined } from '../harness/assertions.js'

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

	test('a Safe nonce refresh keeps a newer simulation stored while it ran', async () => {
		fakeSafeContract.owners = [safeTestOwnerAddress]
		await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeSignerAddresses: [safeTestOwnerAddress] })])
		await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
			...state,
			signerAccounts: [safeTestOwnerAddress],
			activeSigningAddress: safeTestOwnerAddress,
		}))
		// The Safe's next nonce is 0, so accepting a proposal reviewed with nonce 1 rebases it.
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
