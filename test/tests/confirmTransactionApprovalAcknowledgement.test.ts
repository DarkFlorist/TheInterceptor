import * as assert from 'assert'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { test } from 'bun:test'
import { clickRenderedElement, findRenderedElement, installDomMock, type RenderedTreeNode } from './domMock.js'
import { getNativeTokenErc20 } from '../../app/ts/background/metadataUtils.js'
import { acknowledgeAndTrackBridgeRequest } from '../../app/ts/background/bridgeRequestDelivery.js'
import { RawInterceptedRequest } from '../../app/ts/utils/requests.js'

type RuntimeMessageListener = (message: unknown) => unknown

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const getAttribute = (node: RenderedTreeNode, name: string) => 'attributes' in node && isRecord(node.attributes) ? node.attributes[name] : undefined

function createBrowserMock() {
	const listeners: RuntimeMessageListener[] = []
	const sentMessages: unknown[] = []
	const storageState: Record<string, unknown> = {}
	const browser = {
		runtime: {
			lastError: undefined,
			async sendMessage(message: unknown) {
				sentMessages.push(message)
				if (isRecord(message) && message.method === 'popup_readyAndListening') return { method: 'popup_readyAndListening', data: { popupOrTabId: { type: 'popup', id: 1 } } }
				if (isRecord(message) && message.method === 'popup_isMainPopupWindowOpen') return { method: 'popup_isMainPopupWindowOpen', data: { isOpen: true } }
				return undefined
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: {
				addListener(listener: RuntimeMessageListener) { listeners.push(listener) },
				removeListener(listener: RuntimeMessageListener) {
					const index = listeners.indexOf(listener)
					if (index >= 0) listeners.splice(index, 1)
				},
			},
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get() { return { ...storageState } },
				async set(items: Record<string, unknown>) { Object.assign(storageState, items) },
				async remove() { return undefined },
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
			async getCurrent() { return await (pendingWindowLookup ?? { id: 1 }) },
			async get() { return undefined },
			async update() { return undefined },
		},
		action: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
	}
	Object.defineProperty(globalThis, 'browser', { value: browser, configurable: true, writable: true })
	Object.defineProperty(globalThis, 'chrome', { value: { runtime: { id: 'test-extension' } }, configurable: true, writable: true })
	return {
		sentMessages,
		dispatch(message: unknown) {
			for (const listener of [...listeners]) listener(message)
		},
	}
}

// Lets a test hold the popup's window lookup open, the await between a click and the approval message.
let pendingWindowLookup: Promise<{ readonly id: number }> | undefined
const holdNextWindowLookup = () => {
	let finishLookup: () => void = () => undefined
	pendingWindowLookup = new Promise((resolve) => { finishLookup = () => resolve({ id: 1 }) })
	return async () => await act(async () => {
		pendingWindowLookup = undefined
		finishLookup()
		await new Promise((resolve) => setTimeout(resolve, 0))
	})
}

const browserMock = createBrowserMock()
const { UpdateConfirmTransactionDialogPendingTransactions } = await import('../../app/ts/types/interceptor-messages.js')
const { serialize } = await import('../../app/ts/types/wire-types.js')
const { ConfirmTransaction } = await import('../../app/ts/components/pages/ConfirmTransaction.js')

const signerAddress = 0x1111111111111111111111111111111111111111n
const recipientAddress = 0x2222222222222222222222222222222222222222n
const created = new Date('2024-01-01T00:00:00.000Z')
const website = { websiteOrigin: 'https://example.test', icon: undefined, title: undefined }
const rpcNetwork = { name: 'Ethereum Mainnet', chainId: 1n, httpsRpc: 'https://rpc.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
const signerEntry = { type: 'contact' as const, name: 'Signer', address: signerAddress, entrySource: 'User' as const, chainId: 1n }
const recipientEntry = { type: 'contact' as const, name: 'Recipient', address: recipientAddress, entrySource: 'User' as const, chainId: 1n }
const walletDependentReason = 'Wallets may read this message differently, as hex-encoded bytes or text.'
const uniqueRequestIdentifier = (requestId: number) => ({ requestId, requestSocket: { tabId: 1, connectionName: 0n } })
// The extension generates one instance id per pending request; a refreshed request keeps it.
const instanceIdFor = (requestId: number, payload: string) => `instance ${ requestId } ${ payload }`

const makeQuarantinedMessage = (requestId: number, message: string, quarantineReasons = [walletDependentReason]) => {
	const originalRequestParameters = { method: 'personal_sign' as const, params: [message, signerAddress] as const }
	return {
		type: 'SignableMessage' as const,
		popupOrTabId: { type: 'popup' as const, id: 1 },
		originalRequestParameters,
		simulationMode: false,
		uniqueRequestIdentifier: uniqueRequestIdentifier(requestId),
		created,
		instanceId: instanceIdFor(requestId, message),
		website,
		activeAddress: signerAddress,
		approvalStatus: { status: 'WaitingForUser' as const },
		transactionOrMessageCreationStatus: 'Simulated' as const,
		visualizedPersonalSignRequest: {
			type: 'NotParsed' as const,
			method: 'personal_sign' as const,
			activeAddress: signerEntry,
			account: signerEntry,
			rpcNetwork,
			simulationMode: false,
			signerName: 'MetaMask' as const,
			quarantine: true,
			quarantineReasons,
			website,
			created,
			rawMessage: message,
			stringifiedMessage: JSON.stringify(message),
			// The extension hashes the request id into a non-negative identifier; any non-negative value works for the popup.
			messageIdentifier: BigInt(Math.abs(requestId)),
			isValidMessage: true,
			message,
			messageHash: undefined,
		},
	}
}

const lookalikeRecipientReason = 'The recipient is a lookalike of a known address.'
type TransactionOutcome = { readonly transactionStatus: 'Transaction Succeeded' } | { readonly transactionStatus: 'Transaction Failed', readonly error: { readonly code: number, readonly message: string, readonly decodedErrorMessage: string } }
const revertedOutcome: TransactionOutcome = { transactionStatus: 'Transaction Failed', error: { code: 3, message: 'execution reverted', decodedErrorMessage: 'execution reverted' } }

const makeQuarantinedTransaction = (requestId: number, outcome: TransactionOutcome = { transactionStatus: 'Transaction Succeeded' }, quarantineReasons = [lookalikeRecipientReason]) => {
	const transactionIdentifier = BigInt(requestId)
	const requested = { from: signerAddress, to: recipientAddress, value: 1n, gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, input: new Uint8Array() }
	const originalRequestParameters = { method: 'eth_sendTransaction' as const, params: [requested] as const }
	const transaction = { type: '1559' as const, ...requested, nonce: 0n, chainId: 1n, accessList: [] }
	const transactionToSimulate = { website, created, originalRequestParameters, transactionIdentifier, success: true as const, transaction }
	const simulatedTransaction = {
		website,
		created,
		parsedInputData: { type: 'NonParsed' as const, input: requested.input },
		transactionIdentifier,
		originalRequestParameters,
		tokenBalancesAfter: [],
		tokenPriceEstimates: [],
		tokenPriceQuoteToken: undefined,
		gasSpent: 21_000n,
		realizedGasPrice: 1n,
		quarantine: true,
		quarantineReasons,
		...outcome,
		transaction: { ...transaction, from: signerEntry, to: recipientEntry, rpcNetwork, hash: transactionIdentifier },
		events: [],
	}
	return {
		type: 'Transaction' as const,
		transactionOrMessageCreationStatus: 'Simulated' as const,
		popupOrTabId: { type: 'popup' as const, id: 1 },
		originalRequestParameters,
		uniqueRequestIdentifier: uniqueRequestIdentifier(requestId),
		simulationMode: false,
		activeAddress: signerAddress,
		created,
		instanceId: instanceIdFor(requestId, 'transaction'),
		transactionIdentifier,
		transactionToSimulate,
		website,
		approvalStatus: { status: 'WaitingForUser' as const },
		popupVisualisation: {
			statusCode: 'success' as const,
			data: {
				activeAddress: signerAddress,
				simulationMode: false,
				simulationStartedTimestamp: created,
				uniqueRequestIdentifier: uniqueRequestIdentifier(requestId),
				transactionToSimulate,
				signerName: 'MetaMask' as const,
				addressBookEntries: [signerEntry, recipientEntry, getNativeTokenErc20(rpcNetwork)],
				tokenPriceEstimates: [],
				namedTokenIds: [],
				simulationState: {
					success: true as const,
					simulationStateInput: [],
					simulatedBlocks: [],
					blockNumber: 123n,
					blockTimestamp: created,
					baseFeePerGas: 0n,
					simulationConductedTimestamp: created,
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

type PendingRequest = ReturnType<typeof makeQuarantinedMessage> | ReturnType<typeof makeQuarantinedTransaction>

const renderConfirmTransaction = async () => {
	const dom = installDomMock()
	await act(() => { render(h(ConfirmTransaction, {}), dom.document.body) })
	const pushPendingRequests = async (pendingRequests: readonly PendingRequest[]) => await act(() => {
		browserMock.dispatch({ role: 'all', ...serialize(UpdateConfirmTransactionDialogPendingTransactions, {
			method: 'popup_update_confirm_transaction_dialog_pending_transactions',
			data: { pendingTransactionAndSignableMessages: pendingRequests, currentBlockNumber: 123n, rpcConnectionStatus: undefined },
		}) })
	})
	const findCheckBox = () => findRenderedElement(dom.document.body, (node) => node.tagName === 'INPUT' && getAttribute(node, 'type') === 'checkbox')
	const findActionButton = (isReject: boolean) => {
		const button = findRenderedElement(dom.document.body, (node) => {
			const className = getAttribute(node, 'class')
			return node.tagName === 'BUTTON' && typeof className === 'string' && className.includes('dialog-action-button') && className.includes('is-danger') === isReject
		})
		if (button === undefined) throw new Error(`Missing ${ isReject ? 'reject' : 'approve' } button`)
		return button
	}
	const findApproveButton = () => findActionButton(false)
	return {
		pushPendingRequests,
		isCheckBoxShown: () => findCheckBox() !== undefined,
		isTextShown: (text: string) => dom.document.body.textContent?.includes(text) === true,
		isApproveDisabled: () => getAttribute(findApproveButton(), 'disabled') !== undefined,
		// The DOM mock does not synthesize input events, so this calls the handler Preact registered, as a user tick would.
		acknowledge: async () => {
			const checkBox = findCheckBox()
			const onInput = checkBox?.l === undefined ? undefined : Object.entries(checkBox.l).find(([key]) => key.startsWith('Input'))?.[1]
			if (checkBox === undefined || onInput === undefined) throw new Error('Missing acknowledgement checkbox')
			Object.assign(checkBox, { checked: true })
			await act(() => { onInput({ currentTarget: checkBox }) })
		},
		approve: async () => { await act(async () => { await clickRenderedElement(findApproveButton()) }) },
		reject: async () => { await act(async () => { await clickRenderedElement(findActionButton(true)) }) },
		unmount: async () => {
			await act(() => { render(null, dom.document.body) })
			dom.restore()
		},
	}
}

const getConfirmDialogDecisions = (action: 'accept' | 'reject') => browserMock.sentMessages.flatMap((message) => {
	if (!isRecord(message) || message.method !== 'popup_confirmDialog' || !isRecord(message.data) || message.data.action !== action || !isRecord(message.data.uniqueRequestIdentifier)) return []
	return [{ requestId: message.data.uniqueRequestIdentifier.requestId, instanceId: message.data.instanceId }]
})
const getAcceptedRequestIds = () => getConfirmDialogDecisions('accept').map(({ requestId }) => requestId)

test('does not carry a quarantine acknowledgement over to the next queued quarantined message', async () => {
	const popup = await renderConfirmTransaction()
	const second = makeQuarantinedMessage(2, '5369676e20696e')
	await popup.pushPendingRequests([makeQuarantinedMessage(1, '6869'), second])
	assert.equal(popup.isApproveDisabled(), true)
	await popup.acknowledge()
	assert.equal(popup.isApproveDisabled(), false)

	// The first request resolves and the background pushes the second into the same open popup.
	await popup.pushPendingRequests([second])
	assert.equal(popup.isApproveDisabled(), true)

	await popup.acknowledge()
	assert.equal(popup.isApproveDisabled(), false)
	await popup.approve()
	assert.deepEqual(getConfirmDialogDecisions('accept'), [{ requestId: 2, instanceId: second.instanceId }])
	await popup.unmount()
})

test('does not carry a quarantine acknowledgement from a message over to a quarantined transaction', async () => {
	const popup = await renderConfirmTransaction()
	const transaction = makeQuarantinedTransaction(4)
	await popup.pushPendingRequests([makeQuarantinedMessage(3, '6869'), transaction])
	await popup.acknowledge()
	assert.equal(popup.isApproveDisabled(), false)

	await popup.pushPendingRequests([transaction])
	assert.equal(popup.isCheckBoxShown(), true)
	assert.equal(popup.isApproveDisabled(), true)
	await popup.acknowledge()
	assert.equal(popup.isApproveDisabled(), false)
	await popup.unmount()
})

test('requires a new acknowledgement when a refresh changes the warnings of the same request', async () => {
	const popup = await renderConfirmTransaction()
	await popup.pushPendingRequests([makeQuarantinedMessage(5, '6869')])
	await popup.acknowledge()
	assert.equal(popup.isApproveDisabled(), false)
	// A refresh that keeps the warnings keeps the acknowledgement.
	await popup.pushPendingRequests([makeQuarantinedMessage(5, '6869')])
	assert.equal(popup.isApproveDisabled(), false)

	await popup.pushPendingRequests([makeQuarantinedMessage(5, '6869', [walletDependentReason, 'The signature request is for an account that is different from your active address.'])])
	assert.equal(popup.isApproveDisabled(), true)
	await popup.unmount()
})

test('shows the quarantine acknowledgement next to a signer error so a reopened popup can retry', async () => {
	// A reopened popup starts without an acknowledgement while the failed request is still pending.
	const popup = await renderConfirmTransaction()
	await popup.pushPendingRequests([{ ...makeQuarantinedMessage(6, '6869'), approvalStatus: { status: 'SignerError' as const, code: -32603, message: 'Wallet unavailable' } }])
	assert.equal(popup.isCheckBoxShown(), true)
	assert.equal(popup.isApproveDisabled(), true)
	await popup.acknowledge()
	assert.equal(popup.isApproveDisabled(), false)
	await popup.unmount()
})

test('does not carry a quarantine acknowledgement over to a different message that reuses a negative request id', async () => {
	// The bridge forwards every request with a negative id, so a page can send two different messages under the same id.
	const latestReceivedRequestIds = new Map<string, number>()
	for (const message of ['6869', '5369676e20696e']) {
		const request = RawInterceptedRequest.parse({ interceptorRequest: true, usingInterceptorWithoutSigner: false, method: 'personal_sign', params: [message, '0x1111111111111111111111111111111111111111'], requestId: -2 })
		assert.equal(acknowledgeAndTrackBridgeRequest(latestReceivedRequestIds, 'same-socket', request.requestId, () => undefined), true)
	}
	const popup = await renderConfirmTransaction()
	const keepingPopupOpen = makeQuarantinedMessage(20, 'cafe')
	await popup.pushPendingRequests([makeQuarantinedMessage(-2, '6869'), keepingPopupOpen])
	await popup.acknowledge()
	assert.equal(popup.isApproveDisabled(), false)

	// The first message resolves while another queued request keeps the popup open, then the page reuses -2 with the same warning for a different message.
	await popup.pushPendingRequests([keepingPopupOpen])
	const reused = makeQuarantinedMessage(-2, '5369676e20696e')
	await popup.pushPendingRequests([keepingPopupOpen, reused])
	await popup.pushPendingRequests([reused])
	assert.equal(popup.isApproveDisabled(), true)
	await popup.acknowledge()
	assert.equal(popup.isApproveDisabled(), false)
	await popup.unmount()
})

test('does not carry a quarantine acknowledgement over to an identical request created within the same second', async () => {
	// Timestamps are stored with whole-second precision and the page may repeat its request id and payload, so only the extension-generated instance id tells these requests apart.
	const popup = await renderConfirmTransaction()
	const first = { ...makeQuarantinedMessage(-2, '6869'), created: new Date('2024-01-01T00:00:00.100Z'), instanceId: 'first instance' }
	const repeated = { ...makeQuarantinedMessage(-2, '6869'), created: new Date('2024-01-01T00:00:00.900Z'), instanceId: 'repeated instance' }
	const keepingPopupOpen = makeQuarantinedMessage(99, 'cafe')
	await popup.pushPendingRequests([first, keepingPopupOpen])
	await popup.acknowledge()
	assert.equal(popup.isApproveDisabled(), false)

	await popup.pushPendingRequests([keepingPopupOpen])
	await popup.pushPendingRequests([keepingPopupOpen, repeated])
	await popup.pushPendingRequests([repeated])
	assert.equal(popup.isApproveDisabled(), true)
	await popup.unmount()
})

test('does not send an approval when the queue advances while the approval is in flight', async () => {
	const popup = await renderConfirmTransaction()
	const next = makeQuarantinedMessage(402, '5369676e20696e')
	await popup.pushPendingRequests([makeQuarantinedMessage(401, '6869'), next])
	await popup.acknowledge()
	const finishWindowLookup = holdNextWindowLookup()
	await popup.approve()
	await popup.pushPendingRequests([next])
	assert.equal(popup.isApproveDisabled(), true)
	await finishWindowLookup()
	assert.deepEqual(getAcceptedRequestIds().filter((requestId) => requestId === 401 || requestId === 402), [])
	await popup.unmount()
})

test('does not send an approval when the warnings change while the approval is in flight', async () => {
	const popup = await renderConfirmTransaction()
	await popup.pushPendingRequests([makeQuarantinedMessage(403, '6869')])
	await popup.acknowledge()
	const finishWindowLookup = holdNextWindowLookup()
	await popup.approve()
	await popup.pushPendingRequests([makeQuarantinedMessage(403, '6869', [walletDependentReason, 'The signature request is for an account that is different from your active address.'])])
	await finishWindowLookup()
	assert.deepEqual(getAcceptedRequestIds().filter((requestId) => requestId === 403), [])

	// Acknowledging the new warnings lets the approval through.
	await popup.acknowledge()
	await popup.approve()
	assert.deepEqual(getAcceptedRequestIds().filter((requestId) => requestId === 403), [403])
	await popup.unmount()
})

test('requires a new acknowledgement when a failing transaction refreshes with different quarantine reasons', async () => {
	const popup = await renderConfirmTransaction()
	await popup.pushPendingRequests([makeQuarantinedTransaction(405, revertedOutcome)])
	await popup.acknowledge()
	assert.equal(popup.isApproveDisabled(), false)

	await popup.pushPendingRequests([makeQuarantinedTransaction(405, revertedOutcome, [lookalikeRecipientReason, 'The transaction sends funds to an address you have never interacted with.'])])
	assert.equal(popup.isApproveDisabled(), true)
	await popup.unmount()
})

const makeRevertedTransaction = (requestId: number, decodedErrorMessage: string) => makeQuarantinedTransaction(requestId, { transactionStatus: 'Transaction Failed', error: { code: 3, message: 'execution reverted', decodedErrorMessage } })

test('requires a new acknowledgement when only the displayed failure of a failing transaction changes', async () => {
	const popup = await renderConfirmTransaction()
	await popup.pushPendingRequests([makeRevertedTransaction(406, 'SaleNotStarted()')])
	await popup.acknowledge()
	assert.equal(popup.isApproveDisabled(), false)

	// The raw error stays 'execution reverted' while the decoded reason the dialog shows changes.
	await popup.pushPendingRequests([makeRevertedTransaction(406, 'SaleEnded()')])
	assert.equal(popup.isApproveDisabled(), true)
	await popup.unmount()
})

test('does not send an approval when the displayed failure changes while the approval is in flight', async () => {
	const popup = await renderConfirmTransaction()
	await popup.pushPendingRequests([makeRevertedTransaction(904, 'SaleNotStarted()')])
	await popup.acknowledge()
	const finishWindowLookup = holdNextWindowLookup()
	await popup.approve()
	await popup.pushPendingRequests([makeRevertedTransaction(904, 'SaleEnded()')])
	await finishWindowLookup()
	assert.equal(popup.isApproveDisabled(), true)
	assert.deepEqual(getAcceptedRequestIds().filter((requestId) => requestId === 904), [])
	await popup.unmount()
})

test('does not send a rejection when the clicked request is replaced under the same request id while the rejection is in flight', async () => {
	const popup = await renderConfirmTransaction()
	const clicked = makeQuarantinedMessage(500, '6869')
	await popup.pushPendingRequests([clicked])
	const finishWindowLookup = holdNextWindowLookup()
	await popup.reject()
	await popup.pushPendingRequests([{ ...clicked, instanceId: 'replacement instance' }])
	await finishWindowLookup()
	assert.deepEqual(getConfirmDialogDecisions('reject').filter(({ requestId }) => requestId === 500), [])

	// Rejecting the replacement names its own instance.
	await popup.reject()
	assert.deepEqual(getConfirmDialogDecisions('reject').filter(({ requestId }) => requestId === 500), [{ requestId: 500, instanceId: 'replacement instance' }])
	await popup.unmount()
})

test('shows a wallet-dependent message as written and requires an acknowledgement before approving it', async () => {
	const popup = await renderConfirmTransaction()
	await popup.pushPendingRequests([makeQuarantinedMessage(9, '0x6869zz')])
	assert.equal(popup.isTextShown('0x6869zz'), true)
	assert.equal(popup.isCheckBoxShown(), true)
	assert.equal(popup.isApproveDisabled(), true)
	await popup.acknowledge()
	assert.equal(popup.isApproveDisabled(), false)
	await popup.unmount()
})
