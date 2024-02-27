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
import { appendPendingTransaction, clearPendingTransactions, getPendingTransactions, getSimulationResults, removePendingTransaction, replacePendingTransaction } from '../storageVariables.js'
import { InterceptedRequest, getUniqueRequestIdentifierString } from '../../utils/requests.js'
import { replyToInterceptedRequest } from '../messageSending.js'
import { Simulator } from '../../simulation/simulator.js'
import { ethers, keccak256, toUtf8Bytes } from 'ethers'
import { dataStringWith0xStart, stringToUint8Array } from '../../utils/bigint.js'
import { EthereumAddress, EthereumQuantity } from '../../types/wire-types.js'
import { PopupOrTabId, Website } from '../../types/websiteAccessTypes.js'

const pendingConfirmationSemaphore = new Semaphore(1)

export async function updateConfirmTransactionViewWithPendingTransaction(ethereumClientService: EthereumClientService) {
	const promises = await getPendingTransactions()
	if (promises.length === 0) return false
	const currentBlockNumberPromise = ethereumClientService.getBlockNumber()
	await sendPopupMessageToOpenWindows({ method: 'popup_update_confirm_transaction_dialog', data: { pendingTransactions: promises, currentBlockNumber: await currentBlockNumberPromise }})
	return true
}

export const isConfirmTransactionFocused = async () => {
	const pendingTransactions = await getPendingTransactions()
	if (pendingTransactions[0] === undefined) return false
	const popup = await getPopupOrTabOnlyById(pendingTransactions[0].popupOrTabId)
	if (popup === undefined) return false
	if (popup.type === 'popup') return popup.window.focused
	return popup.tab.active
}

export async function resolvePendingTransaction(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation) {
	const pendingTransaction = await removePendingTransaction(confirmation.data.uniqueRequestIdentifier)
	if (pendingTransaction === undefined) throw new Error('Tried to resolve pending transaction that did not exist anymore')
	if (!(await updateConfirmTransactionViewWithPendingTransaction(simulator.ethereum))) await closePopupOrTabById(pendingTransaction.popupOrTabId)
	
	const reply = (message: { type: 'forwardToSigner' } | { type: 'result', error: { code: number, message: string } } | { type: 'result', result: bigint }) => {
		replyToInterceptedRequest(websiteTabConnections, { ...pendingTransaction.originalRequestParameters, ...message, uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
	}
	
	if (confirmation.data.action === 'noResponse') return reply(formRejectMessage(undefined))
	if (pendingTransaction === undefined || pendingTransaction.status !== 'Simulated') return reply(formRejectMessage(undefined))
	if (confirmation.data.action === 'reject') return reply(formRejectMessage(confirmation.data.transactionErrorString))
	if (!pendingTransaction.simulationMode) return reply({ type: 'forwardToSigner' })
	const newState = await updateSimulationState(simulator.ethereum, async (simulationState) => await appendTransaction(simulator.ethereum, simulationState, pendingTransaction.transactionToSimulate), pendingTransaction.activeAddress, true)
	if (newState === undefined || newState.simulatedTransactions === undefined || newState.simulatedTransactions.length === 0) return reply({ type: 'result', ...METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN })
	const lastTransaction = newState.simulatedTransactions[newState.simulatedTransactions.length - 1]
	if (lastTransaction === undefined) throw new Error('missing last transaction')
	return reply({ type: 'result', result: lastTransaction.signedTransaction.hash })
}

export const onCloseWindowOrTab = async (popupOrTabs: PopupOrTabId, simulator: Simulator, websiteTabConnections: WebsiteTabConnections) => { // check if user has closed the window on their own, if so, reject all signatures
	const transactions = await getPendingTransactions()
	const [firstTransaction] = transactions
	if (firstTransaction?.popupOrTabId.id !== popupOrTabs.id) return
	await clearPendingTransactions()
	await Promise.all(transactions.map( async (transaction) => resolvePendingTransaction(simulator, websiteTabConnections, { method: 'popup_confirmDialog', data: { uniqueRequestIdentifier: transaction.uniqueRequestIdentifier, action: 'noResponse', popupOrTabId: transaction.popupOrTabId } })))
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

export async function openConfirmTransactionDialog(
	simulator: Simulator,
	ethereumClientService: EthereumClientService,
	request: InterceptedRequest,
	transactionParams: SendTransactionParams | SendRawTransactionParams,
	simulationMode: boolean,
	activeAddress: bigint | undefined,
	website: Website,
) {
	const uniqueRequestIdentifier = getUniqueRequestIdentifierString(request.uniqueRequestIdentifier)
	const transactionIdentifier = EthereumQuantity.parse(keccak256(toUtf8Bytes(uniqueRequestIdentifier)))
	const created = new Date()
	const transactionToSimulatePromise = transactionParams.method === 'eth_sendTransaction' ? formEthSendTransaction(ethereumClientService, activeAddress, simulationMode, website, transactionParams, created, transactionIdentifier) : formSendRawTransaction(ethereumClientService, transactionParams, website, created, transactionIdentifier)
	if (activeAddress === undefined) return { type: 'result' as const, ...ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS }

	const addedPendingTransaction = await pendingConfirmationSemaphore.execute(async () => {
		const getPendingTransactionWindow = async () => {
			const [firstPendingTransaction] = await getPendingTransactions()
			if (firstPendingTransaction !== undefined) {
				const alreadyOpenWindow = await getPopupOrTabOnlyById(firstPendingTransaction.popupOrTabId)
				if (alreadyOpenWindow) return alreadyOpenWindow
				await clearPendingTransactions()
			}
			return await openPopupOrTab({ url: getHtmlFile('confirmTransaction'), type: 'popup', height: 800, width: 600 })
		}
		const openedDialog = await getPendingTransactionWindow()
		if (openedDialog === undefined) return false //todo add better error here, somehow we failed to create window
		const pendingTransaction = {
			popupOrTabId: openedDialog,
			originalRequestParameters: transactionParams,
			uniqueRequestIdentifier: request.uniqueRequestIdentifier,
			simulationMode,
			activeAddress,
			created,
			status: 'Crafting Transaction' as const,
			transactionIdentifier,
			website,
		}
		const currentPendingTranasctions = await appendPendingTransaction(pendingTransaction)
		if (currentPendingTranasctions.length > 1) await sendPopupMessageToOpenWindows({ method: 'popup_confirm_transaction_dialog_pending_changed', data: { pendingTransactions: await getPendingTransactions() } })
			
		await updateConfirmTransactionViewWithPendingTransaction(ethereumClientService)

		const transactionToSimulate = await transactionToSimulatePromise
		if (transactionToSimulate.success === false) {
			await replacePendingTransaction({
				...pendingTransaction,
				transactionToSimulate,
				simulationResults: await refreshConfirmTransactionSimulation(simulator, ethereumClientService, activeAddress, simulationMode, request.uniqueRequestIdentifier, transactionToSimulate),
				status: 'FailedToSimulate' as const,
			})
			await updateConfirmTransactionViewWithPendingTransaction(ethereumClientService)
			return false
		} else {
			await replacePendingTransaction({ ...pendingTransaction, transactionToSimulate: transactionToSimulate, status: 'Simulating' as const })
			await updateConfirmTransactionViewWithPendingTransaction(ethereumClientService)

			const simulatedTx = await replacePendingTransaction({
				...pendingTransaction,
				transactionToSimulate,
				simulationResults: await refreshConfirmTransactionSimulation(simulator, ethereumClientService, activeAddress, simulationMode, request.uniqueRequestIdentifier, transactionToSimulate),
				status: 'Simulated' as const,
			})
			await updateConfirmTransactionViewWithPendingTransaction(ethereumClientService)
			await tryFocusingTabOrWindow(openedDialog)
			return simulatedTx !== undefined
		}
	})
	if (addedPendingTransaction === false) return formRejectMessage(undefined)
	const pendingTransactionData = (await getPendingTransactions()).find((tx) => tx.transactionIdentifier === transactionIdentifier)
	if (pendingTransactionData === undefined) return formRejectMessage(undefined)
	return { type: 'doNotReply' as const }
}
