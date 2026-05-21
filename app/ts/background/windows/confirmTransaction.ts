import { closePopupOrTabById, getPopupOrTabById, openPopupOrTab, tryFocusingTabOrWindow } from '../../components/ui-utils.js'
import type { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import { getInputFieldFromDataOrInput, getSimulatedTransactionCount, mockSignTransaction, simulateEstimateGas, simulatePersonalSign } from '../../simulation/services/SimulationModeEthereumClientService.js'
import { CANNOT_SIMULATE_OFF_LEGACY_BLOCK, ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS, METAMASK_ERROR_BLANKET_ERROR, METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { type TransactionConfirmation, UpdateConfirmTransactionDialog, UpdateConfirmTransactionDialogPendingTransactions } from '../../types/interceptor-messages.js'
import { Semaphore } from '../../utils/semaphore.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { type InterceptorTransactionStack, PASSTHROUGH_STATE, type WebsiteCreatedEthereumUnsignedTransaction, type WebsiteCreatedEthereumUnsignedTransactionOrFailed, createPassthroughCompleteVisualizedSimulation } from '../../types/visualizer-types.js'
import type { SendRawTransactionParams, SendTransactionParams } from '../../types/JsonRpc-types.js'
import { getUpdatedSimulationState, refreshConfirmTransactionSimulation } from '../background.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { appendPendingTransactionOrMessage, clearPendingTransactions, getInterceptorTransactionStack, getPendingTransactionsAndMessages, removePendingTransactionOrMessage, updateInterceptorTransactionStack, updatePendingTransactionOrMessage } from '../storageVariables.js'
import { type InterceptedRequest, type UniqueRequestIdentifier, doesUniqueRequestIdentifiersMatch, getUniqueRequestIdentifierString, silenceChromeUnCaughtPromise } from '../../utils/requests.js'
import { replyToInterceptedRequest } from '../messageSending.js'
import {
	stringToBytes,
	keccak256,
	recoverAddress,
	parseTransaction as parseSerializedTransaction,
	serializeTransaction,
} from '../../utils/viem.js'
import { dataStringWith0xStart, stringToUint8Array } from '../../utils/bigint.js'
import { EthereumAddress, EthereumBytes32, EthereumQuantity, serialize } from '../../types/wire-types.js'
import type { PopupOrTabId, Website } from '../../types/websiteAccessTypes.js'
import { JsonRpcResponseError, handleUnexpectedError, isFailedToFetchError, isNewBlockAbort, printError } from '../../utils/errors.js'
import type { PendingTransactionOrSignableMessage, PopupPendingTransactionOrSignableMessage } from '../../types/accessRequest.js'
import type { SignMessageParams } from '../../types/jsonRpc-signing-types.js'
import { craftPersonalSignPopupMessage } from './personalSign.js'
import { getSettings } from '../settings.js'
import * as funtypes from 'funtypes'
import { assertNever, modifyObject } from '../../utils/typescript.js'
import { simulateGnosisSafeTransactionOnPass } from '../popupMessageHandlers.js'
import { updatePopupVisualisationIfNeeded } from '../popupVisualisationUpdater.js'
import { POPUP_PERFORMANCE_MARKS, markPerformance } from '../../utils/popupPerformance.js'
import type { TokenPriceService } from '../../simulation/services/priceEstimator.js'

const pendingConfirmationSemaphore = new Semaphore(1)

type TimestampedPopupVisualisation = {
	statusCode: 'success' | 'failed'
	data: {
		simulationStartedTimestamp: Date
		simulationState: {
			simulationConductedTimestamp: Date
		}
	}
}

const getSimulationStartedTimestamp = (popupVisualisation: TimestampedPopupVisualisation) => popupVisualisation.data.simulationStartedTimestamp

const shouldReplacePopupVisualisation = (
	currentPopupVisualisation: TimestampedPopupVisualisation | undefined,
	nextPopupVisualisation: TimestampedPopupVisualisation,
) => {
	const currentTimestamp = currentPopupVisualisation === undefined ? undefined : getSimulationStartedTimestamp(currentPopupVisualisation)
	const nextTimestamp = getSimulationStartedTimestamp(nextPopupVisualisation)
	if (currentTimestamp === undefined || nextTimestamp === undefined) return true
	return nextTimestamp.getTime() >= currentTimestamp.getTime()
}

export function toPopupPendingTransactionOrSignableMessage(pending: PendingTransactionOrSignableMessage): PopupPendingTransactionOrSignableMessage {
	switch (pending.type) {
		case 'Transaction':
			return pending
		case 'SignableMessage': {
			const base = {
				type: pending.type,
				popupOrTabId: pending.popupOrTabId,
				originalRequestParameters: pending.originalRequestParameters,
				simulationMode: pending.simulationMode,
				uniqueRequestIdentifier: pending.uniqueRequestIdentifier,
				created: pending.created,
				website: pending.website,
				activeAddress: pending.activeAddress,
				approvalStatus: pending.approvalStatus,
			}
			const transactionOrMessageCreationStatus = pending.transactionOrMessageCreationStatus
			switch (transactionOrMessageCreationStatus) {
				case 'Simulated':
					return {
						...base,
						transactionOrMessageCreationStatus,
						visualizedPersonalSignRequest: pending.visualizedPersonalSignRequest,
					}
				case 'Crafting':
				case 'Simulating':
					return {
						...base,
						transactionOrMessageCreationStatus,
					}
				default:
					return assertNever(transactionOrMessageCreationStatus)
			}
		}
		default:
			return assertNever(pending)
	}
}

export async function updateConfirmTransactionView(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, onlyIfNotAlreadyUpdating = false) {
	try {
		const visualizedSimulatorStatePromise = silenceChromeUnCaughtPromise(updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, false, onlyIfNotAlreadyUpdating))
		const settings = getSettings()
		const currentBlockNumberPromise = silenceChromeUnCaughtPromise(ethereum.getBlockNumber(undefined))
		const pendingTransactionAndSignableMessages = await getPendingTransactionsAndMessages()
		if (pendingTransactionAndSignableMessages.length === 0) return false
		const message: UpdateConfirmTransactionDialog = { method: 'popup_update_confirm_transaction_dialog', data: {
			currentBlockNumber: await currentBlockNumberPromise,
			visualizedSimulatorState: (await settings).simulationMode ? await visualizedSimulatorStatePromise : createPassthroughCompleteVisualizedSimulation(),
		} }
			const messagePendingTransactions: UpdateConfirmTransactionDialogPendingTransactions = {
				method: 'popup_update_confirm_transaction_dialog_pending_transactions' as const,
				data: {
					pendingTransactionAndSignableMessages: pendingTransactionAndSignableMessages.map(toPopupPendingTransactionOrSignableMessage),
					currentBlockNumber: await currentBlockNumberPromise,
				}
			}
		await Promise.all([
			sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialogPendingTransactions, messagePendingTransactions), 'confirmTransaction'),
			sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialog, message), 'confirmTransaction')
		])
		return true
	} catch(error: unknown) {
		if (error instanceof Error && (isNewBlockAbort(error) || isFailedToFetchError(error))) return false
		await handleUnexpectedError(error)
	}
	return false
}

export const isConfirmTransactionFocused = async () => {
	const pendingTransactions = await getPendingTransactionsAndMessages()
	if (pendingTransactions[0] === undefined) return false
	const popup = await getPopupOrTabById(pendingTransactions[0].popupOrTabId)
	if (popup === undefined) return false
	if (popup.type === 'popup') return popup.window.focused
	return popup.tab.active
}

const getPendingTransactionOrMessageByidentifier = async (uniqueRequestIdentifier: UniqueRequestIdentifier) => {
	return (await getPendingTransactionsAndMessages()).find((tx) => doesUniqueRequestIdentifiersMatch(tx.uniqueRequestIdentifier, uniqueRequestIdentifier))
}

export const setGasLimitForTransaction = async (transactionIdentifier: BigInt, gasLimit: bigint) => {
	const pendingTransaction = (await getPendingTransactionsAndMessages()).find((tx) => tx.type === 'Transaction' && tx.transactionIdentifier === transactionIdentifier)
	if (pendingTransaction === undefined) {
		const theTransactionIsAlreadyInStack = (await getInterceptorTransactionStack()).operations.some((transaction) => transaction.type === 'Transaction' && transaction.preSimulationTransaction.transactionIdentifier === transactionIdentifier)
		if (!theTransactionIsAlreadyInStack) return undefined
		await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => {
			return { operations: prevStack.operations.map((operation) => {
				if (operation.type !== 'Transaction') return operation
				if (operation.preSimulationTransaction.transactionIdentifier !== transactionIdentifier) return operation
				if (operation.preSimulationTransaction.originalRequestParameters.method !== 'eth_sendTransaction') return operation
				const originalParams = operation.preSimulationTransaction.originalRequestParameters
				const originalRequestParameters = modifyObject(originalParams, { params: [modifyObject(originalParams.params[0], { gas: gasLimit })] })
				return modifyObject(operation, { preSimulationTransaction: modifyObject(operation.preSimulationTransaction, { originalRequestParameters, signedTransaction: modifyObject(operation.preSimulationTransaction.signedTransaction, { gas: gasLimit })  }) })
			}) }
		})
		return
	}
	await updatePendingTransactionOrMessage(pendingTransaction.uniqueRequestIdentifier, async (transaction) => {
		if (transaction.originalRequestParameters.method === 'eth_sendTransaction') {
			const originalRequestParameters = modifyObject(transaction.originalRequestParameters, { params: [modifyObject(transaction.originalRequestParameters.params[0], { gas: gasLimit })] })
			return modifyObject(transaction, { originalRequestParameters: originalRequestParameters })
		}
		return transaction
	})
}

export async function resolvePendingTransactionOrMessage(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation) {
	const pendingTransactionOrMessage = await getPendingTransactionOrMessageByidentifier(confirmation.data.uniqueRequestIdentifier)
	if (pendingTransactionOrMessage === undefined) return // no need to resolve as it doesn't exist anymore
	const reply = (message: { type: 'forwardToSigner' } | { type: 'result', error: { code: number, message: string } } | { type: 'result', result: unknown }) => {
		if (message.type === 'result' && !('error' in message)) {
			if (pendingTransactionOrMessage.originalRequestParameters.method === 'eth_sendRawTransaction' || pendingTransactionOrMessage.originalRequestParameters.method === 'eth_sendTransaction') {
				return replyToInterceptedRequest(websiteTabConnections, { ...pendingTransactionOrMessage.originalRequestParameters, ...message, result: EthereumBytes32.parse(message.result), uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
			}
			return replyToInterceptedRequest(websiteTabConnections, { ...pendingTransactionOrMessage.originalRequestParameters, ...message, result: funtypes.String.parse(message.result), uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
		}
		return replyToInterceptedRequest(websiteTabConnections, { ...pendingTransactionOrMessage.originalRequestParameters, ...message, uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
	}
	if (confirmation.data.action === 'accept' && pendingTransactionOrMessage.simulationMode === false) {
		await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (transaction) => modifyObject(transaction, { approvalStatus: { status: 'WaitingForSigner' } }))
		await updateConfirmTransactionView(ethereum, tokenPriceService)
		return replyToInterceptedRequest(websiteTabConnections, { ...pendingTransactionOrMessage.originalRequestParameters, type: 'forwardToSigner', uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
	}
	await removePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier)
	if ((await getPendingTransactionsAndMessages()).length === 0) await tryFocusingTabOrWindow({ type: 'tab', id: pendingTransactionOrMessage.uniqueRequestIdentifier.requestSocket.tabId })
	if (!(await updateConfirmTransactionView(ethereum, tokenPriceService))) await closePopupOrTabById(pendingTransactionOrMessage.popupOrTabId)

	if (confirmation.data.action === 'noResponse') return reply(formRejectMessage(METAMASK_ERROR_USER_REJECTED_REQUEST, 'User denied transaction signature'))
	if (pendingTransactionOrMessage === undefined || pendingTransactionOrMessage.transactionOrMessageCreationStatus !== 'Simulated') return reply(formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'The Interceptor failed to process the transaction'))
	if (confirmation.data.action === 'reject') return reply(formRejectMessage(METAMASK_ERROR_USER_REJECTED_REQUEST, 'User denied transaction signature'))
	if (!pendingTransactionOrMessage.simulationMode) {
		if (confirmation.data.action === 'signerIncluded') return reply({ type: 'result', result: confirmation.data.signerReply })
		return reply({ type: 'forwardToSigner' })
	}
	if (confirmation.data.action === 'signerIncluded') throw new Error('Signer included transaction that was in simulation')

	switch (pendingTransactionOrMessage.type) {
		case 'SignableMessage': {
			await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => ({ operations: [
				...prevStack.operations,
				{ type: 'Message' as const, signedMessageTransaction: pendingTransactionOrMessage.signedMessageTransaction }
			] }))
			await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, false)
			return reply({ type: 'result', result: (await simulatePersonalSign(pendingTransactionOrMessage.originalRequestParameters, pendingTransactionOrMessage.signedMessageTransaction.fakeSignedFor)).signature })
		}
		case 'Transaction': {
			const signedTransaction = mockSignTransaction(pendingTransactionOrMessage.transactionToSimulate.transaction)
			const transaction = { ...pendingTransactionOrMessage.transactionToSimulate, signedTransaction }
			await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => ({ operations: [
				...prevStack.operations,
				{ type: 'Transaction' as const, preSimulationTransaction: transaction}
			] }))
			await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, false)
			markPerformance(POPUP_PERFORMANCE_MARKS.backgroundTransactionStackAppended)
			return reply({ type: 'result', result: EthereumBytes32.serialize(signedTransaction.hash) })
		}
		default: assertNever(pendingTransactionOrMessage)
	}
}

export const onCloseWindowOrTab = async (popupOrTabs: PopupOrTabId, ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections) => { // check if user has closed the window on their own, if so, reject all signatures
	const transactions = await getPendingTransactionsAndMessages()
	const [firstTransaction] = transactions
	if (firstTransaction === undefined || firstTransaction?.popupOrTabId.type !== popupOrTabs.type || firstTransaction.popupOrTabId.id !== popupOrTabs.id) return
	await resolveAllPendingTransactionsAndMessageAsNoResponse(transactions, ethereum, tokenPriceService, websiteTabConnections)
}

const resolveAllPendingTransactionsAndMessageAsNoResponse = async (transactions: readonly PendingTransactionOrSignableMessage[], ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections) => {
	for (const transaction of transactions) {
		try {
			await resolvePendingTransactionOrMessage(ethereum, tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { uniqueRequestIdentifier: transaction.uniqueRequestIdentifier, action: 'noResponse' } })
		} catch(e) {
			printError(e)
		}
	}
	await clearPendingTransactions()
}

const formRejectMessage = (code: number, errorString: string) => {
	return {
		type: 'result' as const,
		error: { code, message: errorString }
	}
}

const isSerializedEip1559Transaction = (transaction: `0x${ string }`): transaction is `0x02${ string }` => transaction.startsWith('0x02')
const recoverSerializedEip1559TransactionAddress = async (serializedTransaction: `0x02${ string }`) => {
	const parsedTransaction = parseSerializedTransaction(serializedTransaction)
	if (parsedTransaction.type !== 'eip1559') throw new Error('Expected EIP-1559 transaction')
	if (parsedTransaction.chainId === undefined || parsedTransaction.gas === undefined || parsedTransaction.maxFeePerGas === undefined || parsedTransaction.maxPriorityFeePerGas === undefined || parsedTransaction.nonce === undefined || parsedTransaction.r === undefined || parsedTransaction.s === undefined) {
		throw new Error('Serialized transaction is missing required signature fields')
	}
	const unsignedTransaction = serializeTransaction({
		type: 'eip1559',
		chainId: Number(parsedTransaction.chainId),
		nonce: parsedTransaction.nonce,
		maxFeePerGas: parsedTransaction.maxFeePerGas,
		maxPriorityFeePerGas: parsedTransaction.maxPriorityFeePerGas,
		gas: parsedTransaction.gas,
		to: parsedTransaction.to,
		value: parsedTransaction.value,
		data: parsedTransaction.data,
		accessList: parsedTransaction.accessList,
	})
	return await recoverAddress({
		hash: keccak256(unsignedTransaction),
		signature: {
			r: parsedTransaction.r,
			s: parsedTransaction.s,
			yParity: parsedTransaction.yParity ?? 0,
		},
	})
}

export const formSendRawTransaction = async(ethereumClientService: EthereumClientService, sendRawTransactionParams: SendRawTransactionParams, website: Website, created: Date, transactionIdentifier: EthereumQuantity): Promise<WebsiteCreatedEthereumUnsignedTransaction> => {
	const serializedTransaction = dataStringWith0xStart(sendRawTransactionParams.params[0])
	const parsedTransaction = parseSerializedTransaction(serializedTransaction)
	if (parsedTransaction.type !== 'eip1559') throw new Error('No support for non-1559 transactions')
	if (!isSerializedEip1559Transaction(serializedTransaction)) throw new Error('Expected serialized EIP-1559 transaction')
	const from = await recoverSerializedEip1559TransactionAddress(serializedTransaction)
	if (parsedTransaction.gas === undefined) throw new Error('Unable to parse gas from serialized transaction')
	if (parsedTransaction.nonce === undefined) throw new Error('Unable to parse nonce from serialized transaction')
	const transactionDetails = {
		from: EthereumAddress.parse(from),
		input: stringToUint8Array(parsedTransaction.data ?? '0x'),
		gas: parsedTransaction.gas,
		value: parsedTransaction.value,
		...(parsedTransaction.to === undefined || parsedTransaction.to === null ? {} : { to: EthereumAddress.parse(parsedTransaction.to) }),
		...(parsedTransaction.maxPriorityFeePerGas === undefined ? {} : { maxPriorityFeePerGas: parsedTransaction.maxPriorityFeePerGas }),
		...(parsedTransaction.maxFeePerGas === undefined ? {} : { maxFeePerGas: parsedTransaction.maxFeePerGas }),
	}

	if (transactionDetails.maxFeePerGas === undefined) throw new Error('No support for non-1559 transactions')

	const transaction = {
		type: '1559' as const,
		from: transactionDetails.from,
		chainId: ethereumClientService.getChainId(),
		nonce: BigInt(parsedTransaction.nonce),
		maxFeePerGas: transactionDetails.maxFeePerGas,
		maxPriorityFeePerGas: transactionDetails.maxPriorityFeePerGas ? transactionDetails.maxPriorityFeePerGas : 0n,
		to: transactionDetails.to === undefined ? null : transactionDetails.to,
		value: transactionDetails.value ? transactionDetails.value : 0n,
		input: transactionDetails.input,
		accessList: [],
		gas: transactionDetails.gas,
	}
	return {
		transaction,
		website,
		created,
		originalRequestParameters: sendRawTransactionParams,
		transactionIdentifier,
		success: true,
	}
}

export const formEthSendTransaction = async(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, activeAddress: bigint | undefined, website: Website, sendTransactionParams: SendTransactionParams, created: Date, transactionIdentifier: EthereumQuantity, simulationMode = true): Promise<WebsiteCreatedEthereumUnsignedTransactionOrFailed> => {
	const simulationState = simulationMode ? await getUpdatedSimulationState(ethereumClientService) : PASSTHROUGH_STATE
	const parentBlockPromise = silenceChromeUnCaughtPromise(ethereumClientService.getBlock(requestAbortController)) // we are getting the real block here, as we are not interested in the current block where this is going to be included, but the parent
	const transactionDetails = sendTransactionParams.params[0]
	if (activeAddress === undefined) throw new Error('Access to active address is denied')
	const from = simulationMode && transactionDetails.from !== undefined ? transactionDetails.from : activeAddress
	const transactionCountPromise = silenceChromeUnCaughtPromise(getSimulatedTransactionCount(ethereumClientService, requestAbortController, simulationState, from))
	const parentBlock = await parentBlockPromise
	if (parentBlock === null) throw new Error('The latest block is null')
	if (parentBlock.baseFeePerGas === undefined) throw new Error(CANNOT_SIMULATE_OFF_LEGACY_BLOCK)
	const maxPriorityFeePerGas = transactionDetails.maxPriorityFeePerGas !== undefined && transactionDetails.maxPriorityFeePerGas !== null ? transactionDetails.maxPriorityFeePerGas : 10n**8n // 0.1 nanoEth/gas
	const transactionWithoutGas = {
		type: '1559' as const,
		from,
		chainId: ethereumClientService.getChainId(),
		nonce: await transactionCountPromise,
		maxFeePerGas: transactionDetails.maxFeePerGas !== undefined && transactionDetails.maxFeePerGas !== null ? transactionDetails.maxFeePerGas : parentBlock.baseFeePerGas * 2n + maxPriorityFeePerGas,
		maxPriorityFeePerGas,
		to: transactionDetails.to === undefined ? null : transactionDetails.to,
		value: transactionDetails.value !== undefined  ? transactionDetails.value : 0n,
		input: getInputFieldFromDataOrInput(transactionDetails),
		accessList: [],
	}
	const extraParams = {
		website,
		created,
		originalRequestParameters: sendTransactionParams,
		transactionIdentifier,
		error: undefined,
	}
	if (transactionDetails.gas === undefined) {
		try {
			const estimateGas = await simulateEstimateGas(ethereumClientService, requestAbortController, simulationState, transactionWithoutGas)
			if ('error' in estimateGas) return { ...extraParams, ...estimateGas, success: false }
			return { transaction: { ...transactionWithoutGas, gas: estimateGas.gas }, ...extraParams, success: true }
		} catch(error: unknown) {
			if (error instanceof JsonRpcResponseError) return { ...extraParams, error: { code: error.code, message: error.message, data: typeof error.data === 'string' ? error.data : '0x' }, success: false }
			printError(error)
			if (error instanceof Error) return { ...extraParams, error: { code: 123456, message: error.message, data: 'data' in error && typeof error.data === 'string' ? error.data : '0x' }, success: false }
			return { ...extraParams, error: { code: 123456, message: 'Unknown Error', data: '0x' }, success: false }
		}
	}
	return { transaction: { ...transactionWithoutGas, gas: transactionDetails.gas }, ...extraParams, success: true }
}

const getPendingTransactionWindow = async (ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections) => {
	const pendingTransactions = await getPendingTransactionsAndMessages()
	const [firstPendingTransaction] = pendingTransactions
	if (firstPendingTransaction !== undefined) {
		const alreadyOpenWindow = await getPopupOrTabById(firstPendingTransaction.popupOrTabId)
		if (alreadyOpenWindow) return alreadyOpenWindow
		await resolveAllPendingTransactionsAndMessageAsNoResponse(pendingTransactions, ethereum, tokenPriceService, websiteTabConnections)
	}
	return await openPopupOrTab({ url: getHtmlFile('confirmTransaction'), type: 'popup', height: 800, width: 600 })
}

export async function openConfirmTransactionDialogForMessage(
	ethereumClientService: EthereumClientService,
	tokenPriceService: TokenPriceService,
	request: InterceptedRequest,
	transactionParams: SignMessageParams,
	simulationMode: boolean,
	activeAddress: bigint | undefined,
	website: Website,
	websiteTabConnections: WebsiteTabConnections,
) {
	if (activeAddress === undefined) return { type: 'result' as const, ...ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS }
	const uniqueRequestIdentifierString = getUniqueRequestIdentifierString(request.uniqueRequestIdentifier)
	const messageIdentifier = EthereumQuantity.parse(keccak256(stringToBytes(uniqueRequestIdentifierString)))
	const created = new Date()
	const signedMessageTransaction = {
		website,
		created,
		originalRequestParameters: transactionParams,
		fakeSignedFor: activeAddress,
		simulationMode,
		request,
		messageIdentifier,
	}
	try {
		const visualizedPersonalSignRequest = await craftPersonalSignPopupMessage(ethereumClientService, undefined, signedMessageTransaction, ethereumClientService.getRpcEntry())
		await pendingConfirmationSemaphore.execute(async () => {
			const openedDialog = await getPendingTransactionWindow(ethereumClientService, tokenPriceService, websiteTabConnections)
			if (openedDialog === undefined) throw new Error('Failed to get pending transaction window!')

			const pendingMessage = {
				type: 'SignableMessage' as const,
				popupOrTabId: openedDialog,
				originalRequestParameters: transactionParams,
				uniqueRequestIdentifier: request.uniqueRequestIdentifier,
				simulationMode,
				activeAddress,
				created,
				transactionOrMessageCreationStatus: 'Crafting' as const,
				website,
				approvalStatus: { status: 'WaitingForUser' as const },
				signedMessageTransaction,
			}
			await appendPendingTransactionOrMessage(pendingMessage)
			await updateConfirmTransactionView(ethereumClientService, tokenPriceService)

			await updatePendingTransactionOrMessage(pendingMessage.uniqueRequestIdentifier, async (message) => {
				if (message.type !== 'SignableMessage') return message
				return modifyObject(message, { transactionOrMessageCreationStatus: 'Simulating' as const } )
			})
			await updateConfirmTransactionView(ethereumClientService, tokenPriceService)

			await updatePendingTransactionOrMessage(pendingMessage.uniqueRequestIdentifier, async (message) => {
				if (message.type !== 'SignableMessage') return message
				return { ...message, visualizedPersonalSignRequest, transactionOrMessageCreationStatus: 'Simulated' as const }
			})
			await updateConfirmTransactionView(ethereumClientService, tokenPriceService)

			await tryFocusingTabOrWindow(openedDialog)
			if (visualizedPersonalSignRequest.type === 'SafeTx') {
				await simulateGnosisSafeTransactionOnPass(ethereumClientService, tokenPriceService, visualizedPersonalSignRequest)
			}
		})
	} catch(e) {
		await handleUnexpectedError(e)
		return formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'Failed to process message signing request. See Interceptor for error message')
	}
	const pendingTransactionData = await getPendingTransactionOrMessageByidentifier(request.uniqueRequestIdentifier)
	if (pendingTransactionData === undefined) return formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'The Interceptor failed to process the transaction')
	return { type: 'doNotReply' as const }
}

export async function openConfirmTransactionDialogForTransaction(
	ethereumClientService: EthereumClientService,
	tokenPriceService: TokenPriceService,
	request: InterceptedRequest,
	transactionParams: SendTransactionParams | SendRawTransactionParams,
	simulationMode: boolean,
	activeAddress: bigint | undefined,
	website: Website,
	websiteTabConnections: WebsiteTabConnections,
) {
	const uniqueRequestIdentifierString = getUniqueRequestIdentifierString(request.uniqueRequestIdentifier)
	const transactionIdentifier = EthereumQuantity.parse(keccak256(stringToBytes(uniqueRequestIdentifierString)))
	const created = new Date()
	const transactionToSimulatePromise = transactionParams.method === 'eth_sendTransaction' ? formEthSendTransaction(ethereumClientService, undefined, activeAddress, website, transactionParams, created, transactionIdentifier, simulationMode) : formSendRawTransaction(ethereumClientService, transactionParams, website, created, transactionIdentifier)
	silenceChromeUnCaughtPromise(transactionToSimulatePromise)
	if (activeAddress === undefined) return { type: 'result' as const, ...ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS }
	const outcome = await pendingConfirmationSemaphore.execute(async () => {
		try {
			const transactionToSimulate = await transactionToSimulatePromise
			const openedDialog = await getPendingTransactionWindow(ethereumClientService, tokenPriceService, websiteTabConnections)
			if (openedDialog === undefined) return formRejectMessage(METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, 'Failed to get pending transaction window')
			markPerformance(POPUP_PERFORMANCE_MARKS.backgroundTransactionConfirmPopupOpened)

			const pendingTransaction = {
				type: 'Transaction' as const,
				popupOrTabId: openedDialog,
				originalRequestParameters: transactionParams,
				uniqueRequestIdentifier: request.uniqueRequestIdentifier,
				simulationMode,
				activeAddress,
				created,
				transactionOrMessageCreationStatus: 'Crafting' as const,
				transactionIdentifier,
				website,
				approvalStatus: { status: 'WaitingForUser' as const }
			}
			await appendPendingTransactionOrMessage(pendingTransaction)
			await updateConfirmTransactionView(ethereumClientService, tokenPriceService)
			markPerformance(POPUP_PERFORMANCE_MARKS.backgroundTransactionSimulationStart)
			const simulationResultsPromise = silenceChromeUnCaughtPromise(refreshConfirmTransactionSimulation(ethereumClientService, tokenPriceService, activeAddress, simulationMode, request.uniqueRequestIdentifier, transactionToSimulate))
			if (transactionToSimulate.success) {
				await updatePendingTransactionOrMessage(pendingTransaction.uniqueRequestIdentifier, async (transaction) => ({ ...transaction, transactionToSimulate: transactionToSimulate, transactionOrMessageCreationStatus: 'Simulating' as const }))
				await updateConfirmTransactionView(ethereumClientService, tokenPriceService)
			}
			const popupVisualisation = await simulationResultsPromise
			markPerformance(POPUP_PERFORMANCE_MARKS.backgroundTransactionSimulationEnd)
			await updatePendingTransactionOrMessage(pendingTransaction.uniqueRequestIdentifier, async (transaction) => {
				if (transaction.type !== 'Transaction') return transaction
				if (popupVisualisation === undefined) return transaction
				if (transaction.transactionOrMessageCreationStatus === 'Simulated' || transaction.transactionOrMessageCreationStatus === 'FailedToSimulate') {
					if ('popupVisualisation' in transaction && !shouldReplacePopupVisualisation(transaction.popupVisualisation, popupVisualisation)) return transaction
				}
				if (transactionToSimulate.success) return { ...transaction, transactionToSimulate, popupVisualisation, transactionOrMessageCreationStatus: 'Simulated' }
				return { ...transaction, transactionToSimulate, popupVisualisation, transactionOrMessageCreationStatus: 'FailedToSimulate' }
			})
			await updateConfirmTransactionView(ethereumClientService, tokenPriceService)
			await tryFocusingTabOrWindow(openedDialog)
			return { success: true }
		} catch(e: unknown) {
			printError(e)
			return formRejectMessage(METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, 'The Interceptor failed to send transaction')
		}
	})
	if (!('success' in outcome)) return formRejectMessage(outcome.error.code, outcome.error.message)
	const pendingTransactionData = await getPendingTransactionOrMessageByidentifier(request.uniqueRequestIdentifier)

	if (pendingTransactionData === undefined) return formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'The Interceptor failed to process the transaction')
	return { type: 'doNotReply' as const }
}
