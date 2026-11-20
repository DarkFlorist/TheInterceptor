import * as assert from 'node:assert'
import { encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import { installDateMock, installDomMock, isMockElement } from './domMock.js'
import { clickElement, findElement, getElement } from './domQueries.js'
import { type BrowserMock, installBrowserMock } from '../harness/browserMock.js'
import { createSafeTx, getSafeTxSigningHashes } from '../../app/ts/safe/safeCore.js'
import { getSafeTxHash } from '../../app/ts/utils/eip712.js'
import { bytes32String } from '../../app/ts/utils/bigint.js'
import { getNativeTokenErc20 } from '../../app/ts/background/metadataUtils.js'
import { Multicall3ABI } from '../../app/ts/utils/constants.js'
import type { PendingTransaction } from '../../app/ts/types/accessRequest.js'
import type { EthereumJsonRpcRequest, SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import type { IEthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { EthSimulateV1Result } from '../../app/ts/types/ethSimulate-types.js'
import { UpdateConfirmTransactionDialogPendingTransactions } from '../../app/ts/types/interceptor-messages.js'
import { EthereumBlockHeader, EthereumQuantity, serialize } from '../../app/ts/types/wire-types.js'
import { ConfirmTransaction } from '../../app/ts/components/pages/ConfirmTransaction.js'
import { getMessageMethod } from './runtimeMessageMatchers.js'

const hexToBytes = (hex: string) => Uint8Array.from(Buffer.from(hex.slice(2), 'hex'))

// Answers like a background page whose main popup is open and that has no pending request to bootstrap the confirmation dialog with.
function replyWithoutBootstrapData(message: unknown) {
	if (getMessageMethod(message) === 'popup_isMainPopupWindowOpen') return { method: 'popup_isMainPopupWindowOpen', data: { isOpen: true } }
	if (getMessageMethod(message) === 'popup_readyAndListening') return { method: 'popup_readyAndListening', data: { popupOrTabId: { type: 'popup', id: 1 } } }
	return undefined
}

const installConfirmTransactionBrowserMock = () => installBrowserMock({ handlers: { runtimeMessage: replyWithoutBootstrapData } })

async function dispatchPendingTransactions(browserMock: BrowserMock, pendingTransactionAndSignableMessages: readonly PendingTransaction[]) {
	const update: UpdateConfirmTransactionDialogPendingTransactions = {
		method: 'popup_update_confirm_transaction_dialog_pending_transactions',
		data: {
			pendingTransactionAndSignableMessages,
			currentBlockNumber: 123n,
			rpcConnectionStatus: undefined,
		},
	}
	await act(async () => {
		await browserMock.dispatchRuntimeMessage({ role: 'all', ...serialize(UpdateConfirmTransactionDialogPendingTransactions, update) })
	})
}

async function unmountConfirmTransaction(dom: ReturnType<typeof installDomMock>) {
	await act(() => {
		render(null, dom.document.body)
	})
}

function makePendingTransaction(simulationConductedTimestamp: Date, value?: bigint) {
	const activeAddress = 0x1111111111111111111111111111111111111111n
	const recipientAddress = 0x2222222222222222222222222222222222222222n
	const transactionIdentifier = 1n
	const created = new Date('2024-01-01T00:00:00.000Z')
	const website = { websiteOrigin: 'https://example.com', icon: undefined, title: undefined }
	const originalRequestParameters = {
		method: 'eth_sendTransaction',
		params: [{
			from: activeAddress,
			to: recipientAddress,
			...(value === undefined ? {} : { value }),
			gas: 21_000n,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
			input: new Uint8Array(),
		}],
	} satisfies SendTransactionParams
	const transactionToSimulate = {
		website,
		created,
		originalRequestParameters,
		transactionIdentifier,
		success: false as const,
		error: {
			code: -32000,
			message: 'simulation failed',
		},
	}
	const pendingTransaction = {
		type: 'Transaction' as const,
		transactionOrMessageCreationStatus: 'FailedToSimulate' as const,
		popupOrTabId: { type: 'popup' as const, id: 1 },
		originalRequestParameters,
		uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } },
		simulationMode: true,
		activeAddress,
		created,
		transactionIdentifier,
		transactionToSimulate,
		website,
		approvalStatus: { status: 'WaitingForUser' as const },
		popupVisualisation: {
			statusCode: 'failed' as const,
			data: {
				activeAddress,
				simulationMode: true,
				simulationStartedTimestamp: created,
				uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } },
				transactionToSimulate,
				signerName: 'NoSignerDetected' as const,
				error: {
					code: -32000,
					message: 'simulation failed',
					decodedErrorMessage: 'simulation failed',
				},
				simulationState: {
					blockNumber: 123n,
					simulationConductedTimestamp,
				},
			},
		},
	} satisfies PendingTransaction

	return pendingTransaction
}

const SAFE_SIGNING_REQUEST_CARD_TITLE = 'Gnosis Safe signing request (EIP-712)'

function makeSafeProposal<T extends ReturnType<typeof makePendingTransaction> | ReturnType<typeof makeSimulatedPendingTransaction>>(pending: T) {
	const [transaction] = pending.originalRequestParameters.params
	const safeTx = createSafeTx(1n, pending.activeAddress, {
		to: transaction.to,
		value: transaction.value ?? 0n,
		input: transaction.input,
	}, 3n)
	return {
		...pending,
		safeTransaction: {
			safeAddress: pending.activeAddress,
			safeSignerAddress: transaction.to,
			safeVersion: '1.4.1' as const,
			threshold: 1n,
			reviewedSafeState: { version: '1.4.1' as const, nonce: 3n, owners: [transaction.to], threshold: 1n },
			safeTxHash: BigInt(getSafeTxHash(safeTx)),
			safeTx,
			executionGasLimit: 21_000n,
		},
	}
}

function makeSimulatedPendingTransaction(value: bigint) {
	const failed = makePendingTransaction(new Date('2024-01-01T00:00:05.000Z'), value)
	const [requested] = failed.originalRequestParameters.params
	const rpcNetwork = { name: 'Ethereum Mainnet', chainId: 1n, httpsRpc: 'https://rpc.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	const safeEntry = { type: 'contact' as const, name: 'Test Safe', address: failed.activeAddress, entrySource: 'User' as const, chainId: 1n }
	const recipientEntry = { type: 'contact' as const, name: 'Recipient', address: requested.to, entrySource: 'User' as const, chainId: 1n }
	const transaction = {
		type: '1559' as const,
		from: requested.from,
		nonce: 0n,
		maxFeePerGas: requested.maxFeePerGas,
		maxPriorityFeePerGas: requested.maxPriorityFeePerGas,
		gas: requested.gas,
		to: requested.to,
		value,
		input: requested.input,
		chainId: 1n,
		accessList: [],
	}
	const transactionToSimulate = {
		website: failed.website,
		created: failed.created,
		originalRequestParameters: failed.originalRequestParameters,
		transactionIdentifier: failed.transactionIdentifier,
		success: true as const,
		transaction,
	}
	const simulatedTransaction = {
		website: failed.website,
		created: failed.created,
		parsedInputData: { type: 'NonParsed' as const, input: requested.input },
		transactionIdentifier: failed.transactionIdentifier,
		originalRequestParameters: failed.originalRequestParameters,
		tokenBalancesAfter: [],
		tokenPriceEstimates: [],
		tokenPriceQuoteToken: undefined,
		gasSpent: 21_000n,
		realizedGasPrice: 1n,
		quarantine: false,
		quarantineReasons: [],
		transactionStatus: 'Transaction Succeeded' as const,
		transaction: { ...transaction, from: safeEntry, to: recipientEntry, rpcNetwork, hash: 1n },
		events: [],
	}
	return {
		...failed,
		transactionOrMessageCreationStatus: 'Simulated' as const,
		transactionToSimulate,
		popupVisualisation: {
			statusCode: 'success' as const,
			data: {
				activeAddress: failed.activeAddress,
				simulationMode: true,
				simulationStartedTimestamp: failed.created,
				uniqueRequestIdentifier: failed.uniqueRequestIdentifier,
				transactionToSimulate,
				signerName: 'NoSignerDetected' as const,
				addressBookEntries: [safeEntry, recipientEntry, getNativeTokenErc20(rpcNetwork)],
				tokenPriceEstimates: [],
				namedTokenIds: [],
				simulationState: {
					success: true as const,
					simulationStateInput: [],
					simulatedBlocks: [],
					blockNumber: 123n,
					blockTimestamp: failed.created,
					baseFeePerGas: 0n,
					simulationConductedTimestamp: new Date('2024-01-01T00:00:05.000Z'),
					rpcNetwork,
				},
				visualizedSimulationState: {
					success: true as const,
					visualizedBlocks: [{
						simulatedAndVisualizedTransactions: [simulatedTransaction],
						visualizedPersonalSignRequests: [],
						blockTimeManipulation: { type: 'AddToTimestamp' as const, deltaToAdd: 0n, deltaUnit: 'Seconds' as const },
					}],
				},
			},
		},
	} satisfies PendingTransaction
}

describe('ConfirmTransaction', () => {
	test('shows the proposal notice only for the classifier-selected Safe proposal flow', async () => {
		const dom = installDomMock()
		const browserMock = installConfirmTransactionBrowserMock()
		const pending = makePendingTransaction(new Date('2024-01-01T00:00:05.000Z'))
		const [requestedTransaction] = pending.originalRequestParameters.params
		const safeTx = createSafeTx(1n, pending.activeAddress, {
			to: requestedTransaction.to,
			value: 0n,
			input: new Uint8Array(),
		}, 3n)
		const proposal = {
			...pending,
			safeTransaction: {
				safeAddress: pending.activeAddress,
				safeSignerAddress: requestedTransaction.to,
				safeVersion: '1.4.1' as const,
				threshold: 1n,
				reviewedSafeState: { version: '1.4.1' as const, nonce: 3n, owners: [requestedTransaction.to], threshold: 1n },
				safeTxHash: BigInt(getSafeTxHash(safeTx)),
				safeTx,
				executionGasLimit: 21_000n,
			},
		}

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})

		await dispatchPendingTransactions(browserMock, [proposal])
		assert.equal(dom.document.body.textContent?.includes('wrapped as Gnosis Safe transaction nonce 3'), true)
		const proposalNotice = getElement(dom.document.body, (element) => element.tagName === 'DIV' && element.childNodes.some((child) => isMockElement(child) && child.tagName === 'DETAILS' && child.textContent.includes('Gnosis Safe transaction nonce 3')), 'the Safe proposal notice')
		assert.equal(proposalNotice.childNodes.some((child) => isMockElement(child) && child.tagName === 'BUTTON'), false, 'the Safe proposal notice must not show a close control that does nothing')
		await dispatchPendingTransactions(browserMock, [{
			...proposal,
			safeExecutionOriginalRequestParameters: proposal.originalRequestParameters,
		}])
		assert.equal(dom.document.body.textContent?.includes('wrapped as Gnosis Safe transaction nonce 3'), false)

		await unmountConfirmTransaction(dom)
		dom.restore()
		browserMock.restore()
	})

	test('shows the EIP-712 signing request for a Safe proposal so it can be compared with a hardware signer', async () => {
		const dom = installDomMock()
		const browserMock = installConfirmTransactionBrowserMock()
		const pending = makePendingTransaction(new Date('2024-01-01T00:00:05.000Z'), 1_250_000_000_000_000_000n)
		const proposal = makeSafeProposal(pending)
		const safeTx = proposal.safeTransaction.safeTx
		const findSigningRequestCardHeader = () => findElement(dom.document.body, (element) => element.tagName === 'HEADER' && element.textContent.includes(SAFE_SIGNING_REQUEST_CARD_TITLE))

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})

		await dispatchPendingTransactions(browserMock, [proposal])
		const cardHeader = findSigningRequestCardHeader()
		assert.notEqual(cardHeader, undefined, 'expected the Safe signing request card for a proposal')
		if (cardHeader === undefined) throw new Error('unreachable')
		const { domainHash, messageHash } = getSafeTxSigningHashes(safeTx)
		assert.equal(dom.document.body.textContent?.includes(domainHash), false, 'the hashes are collapsed until the card is opened')

		await act(async () => { await clickElement(cardHeader) })
		const renderedText = dom.document.body.textContent ?? ''
		assert.equal(renderedText.includes('Domain Hash'), true)
		assert.equal(renderedText.includes(domainHash), true)
		assert.equal(renderedText.includes('Message Hash'), true)
		assert.equal(renderedText.includes(messageHash), true)
		assert.equal(renderedText.includes('Gnosis Safe Transaction Hash'), true)
		assert.equal(renderedText.includes(bytes32String(proposal.safeTransaction.safeTxHash)), true)
		assert.equal(renderedText.includes('Nonce: 3'), true)
		assert.equal(renderedText.includes('Operation: 0'), true)
		// The failed-simulation view has no network, so the value has no token symbol; the raw attoeth value is what a hardware signer shows.
		assert.equal(renderedText.includes('Value: 1.25 (native token)'), true)
		assert.equal(renderedText.includes('Value (attoeth)1250000000000000000'), true)

		await dispatchPendingTransactions(browserMock, [{
			...proposal,
			safeExecutionOriginalRequestParameters: proposal.originalRequestParameters,
		}])
		assert.equal(findSigningRequestCardHeader(), undefined, 'direct Safe executions are signed as normal transactions and have no EIP-712 request')

		await unmountConfirmTransaction(dom)
		dom.restore()
		browserMock.restore()
	})

	test('shows the EIP-712 signing request with the simulated network for a successfully simulated Safe proposal', async () => {
		const dom = installDomMock()
		const browserMock = installConfirmTransactionBrowserMock()
		const proposal = makeSafeProposal(makeSimulatedPendingTransaction(1_250_000_000_000_000_000n))
		const { domainHash, messageHash } = getSafeTxSigningHashes(proposal.safeTransaction.safeTx)

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})
		await dispatchPendingTransactions(browserMock, [proposal])
		const cardHeader = findElement(dom.document.body, (element) => element.tagName === 'HEADER' && element.textContent.includes(SAFE_SIGNING_REQUEST_CARD_TITLE))
		assert.notEqual(cardHeader, undefined, 'expected the Safe signing request card below the simulated transaction')
		if (cardHeader === undefined) throw new Error('unreachable')
		await act(async () => { await clickElement(cardHeader) })

		const renderedText = dom.document.body.textContent ?? ''
		assert.equal(renderedText.includes(domainHash), true)
		assert.equal(renderedText.includes(messageHash), true)
		assert.equal(renderedText.includes(bytes32String(proposal.safeTransaction.safeTxHash)), true)
		assert.equal(renderedText.includes('Chain: Ethereum Mainnet (1)'), true)
		assert.equal(renderedText.includes('Value: 1.25ETH'), true, renderedText)
		assert.equal(renderedText.includes('Value (attoeth)1250000000000000000'), true)
		assert.equal(renderedText.includes('Gnosis Safe: Test Safe'), true, 'address-book entries from the simulation name the Safe')
		assert.equal(renderedText.includes('To: Recipient'), true)

		await unmountConfirmTransaction(dom)
		dom.restore()
		browserMock.restore()
	})

	test('updates the simulation age when a refreshed pending transaction arrives', async () => {
		const dom = installDomMock()
		const clock = installDateMock('2024-01-01T00:00:10.000Z')
		const browserMock = installConfirmTransactionBrowserMock()
		const olderPendingTransaction = makePendingTransaction(new Date('2024-01-01T00:00:05.000Z'))
		const newerPendingTransaction = makePendingTransaction(new Date('2024-01-01T00:00:09.000Z'))

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})

		await dispatchPendingTransactions(browserMock, [olderPendingTransaction])
		assert.equal(dom.document.body.textContent?.includes('Simulated 5s ago'), true)

		await dispatchPendingTransactions(browserMock, [newerPendingTransaction])
		assert.equal(dom.document.body.textContent?.includes('Simulated 1s ago'), true)

		await unmountConfirmTransaction(dom)
		clock.restore()
		dom.restore()
		browserMock.restore()
	})

	test('shows gas limit editing for failed transactions', async () => {
		const dom = installDomMock()
		const clock = installDateMock('2024-01-01T00:00:10.000Z')
		const browserMock = installConfirmTransactionBrowserMock()

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})

		await dispatchPendingTransactions(browserMock, [makePendingTransaction(new Date('2024-01-01T00:00:05.000Z'))])

		assert.equal(dom.document.body.textContent?.includes('Transaction type'), true)
		assert.equal(dom.document.body.textContent?.includes('From'), true)
		assert.equal(dom.document.body.textContent?.includes('To'), true)
		assert.equal(dom.document.body.textContent?.includes('Transaction Input'), true)
		assert.equal(dom.document.body.textContent?.includes('Gas limit'), true)
		assert.equal(dom.document.body.textContent?.includes('0 ether'), true)
		assert.equal(dom.document.body.textContent?.includes('Unknown'), false)
		assert.equal(dom.document.body.textContent?.includes('Change'), true)
		assert.equal(dom.document.body.textContent?.includes('Gas estimation error'), true)
		assert.equal(dom.document.body.textContent?.includes('Execution error'), false)

		await dispatchPendingTransactions(browserMock, [makePendingTransaction(new Date('2024-01-01T00:00:05.000Z'), 1_250_000_000_000_000_000n)])
		assert.equal(dom.document.body.textContent?.includes('1.25 ether'), true)

		await unmountConfirmTransaction(dom)
		clock.restore()
		dom.restore()
		browserMock.restore()
	})

	test('updates the simulation age when the real refresh flow runs', async () => {
		const dom = installDomMock()
		const clock = installDateMock('2024-01-01T00:00:10.000Z')
		const browserMock = installConfirmTransactionBrowserMock()
		const olderPendingTransaction = makePendingTransaction(new Date('2024-01-01T00:00:05.000Z'))
		const { EthereumClientService } = await import('../../app/ts/simulation/services/EthereumClientService.js')
		const { TokenPriceService } = await import('../../app/ts/simulation/services/priceEstimator.js')
		const { updateInterceptorTransactionStack, getPendingTransactionsAndMessages } = await import('../../app/ts/background/storageVariables.js')
		const { refreshPopupConfirmTransactionSimulation } = await import('../../app/ts/background/popupMessageHandlers/confirmation.js')
		const { browserStorageLocalSet2 } = await import('../../app/ts/utils/storageUtils.js')

		const fakeRpcNetwork = {
			name: 'Test Chain',
			chainId: 1337n,
			httpsRpc: 'https://example.invalid',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			currencyLogoUri: undefined,
			primary: true,
			minimized: true,
		}
		const fakeBlock: EthereumBlockHeader = {
			author: 0n,
			difficulty: 0n,
			extraData: new Uint8Array(),
			gasLimit: 30_000_000n,
			gasUsed: 21_000n,
			hash: 0x1234n,
			logsBloom: 0n,
			miner: 0n,
			mixHash: 0n,
			nonce: 0n,
			number: 123n,
			parentHash: 0x1n,
			receiptsRoot: 0n,
			sha3Uncles: 0n,
			stateRoot: 0n,
			timestamp: new Date('2024-01-01T00:00:00.000Z'),
			size: 0n,
			totalDifficulty: 0n,
			uncles: [],
			baseFeePerGas: 1n,
			transactionsRoot: 0n,
			transactions: [],
			withdrawals: [],
			withdrawalsRoot: 0n,
		}
		const fakeRequestHandler = {
			rpcUrl: fakeRpcNetwork.httpsRpc,
			clearCache: () => undefined,
			getChainId: async () => fakeRpcNetwork.chainId,
			async jsonRpcRequest(rpcRequest: EthereumJsonRpcRequest) {
				switch (rpcRequest.method) {
					case 'eth_getBlockByNumber':
						return EthereumBlockHeader.serialize(fakeBlock)
					case 'eth_getTransactionCount':
						return serialize(EthereumQuantity, 0n)
					case 'eth_getBalance':
						return serialize(EthereumQuantity, 0n)
					case 'eth_blockNumber':
						return serialize(EthereumQuantity, 123n)
					case 'eth_getCode':
						return '0x'
					case 'eth_gasPrice':
						return serialize(EthereumQuantity, 1n)
					case 'eth_simulateV1': {
						const balanceResult = encodeFunctionReturn(Multicall3ABI, 'getEthBalance', [0n])
						const aggregate3Result = encodeFunctionReturn(Multicall3ABI, 'aggregate3', [[{ success: true, returnData: balanceResult }]])
						const simulationResult: EthSimulateV1Result = rpcRequest.params[0].blockStateCalls.map((blockStateCall) => ({
							number: 123n,
							hash: 0x9876n,
							timestamp: 0x65920080n,
							gasLimit: 30_000_000n,
							gasUsed: 21_000n,
							baseFeePerGas: 1n,
							calls: blockStateCall.calls.map(() => ({
								status: 'success' as const,
								gasUsed: 21_000n,
								logs: [],
								returnData: hexToBytes(aggregate3Result),
							})),
						}))
						return serialize(EthSimulateV1Result, simulationResult)
					}
					default:
						throw new Error(`Unexpected RPC method: ${ rpcRequest.method }`)
				}
			},
		} satisfies IEthereumJSONRpcRequestHandler
		const ethereum = new EthereumClientService(fakeRequestHandler, async () => undefined, async () => undefined, fakeRpcNetwork)
		const tokenPriceService = new TokenPriceService(ethereum, 0)
		// The refresh only needs the simulation; token prices would need more RPC methods than this fake answers.
		tokenPriceService.estimateEthereumPricesForTokens = async () => []

		await browserStorageLocalSet2({
			pendingTransactionsAndMessages: [olderPendingTransaction],
		})
		await updateInterceptorTransactionStack(() => ({ operations: [] }))

		await act(async () => {
			await refreshPopupConfirmTransactionSimulation(ethereum, tokenPriceService)
		})

		const [refreshedPendingTransaction] = await getPendingTransactionsAndMessages()
		if (refreshedPendingTransaction === undefined
			|| refreshedPendingTransaction.type !== 'Transaction'
			|| (refreshedPendingTransaction.transactionOrMessageCreationStatus !== 'Simulated' && refreshedPendingTransaction.transactionOrMessageCreationStatus !== 'FailedToSimulate')) {
			throw new Error('missing refreshed pending transaction')
		}
		assert.ok(
			refreshedPendingTransaction.popupVisualisation.data.simulationState.simulationConductedTimestamp.getTime() >
			olderPendingTransaction.popupVisualisation.data.simulationState.simulationConductedTimestamp.getTime(),
		)

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})

		await dispatchPendingTransactions(browserMock, [refreshedPendingTransaction])

		assert.equal(dom.document.body.textContent?.includes('Simulated 0s ago'), true)

		await unmountConfirmTransaction(dom)
		clock.restore()
		dom.restore()
		browserMock.restore()
	}, { timeout: 15_000 })
})
