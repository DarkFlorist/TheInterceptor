import * as assert from 'assert'
import { test } from 'bun:test'
import { activeAddress, addressString, createWebsitePort, isRecord, modules, pendingTransaction, recipientAddress, simulator, unsignedTransaction, uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'

const websiteOnlyRequestParameters = {
	method: 'eth_sendTransaction' as const,
	params: [{ from: activeAddress, to: recipientAddress, value: 0n, gas: 21_000n }],
}

function createApprovedConnections(postedMessages: unknown[]) {
	const socket = uniqueRequestIdentifier.requestSocket
	return new Map([[socket.tabId, { connections: {
		[modules.websiteSocketToString(socket)]: {
			port: createWebsitePort(socket, 0, postedMessages),
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			approvedAddress: activeAddress,
			wantsToConnect: true,
		},
	} }]])
}

async function acceptPendingRequest(postedMessages: unknown[]) {
	return await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, createApprovedConnections(postedMessages), {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier, forceSend: false },
	})
}

function getForwardedSignerRequest(postedMessages: readonly unknown[]) {
	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing forwarded signer request')
	return { method: signerRequest.method, params: signerRequest.params }
}

test('forwards the reviewed transaction to the wallet while keeping the website inputs for refreshes', async () => {
	const reviewedTransaction = { ...unsignedTransaction, nonce: 7n, maxFeePerGas: 5n, maxPriorityFeePerGas: 2n }
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{
		...pendingTransaction,
		simulationMode: false,
		originalRequestParameters: websiteOnlyRequestParameters,
		transactionToSimulate: { ...pendingTransaction.transactionToSimulate, originalRequestParameters: websiteOnlyRequestParameters, transaction: reviewedTransaction },
	}] })
	const postedMessages: unknown[] = []

	assert.equal(await acceptPendingRequest(postedMessages), true)

	const signerRequest = getForwardedSignerRequest(postedMessages)
	const signerTransaction = signerRequest.params[0]
	if (!isRecord(signerTransaction)) throw new Error('Missing forwarded transaction parameters')
	assert.equal(signerRequest.method, 'eth_sendTransaction')
	assert.equal(signerTransaction.from, addressString(activeAddress))
	assert.equal(signerTransaction.nonce, '0x7')
	assert.equal(signerTransaction.maxFeePerGas, '0x5')
	assert.equal(signerTransaction.maxPriorityFeePerGas, '0x2')
	assert.equal(signerTransaction.gas, '0x5208')
	assert.equal(signerTransaction.chainId, '0x539')
	const [storedRequest] = await modules.getPendingTransactionsAndMessages()
	assert.deepEqual(storedRequest?.originalRequestParameters, websiteOnlyRequestParameters)
})

test('refreshing a signer-mode confirmation regenerates the nonce the website did not specify', async () => {
	const staleTransaction = { ...unsignedTransaction, nonce: 7n }
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{
		...pendingTransaction,
		simulationMode: false,
		originalRequestParameters: websiteOnlyRequestParameters,
		transactionToSimulate: { ...pendingTransaction.transactionToSimulate, originalRequestParameters: websiteOnlyRequestParameters, transaction: staleTransaction },
	}] })

	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)

	const [refreshedRequest] = await modules.getPendingTransactionsAndMessages()
	if (refreshedRequest?.type !== 'Transaction' || refreshedRequest.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Missing refreshed pending transaction')
	// The fake RPC reports a transaction count of zero, so the regenerated nonce must replace the stale reviewed one.
	assert.equal(refreshedRequest.transactionToSimulate.transaction.nonce, 0n)
	assert.deepEqual(refreshedRequest.originalRequestParameters, websiteOnlyRequestParameters)
	assert.deepEqual(refreshedRequest.transactionToSimulate.originalRequestParameters, websiteOnlyRequestParameters)
})

test('forwards a pre-signed raw transaction from another sender without requiring wallet authorization for that sender', async () => {
	const rawTransactionParameters = { method: 'eth_sendRawTransaction' as const, params: [new Uint8Array([0x02, 0x01])] as const }
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{
		...pendingTransaction,
		simulationMode: false,
		originalRequestParameters: rawTransactionParameters,
		transactionToSimulate: {
			...pendingTransaction.transactionToSimulate,
			originalRequestParameters: rawTransactionParameters,
			transaction: { ...unsignedTransaction, from: recipientAddress },
		},
	}] })
	const postedMessages: unknown[] = []

	assert.equal(await acceptPendingRequest(postedMessages), true)

	const signerRequest = getForwardedSignerRequest(postedMessages)
	assert.equal(signerRequest.method, 'eth_sendRawTransaction')
	assert.deepEqual(signerRequest.params, ['0x0201'])
})

test('still rejects a reviewed wallet-signed transaction whose sender is not the authorized account', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{
		...pendingTransaction,
		simulationMode: false,
		transactionToSimulate: { ...pendingTransaction.transactionToSimulate, transaction: { ...unsignedTransaction, from: recipientAddress } },
	}] })
	const postedMessages: unknown[] = []

	await assert.rejects(acceptPendingRequest(postedMessages), /reviewed transaction sender is not the active authorized account/u)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
})
