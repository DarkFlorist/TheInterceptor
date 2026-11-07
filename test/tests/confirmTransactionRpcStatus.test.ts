import * as assert from 'assert'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import { installDomMock } from './domMock.js'

type RuntimeMessageListener = (message: unknown) => unknown

type TestDomNode = {
	readonly tagName?: string
	readonly parentNode?: TestDomNode | null
	readonly childNodes?: readonly TestDomNode[]
	readonly textContent?: string | null
	readonly attributes?: Record<string, string | undefined>
	readonly l?: Record<string, (event: unknown) => unknown>
}

function collectElements(node: TestDomNode | undefined, tagName: string, results: TestDomNode[] = []) {
	if (node?.tagName === tagName.toUpperCase()) results.push(node)
	for (const child of node?.childNodes ?? []) collectElements(child, tagName, results)
	return results
}

async function clickElement(element: TestDomNode) {
	const clickHandler = element.l === undefined ? undefined : Object.entries(element.l).find(([key]) => key.startsWith('Click'))?.[1]
	if (clickHandler === undefined) throw new Error('Expected click handler')
	await clickHandler({ currentTarget: element, stopPropagation() { return undefined } })
}

function installBrowserMock(sendMessageOverride?: (message: unknown, sentMessages: unknown[]) => unknown) {
	const listeners: RuntimeMessageListener[] = []
	const storageState: Record<string, unknown> = {}
	const sentMessages: unknown[] = []

	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: null,
				async sendMessage(message: unknown) {
					sentMessages.push(message)
					if (sendMessageOverride !== undefined) return await sendMessageOverride(message, sentMessages)
					if (typeof message === 'object' && message !== null && 'method' in message) {
						const typedMessage = message as { method?: string }
						if (typedMessage.method === 'popup_isMainPopupWindowOpen') {
							return { method: 'popup_isMainPopupWindowOpen', data: { isOpen: false } }
						}
						if (typedMessage.method === 'popup_readyAndListening') {
							return { method: 'popup_readyAndListening', data: { popupOrTabId: { type: 'popup', id: 1 } } }
						}
					}
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
					async get(keys?: string | string[] | Record<string, unknown> | null) {
						if (keys === undefined || keys === null) return { ...storageState }
						if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
						if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
						return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
					},
					async set(items: Record<string, unknown>) {
						Object.assign(storageState, items)
					},
					async remove(keys: string | string[]) {
						for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
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
			declarativeNetRequest: {
				async getDynamicRules() { return [] },
				async getSessionRules() { return [] },
				async updateDynamicRules() { return undefined },
				async updateSessionRules() { return undefined },
			},
		},
	})
	Object.defineProperty(globalThis, 'chrome', {
		configurable: true,
		writable: true,
		value: { runtime: { id: 'test-extension' } },
	})

	return {
		sentMessages,
		getSentMessages() {
			return [...sentMessages]
		},
		dispatch(message: unknown) {
			for (const listener of [...listeners]) listener(message)
		},
	}
}

function isApprovalDisabled(dom: ReturnType<typeof installDomMock>) {
	const approveButton = collectElements(dom.document.body, 'button').find((button) => button.attributes?.class?.includes('dialog-action-button') === true && !button.attributes.class.includes('is-danger'))
	if (approveButton === undefined) throw new Error('Expected the approve button')
	return approveButton.attributes?.disabled !== undefined
}

async function unmountConfirmTransaction(dom: ReturnType<typeof installDomMock>) {
	await act(() => {
		render(null, dom.document.body)
	})
}

function makePendingTransaction(errorMessage = 'simulation failed') {
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
			value: 0n,
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
			message: errorMessage,
		},
	}

	return {
		type: 'Transaction' as const,
		transactionOrMessageCreationStatus: 'FailedToSimulate' as const,
		popupOrTabId: { type: 'popup' as const, id: 1 },
		originalRequestParameters,
		uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } },
		simulationMode: false,
		activeAddress,
		created,
		transactionIdentifier,
		requestedChainId: 1n,
		transactionToSimulate,
		website,
		approvalStatus: { status: 'WaitingForUser' as const },
		popupVisualisation: {
			statusCode: 'failed' as const,
			data: {
				activeAddress,
				simulationMode: false,
				simulationStartedTimestamp: created,
				uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } },
				transactionToSimulate,
				signerName: 'NoSignerDetected' as const,
				confirmationRunId: { lifetime: 'fixture', sequence: 1 },
				error: {
					code: -32000,
					message: errorMessage,
					decodedErrorMessage: errorMessage,
				},
				simulationState: {
					blockNumber: 123n,
					simulationConductedTimestamp: created,
				},
			},
		},
	}
}

// A plain transfer that simulated successfully, so the window renders its real approve button.
async function makeSimulatedPendingTransaction(approvalStatus: { readonly status: 'WaitingForUser' | 'WaitingForSigner' }) {
	const { getNativeTokenErc20 } = await import('../../app/ts/background/metadataUtils.js')
	const failed = makeUnexpectedSimulationFailurePendingTransaction('unused')
	const { transactionToSimulate, created, website, originalRequestParameters, transactionIdentifier, uniqueRequestIdentifier } = failed
	const rpcNetwork = { name: 'Ethereum Mainnet', chainId: 1n, httpsRpc: 'https://rpc.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	const sender = { type: 'contact' as const, name: 'Sender', address: 0x1111111111111111111111111111111111111111n, entrySource: 'User' as const, chainId: 1n }
	const recipient = { type: 'contact' as const, name: 'Recipient', address: 0x2222222222222222222222222222222222222222n, entrySource: 'User' as const, chainId: 1n }
	return {
		...failed,
		approvalStatus,
		popupVisualisation: {
			statusCode: 'success' as const,
			data: {
				activeAddress: sender.address,
				simulationMode: false,
				simulationStartedTimestamp: created,
				uniqueRequestIdentifier,
				transactionToSimulate,
				signerName: 'MetaMask' as const,
				confirmationRunId: { lifetime: 'fixture', sequence: 1 },
				addressBookEntries: [sender, recipient, getNativeTokenErc20(rpcNetwork)],
				tokenPriceEstimates: [],
				namedTokenIds: [],
				simulationState: { success: true as const, simulationStateInput: [], simulatedBlocks: [], blockNumber: 123n, blockTimestamp: created, baseFeePerGas: 1n, simulationConductedTimestamp: created, rpcNetwork },
				visualizedSimulationState: {
					success: true as const,
					visualizedBlocks: [{
						simulatedAndVisualizedTransactions: [{
							website,
							created,
							parsedInputData: { type: 'NonParsed' as const, input: new Uint8Array() },
							transactionIdentifier,
							originalRequestParameters,
							tokenBalancesAfter: [],
							tokenPriceEstimates: [],
							tokenPriceQuoteToken: undefined,
							gasSpent: 21_000n,
							realizedGasPrice: 1n,
							quarantine: false,
							quarantineReasons: [],
							transactionStatus: 'Transaction Succeeded' as const,
							transaction: { ...transactionToSimulate.transaction, from: sender, to: recipient, rpcNetwork, hash: 1n },
							events: [],
						}],
						visualizedPersonalSignRequests: [],
						blockTimeManipulation: { type: 'AddToTimestamp' as const, deltaToAdd: 0n, deltaUnit: 'Seconds' as const },
					}],
				},
			},
		},
	}
}

// Holds the reads of the stored pending transactions that shouldHold selects, each with the value storage had when it was made, until the test releases it.
function holdStoredPendingTransactionReads(shouldHold: () => boolean = () => true) {
	const { local } = globalThis.browser.storage
	const read = local.get.bind(local)
	const heldReads: (() => void)[] = []
	Object.defineProperty(local, 'get', {
		configurable: true,
		value: async (keys: Parameters<typeof read>[0]) => {
			const held = shouldHold() && Array.isArray(keys) && keys.includes('pendingTransactionsAndMessages')
			const stored = await read(keys)
			if (!held) return stored
			await new Promise<void>((resolve) => { heldReads.push(resolve) })
			return stored
		},
	})
	return {
		get count() { return heldReads.length },
		release: async (index: number) => {
			heldReads[index]?.()
			await new Promise((resolve) => setTimeout(resolve, 25))
		},
	}
}

function makeUnexpectedSimulationFailurePendingTransaction(errorMessage: string) {
	const failedPendingTransaction = makePendingTransaction(errorMessage)
	const originalTransaction = failedPendingTransaction.originalRequestParameters.params[0]
	const transactionToSimulate = {
		website: failedPendingTransaction.website,
		created: failedPendingTransaction.created,
		originalRequestParameters: failedPendingTransaction.originalRequestParameters,
		transactionIdentifier: failedPendingTransaction.transactionIdentifier,
		success: true as const,
		transaction: {
			type: '1559' as const,
			from: originalTransaction.from,
			nonce: 0n,
			maxFeePerGas: originalTransaction.maxFeePerGas,
			maxPriorityFeePerGas: originalTransaction.maxPriorityFeePerGas,
			gas: originalTransaction.gas,
			to: originalTransaction.to,
			value: originalTransaction.value,
			input: originalTransaction.input,
			chainId: 1n,
			accessList: [],
		},
	}
	return {
		...failedPendingTransaction,
		transactionOrMessageCreationStatus: 'Simulated' as const,
		transactionToSimulate,
		popupVisualisation: {
			...failedPendingTransaction.popupVisualisation,
			data: {
				...failedPendingTransaction.popupVisualisation.data,
				transactionToSimulate,
			},
		},
	}
}

describe('confirm transaction rpc status bootstrap', () => {
	test('includes rpcConnectionStatus in the initial payload and renders the warning before later push events', async () => {
		const browser = installBrowserMock()
		const dom = installDomMock()
		const [
			{ browserStorageLocalSet, browserStorageLocalSet2 },
			{ defaultActiveAddresses, defaultRpcs },
			{ setRpcConnectionStatus },
			{ updateConfirmTransactionView },
			{ ConfirmTransaction },
			{ EthereumClientService },
			{ TokenPriceService },
		] = await Promise.all([
			import('../../app/ts/utils/storageUtils.js'),
			import('../../app/ts/background/settings.js'),
			import('../../app/ts/background/storageVariables.js'),
			import('../../app/ts/background/windows/confirmTransaction.js'),
			import('../../app/ts/components/pages/ConfirmTransaction.js'),
			import('../../app/ts/simulation/services/EthereumClientService.js'),
			import('../../app/ts/simulation/services/priceEstimator.js'),
		])

		const [defaultAddress] = defaultActiveAddresses
		if (defaultAddress === undefined) throw new Error('missing default address')
		const rpcNetwork = defaultRpcs[0]
		if (rpcNetwork === undefined) throw new Error('missing default rpc')

		await browserStorageLocalSet({
			independentActiveSimulationAddress: defaultAddress.address,
			openedPageV2: { page: 'Home' },
			useSignersAddressAsActiveAddress: false,
			websiteAccess: [],
			activeRpcNetwork: rpcNetwork,
			simulationMode: false,
			makeCurrentAddressRich: false,
			fixedAddressRichList: [],
		})
		await browserStorageLocalSet2({
			pendingTransactionsAndMessages: [makePendingTransaction()],
		})
		await setRpcConnectionStatus({
			isConnected: false,
			lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'),
			latestBlock: undefined,
			rpcNetwork,
			retrying: false,
		})

		const ethereum = new EthereumClientService({
			rpcUrl: rpcNetwork.httpsRpc,
			clearCache() { /* noop test stub */ },
			async jsonRpcRequest(rpcRequest: { method: string }) {
				if (rpcRequest.method === 'eth_blockNumber') return '0x7b'
				throw new Error(`Unexpected RPC method: ${ rpcRequest.method }`)
			},
		}, async () => undefined, async () => undefined, rpcNetwork)
		const tokenPriceService = new TokenPriceService(ethereum, 0)

		await updateConfirmTransactionView(ethereum, tokenPriceService)

		const initialMessage = browser.sentMessages.find((message) =>
			typeof message === 'object'
			&& message !== null
			&& 'method' in message
			&& message.method === 'popup_update_confirm_transaction_dialog'
		)
		if (initialMessage === undefined || typeof initialMessage !== 'object' || initialMessage === null || !('data' in initialMessage)) {
			throw new Error('missing initial confirm transaction dialog message')
		}

		assert.equal(
			typeof initialMessage.data === 'object'
				&& initialMessage.data !== null
				&& 'rpcConnectionStatus' in initialMessage.data
				&& initialMessage.data.rpcConnectionStatus !== undefined
				&& initialMessage.data.rpcConnectionStatus.retrying === false,
			true,
		)

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})

		await act(() => {
			browser.dispatch(initialMessage)
		})

		assert.equal(dom.document.body.textContent?.includes('Retrying resumes when the extension becomes active.'), true)
		await unmountConfirmTransaction(dom)
		dom.restore()
	})

	test('hydrates from a later bootstrap reply when the first ready handshake happens before pending data exists', async () => {
		const dom = installDomMock()
		const pendingTransaction = makePendingTransaction()
		const { createPassthroughCompleteVisualizedSimulation } = await import('../../app/ts/types/visualizer-types.js')
		const { serialize } = await import('../../app/ts/types/wire-types.js')
		const { PopupRequestsReplies } = await import('../../app/ts/types/interceptor-reply-messages.js')
		const browser = installBrowserMock((message) => {
			if (typeof message !== 'object' || message === null || !('method' in message)) return undefined
			const typedMessage = message as { method?: string }
			if (typedMessage.method === 'popup_readyAndListening') {
				const readyCalls = browser.getSentMessages().filter((sentMessage) =>
					typeof sentMessage === 'object'
					&& sentMessage !== null
					&& 'method' in sentMessage
					&& sentMessage.method === 'popup_readyAndListening'
				).length
				if (readyCalls === 1) return undefined
				return serialize(PopupRequestsReplies.popup_readyAndListening, {
					method: 'popup_readyAndListening',
					data: {
						popupOrTabId: { type: 'popup', id: 1 },
						confirmTransactionBootstrap: {
							pendingTransactionAndSignableMessages: [pendingTransaction],
							currentBlockNumber: 123n,
							rpcConnectionStatus: undefined,
							visualizedSimulatorState: createPassthroughCompleteVisualizedSimulation(),
						},
					},
				})
			}
			if (typedMessage.method === 'popup_requestSettings') return undefined
			return undefined
		})
		const { ConfirmTransaction, CONFIRM_TRANSACTION_BOOTSTRAP_RETRY_DELAY_MS } = await import('../../app/ts/components/pages/ConfirmTransaction.js')

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})

		await new Promise((resolve) => setTimeout(resolve, CONFIRM_TRANSACTION_BOOTSTRAP_RETRY_DELAY_MS + 50))

		const readyCalls = browser.getSentMessages().filter((message) =>
			typeof message === 'object'
			&& message !== null
			&& 'method' in message
			&& message.method === 'popup_readyAndListening'
		).length
		assert.equal(readyCalls >= 2, true)

		assert.equal(dom.document.body.textContent?.includes('simulation failed'), true)
		assert.equal(dom.document.body.textContent?.includes('Initializing...'), false)
		await unmountConfirmTransaction(dom)
		dom.restore()
	})

	test('does not let a late bootstrap reply overwrite pushed pending transaction data', async () => {
		const dom = installDomMock()
		const stalePendingTransaction = makePendingTransaction('stale bootstrap transaction')
		const freshPendingTransaction = makePendingTransaction('fresh pushed transaction')
		const { createPassthroughCompleteVisualizedSimulation } = await import('../../app/ts/types/visualizer-types.js')
		const { serialize } = await import('../../app/ts/types/wire-types.js')
		const { UpdateConfirmTransactionDialogPendingTransactions } = await import('../../app/ts/types/interceptor-messages.js')
		const { PopupRequestsReplies } = await import('../../app/ts/types/interceptor-reply-messages.js')
		const browser = installBrowserMock(async (message) => {
			if (typeof message !== 'object' || message === null || !('method' in message)) return undefined
			const typedMessage = message as { method?: string }
			if (typedMessage.method === 'popup_readyAndListening') {
				await new Promise((resolve) => setTimeout(resolve, 25))
				return serialize(PopupRequestsReplies.popup_readyAndListening, {
					method: 'popup_readyAndListening',
					data: {
						popupOrTabId: { type: 'popup', id: 1 },
						confirmTransactionBootstrap: {
							pendingTransactionAndSignableMessages: [stalePendingTransaction],
							currentBlockNumber: 123n,
							rpcConnectionStatus: undefined,
							visualizedSimulatorState: createPassthroughCompleteVisualizedSimulation(),
						},
					},
				})
			}
			if (typedMessage.method === 'popup_requestSettings') return undefined
			return undefined
		})
		const { ConfirmTransaction } = await import('../../app/ts/components/pages/ConfirmTransaction.js')

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})

		await act(() => {
			browser.dispatch({
				role: 'all',
				...serialize(UpdateConfirmTransactionDialogPendingTransactions, {
					method: 'popup_update_confirm_transaction_dialog_pending_transactions',
					data: {
						pendingTransactionAndSignableMessages: [freshPendingTransaction],
						currentBlockNumber: 124n,
						rpcConnectionStatus: undefined,
					},
				}),
			})
		})
		await new Promise((resolve) => setTimeout(resolve, 50))

		assert.equal(dom.document.body.textContent?.includes('fresh pushed transaction'), true)
		assert.equal(dom.document.body.textContent?.includes('stale bootstrap transaction'), false)
		await unmountConfirmTransaction(dom)
		dom.restore()
	})

	test('shows the stored pending transactions when the chain changes, as a refusal may have been lifted', async () => {
		const dom = installDomMock()
		const { serialize } = await import('../../app/ts/types/wire-types.js')
		const { UpdateConfirmTransactionDialogPendingTransactions } = await import('../../app/ts/types/interceptor-messages.js')
		const { browserStorageLocalSet2 } = await import('../../app/ts/utils/storageUtils.js')
		const browser = installBrowserMock()
		const { ConfirmTransaction } = await import('../../app/ts/components/pages/ConfirmTransaction.js')
		const dispatchChainUpdate = async () => {
			await act(() => { browser.dispatch({ role: 'all', method: 'popup_chain_update' }) })
			await new Promise((resolve) => setTimeout(resolve, 25))
		}

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})
		await act(() => {
			browser.dispatch({
				role: 'all',
				...serialize(UpdateConfirmTransactionDialogPendingTransactions, {
					method: 'popup_update_confirm_transaction_dialog_pending_transactions',
					data: {
						pendingTransactionAndSignableMessages: [makePendingTransaction('transaction before the chain change')],
						currentBlockNumber: 124n,
						rpcConnectionStatus: undefined,
					},
				}),
			})
		})
		await new Promise((resolve) => setTimeout(resolve, 25))
		assert.equal(dom.document.body.textContent?.includes('transaction before the chain change'), true)

		// With nothing stored the window keeps what it shows until the background closes it.
		await dispatchChainUpdate()
		assert.equal(dom.document.body.textContent?.includes('transaction before the chain change'), true)

		await browserStorageLocalSet2({ pendingTransactionsAndMessages: [makePendingTransaction('transaction after the chain change')] })
		await dispatchChainUpdate()
		assert.equal(dom.document.body.textContent?.includes('transaction after the chain change'), true)
		assert.equal(dom.document.body.textContent?.includes('transaction before the chain change'), false)

		await browserStorageLocalSet2({ pendingTransactionsAndMessages: [makePendingTransaction('transaction after a stored change')] })
		await act(() => { browser.dispatch({ role: 'confirmTransaction', method: 'popup_confirm_transaction_stored_state_changed' }) })
		await new Promise((resolve) => setTimeout(resolve, 25))
		assert.equal(dom.document.body.textContent?.includes('transaction after a stored change'), true)
		await unmountConfirmTransaction(dom)
		dom.restore()
	})

	test('a chain-change read that a newer push overtook does not re-enable approval', async () => {
		const dom = installDomMock()
		const { serialize } = await import('../../app/ts/types/wire-types.js')
		const { UpdateConfirmTransactionDialogPendingTransactions } = await import('../../app/ts/types/interceptor-messages.js')
		const { browserStorageLocalSet2 } = await import('../../app/ts/utils/storageUtils.js')
		const browser = installBrowserMock()
		const { ConfirmTransaction } = await import('../../app/ts/components/pages/ConfirmTransaction.js')
		const push = async (status: 'WaitingForUser' | 'WaitingForSigner') => {
			const pendingTransaction = await makeSimulatedPendingTransaction({ status })
			await act(() => {
				browser.dispatch({
					role: 'all',
					...serialize(UpdateConfirmTransactionDialogPendingTransactions, {
						method: 'popup_update_confirm_transaction_dialog_pending_transactions',
						data: { pendingTransactionAndSignableMessages: [pendingTransaction], currentBlockNumber: 124n, rpcConnectionStatus: undefined },
					}),
				})
			})
			await new Promise((resolve) => setTimeout(resolve, 25))
		}

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})
		await push('WaitingForUser')
		assert.equal(isApprovalDisabled(dom), false)

		await browserStorageLocalSet2({ pendingTransactionsAndMessages: [await makeSimulatedPendingTransaction({ status: 'WaitingForUser' })] })
		const reads = holdStoredPendingTransactionReads()
		await act(() => { browser.dispatch({ role: 'all', method: 'popup_chain_update' }) })
		assert.equal(reads.count, 1)

		await push('WaitingForSigner')
		await act(async () => { await reads.release(0) })
		assert.equal(dom.document.body.textContent?.includes('Waiting for'), true)
		assert.equal(isApprovalDisabled(dom), true)
		await unmountConfirmTransaction(dom)
		dom.restore()
	})

	test('of two overlapping chain-change reads only the later one is shown', async () => {
		const dom = installDomMock()
		const { browserStorageLocalSet2 } = await import('../../app/ts/utils/storageUtils.js')
		const browser = installBrowserMock()
		const { ConfirmTransaction } = await import('../../app/ts/components/pages/ConfirmTransaction.js')

		await browserStorageLocalSet2({ pendingTransactionsAndMessages: [makePendingTransaction('transaction before the chain changes')] })
		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})
		await new Promise((resolve) => setTimeout(resolve, 25))
		const reads = holdStoredPendingTransactionReads()

		await browserStorageLocalSet2({ pendingTransactionsAndMessages: [makePendingTransaction('transaction of the first read')] })
		await act(() => { browser.dispatch({ role: 'all', method: 'popup_chain_update' }) })
		await browserStorageLocalSet2({ pendingTransactionsAndMessages: [makePendingTransaction('transaction of the second read')] })
		await act(() => { browser.dispatch({ role: 'all', method: 'popup_chain_update' }) })
		assert.equal(reads.count, 2)

		await act(async () => { await reads.release(1) })
		await act(async () => { await reads.release(0) })
		assert.equal(dom.document.body.textContent?.includes('transaction of the second read'), true)
		assert.equal(dom.document.body.textContent?.includes('transaction of the first read'), false)
		await unmountConfirmTransaction(dom)
		dom.restore()
	})

	// The real background and the real window in one process: what the background sends reaches the window in order, and the only things held are the block number of the network the user left and, if asked, the window's own read.
	async function setUpApprovalOnOtherNetwork(shouldHoldClearingRead: boolean, blockNumbers: { readonly onRequestedNetwork?: () => Promise<unknown>, readonly otherNetworkFails?: boolean } = {}) {
		const dom = installDomMock()
		let relayingChainUpdate = false
		const browser = installBrowserMock(async (message) => {
			if (typeof message !== 'object' || message === null || !('method' in message)) return undefined
			if (message.method === 'popup_isMainPopupWindowOpen') return { method: 'popup_isMainPopupWindowOpen', data: { isOpen: false } }
			if (!('role' in message)) return undefined
			relayingChainUpdate = message.method === 'popup_chain_update'
			browser.dispatch(message)
			relayingChainUpdate = false
			return undefined
		})
		const { changeActiveAddressAndChain } = await import('../../app/ts/background/activeSettings.js')
		const { getPendingTransactionsAndMessages } = await import('../../app/ts/background/storageVariables.js')
		const { browserStorageLocalSet2 } = await import('../../app/ts/utils/storageUtils.js')
		const { EthereumClientService } = await import('../../app/ts/simulation/services/EthereumClientService.js')
		const { TokenPriceService } = await import('../../app/ts/simulation/services/priceEstimator.js')
		const { createDeferredValue, createTestSimulationServicesOwner } = await import('./backgroundEthAccountsTestHarness.js')
		const { ConfirmTransaction } = await import('../../app/ts/components/pages/ConfirmTransaction.js')

		const requestedNetwork = { name: 'Requested Chain', chainId: 1n, httpsRpc: 'https://requested.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
		const otherNetwork = { ...requestedNetwork, name: 'Other Chain', chainId: 8453n, httpsRpc: 'https://other.invalid' }
		const blockNumberReached = createDeferredValue<undefined>()
		const blockNumberReleased = createDeferredValue<undefined>()
		const createServices = (rpcNetwork: typeof requestedNetwork, beforeBlockNumber: () => Promise<unknown>) => {
			const ethereum = new EthereumClientService({
				rpcUrl: rpcNetwork.httpsRpc,
				clearCache() { return undefined },
				async jsonRpcRequest(rpcRequest: { method: string }) {
					if (rpcRequest.method !== 'eth_blockNumber') throw new Error(`Unexpected RPC request ${ rpcRequest.method }`)
					await beforeBlockNumber()
					return '0x7b'
				},
			}, async () => undefined, async () => undefined, rpcNetwork)
			return { ethereum, tokenPriceService: new TokenPriceService(ethereum, 60_000) }
		}
		const requestedServices = createServices(requestedNetwork, blockNumbers.onRequestedNetwork ?? (async () => undefined))
		const otherServices = createServices(otherNetwork, async () => {
			blockNumberReached.resolve(undefined)
			await blockNumberReleased.promise
			if (blockNumbers.otherNetworkFails === true) throw new TypeError('Failed to fetch')
		})
		const simulationServicesOwner = createTestSimulationServicesOwner(requestedServices, (network) => network.chainId === otherNetwork.chainId ? otherServices : requestedServices)
		const switchNetwork = async (rpcNetwork: typeof requestedNetwork) => await changeActiveAddressAndChain(simulationServicesOwner, new Map(), { simulationMode: false, rpcNetwork })
		const settle = async () => await new Promise((resolve) => setTimeout(resolve, 25))

		const pendingTransaction = await makeSimulatedPendingTransaction({ status: 'WaitingForUser' })
		await browserStorageLocalSet2({ pendingTransactionsAndMessages: [pendingTransaction] })
		await switchNetwork(otherNetwork)
		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})
		await settle()

		const getStoredApprovalStatus = async () => (await getPendingTransactionsAndMessages())[0]?.approvalStatus
		const reads = holdStoredPendingTransactionReads(() => relayingChainUpdate && shouldHoldClearingRead)
		return {
			dom, otherServices, pendingTransaction, reads, settle, simulationServicesOwner, getStoredApprovalStatus,
			blockNumberReached: blockNumberReached.promise,
			releaseBlockNumber: () => blockNumberReleased.resolve(undefined),
			switchBack: async () => await switchNetwork(requestedNetwork),
			expectNoRefusalShown: async () => {
				assert.deepEqual(await getStoredApprovalStatus(), { status: 'WaitingForUser' })
				assert.equal(dom.document.body.textContent?.includes('The active network changed'), false)
				assert.equal(isApprovalDisabled(dom), false)
			},
		}
	}

	for (const clearingRead of ['still running', 'finished'] as const) {
		test(`a refusal that outlived a switch back cannot return to the window when the clearing read is ${ clearingRead } as its update completes`, async () => {
			const race = await setUpApprovalOnOtherNetwork(clearingRead === 'still running')
			const { resolvePendingTransactionOrMessage } = await import('../../app/ts/background/windows/confirmTransaction.js')

			// The approval is refused on the other network, and its window update waits for that network's block number.
			const approval = resolvePendingTransactionOrMessage(race.otherServices.ethereum, race.otherServices.tokenPriceService, new Map(), {
				method: 'popup_confirmDialog',
				data: { action: 'accept', uniqueRequestIdentifier: race.pendingTransaction.uniqueRequestIdentifier },
			})
			await race.blockNumberReached
			await race.settle()
			assert.equal((await race.getStoredApprovalStatus())?.status, 'SignerError')

			await race.switchBack()
			assert.deepEqual(await race.getStoredApprovalStatus(), { status: 'WaitingForUser' })
			assert.equal(race.reads.count, clearingRead === 'still running' ? 1 : 0)
			await race.settle()

			race.releaseBlockNumber()
			await approval
			await race.settle()
			await act(async () => { await race.reads.release(0) })
			await act(async () => { await race.settle() })

			await race.expectNoRefusalShown()
			await unmountConfirmTransaction(race.dom)
			race.dom.restore()
		})
	}

	// Both approvals take the other network's services, and the second waits behind the first, whose window update waits for that network's block number.
	async function approveTwiceOnOtherNetwork(race: Awaited<ReturnType<typeof setUpApprovalOnOtherNetwork>>) {
		const { confirmDialog } = await import('../../app/ts/background/popupMessageHandlers.js')
		const { websiteSocketToString } = await import('../../app/ts/background/backgroundUtils.js')
		const { createPort } = await import('./backgroundEthAccountsTestHarness.js')
		const { uniqueRequestIdentifier } = race.pendingTransaction
		const socket = uniqueRequestIdentifier.requestSocket
		const { port, messages } = createPort(socket.tabId)
		const websiteTabConnections = new Map([[socket.tabId, { connections: { [websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true } } }]])
		const approve = async () => await confirmDialog(race.simulationServicesOwner, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } })
		return { approvals: Promise.all([approve(), approve()]), reachedWallet: () => messages.some((message) => message.type === 'forwardToSigner') }
	}

	test('approvals on the other network are refused without waiting for its block number, and the refusal does not stay after a switch back', async () => {
		const race = await setUpApprovalOnOtherNetwork(false)
		const { approvals, reachedWallet } = await approveTwiceOnOtherNetwork(race)
		await approvals
		assert.equal((await race.getStoredApprovalStatus())?.status, 'SignerError')

		await race.switchBack()
		assert.deepEqual(await race.getStoredApprovalStatus(), { status: 'WaitingForUser' })

		race.releaseBlockNumber()
		await act(async () => { await race.settle() })

		await race.expectNoRefusalShown()
		assert.equal(reachedWallet(), false)
		await unmountConfirmTransaction(race.dom)
		race.dom.restore()
	})

	// Neither network's block number is ever answered with a value, so no view update can publish: the refusal is shown and cleared through storage alone.
	for (const rpc of ['failing', 'hanging'] as const) {
		test(`the window shows a refusal and learns that it was lifted while the RPC is ${ rpc }`, async () => {
			const { createDeferredValue } = await import('./backgroundEthAccountsTestHarness.js')
			const hangingBlockNumber = createDeferredValue<undefined>()
			const race = await setUpApprovalOnOtherNetwork(false, {
				otherNetworkFails: true,
				onRequestedNetwork: async () => {
					if (rpc === 'failing') throw new TypeError('Failed to fetch')
					await hangingBlockNumber.promise
				},
			})
			const { approvals, reachedWallet } = await approveTwiceOnOtherNetwork(race)
			await approvals
			if (rpc === 'failing') race.releaseBlockNumber()
			await act(async () => { await race.settle() })
			assert.equal(race.dom.document.body.textContent?.includes('The active network changed'), true)

			await race.switchBack()
			await act(async () => { await race.settle() })

			await race.expectNoRefusalShown()
			assert.equal(reachedWallet(), false)
			race.releaseBlockNumber()
			hangingBlockNumber.resolve(undefined)
			await unmountConfirmTransaction(race.dom)
			race.dom.restore()
		})
	}

	test('renders an unexpected simulation failure instead of a simulation spinner', async () => {
		const dom = installDomMock()
		installBrowserMock((message) => {
			if (typeof message !== 'object' || message === null || !('method' in message)) return undefined
			const typedMessage = message as { method?: string }
			if (typedMessage.method === 'popup_readyAndListening') return undefined
			if (typedMessage.method === 'popup_requestSettings') return undefined
			return undefined
		})
		const [
			{ browserStorageLocalSet2 },
			{ ConfirmTransaction },
		] = await Promise.all([
			import('../../app/ts/utils/storageUtils.js'),
			import('../../app/ts/components/pages/ConfirmTransaction.js'),
		])

		await browserStorageLocalSet2({
			pendingTransactionsAndMessages: [makeUnexpectedSimulationFailurePendingTransaction('Failed to decode ABI data')],
		})

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})
		await new Promise((resolve) => setTimeout(resolve, 25))

		assert.equal(dom.document.body.textContent?.includes('Failed to decode ABI data'), true)
		assert.equal(dom.document.body.textContent?.includes('Simulating...'), false)
		assert.equal(dom.document.body.textContent?.includes('Initializing...'), false)
		await unmountConfirmTransaction(dom)
		dom.restore()
	})

	test('opens address editing from an execution error preview', async () => {
		const dom = installDomMock()
		installBrowserMock((message) => {
			if (typeof message !== 'object' || message === null || !('method' in message)) return undefined
			const typedMessage = message as { method?: string }
			if (typedMessage.method === 'popup_readyAndListening') return undefined
			if (typedMessage.method === 'popup_requestSettings') return undefined
			return undefined
		})
		const [
			{ browserStorageLocalSet2 },
			{ ConfirmTransaction },
		] = await Promise.all([
			import('../../app/ts/utils/storageUtils.js'),
			import('../../app/ts/components/pages/ConfirmTransaction.js'),
		])

		await browserStorageLocalSet2({
			pendingTransactionsAndMessages: [makeUnexpectedSimulationFailurePendingTransaction('execution reverted')],
		})

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})
		await new Promise((resolve) => setTimeout(resolve, 25))

		assert.equal(dom.document.body.textContent?.includes('Execution error'), true)
		const toLabel = collectElements(dom.document.body, 'dt').find((term) => term.textContent?.trim() === 'To')
		if (toLabel === undefined || toLabel.parentNode === null || toLabel.parentNode === undefined) throw new Error('Expected the receiving address row')
		const toLabelIndex = toLabel.parentNode.childNodes?.indexOf(toLabel) ?? -1
		const receivingAddress = toLabel.parentNode.childNodes?.[toLabelIndex + 1]
		if (receivingAddress === undefined) throw new Error('Expected the receiving address details')
		const editAbiButton = collectElements(receivingAddress, 'button').find((button) => button.textContent?.trim() === 'edit')
		if (editAbiButton === undefined) throw new Error('Expected the receiving address edit button')

		await act(async () => {
			await clickElement(editAbiButton)
		})

		assert.equal(dom.document.body.textContent?.includes('Contract ABI'), true)
		await unmountConfirmTransaction(dom)
		dom.restore()
	})
})
