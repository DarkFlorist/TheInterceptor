import type { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import { getInputFieldFromDataOrInput, getSimulatedBalance, getSimulatedErc20Balance, getSimulatedTransactionCount, simulateEstimateGas } from '../../simulation/services/SimulationModeEthereumClientService.js'
import { simulatePersonalSign } from '../../simulation/services/simulationPersonalSigning.js'
import { getSignedTransactionForSimulation } from '../../simulation/services/simulationTransactionSigning.js'
import { CANNOT_SIMULATE_OFF_LEGACY_BLOCK, ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS, METAMASK_ERROR_BLANKET_ERROR, METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { type TransactionConfirmation, UpdateConfirmTransactionDialog, UpdateConfirmTransactionDialogPendingTransactions } from '../../types/interceptor-messages.js'
import { Semaphore } from '../../utils/semaphore.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { type InterceptorTransactionStack, PASSTHROUGH_STATE, type WebsiteCreatedEthereumTransaction, type WebsiteCreatedEthereumTransactionOrFailed, createPassthroughCompleteVisualizedSimulation } from '../../types/visualizer-types.js'
import type { SendRawTransactionParams, SendTransactionParams } from '../../types/JsonRpc-types.js'
import { refreshConfirmTransactionSimulation } from '../confirmTransactionSimulation.js'
import { getUpdatedSimulationState } from '../simulationUpdating.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { appendPendingTransactionOrMessage, getInterceptorTransactionStack, getPendingTransactionsAndMessages, getRpcConnectionStatus, getTabState, getUserAddressBookEntriesForChainIdMorePreciseFirst, removePendingTransactionOrMessage, updateInterceptorTransactionStack, updatePendingTransactionOrMessage } from '../storageVariables.js'
import { type InterceptedRequest, type UniqueRequestIdentifier, doesUniqueRequestIdentifiersMatch, getUniqueRequestIdentifierString, silenceChromeUnCaughtPromise } from '../../utils/requests.js'
import { replyToInterceptedRequestAfterManifestV2Reconnect } from '../messageSending.js'
import { attemptQueuedTerminalReplyDelivery, queueTerminalReply, queueTerminalReplyAndAttemptDelivery } from '../terminalReplyDelivery.js'
import { stringToBytes, keccak256 } from '../../utils/ethereumPrimitives.js'
import { EthereumBytes32, EthereumQuantity, serialize } from '../../types/wire-types.js'
import type { PopupOrTabId, Website } from '../../types/websiteAccessTypes.js'
import { getErrorMessage, JsonRpcResponseError, reportUnexpectedError, isExpectedInfrastructureError, isNewBlockAbort, reportLocalRecovery } from '../../utils/errors.js'
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
import { closePopupOrTabById, getPopupOrTabById, openPopupOrTab, tryFocusingTabOrWindow } from '../../utils/popupOrTab.js'
import { getDesiredMaxFeePerGasForBaseFee, getTransactionFeesForBaseFee, hasExplicitMaxFeePerGas } from '../../utils/transactionFees.js'
import { parseSendRawTransaction } from '../../utils/sendRawTransactionParsing.js'
import { createEip1559Or7702Transaction } from '../../utils/eip7702Authorization.js'
import { identifyAddress } from '../metadataUtils.js'
import { resolveInsufficientBalanceMessage } from '../../utils/insufficientBalance.js'
import { prepareSafeTransactionConfirmation } from '../safeTransactionConfirmation.js'
import { createSafeMessageCoSignSnapshot, getPendingSafeSignerAddress, getSafeSignerMismatchApprovalStatus, isSafeMessageAccountMismatchFailure, isSafeSignerSelectionFailure, refreshSafeExecutionSignerSelection, refreshSafeMessageCoSignSignerSelection, refreshSafeTransactionSignerSelection, reportUnexpectedDirectSafeExecutionRecovery, resolveSafeConfirmation, SAFE_SIGNER_SELECTION_ERROR_CODE, type RefreshedSafeSignerSelection } from '../safeConfirmationResolver.js'
import { resolveSafeSignerReply } from '../safeConfirmationPersistence.js'
import { getWalletSelectedAccount } from '../../utils/signerMetadata.js'
import { createSafeSignerErrorStatus } from '../safeSignerErrors.js'

const pendingConfirmationSemaphore = new Semaphore(1)
const pendingNoResponseRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const NO_RESPONSE_RETRY_DELAY_MS = 50

async function rebuildDirectSafeExecutionForSigner(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	pending: PendingTransactionOrSignableMessage,
	selectedSigner: bigint,
) {
	if (
		pending.type !== 'Transaction'
		|| pending.safeExecutionOriginalRequestParameters === undefined
		|| pending.safeExecutionSignerAddress === selectedSigner
	) return undefined
	const refreshedPending = await refreshSafeExecutionSignerSelection(ethereum, pending, selectedSigner)
	if (refreshedPending?.type !== 'Transaction' || refreshedPending.originalRequestParameters.method !== 'eth_sendTransaction') return undefined
	const transactionToSimulate = await formEthSendTransaction(
		ethereum,
		undefined,
		refreshedPending.activeAddress,
		refreshedPending.website,
		refreshedPending.originalRequestParameters,
		refreshedPending.created,
		refreshedPending.transactionIdentifier,
		false,
		'external-executor',
	)
	const popupVisualisation = await refreshConfirmTransactionSimulation(
		ethereum,
		tokenPriceService,
		refreshedPending.activeAddress,
		false,
		refreshedPending.uniqueRequestIdentifier,
		transactionToSimulate,
	)
	if (popupVisualisation === undefined) throw new Error('The refreshed Gnosis Safe execution simulation did not complete.')
	if (transactionToSimulate.success) return {
		...refreshedPending,
		transactionToSimulate,
		popupVisualisation,
		transactionOrMessageCreationStatus: 'Simulated' as const,
	}
	return {
		...refreshedPending,
		transactionToSimulate,
		popupVisualisation,
		transactionOrMessageCreationStatus: 'FailedToSimulate' as const,
	}
}

export async function refreshPendingSafeSignerSelectionErrors(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, tabId: number) {
	const tabState = await getTabState(tabId)
	const refreshedSelection = {
		selectedSigner: getWalletSelectedAccount(tabState),
		verificationError: undefined,
	}
	let pendingStateChanged = false
	for (const pending of await getPendingTransactionsAndMessages()) {
		const safeSignerAddress = getPendingSafeSignerAddress(pending)
		if (
			pending.type === 'Transaction'
			&& pending.safeExecutionOriginalRequestParameters !== undefined
			&& refreshedSelection.selectedSigner !== undefined
			&& pending.uniqueRequestIdentifier.requestSocket.tabId === tabId
			&& pending.approvalStatus.status !== 'WaitingForSigner'
		) {
			try {
				const refreshedExecution = await rebuildDirectSafeExecutionForSigner(ethereum, tokenPriceService, pending, refreshedSelection.selectedSigner)
				if (refreshedExecution !== undefined) {
					await updatePendingTransactionOrMessage(pending.uniqueRequestIdentifier, async () => refreshedExecution)
					pendingStateChanged = true
					continue
				}
			} catch(error) {
				await reportUnexpectedDirectSafeExecutionRecovery(error)
				await updatePendingTransactionOrMessage(pending.uniqueRequestIdentifier, async (current) => modifyObject(current, {
					approvalStatus: createSafeSignerErrorStatus(getErrorMessage(error) ?? 'The wallet-selected Safe owner could not be prepared.', SAFE_SIGNER_SELECTION_ERROR_CODE),
				}))
				pendingStateChanged = true
				continue
			}
		}
		if (
			pending.type === 'SignableMessage'
			&& pending.safeMessageCoSignSnapshot !== undefined
			&& refreshedSelection.selectedSigner !== undefined
			&& pending.uniqueRequestIdentifier.requestSocket.tabId === tabId
			&& pending.approvalStatus.status !== 'WaitingForSigner'
		) {
			try {
				const refreshedCoSign = await refreshSafeMessageCoSignSignerSelection(ethereum, pending, refreshedSelection.selectedSigner)
				if (refreshedCoSign !== undefined && refreshedCoSign !== pending) {
					await updatePendingTransactionOrMessage(pending.uniqueRequestIdentifier, async () => refreshedCoSign)
					pendingStateChanged = true
					continue
				}
			} catch(error) {
				await updatePendingTransactionOrMessage(pending.uniqueRequestIdentifier, async (current) => modifyObject(current, {
					approvalStatus: createSafeSignerErrorStatus(getErrorMessage(error) ?? 'Select a current Gnosis Safe owner before co-signing.', SAFE_SIGNER_SELECTION_ERROR_CODE),
				}))
				pendingStateChanged = true
				continue
			}
		}
		if (
			pending.type === 'Transaction'
			&& pending.safeTransaction !== undefined
			&& refreshedSelection.selectedSigner !== undefined
			&& pending.uniqueRequestIdentifier.requestSocket.tabId === tabId
			&& (
				pending.approvalStatus.status === 'WaitingForUser'
				|| pending.approvalStatus.status === 'SignerError' && pending.approvalStatus.code === SAFE_SIGNER_SELECTION_ERROR_CODE
			)
			&& (
				pending.safeTransaction.safeSignerAddress !== refreshedSelection.selectedSigner
				|| pending.approvalStatus.status === 'SignerError'
			)
		) {
			const refreshedTransaction = await refreshSafeTransactionSignerSelection(ethereum, pending, refreshedSelection.selectedSigner)
			if (refreshedTransaction === undefined) continue
			if (
				refreshedTransaction.approvalStatus.status === 'SignerError'
				&& pending.approvalStatus.status === 'SignerError'
				&& pending.approvalStatus.message === refreshedTransaction.approvalStatus.message
			) continue
			await updatePendingTransactionOrMessage(pending.uniqueRequestIdentifier, async (current) => {
				if (current.type !== 'Transaction' || current.safeTransaction === undefined) return current
				return modifyObject(current, refreshedTransaction)
			})
			pendingStateChanged = true
			continue
		}
		if (
			safeSignerAddress === undefined
			|| pending.uniqueRequestIdentifier.requestSocket.tabId !== tabId
			|| pending.approvalStatus.status === 'WaitingForSigner'
			|| pending.approvalStatus.status === 'SignerError' && pending.approvalStatus.code !== SAFE_SIGNER_SELECTION_ERROR_CODE
		) continue
		const signerMismatch = await getSafeSignerMismatchApprovalStatus(tabId, safeSignerAddress, refreshedSelection)
		if (pending.approvalStatus.status === 'WaitingForUser' && signerMismatch === undefined) continue
		await updatePendingTransactionOrMessage(pending.uniqueRequestIdentifier, async (current) => {
			if (current.approvalStatus.status === 'WaitingForSigner') return current
			if (current.approvalStatus.status === 'SignerError' && current.approvalStatus.code !== SAFE_SIGNER_SELECTION_ERROR_CODE) return current
			pendingStateChanged = true
			return modifyObject(current, {
				approvalStatus: signerMismatch ?? { status: 'WaitingForUser' as const },
			})
		})
	}
	if (pendingStateChanged) await updateConfirmTransactionView(ethereum, tokenPriceService)
}

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
		const rpcConnectionStatusPromise = silenceChromeUnCaughtPromise(getRpcConnectionStatus())
		const pendingTransactionAndSignableMessages = await getPendingTransactionsAndMessages()
		if (pendingTransactionAndSignableMessages.length === 0) return false
		const showOptimisticSafeSimulation = pendingTransactionAndSignableMessages.some((pending) => pending.type === 'Transaction' && pending.safeTransaction !== undefined)
		const message: UpdateConfirmTransactionDialog = { method: 'popup_update_confirm_transaction_dialog', data: {
			currentBlockNumber: await currentBlockNumberPromise,
			rpcConnectionStatus: await rpcConnectionStatusPromise,
			visualizedSimulatorState: (await settings).simulationMode || showOptimisticSafeSimulation ? await visualizedSimulatorStatePromise : createPassthroughCompleteVisualizedSimulation(),
		} }
		const messagePendingTransactions: UpdateConfirmTransactionDialogPendingTransactions = {
			method: 'popup_update_confirm_transaction_dialog_pending_transactions' as const,
			data: {
				pendingTransactionAndSignableMessages: pendingTransactionAndSignableMessages.map(toPopupPendingTransactionOrSignableMessage),
				currentBlockNumber: await currentBlockNumberPromise,
				rpcConnectionStatus: await rpcConnectionStatusPromise,
			}
		}
		await Promise.all([
			sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialogPendingTransactions, messagePendingTransactions), 'confirmTransaction'),
			sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialog, message), 'confirmTransaction')
		])
		return true
	} catch(error: unknown) {
		if (isExpectedInfrastructureError(error)) return false
		await reportUnexpectedError(error)
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

export async function resolvePendingTransactionOrMessage(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation, refreshedSafeSignerSelection?: RefreshedSafeSignerSelection) {
	let pendingTransactionOrMessage = await getPendingTransactionOrMessageByidentifier(confirmation.data.uniqueRequestIdentifier)
	if (pendingTransactionOrMessage === undefined) return // no need to resolve as it doesn't exist anymore
	if (confirmation.data.action === 'accept' && refreshedSafeSignerSelection?.selectedSigner !== undefined && refreshedSafeSignerSelection.verificationError === undefined) {
		try {
			const refreshedExecution = await rebuildDirectSafeExecutionForSigner(ethereum, tokenPriceService, pendingTransactionOrMessage, refreshedSafeSignerSelection.selectedSigner)
			if (refreshedExecution !== undefined) {
				await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async () => refreshedExecution)
				await updateConfirmTransactionView(ethereum, tokenPriceService)
				return false
			}
		} catch(error) {
			await reportUnexpectedDirectSafeExecutionRecovery(error)
			await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (pending) => modifyObject(pending, {
				approvalStatus: createSafeSignerErrorStatus(getErrorMessage(error) ?? 'The wallet-selected Safe owner could not be prepared.', SAFE_SIGNER_SELECTION_ERROR_CODE),
			}))
			await updateConfirmTransactionView(ethereum, tokenPriceService)
			return false
		}
	}
	const safeResolution = await resolveSafeConfirmation(
		ethereum,
		pendingTransactionOrMessage,
		confirmation.data.action,
		refreshedSafeSignerSelection,
	)
	if (safeResolution.status === 'blocked') {
		await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (pending) => modifyObject(pending, {
			approvalStatus: safeResolution.approvalStatus,
		}))
		await updateConfirmTransactionView(ethereum, tokenPriceService)
		return false
	}
	if (safeResolution.status === 'refreshed') {
		pendingTransactionOrMessage = safeResolution.pending
		await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async () => pendingTransactionOrMessage)
		await updateConfirmTransactionView(ethereum, tokenPriceService)
		return false
	}
	pendingTransactionOrMessage = safeResolution.pending
	if (safeResolution.pendingChanged) {
		await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async () => pendingTransactionOrMessage)
	}
	const signerFacingRequest: SendTransactionParams | SendRawTransactionParams | SignMessageParams = safeResolution.signerFacingRequest
		?? pendingTransactionOrMessage.originalRequestParameters
	const removePendingRequestAndUpdateView = async () => {
		await removePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier)
		if ((await getPendingTransactionsAndMessages()).length === 0) await tryFocusingTabOrWindow({ type: 'tab', id: pendingTransactionOrMessage.uniqueRequestIdentifier.requestSocket.tabId })
		if (!(await updateConfirmTransactionView(ethereum, tokenPriceService))) await closePopupOrTabById(pendingTransactionOrMessage.popupOrTabId)
	}
	const reply = async (message: { type: 'forwardToSigner' } | { type: 'result', error: { code: number, message: string } } | { type: 'result', result: unknown }) => {
		if (message.type === 'result' && !('error' in message)) {
			if (pendingTransactionOrMessage.originalRequestParameters.method === 'eth_sendRawTransaction' || pendingTransactionOrMessage.originalRequestParameters.method === 'eth_sendTransaction') {
				const terminalReply = { ...pendingTransactionOrMessage.originalRequestParameters, ...message, result: EthereumBytes32.parse(message.result), uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier }
				await queueTerminalReply(terminalReply)
				await removePendingRequestAndUpdateView()
				return await attemptQueuedTerminalReplyDelivery(websiteTabConnections, terminalReply)
			}
			const terminalReply = { ...pendingTransactionOrMessage.originalRequestParameters, ...message, result: funtypes.String.parse(message.result), uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier }
			await queueTerminalReply(terminalReply)
			await removePendingRequestAndUpdateView()
			return await attemptQueuedTerminalReplyDelivery(websiteTabConnections, terminalReply)
		}
		if (message.type === 'result') {
			const terminalReply = { ...pendingTransactionOrMessage.originalRequestParameters, ...message, uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier }
			await queueTerminalReply(terminalReply)
			await removePendingRequestAndUpdateView()
			return await attemptQueuedTerminalReplyDelivery(websiteTabConnections, terminalReply)
		}
		await removePendingRequestAndUpdateView()
		return await replyToInterceptedRequestAfterManifestV2Reconnect(websiteTabConnections, { ...pendingTransactionOrMessage.originalRequestParameters, ...message, uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
	}
	if (
		confirmation.data.action === 'accept'
		&& pendingTransactionOrMessage.transactionOrMessageCreationStatus !== 'Simulated'
	) return false
	if (confirmation.data.action === 'accept' && pendingTransactionOrMessage.simulationMode === false) {
		await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (transaction) => modifyObject(transaction, { approvalStatus: { status: 'WaitingForSigner' } }))
		await updateConfirmTransactionView(ethereum, tokenPriceService)
		const requestWasForwarded = await replyToInterceptedRequestAfterManifestV2Reconnect(websiteTabConnections, { ...signerFacingRequest, type: 'forwardToSigner', uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
		if (requestWasForwarded) return true
		await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (transaction) => modifyObject(transaction, {
			approvalStatus: {
				status: 'SignerError',
				code: METAMASK_ERROR_BLANKET_ERROR,
				message: 'The website connection was interrupted before the request reached your wallet. Reload the website and try again.',
			}
		}))
		await updateConfirmTransactionView(ethereum, tokenPriceService)
		return false
	}
	if (confirmation.data.action === 'noResponse') {
		const noResponseDelivery = await queueTerminalReplyAndAttemptDelivery(websiteTabConnections, {
			...pendingTransactionOrMessage.originalRequestParameters,
			...formRejectMessage(METAMASK_ERROR_USER_REJECTED_REQUEST, 'User denied transaction signature'),
			uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier,
		})
		await removePendingRequestAndUpdateView()
		return noResponseDelivery
	}
	if (pendingTransactionOrMessage === undefined || pendingTransactionOrMessage.transactionOrMessageCreationStatus !== 'Simulated') return reply(formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'The Interceptor failed to process the transaction'))
	if (confirmation.data.action === 'reject') return reply(formRejectMessage(METAMASK_ERROR_USER_REJECTED_REQUEST, 'User denied transaction signature'))
	if (!pendingTransactionOrMessage.simulationMode) {
		if (confirmation.data.action === 'signerIncluded') {
			const safeReply = await resolveSafeSignerReply(ethereum, tokenPriceService, pendingTransactionOrMessage, confirmation.data.signerReply)
			if (safeReply.status === 'error') {
				await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (pending) => modifyObject(pending, {
					approvalStatus: safeReply.approvalStatus,
				}))
				await updateConfirmTransactionView(ethereum, tokenPriceService)
				return false
			}
			if (safeReply.status === 'success') return reply({ type: 'result', result: safeReply.result })
			return reply({ type: 'result', result: confirmation.data.signerReply })
		}
		await removePendingRequestAndUpdateView()
		return await replyToInterceptedRequestAfterManifestV2Reconnect(websiteTabConnections, { ...signerFacingRequest, type: 'forwardToSigner', uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
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
			const signedTransaction = getSignedTransactionForSimulation(pendingTransactionOrMessage.transactionToSimulate)
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

export async function resolvePendingRequestsForMissingConfirmationWindows(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections) {
	const pendingTransactions = await getPendingTransactionsAndMessages()
	const missingConfirmationWindows = new Map<string, boolean>()
	const orphanedTransactions: PendingTransactionOrSignableMessage[] = []
	for (const transaction of pendingTransactions) {
		const windowIdentifier = `${ transaction.popupOrTabId.type }:${ transaction.popupOrTabId.id }`
		let confirmationWindowIsMissing = missingConfirmationWindows.get(windowIdentifier)
		if (confirmationWindowIsMissing === undefined) {
			confirmationWindowIsMissing = await getPopupOrTabById(transaction.popupOrTabId) === undefined
			missingConfirmationWindows.set(windowIdentifier, confirmationWindowIsMissing)
		}
		if (confirmationWindowIsMissing) orphanedTransactions.push(transaction)
	}
	await resolveAllPendingTransactionsAndMessageAsNoResponse(orphanedTransactions, ethereum, tokenPriceService, websiteTabConnections)
}

const resolveAllPendingTransactionsAndMessageAsNoResponse = async (transactions: readonly PendingTransactionOrSignableMessage[], ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections) => {
	for (const transaction of transactions) {
		try {
			await resolvePendingTransactionOrMessage(ethereum, tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { uniqueRequestIdentifier: transaction.uniqueRequestIdentifier, action: 'noResponse' } })
		} catch(e) {
			await reportLocalRecovery(e, { code: 'pending_request_no_response_resolution_failed', message: 'Failed to resolve a pending request as no-response after a popup closed.' })
			schedulePendingNoResponseRetry(transaction, ethereum, tokenPriceService, websiteTabConnections)
		}
	}
}

function schedulePendingNoResponseRetry(transaction: PendingTransactionOrSignableMessage, ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections) {
	const identifier = getUniqueRequestIdentifierString(transaction.uniqueRequestIdentifier)
	if (pendingNoResponseRetryTimers.has(identifier)) return
	const retryTimer = setTimeout(() => {
		pendingNoResponseRetryTimers.delete(identifier)
		void (async () => {
			try {
				await resolvePendingTransactionOrMessage(ethereum, tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { uniqueRequestIdentifier: transaction.uniqueRequestIdentifier, action: 'noResponse' } })
			} catch (error) {
				await reportLocalRecovery(error, { code: 'pending_request_no_response_retry_failed', message: 'Retrying a pending popup-close rejection after a transient failure.' })
				schedulePendingNoResponseRetry(transaction, ethereum, tokenPriceService, websiteTabConnections)
			}
		})()
	}, NO_RESPONSE_RETRY_DELAY_MS)
	pendingNoResponseRetryTimers.set(identifier, retryTimer)
}

const formRejectMessage = (code: number, errorString: string) => {
	return {
		type: 'result' as const,
		error: { code, message: errorString }
	}
}

const resolveInsufficientBalanceMessageForTransaction = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationState: Awaited<ReturnType<typeof getUpdatedSimulationState>>,
	transaction: {
		from: bigint
		to: bigint | null
		value: bigint
		input: Uint8Array
	},
	nativeBalancePromise: Promise<bigint>,
) => {
	try {
		const nativeBalance = await nativeBalancePromise
		return await resolveInsufficientBalanceMessage(
			transaction,
			{ balance: nativeBalance, symbol: ethereumClientService.getRpcEntry().currencyTicker, decimals: 18n },
			async (token, owner) => {
				const tokenEntry = await identifyAddress(ethereumClientService, requestAbortController, token)
				if (tokenEntry.type !== 'ERC20') return undefined
				const tokenBalance = await getSimulatedErc20Balance(ethereumClientService, requestAbortController, simulationState, token, owner)
				if (tokenBalance === undefined) return undefined
				return { token, balance: tokenBalance, symbol: tokenEntry.symbol, decimals: tokenEntry.decimals }
			},
		)
	} catch(error: unknown) {
		if (isNewBlockAbort(error)) throw error
		await reportLocalRecovery(error, {
			code: 'insufficient_balance_diagnosis_failed',
			message: 'Keeping the original gas-estimation error because optional balance diagnosis failed.',
		})
		return undefined
	}
}

export const formSendRawTransaction = async(_ethereumClientService: EthereumClientService, sendRawTransactionParams: SendRawTransactionParams, website: Website, created: Date, transactionIdentifier: EthereumQuantity): Promise<WebsiteCreatedEthereumTransaction> => {
	const parsedTransaction = await parseSendRawTransaction(sendRawTransactionParams.params[0])
	return {
		transaction: parsedTransaction.transaction,
		signedTransaction: parsedTransaction.signedTransaction,
		website,
		created,
		originalRequestParameters: sendRawTransactionParams,
		transactionIdentifier,
		success: true,
	}
}

export type TransactionGasPayment = 'transaction-sender' | 'external-executor'

export const formEthSendTransaction = async(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, activeAddress: bigint | undefined, website: Website, sendTransactionParams: SendTransactionParams, created: Date, transactionIdentifier: EthereumQuantity, simulationMode = true, gasPayment: TransactionGasPayment = 'transaction-sender'): Promise<WebsiteCreatedEthereumTransactionOrFailed> => {
	const simulationState = simulationMode || gasPayment === 'external-executor'
		? await getUpdatedSimulationState(ethereumClientService)
		: PASSTHROUGH_STATE
	const transactionDetails = sendTransactionParams.params[0]
	if (activeAddress === undefined) throw new Error('Access to active address is denied')
	const from = simulationMode && transactionDetails.from !== undefined ? transactionDetails.from : activeAddress
	const transactionCountPromise = silenceChromeUnCaughtPromise(getSimulatedTransactionCount(ethereumClientService, requestAbortController, simulationState, from))
	const parentBlockPromise = gasPayment === 'transaction-sender'
		? silenceChromeUnCaughtPromise(ethereumClientService.getBlock(requestAbortController)) // the latest real block is the parent of the transaction being prepared
		: undefined
	const balancePromise = gasPayment === 'transaction-sender'
		? silenceChromeUnCaughtPromise(getSimulatedBalance(ethereumClientService, requestAbortController, simulationState, from))
		: undefined
	const parentBlock = parentBlockPromise === undefined ? undefined : await parentBlockPromise
	if (parentBlock === null) throw new Error('The latest block is null')
	if (parentBlock !== undefined && parentBlock.baseFeePerGas === undefined) throw new Error(CANNOT_SIMULATE_OFF_LEGACY_BLOCK)
	const parentBaseFeePerGas = parentBlock?.baseFeePerGas
	const requestedMaxPriorityFeePerGas = transactionDetails.maxPriorityFeePerGas !== undefined && transactionDetails.maxPriorityFeePerGas !== null ? transactionDetails.maxPriorityFeePerGas : 10n**8n // 0.1 nanoEth/gas
	const maxPriorityFeePerGas = gasPayment === 'external-executor' ? 0n : requestedMaxPriorityFeePerGas
	const value = transactionDetails.value !== undefined  ? transactionDetails.value : 0n
	const getFeePerGas = async (gasLimit: bigint) => {
		if (gasPayment === 'external-executor') return { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }
		if (parentBaseFeePerGas === undefined || balancePromise === undefined) throw new Error('Transaction fee context is unavailable')
		return getTransactionFeesForBaseFee(parentBaseFeePerGas, maxPriorityFeePerGas, transactionDetails.maxFeePerGas, await balancePromise, value, gasLimit)
	}
	const getInitialMaxFeePerGas = () => {
		if (gasPayment === 'external-executor') return 0n
		if (hasExplicitMaxFeePerGas(transactionDetails.maxFeePerGas)) return transactionDetails.maxFeePerGas
		if (parentBaseFeePerGas === undefined) throw new Error('Transaction fee context is unavailable')
		return getDesiredMaxFeePerGasForBaseFee(parentBaseFeePerGas, maxPriorityFeePerGas)
	}
	const transactionWithoutGasBase = {
		from,
		chainId: ethereumClientService.getChainId(),
		nonce: await transactionCountPromise,
		maxFeePerGas: getInitialMaxFeePerGas(),
		maxPriorityFeePerGas,
		to: transactionDetails.to === undefined ? null : transactionDetails.to,
		value,
		input: getInputFieldFromDataOrInput(transactionDetails),
		accessList: transactionDetails.accessList ?? [],
	}
	const transactionWithoutGas = await createEip1559Or7702Transaction(transactionWithoutGasBase, transactionDetails)
	const extraParams = {
		website,
		created,
		originalRequestParameters: sendTransactionParams,
		transactionIdentifier,
		error: undefined,
	}
	if (transactionDetails.gas === undefined) {
		try {
			if (gasPayment === 'external-executor' && simulationState.kind === 'passthrough') {
				throw new Error('Gnosis Safe transaction gas estimation requires the Interceptor simulator.')
			}
			const estimateGas = await simulateEstimateGas(ethereumClientService, requestAbortController, simulationState, transactionWithoutGas)
			if ('error' in estimateGas) {
				const insufficientBalanceMessage = balancePromise === undefined
					? undefined
					: await resolveInsufficientBalanceMessageForTransaction(ethereumClientService, requestAbortController, simulationState, transactionWithoutGas, balancePromise)
				return {
					...extraParams,
					error: insufficientBalanceMessage === undefined ? estimateGas.error : { ...estimateGas.error, message: insufficientBalanceMessage },
					success: false,
				}
			}
			return { transaction: { ...transactionWithoutGas, ...await getFeePerGas(estimateGas.gas), gas: estimateGas.gas }, ...extraParams, success: true }
		} catch(error: unknown) {
			if (isNewBlockAbort(error)) throw error
			if (error instanceof JsonRpcResponseError) return { ...extraParams, error: { code: error.code, message: error.message, data: typeof error.data === 'string' ? error.data : '0x' }, success: false }
			await reportLocalRecovery(error, { code: 'transaction_gas_estimation_failed', message: 'Returning a typed RPC error to the requesting page.' })
			if (error instanceof Error) return { ...extraParams, error: { code: 123456, message: error.message, data: 'data' in error && typeof error.data === 'string' ? error.data : '0x' }, success: false }
			return { ...extraParams, error: { code: 123456, message: 'Unknown Error', data: '0x' }, success: false }
		}
	}
	return { transaction: { ...transactionWithoutGas, ...await getFeePerGas(transactionDetails.gas), gas: transactionDetails.gas }, ...extraParams, success: true }
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
	const activeAddressEntry = simulationMode
		? (await getUserAddressBookEntriesForChainIdMorePreciseFirst(ethereumClientService.getChainId()))
			.find((entry) => entry.address === activeAddress)
		: undefined
	const simulationSignerAddress = activeAddressEntry?.type === 'safe'
		? activeAddressEntry.safeSimulationSignerAddress ?? activeAddressEntry.safeSignerAddresses?.[0] ?? activeAddress
		: activeAddress
	const uniqueRequestIdentifierString = getUniqueRequestIdentifierString(request.uniqueRequestIdentifier)
	const messageIdentifier = EthereumQuantity.parse(keccak256(stringToBytes(uniqueRequestIdentifierString)))
	const created = new Date()
	const signedMessageTransaction = {
		website,
		created,
		activeAddress,
		originalRequestParameters: transactionParams,
		fakeSignedFor: simulationSignerAddress,
		simulationMode,
		request,
		messageIdentifier,
	}
	try {
		const visualizedPersonalSignRequest = await craftPersonalSignPopupMessage(ethereumClientService, undefined, signedMessageTransaction, ethereumClientService.getRpcEntry())
		const signerTabState = await getTabState(request.uniqueRequestIdentifier.requestSocket.tabId)
		const walletSignerAddress = getWalletSelectedAccount(signerTabState)
		let safeMessageCoSignSnapshot: Awaited<ReturnType<typeof createSafeMessageCoSignSnapshot>> | undefined
		let safeMessageAccountMismatch: string | undefined
		if (!simulationMode && visualizedPersonalSignRequest.type === 'SafeTx') {
			try {
				safeMessageCoSignSnapshot = await createSafeMessageCoSignSnapshot(ethereumClientService, activeAddress, walletSignerAddress, transactionParams, visualizedPersonalSignRequest.message)
			} catch (error) {
				if (!isSafeMessageAccountMismatchFailure(error)) throw error
				safeMessageAccountMismatch = getErrorMessage(error) ?? 'The Gnosis Safe transaction signing account does not match the active Gnosis Safe.'
			}
		}
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
				approvalStatus: safeMessageAccountMismatch === undefined
					? { status: 'WaitingForUser' as const }
					: createSafeSignerErrorStatus(safeMessageAccountMismatch, SAFE_SIGNER_SELECTION_ERROR_CODE),
				signedMessageTransaction,
				...(safeMessageCoSignSnapshot === undefined ? {} : { safeMessageCoSignSnapshot }),
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
		if (isSafeSignerSelectionFailure(e)) {
			return formRejectMessage(SAFE_SIGNER_SELECTION_ERROR_CODE, getErrorMessage(e) ?? 'Select a current Gnosis Safe owner in the signer wallet before co-signing.')
		}
		await reportUnexpectedError(e)
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
	if (activeAddress === undefined) return { type: 'result' as const, ...ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS }
	const signerTabState = await getTabState(request.uniqueRequestIdentifier.requestSocket.tabId)
	const walletSignerAddress = getWalletSelectedAccount(signerTabState)
	const safePreparation = await prepareSafeTransactionConfirmation(
		ethereumClientService,
		transactionParams,
		simulationMode,
		activeAddress,
		walletSignerAddress,
	)
	if (safePreparation.rejection !== undefined) {
		return formRejectMessage(safePreparation.rejection.code, safePreparation.rejection.message)
	}
	const {
		effectiveTransactionParams,
		transactionExecutor,
		gasPayment,
		preparationMessage: safePreparationMessage,
	} = safePreparation
	const transactionToSimulatePromise = safePreparationMessage !== undefined
		? Promise.resolve({
			website,
			created,
			originalRequestParameters: effectiveTransactionParams,
			transactionIdentifier,
			success: false as const,
			error: {
				code: METAMASK_ERROR_FAILED_TO_PARSE_REQUEST,
				message: safePreparationMessage,
			},
		})
		: effectiveTransactionParams.method === 'eth_sendTransaction'
		? formEthSendTransaction(
			ethereumClientService,
			undefined,
			transactionExecutor,
			website,
			effectiveTransactionParams,
			created,
			transactionIdentifier,
			simulationMode,
			gasPayment,
		)
		: formSendRawTransaction(ethereumClientService, effectiveTransactionParams, website, created, transactionIdentifier)
	silenceChromeUnCaughtPromise(transactionToSimulatePromise)
	const outcome = await pendingConfirmationSemaphore.execute(async () => {
		try {
			const finalizedSafePreparation = await safePreparation.finalize(
				await transactionToSimulatePromise,
				request.uniqueRequestIdentifier.requestSocket.tabId,
			)
			const { transactionToSimulate, safeTransaction, approvalStatus: safeSignerMismatch, pendingSafeFields } = finalizedSafePreparation
			const openedDialog = await getPendingTransactionWindow(ethereumClientService, tokenPriceService, websiteTabConnections)
			if (openedDialog === undefined) return formRejectMessage(METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, 'Failed to get pending transaction window')
			markPerformance(POPUP_PERFORMANCE_MARKS.backgroundTransactionConfirmPopupOpened)

			const pendingTransaction = {
				type: 'Transaction' as const,
				popupOrTabId: openedDialog,
				originalRequestParameters: effectiveTransactionParams,
				uniqueRequestIdentifier: request.uniqueRequestIdentifier,
				simulationMode,
				activeAddress: transactionExecutor,
				created,
				transactionOrMessageCreationStatus: 'Crafting' as const,
				transactionIdentifier,
				website,
				approvalStatus: safeSignerMismatch ?? { status: 'WaitingForUser' as const },
				...(safeTransaction === undefined ? {} : { safeTransaction }),
				...(pendingSafeFields ?? {}),
			}
			await appendPendingTransactionOrMessage(pendingTransaction)
			await updateConfirmTransactionView(ethereumClientService, tokenPriceService)
			markPerformance(POPUP_PERFORMANCE_MARKS.backgroundTransactionSimulationStart)
			const simulationResultsPromise = silenceChromeUnCaughtPromise(refreshConfirmTransactionSimulation(
				ethereumClientService,
				tokenPriceService,
				transactionExecutor,
				simulationMode,
				request.uniqueRequestIdentifier,
				transactionToSimulate,
				safeTransaction,
			))
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
			await reportLocalRecovery(e, { code: 'send_transaction_preparation_failed', message: 'Returning a wallet-compatible rejection to the requesting page.', details: e instanceof Error ? e.stack : undefined })
			return formRejectMessage(METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, 'The Interceptor failed to send transaction')
		}
	})
	if (!('success' in outcome)) return formRejectMessage(outcome.error.code, outcome.error.message)
	const pendingTransactionData = await getPendingTransactionOrMessageByidentifier(request.uniqueRequestIdentifier)

	if (pendingTransactionData === undefined) return formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'The Interceptor failed to process the transaction')
	return { type: 'doNotReply' as const }
}
