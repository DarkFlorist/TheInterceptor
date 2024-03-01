import { closePopupOrTabById, getPopupOrTabOnlyById, openPopupOrTab, tryFocusingTabOrWindow } from '../../components/ui-utils.js'
import { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import { appendTransaction, getInputFieldFromDataOrInput, getSimulatedTransactionCount, simulateEstimateGas } from '../../simulation/services/SimulationModeEthereumClientService.js'
import { CANNOT_SIMULATE_OFF_LEGACY_BLOCK, ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS, METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { TransactionConfirmation } from '../../types/interceptor-messages.js'
import { Semaphore } from '../../utils/semaphore.js'
import { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { WebsiteCreatedEthereumUnsignedTransaction, WebsiteCreatedEthereumUnsignedTransactionOrFailed } from '../../types/visualizer-types.js'
import { SendRawTransactionParams, SendTransactionParams } from '../../types/JsonRpc-types.js'
import { refreshConfirmTransactionSimulation, updateSimulationState } from '../background.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { appendPendingTransactionOrMessage, clearPendingTransactions, getPendingTransactionsAndMessages, getSimulationResults, removePendingTransaction, updatePendingSignableMessage, updatePendingTransaction } from '../storageVariables.js'
import { InterceptedRequest, UniqueRequestIdentifier, doesUniqueRequestIdentifiersMatch, getUniqueRequestIdentifierString } from '../../utils/requests.js'
import { replyToInterceptedRequest } from '../messageSending.js'
import { Simulator } from '../../simulation/simulator.js'
import { ethers, keccak256, toUtf8Bytes } from 'ethers'
import { dataStringWith0xStart, stringToUint8Array } from '../../utils/bigint.js'
import { EthereumAddress, EthereumQuantity } from '../../types/wire-types.js'
import { PopupOrTabId, Website } from '../../types/websiteAccessTypes.js'
import { printError } from '../../utils/errors.js'
import { PendingTransactionOrSignableMessage } from '../../types/accessRequest.js'
import { SignMessageParams } from '../../types/jsonRpc-signing-types.js'
import { craftPersonalSignPopupMessage } from './personalSign.js'

const pendingConfirmationSemaphore = new Semaphore(1)

export async function updateConfirmTransactionViewWithPendingTransaction(ethereumClientService: EthereumClientService) {
	const promises = await getPendingTransactionsAndMessages()
	if (promises.length === 0) return false
	const currentBlockNumberPromise = ethereumClientService.getBlockNumber()
	await sendPopupMessageToOpenWindows({ method: 'popup_update_confirm_transaction_dialog', data: { pendingTransactionAndSignableMessages: promises, currentBlockNumber: await currentBlockNumberPromise }})
	return true
}

export const isConfirmTransactionFocused = async () => {
	const pendingTransactions = await getPendingTransactionsAndMessages()
	if (pendingTransactions[0] === undefined) return false
	const popup = await getPopupOrTabOnlyById(pendingTransactions[0].popupOrTabId)
	if (popup === undefined) return false
	if (popup.type === 'popup') return popup.window.focused
	return popup.tab.active
}

const getPendingTransactionByidentifier = async (uniqueRequestIdentifier: UniqueRequestIdentifier) => {
	return (await getPendingTransactionsAndMessages()).find((tx) => doesUniqueRequestIdentifiersMatch(tx.uniqueRequestIdentifier, uniqueRequestIdentifier))
}

export async function resolvePendingTransaction(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation) {
	const pendingTransaction = await getPendingTransactionByidentifier(confirmation.data.uniqueRequestIdentifier)
	if (pendingTransaction === undefined) throw new Error('Tried to resolve pending transaction that did not exist anymore')
	if (pendingTransaction.type !== 'Transaction') return
	if (confirmation.data.action === 'accept' && pendingTransaction.simulationMode === false) {
		await updatePendingTransaction(confirmation.data.uniqueRequestIdentifier, async (transaction) => ({ ...transaction, approvalStatus: { status: 'WaitingForSigner' } }))
		await updateConfirmTransactionViewWithPendingTransaction(simulator.ethereum)
		return replyToInterceptedRequest(websiteTabConnections, { ...pendingTransaction.originalRequestParameters, type: 'forwardToSigner', uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
	}
	await removePendingTransaction(confirmation.data.uniqueRequestIdentifier)
	if ((await getPendingTransactionsAndMessages()).length === 0) await tryFocusingTabOrWindow({ type: 'tab', id: pendingTransaction.uniqueRequestIdentifier.requestSocket.tabId })
	if (!(await updateConfirmTransactionViewWithPendingTransaction(simulator.ethereum))) await closePopupOrTabById(pendingTransaction.popupOrTabId)
	
	const reply = (message: { type: 'forwardToSigner' } | { type: 'result', error: { code: number, message: string } } | { type: 'result', result: bigint }) => {
		replyToInterceptedRequest(websiteTabConnections, { ...pendingTransaction.originalRequestParameters, ...message, uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
	}
	
	if (confirmation.data.action === 'noResponse') return reply(formRejectMessage(undefined))
	if (pendingTransaction === undefined || pendingTransaction.transactionOrMessageCreationStatus !== 'Simulated') return reply(formRejectMessage(undefined))
	if (confirmation.data.action === 'reject') return reply(formRejectMessage(confirmation.data.transactionErrorString))
	if (!pendingTransaction.simulationMode) {
		if (confirmation.data.action === 'signerIncluded') return reply({ type: 'result', result: confirmation.data.transactionHash })
		return reply({ type: 'forwardToSigner' })
	}
	if (confirmation.data.action === 'signerIncluded') throw new Error('Signer included transaction that was in simulation')
	const newState = await updateSimulationState(simulator.ethereum, async (simulationState) => await appendTransaction(simulator.ethereum, simulationState, pendingTransaction.transactionToSimulate), pendingTransaction.activeAddress, true)
	if (newState === undefined || newState.simulatedTransactions === undefined || newState.simulatedTransactions.length === 0) return reply({ type: 'result', ...METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN })
	const lastTransaction = newState.simulatedTransactions[newState.simulatedTransactions.length - 1]
	if (lastTransaction === undefined) throw new Error('missing last transaction')
	return reply({ type: 'result', result: lastTransaction.signedTransaction.hash })
}

export const onCloseWindowOrTab = async (popupOrTabs: PopupOrTabId, simulator: Simulator, websiteTabConnections: WebsiteTabConnections) => { // check if user has closed the window on their own, if so, reject all signatures
	const transactions = await getPendingTransactionsAndMessages()
	const [firstTransaction] = transactions
	if (firstTransaction?.popupOrTabId.id !== popupOrTabs.id) return
	await resolveAllPendingTransactionsAndMessageAsNoResponse(transactions, simulator, websiteTabConnections)
}

const resolveAllPendingTransactionsAndMessageAsNoResponse = async (transactions: readonly PendingTransactionOrSignableMessage[], simulator: Simulator, websiteTabConnections: WebsiteTabConnections) => {
	for (const transaction of transactions) {
		try {
			await resolvePendingTransaction(simulator, websiteTabConnections, { method: 'popup_confirmDialog', data: { uniqueRequestIdentifier: transaction.uniqueRequestIdentifier, action: 'noResponse' } })
		} catch(e) {
			printError(e)
		}
	}
	await clearPendingTransactions()
}

const formRejectMessage = (errorString: undefined | string) => {
	return {
		type: 'result' as const,
		error: {
			code: METAMASK_ERROR_USER_REJECTED_REQUEST,
			message: errorString === undefined ? 'Interceptor Tx Signature: User denied transaction signature.' : `Interceptor Tx Signature: User denied reverting transaction: ${ errorString }.`
		}
	}
}

export const formSendRawTransaction = async(ethereumClientService: EthereumClientService, sendRawTransactionParams: SendRawTransactionParams, website: Website, created: Date, transactionIdentifier: EthereumQuantity): Promise<WebsiteCreatedEthereumUnsignedTransaction> => {	
	const ethersTransaction = ethers.Transaction.from(dataStringWith0xStart(sendRawTransactionParams.params[0]))
	const transactionDetails = {
		from: EthereumAddress.parse(ethersTransaction.from),
		input: stringToUint8Array(ethersTransaction.data),
		...ethersTransaction.gasLimit === null ? { gas: ethersTransaction.gasLimit } : {},
		value: ethersTransaction.value,
		...ethersTransaction.to === null ? {} : { to: EthereumAddress.parse(ethersTransaction.to) },
		...ethersTransaction.gasPrice === null ? {} : { gasPrice: ethersTransaction.gasPrice },
		...ethersTransaction.maxPriorityFeePerGas === null ? {} : { maxPriorityFeePerGas: ethersTransaction.maxPriorityFeePerGas },
		...ethersTransaction.maxFeePerGas === null ? {} : { maxFeePerGas: ethersTransaction.maxFeePerGas },
	}

	if (transactionDetails.maxFeePerGas === undefined) throw new Error('No support for non-1559 transactions')

	const transaction = {
		type: '1559' as const,
		from: transactionDetails.from,
		chainId: ethereumClientService.getChainId(),
		nonce: BigInt(ethersTransaction.nonce),
		maxFeePerGas: transactionDetails.maxFeePerGas,
		maxPriorityFeePerGas: transactionDetails.maxPriorityFeePerGas ? transactionDetails.maxPriorityFeePerGas : 0n,
		to: transactionDetails.to === undefined ? null : transactionDetails.to,
		value: transactionDetails.value ? transactionDetails.value : 0n,
		input: transactionDetails.input,
		accessList: [],
		gas: ethersTransaction.gasLimit,
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

export const formEthSendTransaction = async(ethereumClientService: EthereumClientService, activeAddress: bigint | undefined, simulationMode: boolean = true, website: Website, sendTransactionParams: SendTransactionParams, created: Date, transactionIdentifier: EthereumQuantity): Promise<WebsiteCreatedEthereumUnsignedTransactionOrFailed> => {
	const simulationState = simulationMode ? (await getSimulationResults()).simulationState : undefined
	const parentBlockPromise = ethereumClientService.getBlock() // we are getting the real block here, as we are not interested in the current block where this is going to be included, but the parent
	const transactionDetails = sendTransactionParams.params[0]
	if (activeAddress === undefined) throw new Error('Access to active address is denied')
	const from = simulationMode && transactionDetails.from !== undefined ? transactionDetails.from : activeAddress
	const transactionCount = getSimulatedTransactionCount(ethereumClientService, simulationState, from)
	const parentBlock = await parentBlockPromise
	if (parentBlock.baseFeePerGas === undefined) throw new Error(CANNOT_SIMULATE_OFF_LEGACY_BLOCK)
	const transactionWithoutGas = {
		type: '1559' as const,
		from,
		chainId: ethereumClientService.getChainId(),
		nonce: await transactionCount,
		maxFeePerGas: transactionDetails.maxFeePerGas !== undefined && transactionDetails.maxFeePerGas !== null ? transactionDetails.maxFeePerGas : parentBlock.baseFeePerGas * 2n,
		maxPriorityFeePerGas: transactionDetails.maxPriorityFeePerGas !== undefined && transactionDetails.maxPriorityFeePerGas !== null ? transactionDetails.maxPriorityFeePerGas : 10n**8n, // 0.1 nanoEth/gas
		to: transactionDetails.to === undefined ? null : transactionDetails.to,
		value: transactionDetails.value != undefined  ? transactionDetails.value : 0n,
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
		const estimateGas = await simulateEstimateGas(ethereumClientService, simulationState, transactionWithoutGas)
		if ('error' in estimateGas) return { ...extraParams, ...estimateGas, success: false }
		return { transaction: { ...transactionWithoutGas, gas: estimateGas.gas }, ...extraParams, success: true }
	}
	return { transaction: { ...transactionWithoutGas, gas: transactionDetails.gas }, ...extraParams, success: true }
}

const getPendingTransactionWindow = async (simulator: Simulator, websiteTabConnections: WebsiteTabConnections) => {
	const pendingTransactions = await getPendingTransactionsAndMessages()
	const [firstPendingTransaction] = pendingTransactions
	if (firstPendingTransaction !== undefined) {
		const alreadyOpenWindow = await getPopupOrTabOnlyById(firstPendingTransaction.popupOrTabId)
		if (alreadyOpenWindow) return alreadyOpenWindow
		await resolveAllPendingTransactionsAndMessageAsNoResponse(pendingTransactions, simulator, websiteTabConnections)
	}
	return await openPopupOrTab({ url: getHtmlFile('confirmTransaction'), type: 'popup', height: 800, width: 600 })
}


export async function openConfirmTransactionDialogForMessage(
	simulator: Simulator,
	ethereumClientService: EthereumClientService,
	request: InterceptedRequest,
	transactionParams: SignMessageParams,
	simulationMode: boolean,
	activeAddress: bigint | undefined,
	website: Website,
	websiteTabConnections: WebsiteTabConnections,
) {
	if (activeAddress === undefined) return { type: 'result' as const, ...ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS }
	const created = new Date()
	const signedMessageTransaction = {
		website,
		created,
		originalRequestParameters: transactionParams,
		fakeSignedFor: activeAddress,
		simulationMode,
		request,
	}
	const visualizedPersonalSignRequestPromise = craftPersonalSignPopupMessage(ethereumClientService, signedMessageTransaction, ethereumClientService.getRpcEntry())

	await pendingConfirmationSemaphore.execute(async () => {
		const openedDialog = await getPendingTransactionWindow(simulator, websiteTabConnections)
		if (openedDialog === undefined) throw new Error('Failed to get pending transaction window!')

		const pendingTransaction = {
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
		const currentPendingTranasctions = await appendPendingTransactionOrMessage(pendingTransaction)
		if (currentPendingTranasctions.length > 1) await sendPopupMessageToOpenWindows({ method: 'popup_confirm_transaction_dialog_pending_changed', data: {
			currentBlockNumber: await ethereumClientService.getBlockNumber(),
			pendingTransactionAndSignableMessages: await getPendingTransactionsAndMessages()
		} })
		await updateConfirmTransactionViewWithPendingTransaction(ethereumClientService)

		await updatePendingSignableMessage(pendingTransaction.uniqueRequestIdentifier, async (message) => ({ ...message, transactionOrMessageCreationStatus: 'Simulating' as const }))
		await updateConfirmTransactionViewWithPendingTransaction(ethereumClientService)
		await updatePendingSignableMessage(pendingTransaction.uniqueRequestIdentifier, async (message) => ({
			...message,
			visualizedPersonalSignRequest: await visualizedPersonalSignRequestPromise,
			transactionOrMessageCreationStatus: 'Simulated' as const,
		}))
		await updateConfirmTransactionViewWithPendingTransaction(ethereumClientService)
		await tryFocusingTabOrWindow(openedDialog)
	})
	const pendingTransactionData = await getPendingTransactionByidentifier(request.uniqueRequestIdentifier)
	if (pendingTransactionData === undefined) return formRejectMessage(undefined)
	return { type: 'doNotReply' as const }
}

export async function openConfirmTransactionDialogForTransaction(
	simulator: Simulator,
	ethereumClientService: EthereumClientService,
	request: InterceptedRequest,
	transactionParams: SendTransactionParams | SendRawTransactionParams,
	simulationMode: boolean,
	activeAddress: bigint | undefined,
	website: Website,
	websiteTabConnections: WebsiteTabConnections,
) {
	const uniqueRequestIdentifier = getUniqueRequestIdentifierString(request.uniqueRequestIdentifier)
	const transactionIdentifier = EthereumQuantity.parse(keccak256(toUtf8Bytes(uniqueRequestIdentifier)))
	const created = new Date()
	const transactionToSimulatePromise = transactionParams.method === 'eth_sendTransaction' ? formEthSendTransaction(ethereumClientService, activeAddress, simulationMode, website, transactionParams, created, transactionIdentifier) : formSendRawTransaction(ethereumClientService, transactionParams, website, created, transactionIdentifier)
	if (activeAddress === undefined) return { type: 'result' as const, ...ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS }

	await pendingConfirmationSemaphore.execute(async () => {
		const openedDialog = await getPendingTransactionWindow(simulator, websiteTabConnections)
		if (openedDialog === undefined) throw new Error('Failed to get pending transaction window!')

		const pendingTransaction =  {
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

		const currentPendingTranasctions = await appendPendingTransactionOrMessage(pendingTransaction)
		if (currentPendingTranasctions.length > 1) await sendPopupMessageToOpenWindows({ method: 'popup_confirm_transaction_dialog_pending_changed', data: {
			currentBlockNumber: await ethereumClientService.getBlockNumber(),
			pendingTransactionAndSignableMessages: await getPendingTransactionsAndMessages()
		} })
		await updateConfirmTransactionViewWithPendingTransaction(ethereumClientService)

		const transactionToSimulate = await transactionToSimulatePromise
		if (transactionToSimulate.success === false) {
			await updatePendingTransaction(pendingTransaction.uniqueRequestIdentifier, async (transaction) => ({
				...transaction,
				transactionToSimulate,
				simulationResults: await refreshConfirmTransactionSimulation(simulator, ethereumClientService, activeAddress, simulationMode, request.uniqueRequestIdentifier, transactionToSimulate),
				transactionOrMessageCreationStatus: 'FailedToSimulate' as const,
			}))
		} else {
			await updatePendingTransaction(pendingTransaction.uniqueRequestIdentifier, async (transaction) => ({ ...transaction, transactionToSimulate: transactionToSimulate, transactionOrMessageCreationStatus: 'Simulating' as const }))
			await updateConfirmTransactionViewWithPendingTransaction(ethereumClientService)
			await updatePendingTransaction(pendingTransaction.uniqueRequestIdentifier, async (transaction) => ({
				...transaction,
				transactionToSimulate,
				simulationResults: await refreshConfirmTransactionSimulation(simulator, ethereumClientService, activeAddress, simulationMode, request.uniqueRequestIdentifier, transactionToSimulate),
				transactionOrMessageCreationStatus: 'Simulated' as const,
			}))
		}
		await updateConfirmTransactionViewWithPendingTransaction(ethereumClientService)
		await tryFocusingTabOrWindow(openedDialog)
	})
	const pendingTransactionData = await getPendingTransactionByidentifier(request.uniqueRequestIdentifier)
	if (pendingTransactionData === undefined) return formRejectMessage(undefined)
	return { type: 'doNotReply' as const }
}
