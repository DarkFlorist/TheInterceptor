import { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import { appendTransaction } from '../../simulation/services/SimulationModeEthereumClientService.js'
import { bytes32String } from '../../utils/bigint.js'
import { ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS, METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import { ExternalPopupMessage, InterceptedRequest, Settings } from '../../utils/interceptor-messages.js'
import { Website, WebsiteSocket, WebsiteTabConnections } from '../../utils/user-interface-types.js'
import { EthereumUnsignedTransaction } from '../../utils/wire-types.js'
import { getActiveAddressForDomain } from '../accessManagement.js'
import { refreshConfirmTransactionSimulation, sendMessageToContentScript, updateSimulationState } from '../background.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { getConfirmationWindowPromise, getSimulationResults, setConfirmationWindowPromise } from '../settings.js'

export type Confirmation = 'Approved' | 'Rejected' | 'NoResponse'
let openedConfirmTransactionDialogWindow: browser.windows.Window | null = null
let pendingTransaction: Future<Confirmation> | undefined = undefined

export async function resolvePendingTransaction(ethereumClientService: EthereumClientService, websiteTabConnections: WebsiteTabConnections, confirmation: Confirmation) {
	if (pendingTransaction !== undefined) {
		pendingTransaction.resolve(confirmation)
	} else {
		// we have not been tracking this window, forward its message directly to content script (or signer)
		const data = await getConfirmationWindowPromise()
		if (data === undefined) return
		const resolved = await resolve(ethereumClientService, confirmation, data.simulationMode, data.transactionToSimulate, data.website, data.activeAddress)
		sendMessageToContentScript(websiteTabConnections, data.socket, resolved, data.request)
	}
	openedConfirmTransactionDialogWindow = null
}

const getOnCloseFunction = (ethereumClientService: EthereumClientService, websiteTabConnections: WebsiteTabConnections) => {
	return (windowId: number) => { // check if user has closed the window on their own, if so, reject signature
		if (openedConfirmTransactionDialogWindow === null || openedConfirmTransactionDialogWindow.id !== windowId) return
		if (pendingTransaction === undefined) return
		openedConfirmTransactionDialogWindow = null
		resolvePendingTransaction(ethereumClientService, websiteTabConnections, 'Rejected')
	}
}

const reject = function() {
	return {
		error: {
			code: METAMASK_ERROR_USER_REJECTED_REQUEST,
			message: 'Interceptor Tx Signature: User denied transaction signature.'
		}
	}
}

export async function openConfirmTransactionDialog(
	ethereumClientService: EthereumClientService,
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	request: InterceptedRequest,
	website: Website,
	simulationMode: boolean,
	transactionToSimulatePromise: () => Promise<EthereumUnsignedTransaction | undefined>,
	settings: Settings,
) {
	if (pendingTransaction !== undefined) return reject() // previous window still loading
	pendingTransaction = new Future<Confirmation>()
	const onCloseWindow = getOnCloseFunction(ethereumClientService, websiteTabConnections)
	try {
		const oldPromise = await getConfirmationWindowPromise()
		if (oldPromise !== undefined) {
			if ((await browser.tabs.query({ windowId: oldPromise.dialogId })).length > 0) {
				return reject() // previous window still open
			} else {
				await setConfirmationWindowPromise(undefined)
			}
		}

		const activeAddress = getActiveAddressForDomain(settings.websiteAccess, website.websiteOrigin, settings)
		if (activeAddress === undefined) return ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS

		if (openedConfirmTransactionDialogWindow !== null && openedConfirmTransactionDialogWindow.id) {
			browser.windows.onRemoved.removeListener(onCloseWindow)
			await browser.windows.remove(openedConfirmTransactionDialogWindow.id)
		}

		const transactionToSimulate = await transactionToSimulatePromise()
		if (transactionToSimulate === undefined) return reject()

		const simulationState = (await getSimulationResults()).simulationState
		if (simulationState === undefined) throw new Error('no simulation state')
		const refreshSimulationPromise = refreshConfirmTransactionSimulation(ethereumClientService, simulationState, activeAddress, simulationMode, request.requestId, transactionToSimulate, website)

		const windowReadyAndListening = async function popupMessageListener(msg: unknown) {
			const message = ExternalPopupMessage.parse(msg)
			if (message.method !== 'popup_confirmTransactionReadyAndListening') return
			browser.runtime.onMessage.removeListener(windowReadyAndListening)
			return sendPopupMessageToOpenWindows(await refreshSimulationPromise)
		}

		try {
			browser.runtime.onMessage.addListener(windowReadyAndListening)
			browser.windows.onRemoved.addListener(onCloseWindow)

			openedConfirmTransactionDialogWindow = await browser.windows.create({
				url: getHtmlFile('confirmTransaction'),
				type: 'popup',
				height: 800,
				width: 600,
			})

			if (openedConfirmTransactionDialogWindow === null || openedConfirmTransactionDialogWindow.id === undefined) return reject()

			await setConfirmationWindowPromise({
				website: website,
				dialogId: openedConfirmTransactionDialogWindow.id,
				socket: socket,
				request: request,
				transactionToSimulate: transactionToSimulate,
				simulationMode: simulationMode,
				activeAddress: activeAddress,
			})

			const reply = await pendingTransaction
			return await resolve(ethereumClientService, reply, simulationMode, transactionToSimulate, website, activeAddress)
		} finally {
			browser.windows.onRemoved.removeListener(windowReadyAndListening)
			browser.windows.onRemoved.removeListener(onCloseWindow)
		}
	} finally {
		pendingTransaction = undefined
	}
}

async function resolve(ethereumClientService: EthereumClientService, reply: Confirmation, simulationMode: boolean, transactionToSimulate: EthereumUnsignedTransaction, website: Website, activeAddress: bigint) {
	await setConfirmationWindowPromise(undefined)
	if (reply !== 'Approved') return reject()
	if (!simulationMode) return { forward: true as const }
	const newState = await updateSimulationState(async () => {
		const simulationState = (await getSimulationResults()).simulationState
		if (simulationState === undefined) return undefined
		return await appendTransaction(ethereumClientService, simulationState, { transaction: transactionToSimulate, website: website })
	}, activeAddress)
	if (newState === undefined || newState.simulatedTransactions === undefined || newState.simulatedTransactions.length === 0) {
		return METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN
	}
	return { result: bytes32String(newState.simulatedTransactions[newState.simulatedTransactions.length -1 ].signedTransaction.hash) }
}
