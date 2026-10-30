import * as assert from 'assert'
import { test } from 'bun:test'
import { Signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'
import { nanoString } from '../../app/ts/utils/bigint.js'
import { clickRenderedElement, findRenderedElement, installDomMock } from './domMock.js'
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
	readonly pendingNonce?: bigint
	readonly preparationBaseFeePerGas: bigint
	readonly simulationBaseFeePerGas: bigint
	readonly failConfirmationSimulation?: boolean
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
				case 'eth_simulateV1': {
					if (scenario.failConfirmationSimulation === true) throw new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'eth_simulateV1 is unavailable' } })
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

async function getLatestDisplayedTransaction() {
	const { getSignerNonce } = await import('../../app/ts/components/pages/ConfirmTransaction.js')
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
	const displayedNonceText = getNonceDisplayText(displayedTransaction.nonce, getSignerNonce(displayedRequest, getSafeTransactionPendingFlow(displayedRequest)))
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
	assert.equal(await modules.resolvePendingTransactionOrMessage(ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier: requestIdentifier, forceSend: false },
	}), true)
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

async function renderFailedSimulationView(renderInSimulationMode = false) {
	const { FailedTransactionPreviewDetails, isFailedRequestForwardedToWallet } = await import('../../app/ts/components/pages/ConfirmTransaction.js')
	const { getSafeTransactionPendingFlow } = await import('../../app/ts/safe/safePendingFlow.js')
	const popupUpdate = browserMock.sentMessages.findLast((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions')
	const [displayedRequest] = UpdateConfirmTransactionDialogPendingTransactions.parse(popupUpdate).data.pendingTransactionAndSignableMessages
	if (displayedRequest?.type !== 'Transaction' || displayedRequest.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('The popup did not receive a prepared transaction')
	// Preparation succeeded, so the request stays acceptable with the override, but the popup can only show its failure view.
	if (displayedRequest.popupVisualisation.statusCode !== 'failed') throw new Error('Expected the confirmation simulation to fail')
	const renderedRequest = renderInSimulationMode ? { ...displayedRequest, simulationMode: true } : displayedRequest
	const dom = installDomMock()
	try {
		await act(() => {
			render(h(FailedTransactionPreviewDetails, {
				website: displayedRequest.website,
				forwardsRequestToWallet: isFailedRequestForwardedToWallet(renderedRequest, getSafeTransactionPendingFlow(renderedRequest)),
				transactionIdentifier: displayedRequest.transactionIdentifier,
				originalRequestParameters: displayedRequest.originalRequestParameters,
				addressMetaData: [],
				created: displayedRequest.created,
				errorMessage: displayedRequest.popupVisualisation.data.error.decodedErrorMessage,
				isGasEstimationError: false,
				simulationBlockNumber: displayedRequest.popupVisualisation.data.simulationState.blockNumber,
				simulationConductedTimestamp: displayedRequest.popupVisualisation.data.simulationState.simulationConductedTimestamp,
				rpcConnectionStatus: new Signal(undefined),
				currentBlockNumber: new Signal(undefined),
				renameAddressCallBack: () => undefined,
			}), dom.document.body)
		})
		return dom.document.body.textContent ?? ''
	} finally {
		await act(() => { render(null, dom.document.body) })
		dom.restore()
	}
}

async function prepareFailSimulationAndOverride(requestedNonce: bigint | undefined) {
	await browser.storage.local.set({ simulationMode: false })
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const ethereum = createChainScenarioEthereum({ chainNonce: 5n, pendingNonce: 6n, preparationBaseFeePerGas: 1n, simulationBaseFeePerGas: 1n, failConfirmationSimulation: true })
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			value: '0x0',
			...(requestedNonce === undefined ? {} : { nonce: toHex(requestedNonce) }),
		}],
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
	const [pendingRequest] = await modules.getPendingTransactionsAndMessages()
	if (pendingRequest?.type !== 'Transaction' || pendingRequest.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected a prepared transaction')
	// Preparation generated gas and fees that the failure view never shows.
	assert.equal(pendingRequest.transactionToSimulate.transaction.gas, 21_000n)
	const renderedText = await renderFailedSimulationView()
	// The background refuses an acceptance without the override acknowledgement even if a caller bypasses the popup's disabled confirm button.
	await assert.rejects(modules.resolvePendingTransactionOrMessage(ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier, forceSend: false },
	}), /Transactions whose simulation failed require explicit user acknowledgement/u)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
	// The popup sends forceSend once the user ticks the override checkbox for a failing transaction.
	assert.equal(await modules.resolvePendingTransactionOrMessage(ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier, forceSend: true },
	}), true)
	const signerRequest = getForwardedSignerRequest(postedMessages)
	const forwardedTransaction = signerRequest.params[0]
	if (!isRecord(forwardedTransaction)) throw new Error('Missing forwarded transaction parameters')
	assert.equal(signerRequest.method, 'eth_sendTransaction')
	assert.deepEqual(Object.keys(forwardedTransaction).sort(), ['from', 'to', 'value', ...(requestedNonce === undefined ? [] : ['nonce'])].sort())
	assert.equal(forwardedTransaction.from, addressString(activeAddress))
	assert.equal(forwardedTransaction.to, addressString(recipientAddress))
	assert.equal(forwardedTransaction.value, '0x0')
	assert.match(renderedText, /Value0 ether/u)
	assert.match(renderedText, /Gas limit Selected by your wallet/u)
	assert.match(renderedText, /FeesSelected by your wallet/u)
	assert.match(renderedText, /Request sent to your wallet/u)
	// In simulation mode acceptance only adds the prepared transaction locally, so the same failure keeps its plain summary.
	const simulationModeText = await renderFailedSimulationView(true)
	assert.doesNotMatch(simulationModeText, /your wallet/u)
	assert.doesNotMatch(simulationModeText, /Nonce/u)
	assert.match(simulationModeText, /Value0 ether/u)
	return { forwardedTransaction, renderedText }
}

test('an override after a failed confirmation simulation forwards exactly the request the failure view shows, including an explicit nonce', async () => {
	const { forwardedTransaction, renderedText } = await prepareFailSimulationAndOverride(6n)
	assert.equal(forwardedTransaction.nonce, '0x6')
	assert.match(renderedText, /Nonce6/u)
})

test('an override after a failed confirmation simulation leaves an omitted nonce to the wallet', async () => {
	const { renderedText } = await prepareFailSimulationAndOverride(undefined)
	assert.match(renderedText, /NonceSelected by your wallet/u)
})

async function prepareAcceptAndRenderFeeFields(requestFields: Record<string, unknown>) {
	const { getSignerNonce } = await import('../../app/ts/components/pages/ConfirmTransaction.js')
	const { RawTransactionDetailsCard } = await import('../../app/ts/components/simulationExplaining/SimulationSummary.js')
	const { getSafeTransactionPendingFlow } = await import('../../app/ts/safe/safePendingFlow.js')
	await browser.storage.local.set({ simulationMode: false })
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const ethereum = createChainScenarioEthereum({ chainNonce: 0n, preparationBaseFeePerGas: 1n, simulationBaseFeePerGas: 100n })
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
				signerNonce: getSignerNonce(displayedRequest, getSafeTransactionPendingFlow(displayedRequest)),
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
	assert.equal(await modules.resolvePendingTransactionOrMessage(ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier, forceSend: false },
	}), true)
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
