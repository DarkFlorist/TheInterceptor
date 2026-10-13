import * as assert from 'node:assert'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import type * as funtypes from 'funtypes'
import { installDomMock } from './domMock.js'
import { clickElement, collectElements } from './domQueries.js'
import { installBrowserMock } from '../harness/browserMock.js'
import { flushMicrotasks, waitFor } from '../harness/async.js'
import { replaceGlobal } from '../harness/globals.js'
import { getMessageMethod, hasMessageMethod } from './runtimeMessageMatchers.js'
import type { PendingTransaction } from '../../app/ts/types/accessRequest.js'
import type { SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import type { IEthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { UpdateConfirmTransactionDialog, UpdateConfirmTransactionDialogPendingTransactions } from '../../app/ts/types/interceptor-messages.js'
import { PopupRequestsReplies } from '../../app/ts/types/interceptor-reply-messages.js'
import { createPassthroughCompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'
import { serialize } from '../../app/ts/types/wire-types.js'

type PopupReadyAndListeningReply = funtypes.Static<typeof PopupRequestsReplies.popup_readyAndListening>

function getSentMessagesWithMethod(sentMessages: readonly unknown[], method: string) {
	return sentMessages.filter((message) => hasMessageMethod(message, method))
}

// Answers like a background page that has no pending request to bootstrap the confirmation dialog with.
function replyWithoutBootstrapData(message: unknown) {
	if (getMessageMethod(message) === 'popup_isMainPopupWindowOpen') return { method: 'popup_isMainPopupWindowOpen', data: { isOpen: false } }
	if (getMessageMethod(message) === 'popup_readyAndListening') return { method: 'popup_readyAndListening', data: { popupOrTabId: { type: 'popup', id: 1 } } }
	return undefined
}

function serializeBootstrapReply(pendingTransaction: PendingTransaction) {
	const reply: PopupReadyAndListeningReply = {
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
	}
	return serialize(PopupRequestsReplies.popup_readyAndListening, reply)
}

function createPendingTransactionsPush(pendingTransactionAndSignableMessages: readonly PendingTransaction[]) {
	const update: UpdateConfirmTransactionDialogPendingTransactions = {
		method: 'popup_update_confirm_transaction_dialog_pending_transactions',
		data: {
			pendingTransactionAndSignableMessages,
			currentBlockNumber: 124n,
			rpcConnectionStatus: undefined,
		},
	}
	return { role: 'all', ...serialize(UpdateConfirmTransactionDialogPendingTransactions, update) }
}

// ConfirmTransaction only waits for the bootstrap retry delay before sending another popup_readyAndListening, so counting the timers scheduled with that delay shows whether a retry is coming without waiting for one.
function countScheduledBootstrapRetries(retryDelayMs: number) {
	const scheduleTimer = globalThis.setTimeout
	let scheduledRetries = 0
	const restore = replaceGlobal('setTimeout', (handler: TimerHandler, delay?: number, ...timerArguments: unknown[]) => {
		if (delay === retryDelayMs) scheduledRetries += 1
		return scheduleTimer(handler, delay, ...timerArguments)
	})
	return { getScheduledRetries: () => scheduledRetries, restore }
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
		method: 'eth_sendTransaction',
		params: [{
			from: activeAddress,
			to: recipientAddress,
			value: 0n,
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
	} satisfies PendingTransaction
}

function makeUnexpectedSimulationFailurePendingTransaction(errorMessage: string) {
	const failedPendingTransaction = makePendingTransaction(errorMessage)
	const [originalTransaction] = failedPendingTransaction.originalRequestParameters.params
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
	} satisfies PendingTransaction
}

describe('confirm transaction rpc status bootstrap', () => {
	test('includes rpcConnectionStatus in the initial payload and renders the warning before later push events', async () => {
		const browserMock = installBrowserMock({ handlers: { runtimeMessage: replyWithoutBootstrapData } })
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

		const requestHandler = {
			rpcUrl: rpcNetwork.httpsRpc,
			clearCache: () => undefined,
			getChainId: async () => rpcNetwork.chainId,
			async jsonRpcRequest(rpcRequest: { readonly method: string }) {
				if (rpcRequest.method === 'eth_blockNumber') return '0x7b'
				throw new Error(`Unexpected RPC method: ${ rpcRequest.method }`)
			},
		} satisfies IEthereumJSONRpcRequestHandler
		const ethereum = new EthereumClientService(requestHandler, async () => undefined, async () => undefined, rpcNetwork)
		const tokenPriceService = new TokenPriceService(ethereum, 0)

		await updateConfirmTransactionView(ethereum, tokenPriceService)

		const initialMessage = browserMock.calls.runtimeSendMessage.find((message) => getMessageMethod(message) === 'popup_update_confirm_transaction_dialog')
		if (initialMessage === undefined) throw new Error('missing initial confirm transaction dialog message')
		const initialUpdate = UpdateConfirmTransactionDialog.parse(initialMessage)

		assert.equal(
			initialUpdate.data.rpcConnectionStatus !== undefined
				&& initialUpdate.data.rpcConnectionStatus.retrying === false,
			true,
		)

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})

		await act(async () => {
			await browserMock.dispatchRuntimeMessage(initialMessage)
		})

		assert.equal(dom.document.body.textContent?.includes('Retrying resumes when the extension becomes active.'), true)
		await unmountConfirmTransaction(dom)
		dom.restore()
		browserMock.restore()
	})

	test('hydrates from a later bootstrap reply when the first ready handshake happens before pending data exists', async () => {
		const dom = installDomMock()
		const pendingTransaction = makePendingTransaction()
		const browserMock = installBrowserMock()
		browserMock.handlers.runtimeMessage = (message) => {
			if (getMessageMethod(message) !== 'popup_readyAndListening') return undefined
			const readyCalls = getSentMessagesWithMethod(browserMock.calls.runtimeSendMessage, 'popup_readyAndListening').length
			if (readyCalls === 1) return undefined
			return serializeBootstrapReply(pendingTransaction)
		}
		const { ConfirmTransaction, CONFIRM_TRANSACTION_BOOTSTRAP_RETRY_DELAY_MS } = await import('../../app/ts/components/pages/ConfirmTransaction.js')

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})

		await waitFor(() => dom.document.body.textContent?.includes('simulation failed') === true, {
			timeoutMs: CONFIRM_TRANSACTION_BOOTSTRAP_RETRY_DELAY_MS + 1000,
			description: 'the retried bootstrap reply to render',
		})

		const readyCalls = getSentMessagesWithMethod(browserMock.calls.runtimeSendMessage, 'popup_readyAndListening').length
		assert.equal(readyCalls >= 2, true)

		assert.equal(dom.document.body.textContent?.includes('simulation failed'), true)
		assert.equal(dom.document.body.textContent?.includes('Initializing...'), false)
		await unmountConfirmTransaction(dom)
		dom.restore()
		browserMock.restore()
	})

	test('sends a single popup_readyAndListening request at startup', async () => {
		const dom = installDomMock()
		const pendingTransaction = makePendingTransaction('bootstrapped transaction')
		const browserMock = installBrowserMock({
			handlers: { runtimeMessage: (message) => getMessageMethod(message) === 'popup_readyAndListening' ? serializeBootstrapReply(pendingTransaction) : undefined },
		})
		const { ConfirmTransaction, CONFIRM_TRANSACTION_BOOTSTRAP_RETRY_DELAY_MS } = await import('../../app/ts/components/pages/ConfirmTransaction.js')
		const bootstrapRetries = countScheduledBootstrapRetries(CONFIRM_TRANSACTION_BOOTSTRAP_RETRY_DELAY_MS)

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})
		await waitFor(() => dom.document.body.textContent?.includes('bootstrapped transaction') === true, { description: 'the bootstrap reply to render' })
		await flushMicrotasks()

		assert.equal(dom.document.body.textContent?.includes('bootstrapped transaction'), true)
		assert.equal(bootstrapRetries.getScheduledRetries(), 0)
		assert.equal(getSentMessagesWithMethod(browserMock.calls.runtimeSendMessage, 'popup_readyAndListening').length, 1)
		bootstrapRetries.restore()
		await unmountConfirmTransaction(dom)
		dom.restore()
		browserMock.restore()
	})

	test('reports an empty pushed pending transaction list, keeps showing the last request and removes its listeners on unmount', async () => {
		const dom = installDomMock()
		const browserMock = installBrowserMock()
		const { ConfirmTransaction } = await import('../../app/ts/components/pages/ConfirmTransaction.js')
		const dispatchPendingTransactions = async (pendingTransactions: readonly PendingTransaction[]) => await act(async () => {
			await browserMock.dispatchRuntimeMessage(createPendingTransactionsPush(pendingTransactions))
		})

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})
		assert.equal(browserMock.browser.runtime.onMessage.hasListeners(), true)
		await dispatchPendingTransactions([makePendingTransaction('last pending transaction')])
		await dispatchPendingTransactions([])
		// The background never pushes an empty list, so the handler reports it; the report goes out through promise callbacks.
		await flushMicrotasks()

		assert.equal(dom.document.body.textContent?.includes('last pending transaction'), true)
		assert.equal(getSentMessagesWithMethod(browserMock.calls.runtimeSendMessage, 'popup_UnexpectedErrorOccured').length, 1)
		await unmountConfirmTransaction(dom)
		assert.equal(browserMock.browser.runtime.onMessage.hasListeners(), false)
		dom.restore()
		browserMock.restore()
	})

	test('does not let a late bootstrap reply overwrite pushed pending transaction data', async () => {
		const dom = installDomMock()
		const stalePendingTransaction = makePendingTransaction('stale bootstrap transaction')
		const freshPendingTransaction = makePendingTransaction('fresh pushed transaction')
		const lateBootstrapReply = Promise.withResolvers<void>()
		const browserMock = installBrowserMock({
			handlers: {
				runtimeMessage: async (message) => {
					if (getMessageMethod(message) !== 'popup_readyAndListening') return undefined
					// The bootstrap reply is held back until the test has pushed fresher pending transactions.
					await lateBootstrapReply.promise
					return serializeBootstrapReply(stalePendingTransaction)
				},
			},
		})
		const { ConfirmTransaction } = await import('../../app/ts/components/pages/ConfirmTransaction.js')

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})
		await waitFor(() => getSentMessagesWithMethod(browserMock.calls.runtimeSendMessage, 'popup_readyAndListening').length === 1, { description: 'the bootstrap request' })

		await act(async () => {
			await browserMock.dispatchRuntimeMessage(createPendingTransactionsPush([freshPendingTransaction]))
		})
		await act(async () => {
			lateBootstrapReply.resolve()
			await flushMicrotasks()
		})

		assert.equal(dom.document.body.textContent?.includes('fresh pushed transaction'), true)
		assert.equal(dom.document.body.textContent?.includes('stale bootstrap transaction'), false)
		await unmountConfirmTransaction(dom)
		dom.restore()
		browserMock.restore()
	})

	test('renders an unexpected simulation failure instead of a simulation spinner', async () => {
		const dom = installDomMock()
		const browserMock = installBrowserMock()
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
		await waitFor(() => dom.document.body.textContent?.includes('Failed to decode ABI data') === true, { description: 'the stored pending transaction to render' })

		assert.equal(dom.document.body.textContent?.includes('Failed to decode ABI data'), true)
		assert.equal(dom.document.body.textContent?.includes('Simulating...'), false)
		assert.equal(dom.document.body.textContent?.includes('Initializing...'), false)
		await unmountConfirmTransaction(dom)
		dom.restore()
		browserMock.restore()
	})

	test('opens address editing from an execution error preview', async () => {
		const dom = installDomMock()
		const browserMock = installBrowserMock()
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
		await waitFor(() => dom.document.body.textContent?.includes('Execution error') === true, { description: 'the stored pending transaction to render' })

		assert.equal(dom.document.body.textContent?.includes('Execution error'), true)
		const toLabel = collectElements(dom.document.body, 'dt').find((term) => term.textContent.trim() === 'To')
		if (toLabel === undefined || toLabel.parentNode === null) throw new Error('Expected the receiving address row')
		const receivingAddress = toLabel.parentNode.childNodes[toLabel.parentNode.childNodes.indexOf(toLabel) + 1]
		if (receivingAddress === undefined) throw new Error('Expected the receiving address details')
		const editAbiButton = collectElements(receivingAddress, 'button').find((button) => button.textContent.trim() === 'edit')
		if (editAbiButton === undefined) throw new Error('Expected the receiving address edit button')

		await act(async () => {
			await clickElement(editAbiButton)
		})

		assert.equal(dom.document.body.textContent?.includes('Contract ABI'), true)
		await unmountConfirmTransaction(dom)
		dom.restore()
		browserMock.restore()
	})
})
