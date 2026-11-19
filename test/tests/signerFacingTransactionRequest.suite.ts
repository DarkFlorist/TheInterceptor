import * as assert from 'assert'
import { test } from 'bun:test'
import { Signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'
import { createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import { getLatestUnexpectedError } from '../../app/ts/background/storageVariables.js'
import { nanoString } from '../../app/ts/utils/bigint.js'
import { clickRenderedElement, findRenderedElement, installDomMock } from './domMock.js'
import { SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import { TransactionConfirmation, UpdateConfirmTransactionDialogPendingTransactions } from '../../app/ts/types/interceptor-messages.js'
import { activeAddress, addressString, browserMock, createAcceptConfirmation, createWebsitePort, fakeBlock, fakeRequestHandler, fakeRpcNetwork, isRecord, modules, pendingTransaction, recipientAddress, simulator, unsignedTransaction, uniqueRequestIdentifier, withSimulatedTransactionResult } from './confirmTransactionTestHarness.js'

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
	return await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, createApprovedConnections(postedMessages), await createAcceptConfirmation())
}

// Sends the confirmation through the background's popup message routing, where an uncaught refusal would surface as an unexpected error.
async function routePopupConfirmation(ethereum: InstanceType<typeof modules.EthereumClientService>, websiteTabConnections: ReturnType<typeof createApprovedConnections>, data: { action: 'accept', forceSend: boolean } | { action: 'reject', errorString: undefined }) {
	const { popupMessageHandler } = await import('../../app/ts/background/popupMessageRouting.js')
	const { getSettings } = await import('../../app/ts/background/settings.js')
	const simulationServicesOwner = createTestSimulationServicesOwner({ ethereum, tokenPriceService: simulator.tokenPriceService })
	const confirmation = data.action === 'accept' ? (await createAcceptConfirmation(uniqueRequestIdentifier, data.forceSend)).data : { ...data, uniqueRequestIdentifier }
	const request = TransactionConfirmation.serialize({ method: 'popup_confirmDialog', data: confirmation })
	return await popupMessageHandler(websiteTabConnections, simulationServicesOwner, request, await getSettings(), () => undefined)
}

async function assertAcceptanceRefusedWithoutAcknowledgement(ethereum: InstanceType<typeof modules.EthereumClientService>, websiteTabConnections: ReturnType<typeof createApprovedConnections>, postedMessages: readonly unknown[]) {
	assert.equal(await routePopupConfirmation(ethereum, websiteTabConnections, { action: 'accept', forceSend: false }), undefined)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [pendingRequest] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingRequest?.approvalStatus.status, 'WaitingForUser')
	assert.equal(await getLatestUnexpectedError(), undefined)
}

function getForwardedSignerRequest(postedMessages: readonly unknown[]) {
	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing forwarded signer request')
	return { method: signerRequest.method, params: signerRequest.params }
}

type ChainScenario = {
	readonly chainNonce: bigint
	readonly pendingNonce?: bigint
	readonly preparationBaseFeePerGas: bigint
	readonly simulationBaseFeePerGas: bigint
	readonly failConfirmationSimulation?: boolean
	readonly revertSenderCalls?: boolean
	readonly networkGasPrice?: bigint
}

// Answers like the shared fake RPC, but reports the sender's latest and pending nonces, rejects nonces other than the latest one like a node would, and changes the base fee after the confirmation was prepared.
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
				case 'eth_getTransactionCount': return modules.serialize(modules.EthereumQuantity, rpcRequest.params?.[1] === 'pending' ? scenario.pendingNonce ?? scenario.chainNonce : scenario.chainNonce)
				case 'eth_getBalance': return modules.serialize(modules.EthereumQuantity, 10n ** 21n)
				case 'eth_estimateGas': return modules.serialize(modules.EthereumQuantity, 21_000n)
				case 'eth_gasPrice': return scenario.networkGasPrice === undefined ? await fakeRequestHandler.jsonRpcRequest(rpcRequest) : modules.serialize(modules.EthereumQuantity, scenario.networkGasPrice)
				case 'eth_simulateV1': {
					if (scenario.failConfirmationSimulation === true) throw new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'eth_simulateV1 is unavailable' } })
					const simulation = modules.EthSimulateV1Result.parse(await fakeRequestHandler.jsonRpcRequest(rpcRequest))
					const blockStateCalls = getBlockStateCalls(rpcRequest.params?.[0])
					return modules.serialize(modules.EthSimulateV1Result, simulation.map((block, blockIndex) => ({
						...block,
						calls: block.calls.map((call, callIndex) => (scenario.revertSenderCalls === true && isSenderCall(blockStateCalls[blockIndex]?.[callIndex])) || hasWrongSenderNonce(blockStateCalls[blockIndex]?.[callIndex], scenario.chainNonce)
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

function isSenderCall(call: unknown) {
	if (!isRecord(call) || (typeof call.from !== 'string' && typeof call.from !== 'bigint')) return false
	return BigInt(call.from) === activeAddress
}

function hasWrongSenderNonce(call: unknown, chainNonce: bigint) {
	if (!isRecord(call) || call.nonce === undefined || call.from === undefined) return false
	if (typeof call.from !== 'string' && typeof call.from !== 'bigint') return false
	if (typeof call.nonce !== 'string' && typeof call.nonce !== 'bigint') return false
	return BigInt(call.from) === activeAddress && BigInt(call.nonce) !== chainNonce
}

async function getLatestDisplayedTransaction() {
	const { getSignerNonce } = await import('../../app/ts/utils/signerFacingTransactionRequest.js')
	const { getNonceDisplayText } = await import('../../app/ts/components/simulationExplaining/SimulationSummary.js')
	const { getSafeTransactionPendingFlow } = await import('../../app/ts/safe/safePendingFlow.js')
	const popupUpdate = browserMock.sentMessages.findLast((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions')
	const [displayedRequest] = UpdateConfirmTransactionDialogPendingTransactions.parse(popupUpdate).data.pendingTransactionAndSignableMessages
	if (displayedRequest?.type !== 'Transaction' || displayedRequest.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('The popup did not receive a simulated transaction')
	if (displayedRequest.popupVisualisation.statusCode !== 'success') throw new Error('The popup did not receive a successful simulation')
	const displayedTransaction = displayedRequest.popupVisualisation.data.visualizedSimulationState.visualizedBlocks
		.flatMap((block) => block.simulatedAndVisualizedTransactions)
		.find((transaction) => transaction.transactionIdentifier === displayedRequest.transactionIdentifier)?.transaction
	if (displayedTransaction?.type !== '1559') throw new Error('The popup did not display the reviewed EIP-1559 transaction')
	// The same helpers the raw-transaction card uses to render the nonce row.
	const displayedNonceText = getNonceDisplayText(displayedTransaction.nonce, getSignerNonce(displayedRequest, getSafeTransactionPendingFlow(displayedRequest)?.kind))
	return { displayedTransaction, displayedNonceText, preparedTransaction: displayedRequest.transactionToSimulate.transaction }
}

const toHex = (value: bigint) => `0x${ value.toString(16) }`

async function prepareSimulateAndAccept(ethereum: ReturnType<typeof createChainScenarioEthereum>, requestIdentifier: typeof uniqueRequestIdentifier, requestedNonce: bigint | undefined) {
	await browser.storage.local.set({ simulationMode: false })
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
	const postedMessages: unknown[] = []
	const websiteTabConnections = createApprovedConnections(postedMessages)
	assert.deepEqual(await modules.openConfirmTransactionDialogForTransaction(
		ethereum,
		simulator.tokenPriceService,
		{ interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: requestIdentifier, ...transactionParams },
		{ kind: 'transaction', parameters: transactionParams },
		false,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		websiteTabConnections,
	), { type: 'doNotReply' })
	const { displayedTransaction, displayedNonceText, preparedTransaction } = await getLatestDisplayedTransaction()
	assert.equal(await modules.resolvePendingTransactionOrMessage(ethereum, simulator.tokenPriceService, websiteTabConnections, await createAcceptConfirmation(requestIdentifier)), true)
	const signerRequest = getForwardedSignerRequest(postedMessages)
	const forwardedTransaction = signerRequest.params[0]
	if (!isRecord(forwardedTransaction)) throw new Error('Missing forwarded transaction parameters')
	assert.equal(signerRequest.method, 'eth_sendTransaction')
	assert.equal(forwardedTransaction.type, '0x2')
	assert.equal(forwardedTransaction.from, addressString(displayedTransaction.from.address))
	assert.equal(forwardedTransaction.to, displayedTransaction.to === undefined ? undefined : addressString(displayedTransaction.to.address))
	assert.equal(forwardedTransaction.chainId, toHex(displayedTransaction.rpcNetwork.chainId))
	assert.equal(forwardedTransaction.gas, toHex(displayedTransaction.gas))
	assert.equal(forwardedTransaction.value, toHex(displayedTransaction.value))
	assert.equal(forwardedTransaction.maxFeePerGas, toHex(displayedTransaction.maxFeePerGas))
	assert.equal(forwardedTransaction.maxPriorityFeePerGas, toHex(displayedTransaction.maxPriorityFeePerGas))
	assert.deepEqual(forwardedTransaction.accessList, [])
	assert.equal(forwardedTransaction.data, '0x')
	assert.equal(displayedTransaction.input.length, 0)
	if (requestedNonce === undefined) {
		// An omitted nonce stays wallet-selected so the wallet can account for its own pending transactions.
		assert.equal('nonce' in forwardedTransaction, false)
		assert.equal(displayedNonceText, `${ displayedTransaction.nonce.toString(10) } (estimate, your wallet picks the final nonce)`)
	} else {
		// A requested nonce is forwarded unchanged, and the popup shows that nonce first.
		assert.equal(forwardedTransaction.nonce, toHex(requestedNonce))
		assert.equal(displayedNonceText.split(' ')[0], requestedNonce.toString(10))
	}
	return { displayedTransaction, displayedNonceText, preparedTransaction, websiteTabConnections }
}

test('forwards a requested future nonce unchanged instead of the simulation-repaired latest nonce', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const ethereum = createChainScenarioEthereum({ chainNonce: 5n, pendingNonce: 6n, preparationBaseFeePerGas: 1n, simulationBaseFeePerGas: 1n })
	const { displayedTransaction, displayedNonceText, preparedTransaction } = await prepareSimulateAndAccept(ethereum, uniqueRequestIdentifier, 6n)
	assert.equal(preparedTransaction.nonce, 6n)
	// The preview repaired the nonce to the latest one, which a pending wallet transaction already uses.
	assert.equal(displayedTransaction.nonce, 5n)
	assert.equal(displayedNonceText, '6 (simulated with nonce 5)')
})

test('forwards an already-mined requested nonce unchanged so a retried transfer cannot execute twice', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const ethereum = createChainScenarioEthereum({ chainNonce: 5n, preparationBaseFeePerGas: 1n, simulationBaseFeePerGas: 1n })
	const { displayedTransaction, displayedNonceText } = await prepareSimulateAndAccept(ethereum, uniqueRequestIdentifier, 3n)
	assert.equal(displayedTransaction.nonce, 5n)
	assert.equal(displayedNonceText, '3 (simulated with nonce 5)')
	const [storedRequest] = await modules.getPendingTransactionsAndMessages()
	assert.equal(storedRequest?.originalRequestParameters.method === 'eth_sendTransaction' ? storedRequest.originalRequestParameters.params[0].nonce : undefined, 3n)
})

test('forwards the displayed fees after the base fee changes between preparation and simulation', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const ethereum = createChainScenarioEthereum({ chainNonce: 3n, preparationBaseFeePerGas: 1n, simulationBaseFeePerGas: 100n })
	const { displayedTransaction, preparedTransaction } = await prepareSimulateAndAccept(ethereum, uniqueRequestIdentifier, undefined)
	if (preparedTransaction.type !== '1559') throw new Error('Expected an EIP-1559 prepared transaction')
	assert.equal(displayedTransaction.nonce, 3n)
	assert.notEqual(displayedTransaction.maxFeePerGas, preparedTransaction.maxFeePerGas)
	const [storedRequest] = await modules.getPendingTransactionsAndMessages()
	assert.equal(storedRequest?.originalRequestParameters.method === 'eth_sendTransaction' ? storedRequest.originalRequestParameters.params[0].maxFeePerGas : 'missing', undefined)
})

test('does not force the latest nonce over a pending wallet transaction when the website omitted the nonce', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const ethereum = createChainScenarioEthereum({ chainNonce: 5n, pendingNonce: 6n, preparationBaseFeePerGas: 1n, simulationBaseFeePerGas: 1n })
	const { displayedTransaction } = await prepareSimulateAndAccept(ethereum, uniqueRequestIdentifier, undefined)
	// The simulation only sees the latest block, so the displayed nonce is the one a pending wallet transaction already uses.
	assert.equal(displayedTransaction.nonce, 5n)
})

test('leaves nonce selection to the wallet for two sends accepted before either is mined', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const ethereum = createChainScenarioEthereum({ chainNonce: 5n, preparationBaseFeePerGas: 1n, simulationBaseFeePerGas: 1n })
	const firstRequestIdentifier = { ...uniqueRequestIdentifier, requestId: 21 }
	const secondRequestIdentifier = { ...uniqueRequestIdentifier, requestId: 22 }
	const firstSend = await prepareSimulateAndAccept(ethereum, firstRequestIdentifier, undefined)
	assert.equal(await modules.resolvePendingTransactionOrMessage(ethereum, simulator.tokenPriceService, firstSend.websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: `0x${ '12'.repeat(32) }`, uniqueRequestIdentifier: firstRequestIdentifier },
	}), true)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	const secondSend = await prepareSimulateAndAccept(ethereum, secondRequestIdentifier, undefined)
	// Both previews estimate the same latest nonce; forwarding it would make the second send replace the first.
	assert.equal(firstSend.displayedTransaction.nonce, 5n)
	assert.equal(secondSend.displayedTransaction.nonce, 5n)
})

test('the simulated transaction guard compares access lists and EIP-7702 authorizations but ignores placeholder signatures', () => {
	const authorization = { chainId: 1n, address: recipientAddress, nonce: 4n }
	const prepared = { ...unsignedTransaction, type: '7702' as const, accessList: [{ address: recipientAddress, storageKeys: [1n] }], authorizationList: [authorization] }
	const simulated = { ...prepared, r: 0n, s: 0n, yParity: 'even' as const, hash: 1n, authorizationList: [{ ...authorization, r: 0n, s: 0n, yParity: 'even' as const }] }
	modules.assertSimulatedTransactionMatchesPrepared(prepared, simulated)
	modules.assertSimulatedTransactionMatchesPrepared(prepared, { ...simulated, nonce: 9n, maxFeePerGas: 9n, maxPriorityFeePerGas: 9n })
	const mismatches = [
		{ ...simulated, accessList: [{ address: recipientAddress, storageKeys: [2n] }] },
		{ ...simulated, accessList: [] },
		{ ...simulated, authorizationList: [{ ...authorization, address: activeAddress, r: 0n, s: 0n, yParity: 'even' as const }] },
		{ ...simulated, authorizationList: [{ ...authorization, nonce: 5n, r: 0n, s: 0n, yParity: 'even' as const }] },
		{ ...simulated, authorizationList: [] },
		{ ...simulated, gas: unsignedTransaction.gas + 1n },
		{ ...simulated, input: new Uint8Array([1]) },
	]
	for (const mismatch of mismatches) {
		assert.throws(() => modules.assertSimulatedTransactionMatchesPrepared(prepared, mismatch), /does not match the prepared transaction/u)
	}
})

test('a background-only override after a failed confirmation simulation is refused, because no reviewed result exists to forward', async () => {
	await browser.storage.local.set({ simulationMode: false })
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const ethereum = createChainScenarioEthereum({ chainNonce: 5n, pendingNonce: 6n, preparationBaseFeePerGas: 1n, simulationBaseFeePerGas: 1n, failConfirmationSimulation: true })
	const { postedMessages, websiteTabConnections } = await openSigningModeTransaction(ethereum, { nonce: toHex(6n) })
	const [pendingRequest] = await modules.getPendingTransactionsAndMessages()
	if (pendingRequest?.type !== 'Transaction' || pendingRequest.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected a prepared transaction')
	if (pendingRequest.popupVisualisation.statusCode !== 'failed') throw new Error('Expected the confirmation simulation to fail')
	// The failure view offers only rejection, and a stale or non-popup accept carrying the send-anyway override is refused as well.
	assert.equal(await routePopupConfirmation(ethereum, websiteTabConnections, { action: 'accept', forceSend: true }), undefined)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [refusedRequest] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refusedRequest?.approvalStatus.status, 'WaitingForUser')
	assert.equal(await getLatestUnexpectedError(), undefined)
})

test('a refused acceptance after a failed confirmation simulation leaves the request rejectable without an unexpected error', async () => {
	await browser.storage.local.set({ simulationMode: false })
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const ethereum = createChainScenarioEthereum({ chainNonce: 0n, preparationBaseFeePerGas: 1n, simulationBaseFeePerGas: 1n, failConfirmationSimulation: true })
	const { postedMessages, websiteTabConnections } = await openSigningModeTransaction(ethereum, {})
	await assertAcceptanceRefusedWithoutAcknowledgement(ethereum, websiteTabConnections, postedMessages)
	assert.equal(await routePopupConfirmation(ethereum, websiteTabConnections, { action: 'reject', errorString: undefined }), undefined)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	const websiteReply = postedMessages.find((message) => isRecord(message) && message.method === 'eth_sendTransaction' && message.requestId === uniqueRequestIdentifier.requestId)
	assert.equal(isRecord(websiteReply) && isRecord(websiteReply.error) ? websiteReply.error.code : undefined, 4001)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	assert.equal(await getLatestUnexpectedError(), undefined)
})

async function openSigningModeTransaction(ethereum: ReturnType<typeof createChainScenarioEthereum>, requestFields: Record<string, unknown>) {
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{ from: addressString(activeAddress), to: addressString(recipientAddress), value: '0x0', gas: '0x5208', ...requestFields }],
	})
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
	return { postedMessages, websiteTabConnections }
}

// The simulation succeeds, but the popup only enables Confirm after its override checkbox, so the background requires the same acknowledgement before forwarding.
async function assertSimulatedTransactionNeedsAcknowledgement(scenario: ChainScenario, requestFields: Record<string, unknown>, expectedResult: (result: { readonly transactionStatus: string, readonly quarantine: boolean }) => boolean) {
	const { getResultsForTransaction } = await import('../../app/ts/utils/visualizedTransactionResult.js')
	await browser.storage.local.set({ simulationMode: false })
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const ethereum = createChainScenarioEthereum(scenario)
	const { postedMessages, websiteTabConnections } = await openSigningModeTransaction(ethereum, requestFields)
	const [pendingRequest] = await modules.getPendingTransactionsAndMessages()
	if (pendingRequest?.type !== 'Transaction' || pendingRequest.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected a simulated transaction')
	if (pendingRequest.popupVisualisation.statusCode !== 'success') throw new Error('Expected a successful confirmation simulation')
	const result = getResultsForTransaction(pendingRequest.popupVisualisation.data.visualizedSimulationState, pendingRequest.transactionIdentifier)
	if (result === undefined) throw new Error('Missing simulated transaction result')
	assert.equal(expectedResult(result), true)
	await assertAcceptanceRefusedWithoutAcknowledgement(ethereum, websiteTabConnections, postedMessages)
	assert.equal(await routePopupConfirmation(ethereum, websiteTabConnections, { action: 'accept', forceSend: true }), undefined)
	assert.equal(getForwardedSignerRequest(postedMessages).method, 'eth_sendTransaction')
	assert.equal(await getLatestUnexpectedError(), undefined)
}

test('a reverting transaction from a successful simulation is forwarded only with the override acknowledgement', async () => {
	await assertSimulatedTransactionNeedsAcknowledgement(
		{ chainNonce: 0n, preparationBaseFeePerGas: 1n, simulationBaseFeePerGas: 1n, revertSenderCalls: true },
		{},
		(result) => result.transactionStatus === 'Transaction Failed',
	)
})

test('a quarantined transaction from a successful simulation is forwarded only with the override acknowledgement', async () => {
	// The fee protector quarantines a legacy gas price of ten times the network gas price or more, and the simulated base fee pushes the reviewed gas price far above it.
	await assertSimulatedTransactionNeedsAcknowledgement(
		{ chainNonce: 0n, preparationBaseFeePerGas: 1n, simulationBaseFeePerGas: 100n },
		{ type: '0x0' },
		(result) => result.transactionStatus === 'Transaction Succeeded' && result.quarantine,
	)
})

async function prepareAcceptAndRenderFeeFields(requestFields: Record<string, unknown>) {
	const { getSignerNonce } = await import('../../app/ts/utils/signerFacingTransactionRequest.js')
	const { RawTransactionDetailsCard } = await import('../../app/ts/components/simulationExplaining/SimulationSummary.js')
	const { getSafeTransactionPendingFlow } = await import('../../app/ts/safe/safePendingFlow.js')
	await browser.storage.local.set({ simulationMode: false })
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	// A realistic network gas price keeps the fee protector from quarantining the legacy and EIP-2930 cases, which would require the override acknowledgement.
	const ethereum = createChainScenarioEthereum({ chainNonce: 0n, preparationBaseFeePerGas: 1n, simulationBaseFeePerGas: 100n, networkGasPrice: 10n ** 9n })
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{ from: addressString(activeAddress), to: addressString(recipientAddress), value: '0x0', gas: '0x5208', ...requestFields }],
	})
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
	const popupUpdate = browserMock.sentMessages.findLast((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions')
	const [displayedRequest] = UpdateConfirmTransactionDialogPendingTransactions.parse(popupUpdate).data.pendingTransactionAndSignableMessages
	if (displayedRequest?.type !== 'Transaction' || displayedRequest.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('The popup did not receive a simulated transaction')
	if (displayedRequest.popupVisualisation.statusCode !== 'success') throw new Error('The popup did not receive a successful simulation')
	const simTx = displayedRequest.popupVisualisation.data.visualizedSimulationState.visualizedBlocks
		.flatMap((block) => block.simulatedAndVisualizedTransactions)
		.find((transaction) => transaction.transactionIdentifier === displayedRequest.transactionIdentifier)
	if (simTx === undefined) throw new Error('The popup did not display the reviewed transaction')
	const dom = installDomMock()
	let renderedText = ''
	try {
		await act(() => {
			render(h(RawTransactionDetailsCard, {
				isRawTransaction: false,
				transaction: simTx.transaction,
				renameAddressCallBack: () => undefined,
				gasSpent: undefined,
				parsedInputData: simTx.parsedInputData,
				addressMetaData: new Signal([]),
				transactionIdentifier: simTx.transactionIdentifier,
				signerNonce: getSignerNonce(displayedRequest, getSafeTransactionPendingFlow(displayedRequest)?.kind),
			}), dom.document.body)
		})
		const cardHeader = findRenderedElement(dom.document.body, (node) => node.tagName === 'HEADER' && node.textContent?.includes('Raw transaction information') === true)
		if (cardHeader === undefined) throw new Error('Missing raw transaction card header')
		await act(async () => { await clickRenderedElement(cardHeader) })
		renderedText = dom.document.body.textContent ?? ''
	} finally {
		await act(() => { render(null, dom.document.body) })
		dom.restore()
	}
	assert.equal(await modules.resolvePendingTransactionOrMessage(ethereum, simulator.tokenPriceService, websiteTabConnections, await createAcceptConfirmation()), true)
	const forwardedTransaction = getForwardedSignerRequest(postedMessages).params[0]
	if (!isRecord(forwardedTransaction)) throw new Error('Missing forwarded transaction parameters')
	return { renderedText, forwardedTransaction }
}

const toNanoethPerGasText = (forwardedValue: unknown) => {
	if (typeof forwardedValue !== 'string') throw new Error('Missing forwarded fee field')
	return `${ nanoString(BigInt(forwardedValue)) } nanoeth/gas`
}

const feeFieldCases = [
	{ name: 'legacy', requestFields: { type: '0x0' }, forwardedType: '0x0' },
	{ name: 'EIP-2930', requestFields: { type: '0x1', accessList: [] }, forwardedType: '0x1' },
	{ name: 'EIP-1559', requestFields: {}, forwardedType: '0x2' },
	{ name: 'EIP-7702', requestFields: { type: '0x4', authorizationList: [{ chainId: toHex(fakeRpcNetwork.chainId), address: addressString(recipientAddress), nonce: '0x1' }] }, forwardedType: '0x4' },
]

for (const feeFieldCase of feeFieldCases) {
	test(`the expanded ${ feeFieldCase.name } confirmation details show every fee field forwarded to the wallet`, async () => {
		const { renderedText, forwardedTransaction } = await prepareAcceptAndRenderFeeFields(feeFieldCase.requestFields)
		assert.equal(forwardedTransaction.type, feeFieldCase.forwardedType)
		if (forwardedTransaction.gasPrice !== undefined) {
			assert.equal(renderedText.includes(`Gas Price${ toNanoethPerGasText(forwardedTransaction.gasPrice) }`), true, renderedText)
			assert.equal(renderedText.includes('Max Fee Per Gas'), false)
		} else {
			assert.equal(renderedText.includes(`Max Fee Per Gas${ toNanoethPerGasText(forwardedTransaction.maxFeePerGas) }`), true, renderedText)
			assert.equal(renderedText.includes(`Max Priority Fee Per Gas${ toNanoethPerGasText(forwardedTransaction.maxPriorityFeePerGas) }`), true, renderedText)
		}
	})
}

for (const nullPlaceholderCase of [{ name: 'a legacy', type: '0x0' }, { name: 'an EIP-2930', type: '0x1' }]) {
	test(`${ nullPlaceholderCase.name } request with null dynamic fee placeholders is prepared and forwarded with its gas price`, async () => {
		const { renderedText, forwardedTransaction } = await prepareAcceptAndRenderFeeFields({ type: nullPlaceholderCase.type, maxFeePerGas: null, maxPriorityFeePerGas: null })
		assert.equal(forwardedTransaction.type, nullPlaceholderCase.type)
		assert.equal('maxFeePerGas' in forwardedTransaction, false)
		assert.equal('maxPriorityFeePerGas' in forwardedTransaction, false)
		assert.equal(renderedText.includes(`Gas Price${ toNanoethPerGasText(forwardedTransaction.gasPrice) }`), true, renderedText)
	})
}

test('a legacy request with a real dynamic fee value is still rejected', async () => {
	await assert.rejects(modules.formEthSendTransaction(
		simulator.ethereum,
		undefined,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		SendTransactionParams.parse({
			method: 'eth_sendTransaction',
			params: [{ type: '0x0', from: addressString(activeAddress), to: addressString(recipientAddress), gas: '0x5208', maxFeePerGas: '0x2', maxPriorityFeePerGas: null }],
		}),
		new Date('2024-01-01T00:00:00.000Z'),
		1n,
		false,
	), /Legacy transactions cannot include dynamic fee fields/u)
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
	// A located successful result, so the accept is for a reviewable request.
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [withSimulatedTransactionResult({
		...pendingTransaction,
		simulationMode: false,
		originalRequestParameters: rawTransactionParameters,
		transactionToSimulate: {
			...pendingTransaction.transactionToSimulate,
			originalRequestParameters: rawTransactionParameters,
			transaction: { ...unsignedTransaction, from: recipientAddress },
		},
	})] })
	const postedMessages: unknown[] = []

	assert.equal(await acceptPendingRequest(postedMessages), true)

	const signerRequest = getForwardedSignerRequest(postedMessages)
	assert.equal(signerRequest.method, 'eth_sendRawTransaction')
	assert.deepEqual(signerRequest.params, ['0x0201'])
})

test('still refuses a reviewed wallet-signed transaction whose sender is not the authorized account, without an unexpected error', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [withSimulatedTransactionResult({
		...pendingTransaction,
		simulationMode: false,
		transactionToSimulate: { ...pendingTransaction.transactionToSimulate, transaction: { ...unsignedTransaction, from: recipientAddress } },
	})] })
	const postedMessages: unknown[] = []

	assert.equal(await routePopupConfirmation(simulator.ethereum, createApprovedConnections(postedMessages), { action: 'accept', forceSend: true }), undefined)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [pendingRequest] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingRequest?.approvalStatus.status, 'SignerError')
	assert.match(pendingRequest?.approvalStatus.status === 'SignerError' ? pendingRequest.approvalStatus.message : '', /reviewed transaction sender is not the active authorized account/u)
	assert.equal(await getLatestUnexpectedError(), undefined)
})
