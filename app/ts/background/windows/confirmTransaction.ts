import { PopupOrTab, addWindowTabListener, closePopupOrTab, getPopupOrTabOnlyById, openPopupOrTab, removeWindowTabListener } from '../../components/ui-utils.js'
import { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import { appendTransaction, getInputFieldFromDataOrInput, getSimulatedBlock, getSimulatedTransactionCount, simulateEstimateGas } from '../../simulation/services/SimulationModeEthereumClientService.js'
import { CANNOT_SIMULATE_OFF_LEGACY_BLOCK, ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS, METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import { TransactionConfirmation } from '../../utils/interceptor-messages.js'
import { Semaphore } from '../../utils/semaphore.js'
import { WebsiteTabConnections } from '../../utils/user-interface-types.js'
import { WebsiteCreatedEthereumUnsignedTransaction } from '../../utils/visualizer-types.js'
import { SendRawTransactionParams, SendTransactionParams } from '../../utils/JsonRpc-types.js'
import { refreshConfirmTransactionSimulation, updateSimulationState } from '../background.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { appendPendingTransaction, clearPendingTransactions, getPendingTransactions, getSimulationResults, removePendingTransaction } from '../storageVariables.js'
import { InterceptedRequest, getUniqueRequestIdentifierString } from '../../utils/requests.js'
import { replyToInterceptedRequest } from '../messageSending.js'
import { Simulator } from '../../simulation/simulator.js'
import { ethers } from 'ethers'
import { dataStringWith0xStart, stringToUint8Array } from '../../utils/bigint.js'
import { EthereumAddress } from '../../utils/wire-types.js'
import { Website } from '../../utils/websiteAccessTypes.js'

type Confirmation = TransactionConfirmation | 'NoResponse'
let openedDialog: PopupOrTab | undefined = undefined
let pendingTransactions = new Map<string, Future<Confirmation>>()
const pendingConfirmationSemaphore = new Semaphore(1)

export async function updateConfirmTransactionViewWithPendingTransaction() {
	const promises = await getPendingTransactions()
	if (promises.length >= 1) {
		await sendPopupMessageToOpenWindows({ method: 'popup_update_confirm_transaction_dialog', data: promises })
		return true
	}
	return false
}

async function updateConfirmTransactionViewWithPendingTransactionOrClose() {
	if (await updateConfirmTransactionViewWithPendingTransaction() === true) return
	if (openedDialog) await closePopupOrTab(openedDialog)
	openedDialog = undefined
}

export async function resolvePendingTransaction(simulator: Simulator, ethereumClientService: EthereumClientService, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation) {
	const pending = pendingTransactions.get(getUniqueRequestIdentifierString(confirmation.data.uniqueRequestIdentifier))
	const pendingTransaction = await removePendingTransaction(confirmation.data.uniqueRequestIdentifier)
	if (pendingTransaction === undefined) throw new Error('Failed to find pending transaction')
	await updateConfirmTransactionViewWithPendingTransactionOrClose()
	if (pending) {
		return pending.resolve(confirmation)
	} else {
		// we have not been tracking this window, forward its message directly to content script (or signer)
		const resolvedPromise = await resolve(simulator, ethereumClientService, pendingTransaction.simulationMode, pendingTransaction.activeAddress, pendingTransaction.transactionToSimulate, confirmation)
		replyToInterceptedRequest(websiteTabConnections, { ...pendingTransaction.transactionToSimulate.originalTransactionRequestParameters, ...resolvedPromise, uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
		openedDialog = await getPopupOrTabOnlyById(confirmation.data.windowId)
	}
}
const onCloseWindow = async (windowId: number) => { // check if user has closed the window on their own, if so, reject all signatures
	if (openedDialog === undefined || openedDialog.windowOrTab.id !== windowId) return
	openedDialog = undefined
	await clearPendingTransactions()
	pendingTransactions.forEach((pending) => pending.resolve('NoResponse'))
	pendingTransactions.clear()
}

const formRejectMessage = (errorString: undefined | string) => {
	return {
		error: {
			code: METAMASK_ERROR_USER_REJECTED_REQUEST,
			message: errorString === undefined ? 'Interceptor Tx Signature: User denied transaction signature.' : `Interceptor Tx Signature: User denied reverting transaction: ${ errorString }.`
		}
	}
}

export const formSendRawTransaction = async(ethereumClientService: EthereumClientService, sendRawTransactionParams: SendRawTransactionParams, website: Website, transactionCreated: Date): Promise<WebsiteCreatedEthereumUnsignedTransaction> => {	
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
		transactionCreated,
		originalTransactionRequestParameters: sendRawTransactionParams,
		error: undefined,
	}
}

export const formEthSendTransaction = async(ethereumClientService: EthereumClientService, activeAddress: bigint | undefined, simulationMode: boolean = true, website: Website, sendTransactionParams: SendTransactionParams, transactionCreated: Date): Promise<WebsiteCreatedEthereumUnsignedTransaction> => {
	const simulationState = simulationMode ? (await getSimulationResults()).simulationState : undefined
	const blockPromise = getSimulatedBlock(ethereumClientService, simulationState)
	const transactionDetails = sendTransactionParams.params[0]
	if (activeAddress === undefined) throw new Error('Access to active address is denied')
	const from = simulationMode && transactionDetails.from !== undefined ? transactionDetails.from : activeAddress
	const transactionCount = getSimulatedTransactionCount(ethereumClientService, simulationState, from)
	const parentBlock = await blockPromise
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
		transactionCreated,
		originalTransactionRequestParameters: sendTransactionParams,
		error: undefined,
	}
	if (transactionDetails.gas === undefined) {
		const estimateGas = await simulateEstimateGas(ethereumClientService, simulationState, transactionWithoutGas)
		if ('error' in estimateGas) return { ...extraParams, ...estimateGas, transaction: { ...transactionWithoutGas, gas: estimateGas.gas } }
		return { transaction: { ...transactionWithoutGas, gas: estimateGas.gas }, ...extraParams }
	}
	return { transaction: { ...transactionWithoutGas, gas: transactionDetails.gas }, ...extraParams }
}

export async function openConfirmTransactionDialog(
	simulator: Simulator,
	ethereumClientService: EthereumClientService,
	request: InterceptedRequest,
	transactionParams: SendTransactionParams | SendRawTransactionParams,
	simulationMode: boolean,
	activeAddress: bigint | undefined,
	website: Website
) {
	let justAddToPending = false
	if (pendingTransactions.size !== 0) justAddToPending = true
	const pendingTransaction = new Future<Confirmation>()
	const uniqueRequestIdentifier = getUniqueRequestIdentifierString(request.uniqueRequestIdentifier)
	pendingTransactions.set(uniqueRequestIdentifier, pendingTransaction)
	try {
		const transactionCreated = new Date()
		const transactionToSimulate = transactionParams.method === 'eth_sendTransaction' ? await formEthSendTransaction(ethereumClientService, activeAddress, simulationMode, website, transactionParams, transactionCreated) : await formSendRawTransaction(ethereumClientService, transactionParams, website, transactionCreated)
		if (activeAddress === undefined) return ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS

		const addedPendingTransaction = await pendingConfirmationSemaphore.execute(async () => {
			if (!justAddToPending) {
				const oldPromise = await getPendingTransactions()
				if (oldPromise.length !== 0) {
					if (await getPopupOrTabOnlyById(oldPromise[0].dialogId) !== undefined) {
						justAddToPending = true
					} else {
						await clearPendingTransactions()
					}
				}
			}

			const openDialog = async () => {
				addWindowTabListener(onCloseWindow)
				return await openPopupOrTab({ url: getHtmlFile('confirmTransaction'), type: 'popup', height: 800, width: 600 })
			}
			const refreshSimulationPromise = refreshConfirmTransactionSimulation(simulator, ethereumClientService, activeAddress, simulationMode, request.uniqueRequestIdentifier, transactionToSimulate)
			if (!justAddToPending) openedDialog = await openDialog()
			if (openedDialog?.windowOrTab.id === undefined) return false
			await appendPendingTransaction({
				dialogId: openedDialog.windowOrTab.id,
				request,
				simulationMode,
				activeAddress,
				transactionToSimulate,
				simulationResults: await refreshSimulationPromise,
				transactionCreated,
			})
			await updateConfirmTransactionViewWithPendingTransaction()
			if (justAddToPending) await sendPopupMessageToOpenWindows({ method: 'popup_confirm_transaction_dialog_pending_changed', data: await getPendingTransactions() })
			return true
		})
		if (addedPendingTransaction === false) return formRejectMessage(undefined)
		const reply = await pendingTransaction
		const resolvedPromise = await resolve(simulator, ethereumClientService, simulationMode, activeAddress, transactionToSimulate, reply)
		return resolvedPromise
	} finally {
		removeWindowTabListener(onCloseWindow)
		pendingTransactions.delete(uniqueRequestIdentifier)
		await updateConfirmTransactionViewWithPendingTransactionOrClose()
	}
}

async function resolve(simulator: Simulator, ethereumClientService: EthereumClientService, simulationMode: boolean, activeAddress: bigint, transactionToSimulate: WebsiteCreatedEthereumUnsignedTransaction, confirmation: Confirmation): Promise<{ forward: true } | { error: { code: number, message: string } } | { result: bigint }> {
	if (transactionToSimulate.error !== undefined) return { error: transactionToSimulate.error }
	if (confirmation === 'NoResponse') return formRejectMessage(undefined)
	if (confirmation.data.accept === false) return formRejectMessage(confirmation.data.transactionErrorString)
	if (!simulationMode) return { forward: true }
	const newState = await updateSimulationState(simulator, async (simulationState) => {
		if (simulationState === undefined) return undefined
		return await appendTransaction(ethereumClientService, simulationState, transactionToSimulate)
	}, activeAddress, true)
	if (newState === undefined || newState.simulatedTransactions === undefined || newState.simulatedTransactions.length === 0) {
		return METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN
	}
	return { result: newState.simulatedTransactions[newState.simulatedTransactions.length - 1].signedTransaction.hash }
}
