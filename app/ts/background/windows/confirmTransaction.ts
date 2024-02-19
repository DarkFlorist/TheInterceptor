import { PopupOrTab, addWindowTabListeners, closePopupOrTabById, getPopupOrTabOnlyById, openPopupOrTab, removeWindowTabListeners, tryFocusingTabOrWindow } from '../../components/ui-utils.js'
import { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import { appendTransaction, getInputFieldFromDataOrInput, getSimulatedTransactionCount, simulateEstimateGas } from '../../simulation/services/SimulationModeEthereumClientService.js'
import { CANNOT_SIMULATE_OFF_LEGACY_BLOCK, ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS, METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
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
import { PendingTransaction } from '../../types/accessRequest.js'

type Confirmation = TransactionConfirmation | 'NoResponse'
let openedDialog: PopupOrTab | undefined = undefined
let pendingTransactions = new Map<string, Future<Confirmation>>()
const pendingConfirmationSemaphore = new Semaphore(1)

export async function updateConfirmTransactionViewWithPendingTransaction() {
	const promises = await getPendingTransactions()
	if (promises.length > 0) {
		await sendPopupMessageToOpenWindows({ method: 'popup_update_confirm_transaction_dialog', data: promises })
		return true
	}
	return false
}

export async function updateConfirmTransactionViewWithPendingTransactionOrClose() {
	if (await updateConfirmTransactionViewWithPendingTransaction() === true) return
	if (openedDialog) await closePopupOrTabById(openedDialog.popupOrTab)
	openedDialog = undefined
}

export async function resolvePendingTransaction(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation) {
	const pending = pendingTransactions.get(getUniqueRequestIdentifierString(confirmation.data.uniqueRequestIdentifier))
	const pendingTransaction = await removePendingTransaction(confirmation.data.uniqueRequestIdentifier)
	await updateConfirmTransactionViewWithPendingTransactionOrClose()
	if (pendingTransaction === undefined) return
	if (pending) {
		return pending.resolve(confirmation)
	} else {
		// we have not been tracking this window, forward its message directly to content script (or signer)
		const resolvedPromise = await resolve(simulator, pendingTransaction.simulationMode, pendingTransaction.activeAddress, confirmation, pendingTransaction)
		replyToInterceptedRequest(websiteTabConnections, { ...pendingTransaction.originalRequestParameters, ...resolvedPromise, uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
		openedDialog = await getPopupOrTabOnlyById(confirmation.data.popupOrTabId)
	}
}

const onCloseWindowOrTab = async (popupOrTabs: PopupOrTabId) => { // check if user has closed the window on their own, if so, reject all signatures
	if (openedDialog === undefined || openedDialog.popupOrTab.id !== popupOrTabs.id || openedDialog.popupOrTab.type !== popupOrTabs.type) return
	openedDialog = undefined
	await clearPendingTransactions()
	pendingTransactions.forEach((pending) => pending.resolve('NoResponse'))
	pendingTransactions.clear()
}
const onCloseWindow = async (id: number) => onCloseWindowOrTab({ type: 'popup' as const, id })
const onCloseTab = async (id: number) => onCloseWindowOrTab({ type: 'tab' as const, id })

const formRejectMessage = (errorString: undefined | string) => {
	return {
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
	website: Website
) {
	let justAddToPending = false
	if (pendingTransactions.size !== 0) justAddToPending = true
	const pendingTransaction = new Future<Confirmation>()
	const uniqueRequestIdentifier = getUniqueRequestIdentifierString(request.uniqueRequestIdentifier)
	pendingTransactions.set(uniqueRequestIdentifier, pendingTransaction)
	const transactionIdentifier = EthereumQuantity.parse(keccak256(toUtf8Bytes(uniqueRequestIdentifier)))
	try {
		const created = new Date()
		const transactionToSimulatePromise = transactionParams.method === 'eth_sendTransaction' ? formEthSendTransaction(ethereumClientService, activeAddress, simulationMode, website, transactionParams, created, transactionIdentifier) : formSendRawTransaction(ethereumClientService, transactionParams, website, created, transactionIdentifier)
		if (activeAddress === undefined) return ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS

		const addedPendingTransaction = await pendingConfirmationSemaphore.execute(async () => {
			if (!justAddToPending) {
				const pendingTransactions = await getPendingTransactions()
				if (pendingTransactions.length !== 0) {
					const pendingTransaction = pendingTransactions[0]
					if (pendingTransaction === undefined) throw new Error('pending transaction was undefined')
					if (await getPopupOrTabOnlyById(pendingTransaction.popupOrTabId) !== undefined) {
						justAddToPending = true
					} else {
						await clearPendingTransactions()
					}
				}
			}

			const openDialog = async () => {
				addWindowTabListeners(onCloseWindow, onCloseTab)
				return await openPopupOrTab({ url: getHtmlFile('confirmTransaction'), type: 'popup', height: 800, width: 600 })
			}
			if (!justAddToPending || openedDialog === undefined) openedDialog = await openDialog()
			else { await tryFocusingTabOrWindow(openedDialog.popupOrTab) }

			if (openedDialog === undefined) return false
			const pendingTransaction = {
				popupOrTabId: openedDialog.popupOrTab,
				originalRequestParameters: transactionParams,
				uniqueRequestIdentifier: request.uniqueRequestIdentifier,
				simulationMode,
				activeAddress,
				created,
				status: 'Crafting Transaction' as const,
				transactionIdentifier,
				website,
			}
			await appendPendingTransaction(pendingTransaction)
			if (justAddToPending) await sendPopupMessageToOpenWindows({ method: 'popup_confirm_transaction_dialog_pending_changed', data: await getPendingTransactions() })
				
			await updateConfirmTransactionViewWithPendingTransaction()

			const transactionToSimulate = await transactionToSimulatePromise
			if (transactionToSimulate.success === false) {
				await replacePendingTransaction({
					...pendingTransaction,
					transactionToSimulate,
					simulationResults: await refreshConfirmTransactionSimulation(simulator, ethereumClientService, activeAddress, simulationMode, request.uniqueRequestIdentifier, transactionToSimulate),
					status: 'FailedToSimulate' as const,
				})
				await updateConfirmTransactionViewWithPendingTransaction()
				return false
			} else {
				await replacePendingTransaction({ ...pendingTransaction, transactionToSimulate: transactionToSimulate, status: 'Simulating' as const })
				await updateConfirmTransactionViewWithPendingTransaction()

				const simulatedTx = await replacePendingTransaction({
					...pendingTransaction,
					transactionToSimulate,
					simulationResults: await refreshConfirmTransactionSimulation(simulator, ethereumClientService, activeAddress, simulationMode, request.uniqueRequestIdentifier, transactionToSimulate),
					status: 'Simulated' as const,
				})
				await updateConfirmTransactionViewWithPendingTransaction()
				return simulatedTx !== undefined
			}
		})
		if (addedPendingTransaction === false) return formRejectMessage(undefined)
		const pendingTransactionData = (await getPendingTransactions()).find((tx) => tx.transactionIdentifier === transactionIdentifier)
		if (pendingTransactionData === undefined) return formRejectMessage(undefined)
		const reply = await pendingTransaction
		const resolvedPromise = await resolve(simulator, simulationMode, activeAddress, reply, pendingTransactionData)
		return resolvedPromise
	} finally {
		removeWindowTabListeners(onCloseWindow, onCloseTab)
		pendingTransactions.delete(uniqueRequestIdentifier)
		await updateConfirmTransactionViewWithPendingTransactionOrClose()
	}
}

async function resolve(simulator: Simulator, simulationMode: boolean, activeAddress: bigint, confirmation: Confirmation, pendingTransaction: PendingTransaction): Promise<{ forward: true } | { error: { code: number, message: string } } | { result: bigint }> {
	if (confirmation === 'NoResponse') return formRejectMessage(undefined)
	if (pendingTransaction === undefined || pendingTransaction.status !== 'Simulated') return formRejectMessage(undefined)
	if (confirmation.data.accept === false) return formRejectMessage(confirmation.data.transactionErrorString)
	if (!simulationMode) return { forward: true }
	const newState = await updateSimulationState(simulator.ethereum, async (simulationState) => {
		return await appendTransaction(simulator.ethereum, simulationState, pendingTransaction.transactionToSimulate)
	}, activeAddress, true)
	if (newState === undefined || newState.simulatedTransactions === undefined || newState.simulatedTransactions.length === 0) {
		return METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN
	}
	const lastTransaction = newState.simulatedTransactions[newState.simulatedTransactions.length - 1]
	if (lastTransaction === undefined) throw new Error('missing last transaction')
	return { result: lastTransaction.signedTransaction.hash }
}
