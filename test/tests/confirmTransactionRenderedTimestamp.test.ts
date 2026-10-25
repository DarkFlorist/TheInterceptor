import * as assert from 'assert'
import { encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import { clickRenderedElement, findRenderedElement, installDateMock, installDomMock } from './domMock.js'
import { createSafeTx, getSafeTxSigningHashes } from '../../app/ts/safe/safeCore.js'
import { getSafeTxHash } from '../../app/ts/utils/eip712.js'
import { bytes32String } from '../../app/ts/utils/bigint.js'
import { getNativeTokenErc20 } from '../../app/ts/background/metadataUtils.js'

type RuntimeMessageListener = (message: unknown) => unknown
type CurrentWindowProvider = () => Promise<{ id: number }>
type ConfirmDialogHandler = (message: unknown) => Promise<void>
const hexToBytes = (hex: string) => Uint8Array.from(Buffer.from(hex.slice(2), 'hex'))

function createBrowserMock() {
	const listeners: RuntimeMessageListener[] = []
	const storageState: Record<string, unknown> = {}
	let getCurrentWindow: CurrentWindowProvider = async () => ({ id: 1 })
	let confirmDialogHandler: ConfirmDialogHandler | undefined

	const getStorageItems = (keys?: string | string[] | Record<string, unknown> | null) => {
		if (keys === undefined || keys === null) return { ...storageState }
		if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
		if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
		return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
	}

	const browser = {
		runtime: {
			lastError: null as browser.runtime._LastError | undefined | null,
			async sendMessage(message: unknown) {
				for (const listener of [...listeners]) listener(message)
				if (message?.method === 'popup_isMainPopupWindowOpen') {
					return { method: 'popup_isMainPopupWindowOpen', data: { isOpen: true } }
				}
				if (message?.method === 'popup_readyAndListening') {
					return { method: 'popup_readyAndListening', data: { popupOrTabId: { type: 'popup', id: 1 } } }
				}
				if (message?.method === 'popup_confirmDialog') await confirmDialogHandler?.(message)
				return undefined
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: {
				addListener(listener: RuntimeMessageListener) {
					listeners.push(listener)
				},
				removeListener(listener: RuntimeMessageListener) {
					const index = listeners.indexOf(listener)
					if (index >= 0) listeners.splice(index, 1)
				},
			},
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) { return getStorageItems(keys) },
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
					return undefined
				},
				async remove(keys: string | string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
					return undefined
				},
			},
		},
		tabs: {
			async query() { return [] },
			async get() { return undefined },
			async update() { return undefined },
			onUpdated: { addListener: () => undefined, removeListener: () => undefined },
			onRemoved: { addListener: () => undefined, removeListener: () => undefined },
		},
		windows: {
			async get() { return undefined },
			async getCurrent() { return await getCurrentWindow() },
			async update() { return undefined },
		},
		action: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
		browserAction: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
	}
	Object.defineProperty(globalThis, 'browser', { value: browser, configurable: true, writable: true })
	Object.defineProperty(globalThis, 'chrome', { value: { runtime: { id: 'test-extension' } }, configurable: true, writable: true })

	return {
		storage: browser.storage,
		dispatch(message: unknown) {
			for (const listener of [...listeners]) listener(message)
		},
		setCurrentWindowProvider(provider: CurrentWindowProvider) { getCurrentWindow = provider },
		setConfirmDialogHandler(handler: ConfirmDialogHandler) { confirmDialogHandler = handler },
	}
}

createBrowserMock()

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
		method: 'eth_sendTransaction' as const,
		params: [{
			from: activeAddress,
			to: recipientAddress,
			...(value === undefined ? {} : { value }),
			gas: 21_000n,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
			input: new Uint8Array(),
		}],
	}
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
	}

	return pendingTransaction
}

const SAFE_SIGNING_REQUEST_CARD_TITLE = 'Gnosis Safe signing request (EIP-712)'

function makeSafeProposal<T extends ReturnType<typeof makePendingTransaction> | ReturnType<typeof makeSimulatedPendingTransaction>>(pending: T) {
	const transaction = pending.originalRequestParameters.params[0]
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

type SimulatedTransactionOutcome = ({ transactionStatus: 'Transaction Succeeded' } | { transactionStatus: 'Transaction Failed', error: { code: number, message: string, decodedErrorMessage: string } }) & { quarantine?: boolean, quarantineReasons?: readonly string[] }

function makeSimulatedPendingTransaction(value: bigint, outcome: SimulatedTransactionOutcome = { transactionStatus: 'Transaction Succeeded' }) {
	const failed = makePendingTransaction(new Date('2024-01-01T00:00:05.000Z'), value)
	const requested = failed.originalRequestParameters.params[0]
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
		...outcome,
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
	}
}

// A simulation client whose RPC answers every transaction as a successful 21,000 gas call at block 123.
async function createFakeSimulator() {
	const { EthereumClientService } = await import('../../app/ts/simulation/services/EthereumClientService.js')
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
	const fakeBlock = {
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
		clearCache() { return undefined },
		async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
			switch (rpcRequest.method) {
				case 'eth_getBlockByNumber':
					return serialize((await import('../../app/ts/types/wire-types.js')).EthereumBlockHeader, fakeBlock)
				case 'eth_getTransactionCount':
					return serialize((await import('../../app/ts/types/wire-types.js')).EthereumQuantity, 0n)
				case 'eth_getBalance':
					return serialize((await import('../../app/ts/types/wire-types.js')).EthereumQuantity, 0n)
				case 'eth_blockNumber':
					return serialize((await import('../../app/ts/types/wire-types.js')).EthereumQuantity, 123n)
				case 'eth_getCode':
					return '0x'
				case 'eth_gasPrice':
					return serialize((await import('../../app/ts/types/wire-types.js')).EthereumQuantity, 1n)
				case 'eth_simulateV1':
					{
						const multicallAbi = (await import('../../app/ts/utils/constants.js')).Multicall3ABI
						const balanceResult = encodeFunctionReturn(multicallAbi, 'getEthBalance', [0n])
						const aggregate3Result = encodeFunctionReturn(multicallAbi, 'aggregate3', [[{ success: true, returnData: balanceResult }]])
						const blockStateCalls = Array.isArray(rpcRequest.params?.[0]?.blockStateCalls) ? rpcRequest.params[0].blockStateCalls : [{}]
						return serialize((await import('../../app/ts/types/ethSimulate-types.js')).EthSimulateV1Result, blockStateCalls.map((blockStateCall) => ({
							number: 123n,
							hash: 0x9876n,
							timestamp: 0x65920080n,
							gasLimit: 30_000_000n,
							gasUsed: 21_000n,
							baseFeePerGas: 1n,
							calls: Array.from({ length: Array.isArray(blockStateCall.calls) ? blockStateCall.calls.length : 0 }, () => ({
								status: 'success',
								gasUsed: 21_000n,
								logs: [],
								returnData: hexToBytes(aggregate3Result),
							})),
						})))
					}
				default:
					throw new Error(`Unexpected RPC method: ${ rpcRequest.method }`)
			}
		},
	}
	const ethereum = new EthereumClientService(fakeRequestHandler, async () => undefined, async () => undefined, fakeRpcNetwork)
	const simulator = {
		ethereum,
		tokenPriceService: {
			estimateEthereumPricesForTokens: async () => [],
		},
	}
	return simulator
}

const revertedOutcome = { transactionStatus: 'Transaction Failed' as const, error: { code: -32000, message: 'execution reverted', decodedErrorMessage: 'execution reverted' } }
const CONFIRM_BUTTON_CLASS = 'button is-primary button-overflow dialog-action-button'

type RenderedDom = ReturnType<typeof installDomMock>
type RenderedElementWithAttributes = { readonly attributes: Record<string, string | undefined> }
const hasAttributes = (node: object): node is RenderedElementWithAttributes => 'attributes' in node && typeof node.attributes === 'object' && node.attributes !== null

// Preact writes a prop as a property when the element defines one and as an attribute otherwise.
const getRenderedProp = (node: object, name: string): unknown => name in node ? Reflect.get(node, name) : hasAttributes(node) ? node.attributes[name] : undefined
const hasBooleanProp = (node: object, name: 'checked' | 'disabled') => name in node ? Reflect.get(node, name) === true : getRenderedProp(node, name) !== undefined

const findSendAnywayCheckbox = (dom: RenderedDom) => findRenderedElement(dom.document.body, (node) => node.tagName === 'INPUT' && getRenderedProp(node, 'type') === 'checkbox')
const findConfirmButton = (dom: RenderedDom) => findRenderedElement(dom.document.body, (node) => node.tagName === 'BUTTON' && getRenderedProp(node, 'class') === CONFIRM_BUTTON_CLASS)

function isSendAnywayTicked(dom: RenderedDom) {
	const checkbox = findSendAnywayCheckbox(dom)
	return checkbox !== undefined && hasBooleanProp(checkbox, 'checked')
}

function isConfirmEnabled(dom: RenderedDom) {
	const button = findConfirmButton(dom)
	return button !== undefined && !hasBooleanProp(button, 'disabled')
}

// The checkbox handler reads the ticked state from an HTMLInputElement target, which the DOM mock does not define.
async function tickSendAnyway(dom: RenderedDom) {
	const inputHandler = Object.entries(findSendAnywayCheckbox(dom)?.l ?? {}).find(([key]) => key.toLowerCase().startsWith('input'))?.[1]
	if (inputHandler === undefined) throw new Error('Expected the send-anyway checkbox')
	class TickedCheckbox { readonly checked = true }
	const previousHtmlInputElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLInputElement')
	Object.defineProperty(globalThis, 'HTMLInputElement', { value: TickedCheckbox, configurable: true, writable: true })
	try {
		await act(() => { inputHandler({ target: new TickedCheckbox() }) })
	} finally {
		if (previousHtmlInputElement === undefined) Reflect.deleteProperty(globalThis, 'HTMLInputElement')
		else Object.defineProperty(globalThis, 'HTMLInputElement', previousHtmlInputElement)
	}
}

const { UpdateConfirmTransactionDialogPendingTransactions } = await import('../../app/ts/types/interceptor-messages.js')
const { serialize } = await import('../../app/ts/types/wire-types.js')
const { ConfirmTransaction } = await import('../../app/ts/components/pages/ConfirmTransaction.js')
async function dispatchPendingTransactions(browser: ReturnType<typeof createBrowserMock>, pendingTransactionAndSignableMessages: readonly unknown[]) {
	await act(() => {
		browser.dispatch({
			role: 'all',
			...serialize(UpdateConfirmTransactionDialogPendingTransactions, {
				method: 'popup_update_confirm_transaction_dialog_pending_transactions',
				data: { pendingTransactionAndSignableMessages, currentBlockNumber: 123n, rpcConnectionStatus: undefined },
			}),
		})
	})
}

describe('ConfirmTransaction', () => {
	test('shows the proposal notice only for the classifier-selected Safe proposal flow', async () => {
		const dom = installDomMock()
		const browser = createBrowserMock()
		const pending = makePendingTransaction(new Date('2024-01-01T00:00:05.000Z'))
		const safeTx = createSafeTx(1n, pending.activeAddress, {
			to: pending.originalRequestParameters.params[0].to,
			value: 0n,
			input: new Uint8Array(),
		}, 3n)
		const proposal = {
			...pending,
			safeTransaction: {
				safeAddress: pending.activeAddress,
				safeSignerAddress: pending.originalRequestParameters.params[0].to,
				safeVersion: '1.4.1' as const,
				threshold: 1n,
				reviewedSafeState: { version: '1.4.1' as const, nonce: 3n, owners: [pending.originalRequestParameters.params[0].to], threshold: 1n },
				safeTxHash: BigInt(getSafeTxHash(safeTx)),
				safeTx,
				executionGasLimit: 21_000n,
			},
		}

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})
		const dispatchPending = async (pendingTransaction: typeof proposal) => await act(() => {
			browser.dispatch({
				role: 'all',
				...serialize(UpdateConfirmTransactionDialogPendingTransactions, {
					method: 'popup_update_confirm_transaction_dialog_pending_transactions',
					data: {
						pendingTransactionAndSignableMessages: [pendingTransaction],
						currentBlockNumber: 123n,
						rpcConnectionStatus: undefined,
					},
				}),
			})
		})

		await dispatchPending(proposal)
		assert.equal(dom.document.body.textContent?.includes('wrapped as Gnosis Safe transaction nonce 3'), true)
		await dispatchPending({
			...proposal,
			safeExecutionOriginalRequestParameters: proposal.originalRequestParameters,
		})
		assert.equal(dom.document.body.textContent?.includes('wrapped as Gnosis Safe transaction nonce 3'), false)

		await unmountConfirmTransaction(dom)
		dom.restore()
	})

	test('shows the EIP-712 signing request for a Safe proposal so it can be compared with a hardware signer', async () => {
		const dom = installDomMock()
		const browser = createBrowserMock()
		const pending = makePendingTransaction(new Date('2024-01-01T00:00:05.000Z'), 1_250_000_000_000_000_000n)
		const proposal = makeSafeProposal(pending)
		const safeTx = proposal.safeTransaction.safeTx
		const findSigningRequestCardHeader = () => findRenderedElement(dom.document.body, (node) => node.tagName === 'HEADER' && node.textContent?.includes(SAFE_SIGNING_REQUEST_CARD_TITLE) === true)

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})
		const dispatchPending = async (pendingTransaction: typeof proposal) => await act(() => {
			browser.dispatch({
				role: 'all',
				...serialize(UpdateConfirmTransactionDialogPendingTransactions, {
					method: 'popup_update_confirm_transaction_dialog_pending_transactions',
					data: {
						pendingTransactionAndSignableMessages: [pendingTransaction],
						currentBlockNumber: 123n,
						rpcConnectionStatus: undefined,
					},
				}),
			})
		})

		await dispatchPending(proposal)
		const cardHeader = findSigningRequestCardHeader()
		assert.notEqual(cardHeader, undefined, 'expected the Safe signing request card for a proposal')
		if (cardHeader === undefined) throw new Error('unreachable')
		const { domainHash, messageHash } = getSafeTxSigningHashes(safeTx)
		assert.equal(dom.document.body.textContent?.includes(domainHash), false, 'the hashes are collapsed until the card is opened')

		await act(async () => { await clickRenderedElement(cardHeader) })
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

		await dispatchPending({
			...proposal,
			safeExecutionOriginalRequestParameters: proposal.originalRequestParameters,
		})
		assert.equal(findSigningRequestCardHeader(), undefined, 'direct Safe executions are signed as normal transactions and have no EIP-712 request')

		await unmountConfirmTransaction(dom)
		dom.restore()
	})

	test('shows the EIP-712 signing request with the simulated network for a successfully simulated Safe proposal', async () => {
		const dom = installDomMock()
		const browser = createBrowserMock()
		const proposal = makeSafeProposal(makeSimulatedPendingTransaction(1_250_000_000_000_000_000n))
		const { domainHash, messageHash } = getSafeTxSigningHashes(proposal.safeTransaction.safeTx)

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})
		await act(() => {
			browser.dispatch({
				role: 'all',
				...serialize(UpdateConfirmTransactionDialogPendingTransactions, {
					method: 'popup_update_confirm_transaction_dialog_pending_transactions',
					data: {
						pendingTransactionAndSignableMessages: [proposal],
						currentBlockNumber: 123n,
						rpcConnectionStatus: undefined,
					},
				}),
			})
		})
		const cardHeader = findRenderedElement(dom.document.body, (node) => node.tagName === 'HEADER' && node.textContent?.includes(SAFE_SIGNING_REQUEST_CARD_TITLE) === true)
		assert.notEqual(cardHeader, undefined, 'expected the Safe signing request card below the simulated transaction')
		if (cardHeader === undefined) throw new Error('unreachable')
		await act(async () => { await clickRenderedElement(cardHeader) })

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
	})

	test('updates the simulation age when a refreshed pending transaction arrives', async () => {
		const dom = installDomMock()
		const clock = installDateMock('2024-01-01T00:00:10.000Z')
		const browser = createBrowserMock()
		const olderPendingTransaction = makePendingTransaction(new Date('2024-01-01T00:00:05.000Z'))
		const newerPendingTransaction = makePendingTransaction(new Date('2024-01-01T00:00:09.000Z'))

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})

		await act(() => {
			browser.dispatch({
				role: 'all',
				...serialize(UpdateConfirmTransactionDialogPendingTransactions, {
				method: 'popup_update_confirm_transaction_dialog_pending_transactions',
				data: {
					pendingTransactionAndSignableMessages: [olderPendingTransaction],
					currentBlockNumber: 123n,
					rpcConnectionStatus: undefined,
				},
				}),
			})
		})
		assert.equal(dom.document.body.textContent?.includes('Simulated 5s ago'), true)

		await act(() => {
			browser.dispatch({
				role: 'all',
				...serialize(UpdateConfirmTransactionDialogPendingTransactions, {
				method: 'popup_update_confirm_transaction_dialog_pending_transactions',
				data: {
					pendingTransactionAndSignableMessages: [newerPendingTransaction],
					currentBlockNumber: 123n,
					rpcConnectionStatus: undefined,
				},
				}),
			})
		})
		assert.equal(dom.document.body.textContent?.includes('Simulated 1s ago'), true)

		await unmountConfirmTransaction(dom)
		clock.restore()
		dom.restore()
	})

	test('shows gas limit editing for failed transactions', async () => {
		const dom = installDomMock()
		const clock = installDateMock('2024-01-01T00:00:10.000Z')
		const browser = createBrowserMock()

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})

		await act(() => {
			browser.dispatch({
				role: 'all',
				...serialize(UpdateConfirmTransactionDialogPendingTransactions, {
					method: 'popup_update_confirm_transaction_dialog_pending_transactions',
					data: {
						pendingTransactionAndSignableMessages: [makePendingTransaction(new Date('2024-01-01T00:00:05.000Z'))],
						currentBlockNumber: 123n,
						rpcConnectionStatus: undefined,
					},
				}),
			})
		})

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

		await act(() => {
			browser.dispatch({
				role: 'all',
				...serialize(UpdateConfirmTransactionDialogPendingTransactions, {
					method: 'popup_update_confirm_transaction_dialog_pending_transactions',
					data: {
						pendingTransactionAndSignableMessages: [makePendingTransaction(new Date('2024-01-01T00:00:05.000Z'), 1_250_000_000_000_000_000n)],
						currentBlockNumber: 123n,
						rpcConnectionStatus: undefined,
					},
				}),
			})
		})
		assert.equal(dom.document.body.textContent?.includes('1.25 ether'), true)

		await unmountConfirmTransaction(dom)
		clock.restore()
		dom.restore()
	})

	test('updates the simulation age when the real refresh flow runs', { timeout: 15_000 }, async () => {
		const dom = installDomMock()
		const clock = installDateMock('2024-01-01T00:00:10.000Z')
		const browser = createBrowserMock()
		const olderPendingTransaction = makePendingTransaction(new Date('2024-01-01T00:00:05.000Z'))
		const { updateInterceptorTransactionStack, getPendingTransactionsAndMessages } = await import('../../app/ts/background/storageVariables.js')
		const { refreshPopupConfirmTransactionSimulation } = await import('../../app/ts/background/popupMessageHandlers.js')
		const { browserStorageLocalSet2 } = await import('../../app/ts/utils/storageUtils.js')

		const simulator = await createFakeSimulator()

		await browserStorageLocalSet2({
			pendingTransactionsAndMessages: [olderPendingTransaction],
		})
		await updateInterceptorTransactionStack(() => ({ operations: [] }))

		await act(async () => {
			await refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService as never)
		})

		const [refreshedPendingTransaction] = await getPendingTransactionsAndMessages()
		if (refreshedPendingTransaction === undefined || refreshedPendingTransaction.type !== 'Transaction') throw new Error('missing refreshed pending transaction')
		assert.ok(
			refreshedPendingTransaction.popupVisualisation.data.simulationState.simulationConductedTimestamp.getTime() >
			olderPendingTransaction.popupVisualisation.data.simulationState.simulationConductedTimestamp.getTime(),
		)

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})

		await act(() => {
			browser.dispatch({
				role: 'all',
				...serialize(UpdateConfirmTransactionDialogPendingTransactions, {
					method: 'popup_update_confirm_transaction_dialog_pending_transactions',
					data: {
						pendingTransactionAndSignableMessages: [refreshedPendingTransaction],
						currentBlockNumber: 123n,
						rpcConnectionStatus: undefined,
					},
				}),
			})
		})

		assert.equal(dom.document.body.textContent?.includes('Simulated 0s ago'), true)

		await unmountConfirmTransaction(dom)
		clock.restore()
		dom.restore()
	})
	test('keeps the send-anyway override across per-block re-simulations and clears it when the acknowledged failure or request changes', async () => {
		const dom = installDomMock()
		const browser = createBrowserMock()
		const reviewed = { ...makeSimulatedPendingTransaction(0n, revertedOutcome), resultRevision: 1 }
		// A new block re-simulates the request: timestamps, block and base fee change, the failure does not.
		const resimulated = (resultRevision: number, pending: typeof reviewed) => ({
			...pending,
			resultRevision,
			popupVisualisation: {
				...pending.popupVisualisation,
				data: {
					...pending.popupVisualisation.data,
					simulationStartedTimestamp: new Date('2024-01-01T00:00:12.000Z'),
					simulationState: { ...pending.popupVisualisation.data.simulationState, blockNumber: 124n, baseFeePerGas: 7n, simulationConductedTimestamp: new Date('2024-01-01T00:00:13.000Z') },
				},
			},
		})
		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})

		await dispatchPendingTransactions(browser, [reviewed])
		assert.equal(isConfirmEnabled(dom), false, 'a failing result needs the override')
		await tickSendAnyway(dom)
		assert.equal(isSendAnywayTicked(dom), true)
		assert.equal(isConfirmEnabled(dom), true)

		await dispatchPendingTransactions(browser, [reviewed])
		assert.equal(isSendAnywayTicked(dom), true, 'identical redelivery keeps the override')
		await dispatchPendingTransactions(browser, [resimulated(2, reviewed)])
		assert.equal(isSendAnywayTicked(dom), true, 'a re-simulation with the same failure keeps the override')
		assert.equal(isConfirmEnabled(dom), true)

		const insufficientFunds = { transactionStatus: 'Transaction Failed' as const, error: { code: -32000, message: 'insufficient funds', decodedErrorMessage: 'insufficient funds' } }
		const differentFailure = { ...makeSimulatedPendingTransaction(0n, insufficientFunds), resultRevision: 3 }
		await dispatchPendingTransactions(browser, [differentFailure])
		assert.equal(isSendAnywayTicked(dom), false, 'a different failure needs a new acknowledgement')
		assert.equal(isConfirmEnabled(dom), false)

		await tickSendAnyway(dom)
		const newQuarantineReason = { ...makeSimulatedPendingTransaction(0n, { ...insufficientFunds, quarantine: true, quarantineReasons: ['The recipient is a known scam address.'] }), resultRevision: 4 }
		await dispatchPendingTransactions(browser, [newQuarantineReason])
		assert.equal(isSendAnywayTicked(dom), false, 'a new quarantine reason needs a new acknowledgement')

		await tickSendAnyway(dom)
		await dispatchPendingTransactions(browser, [{ ...newQuarantineReason, uniqueRequestIdentifier: { ...newQuarantineReason.uniqueRequestIdentifier, requestId: 2 } }])
		assert.equal(isSendAnywayTicked(dom), false, 'the override does not carry over to the next request')
		assert.equal(isConfirmEnabled(dom), false)

		await unmountConfirmTransaction(dom)
		dom.restore()
	})

	test('an approval in flight accepts only the result the user clicked on', { timeout: 15_000 }, async () => {
		const dom = installDomMock()
		const browser = createBrowserMock()
		const simulator = await createFakeSimulator()
		const { TokenPriceService } = await import('../../app/ts/simulation/services/priceEstimator.js')
		const { TransactionConfirmation } = await import('../../app/ts/types/interceptor-messages.js')
		const { resolvePendingTransactionOrMessage } = await import('../../app/ts/background/windows/confirmTransaction.js')
		const { getInterceptorTransactionStack, getPendingTransactionsAndMessages, updateInterceptorTransactionStack, updatePendingTransactionOrMessage } = await import('../../app/ts/background/storageVariables.js')
		const { browserStorageLocalSet2 } = await import('../../app/ts/utils/storageUtils.js')
		const reviewed = makeSimulatedPendingTransaction(0n, revertedOutcome)
		const refreshed = makeSimulatedPendingTransaction(0n, { transactionStatus: 'Transaction Failed', error: { code: -32000, message: 'insufficient funds', decodedErrorMessage: 'insufficient funds' } })
		await browserStorageLocalSet2({ pendingTransactionsAndMessages: [reviewed] })
		await updateInterceptorTransactionStack(() => ({ operations: [] }))

		const windowRequested = Promise.withResolvers<void>()
		const windowReleased = Promise.withResolvers<void>()
		browser.setCurrentWindowProvider(async () => {
			windowRequested.resolve()
			await windowReleased.promise
			return { id: 1 }
		})
		const acceptReachedBackground = Promise.withResolvers<{ accept: unknown, resolution: Promise<boolean | undefined> }>()
		browser.setConfirmDialogHandler(async (message) => {
			const accept = TransactionConfirmation.parse(message)
			const resolution = resolvePendingTransactionOrMessage(simulator.ethereum, new TokenPriceService(simulator.ethereum, 60_000), new Map(), accept)
			acceptReachedBackground.resolve({ accept, resolution })
			await resolution
		})

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})
		await dispatchPendingTransactions(browser, await getPendingTransactionsAndMessages())
		await tickSendAnyway(dom)
		const confirmButton = findConfirmButton(dom)
		if (confirmButton === undefined) throw new Error('Expected the confirm button')
		await act(async () => { await clickRenderedElement(confirmButton) })
		await windowRequested.promise

		// A new block re-simulates the request while the approval still waits for its window.
		await updatePendingTransactionOrMessage(reviewed.uniqueRequestIdentifier, async (pending) => ({ ...pending, popupVisualisation: refreshed.popupVisualisation }))
		await dispatchPendingTransactions(browser, await getPendingTransactionsAndMessages())
		windowReleased.resolve()
		const { accept, resolution } = await acceptReachedBackground.promise
		await act(async () => { await resolution })

		const pendingAfterApproval = await getPendingTransactionsAndMessages()
		assert.equal(pendingAfterApproval.length, 1, 'the request stays pending')
		assert.equal(pendingAfterApproval[0]?.resultRevision, 1)
		assert.equal(pendingAfterApproval[0]?.approvalStatus.status, 'WaitingForUser')
		assert.deepEqual((await getInterceptorTransactionStack()).operations, [], 'nothing was added to the simulation')
		assert.deepEqual(accept, { method: 'popup_confirmDialog', data: { uniqueRequestIdentifier: reviewed.uniqueRequestIdentifier, action: 'accept', resultRevision: 0, forceSend: true } }, 'the accept names the clicked result')
		assert.equal(isSendAnywayTicked(dom), false, 'the refreshed result needs a new acknowledgement')

		await unmountConfirmTransaction(dom)
		dom.restore()
	})
})
