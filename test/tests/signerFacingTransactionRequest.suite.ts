import * as assert from 'assert'
import { test } from 'bun:test'
import { SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import { UpdateConfirmTransactionDialogPendingTransactions } from '../../app/ts/types/interceptor-messages.js'
import { activeAddress, addressString, browserMock, createWebsitePort, fakeBlock, fakeRequestHandler, fakeRpcNetwork, isRecord, modules, pendingTransaction, recipientAddress, simulator, unsignedTransaction, uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'

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

type ChainScenario = {
	readonly chainNonce: bigint
	readonly preparationBaseFeePerGas: bigint
	readonly simulationBaseFeePerGas: bigint
}

// Answers like the shared fake RPC, but reports the sender's on-chain nonce, rejects other nonces like a node would, and changes the base fee after the confirmation was prepared.
function createChainScenarioEthereum(scenario: ChainScenario) {
	let blockRequests = 0
	const requestHandler = {
		rpcUrl: fakeRpcNetwork.httpsRpc,
		clearCache() { return undefined },
		async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
			switch (rpcRequest.method) {
				case 'eth_getBlockByNumber': {
					blockRequests += 1
					const baseFeePerGas = blockRequests === 1 ? scenario.preparationBaseFeePerGas : scenario.simulationBaseFeePerGas
					return modules.serialize(modules.EthereumBlockHeader, { ...fakeBlock, baseFeePerGas })
				}
				case 'eth_getTransactionCount': return modules.serialize(modules.EthereumQuantity, scenario.chainNonce)
				case 'eth_getBalance': return modules.serialize(modules.EthereumQuantity, 10n ** 21n)
				case 'eth_simulateV1': {
					const simulation = modules.EthSimulateV1Result.parse(await fakeRequestHandler.jsonRpcRequest(rpcRequest))
					const blockStateCalls = getBlockStateCalls(rpcRequest.params?.[0])
					return modules.serialize(modules.EthSimulateV1Result, simulation.map((block, blockIndex) => ({
						...block,
						calls: block.calls.map((call, callIndex) => hasWrongSenderNonce(blockStateCalls[blockIndex]?.[callIndex], scenario.chainNonce)
							? { status: 'failure' as const, returnData: new Uint8Array(), gasUsed: 21_000n, error: { code: -32000, message: 'wrong transaction nonce' } }
							: call),
					})))
				}
				default: return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
			}
		},
	}
	return new modules.EthereumClientService(requestHandler, async () => undefined, async () => undefined, fakeRpcNetwork)
}

function getBlockStateCalls(simulationRequest: unknown): readonly (readonly unknown[])[] {
	if (!isRecord(simulationRequest) || !Array.isArray(simulationRequest.blockStateCalls)) return []
	return simulationRequest.blockStateCalls.map((blockStateCall: unknown) => isRecord(blockStateCall) && Array.isArray(blockStateCall.calls) ? blockStateCall.calls : [])
}

function hasWrongSenderNonce(call: unknown, chainNonce: bigint) {
	if (!isRecord(call) || call.nonce === undefined || call.from === undefined) return false
	if (typeof call.from !== 'string' && typeof call.from !== 'bigint') return false
	if (typeof call.nonce !== 'string' && typeof call.nonce !== 'bigint') return false
	return BigInt(call.from) === activeAddress && BigInt(call.nonce) !== chainNonce
}

function getLatestDisplayedTransaction() {
	const popupUpdate = browserMock.sentMessages.findLast((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions')
	const [displayedRequest] = UpdateConfirmTransactionDialogPendingTransactions.parse(popupUpdate).data.pendingTransactionAndSignableMessages
	if (displayedRequest?.type !== 'Transaction' || displayedRequest.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('The popup did not receive a simulated transaction')
	if (displayedRequest.popupVisualisation.statusCode !== 'success') throw new Error('The popup did not receive a successful simulation')
	const displayedTransaction = displayedRequest.popupVisualisation.data.visualizedSimulationState.visualizedBlocks
		.flatMap((block) => block.simulatedAndVisualizedTransactions)
		.find((transaction) => transaction.transactionIdentifier === displayedRequest.transactionIdentifier)?.transaction
	if (displayedTransaction?.type !== '1559') throw new Error('The popup did not display the reviewed EIP-1559 transaction')
	return { displayedTransaction, preparedTransaction: displayedRequest.transactionToSimulate.transaction }
}

const toHex = (value: bigint) => `0x${ value.toString(16) }`

async function prepareSimulateAndAccept(scenario: ChainScenario, requestedNonce: bigint | undefined) {
	await browser.storage.local.set({ simulationMode: false })
	const ethereum = createChainScenarioEthereum(scenario)
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			value: '0x0',
			gas: '0x5208',
			...(requestedNonce === undefined ? {} : { nonce: toHex(requestedNonce) }),
		}],
	})
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const postedMessages: unknown[] = []
	const websiteTabConnections = createApprovedConnections(postedMessages)
	assert.deepEqual(await modules.openConfirmTransactionDialogForTransaction(
		ethereum,
		simulator.tokenPriceService,
		{ interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier, ...transactionParams },
		{ kind: 'transaction', parameters: transactionParams },
		false,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		websiteTabConnections,
	), { type: 'doNotReply' })
	const displayed = getLatestDisplayedTransaction()
	assert.equal(await modules.resolvePendingTransactionOrMessage(ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier, forceSend: false },
	}), true)
	const signerRequest = getForwardedSignerRequest(postedMessages)
	const forwardedTransaction = signerRequest.params[0]
	if (!isRecord(forwardedTransaction)) throw new Error('Missing forwarded transaction parameters')
	assert.equal(signerRequest.method, 'eth_sendTransaction')
	const { displayedTransaction } = displayed
	assert.equal(forwardedTransaction.type, '0x2')
	assert.equal(forwardedTransaction.from, addressString(displayedTransaction.from.address))
	assert.equal(forwardedTransaction.to, displayedTransaction.to === undefined ? undefined : addressString(displayedTransaction.to.address))
	assert.equal(forwardedTransaction.chainId, toHex(displayedTransaction.rpcNetwork.chainId))
	assert.equal(forwardedTransaction.nonce, toHex(displayedTransaction.nonce))
	assert.equal(forwardedTransaction.gas, toHex(displayedTransaction.gas))
	assert.equal(forwardedTransaction.value, toHex(displayedTransaction.value))
	assert.equal(forwardedTransaction.maxFeePerGas, toHex(displayedTransaction.maxFeePerGas))
	assert.equal(forwardedTransaction.maxPriorityFeePerGas, toHex(displayedTransaction.maxPriorityFeePerGas))
	assert.equal(forwardedTransaction.data, '0x')
	assert.equal(displayedTransaction.input.length, 0)
	return displayed
}

test('forwards the displayed transaction after the confirmation simulation repairs the nonce', async () => {
	const { displayedTransaction, preparedTransaction } = await prepareSimulateAndAccept({ chainNonce: 0n, preparationBaseFeePerGas: 1n, simulationBaseFeePerGas: 1n }, 7n)
	assert.equal(preparedTransaction.nonce, 7n)
	assert.equal(displayedTransaction.nonce, 0n)
	const [storedRequest] = await modules.getPendingTransactionsAndMessages()
	assert.equal(storedRequest?.originalRequestParameters.method === 'eth_sendTransaction' ? storedRequest.originalRequestParameters.params[0].nonce : undefined, 7n)
})

test('forwards the displayed fees after the base fee changes between preparation and simulation', async () => {
	const { displayedTransaction, preparedTransaction } = await prepareSimulateAndAccept({ chainNonce: 3n, preparationBaseFeePerGas: 1n, simulationBaseFeePerGas: 100n }, undefined)
	if (preparedTransaction.type !== '1559') throw new Error('Expected an EIP-1559 prepared transaction')
	assert.equal(displayedTransaction.nonce, 3n)
	assert.notEqual(displayedTransaction.maxFeePerGas, preparedTransaction.maxFeePerGas)
	const [storedRequest] = await modules.getPendingTransactionsAndMessages()
	assert.equal(storedRequest?.originalRequestParameters.method === 'eth_sendTransaction' ? storedRequest.originalRequestParameters.params[0].maxFeePerGas : 'missing', undefined)
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
