import { isSignerChainChangePending, changeActiveRpc } from '../walletSwitch.js'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import type { ChainChangeConfirmation } from '../../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { getChainChangeConfirmationPromise, getRpcNetworkForChain, setChainChangeConfirmationPromise } from '../storageVariables.js'
import type { RpcNetwork } from '../../types/rpc.js'
import { type InterceptedRequest, type UniqueRequestIdentifier, doesUniqueRequestIdentifiersMatch } from '../../utils/requests.js'
import { replyToInterceptedRequest } from '../messageSending.js'
import type { SwitchEthereumChainParams } from '../../types/JsonRpc-types.js'
import type { PopupOrTabId, Website } from '../../types/websiteAccessTypes.js'
import type { SimulationServicesOwner } from '../../simulation/serviceLifecycle.js'
import { type PopupOrTab, addWindowTabListeners, closePopupOrTabById, getPopupOrTabById, openPopupOrTab, removeWindowTabListeners } from '../../utils/popupOrTab.js'

let pendForUserReply: Future<ChainChangeConfirmation> | undefined 

let chainChangeResolutionInProgress = false

let openedDialog: PopupOrTab | undefined 

export async function updateChainChangeViewWithPendingRequest() {
	const promise = await getChainChangeConfirmationPromise()
	if (promise) await sendPopupMessageToOpenWindows({ method: 'popup_ChangeChainRequest', data: promise })
	return
}

export async function resolveChainChange(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, confirmation: ChainChangeConfirmation) {
	if (pendForUserReply !== undefined) {
		pendForUserReply.resolve(confirmation)
		return
	}
	await runExclusiveChainChangeResolution(async () => {
		const data = await getChainChangeConfirmationPromise()
		if (data === undefined || !doesUniqueRequestIdentifiersMatch(confirmation.data.uniqueRequestIdentifier, data.request.uniqueRequestIdentifier)) throw new Error('Unique request identifier mismatch in change chain')
		const resolved = await resolve(simulationServicesOwner, websiteTabConnections, confirmation, data.simulationMode)
		if (resolved.error !== undefined) {
			replyToInterceptedRequest(websiteTabConnections, { type: 'result', method: 'wallet_switchEthereumChain' as const, error: resolved.error, uniqueRequestIdentifier: data.request.uniqueRequestIdentifier })
		} else {
			replyToInterceptedRequest(websiteTabConnections, { type: 'result', method: 'wallet_switchEthereumChain' as const, result: resolved.result, uniqueRequestIdentifier: data.request.uniqueRequestIdentifier })
		}
		if (openedDialog) await closePopupOrTabById(openedDialog)
		openedDialog = undefined
	})
}

async function runExclusiveChainChangeResolution<T>(resolution: () => Promise<T>) {
	if (chainChangeResolutionInProgress) return undefined
	chainChangeResolutionInProgress = true
	try {
		return await resolution()
	} finally {
		chainChangeResolutionInProgress = false
	}
}

function rejectMessage(rpcNetwork: RpcNetwork, uniqueRequestIdentifier: UniqueRequestIdentifier) {
	return {
		method: 'popup_changeChainDialog',
		data: {
			rpcNetwork,
			uniqueRequestIdentifier,
			accept: false,
		},
	} as const
}

const userDeniedChange = {
	error: {
		code: METAMASK_ERROR_USER_REJECTED_REQUEST,
		message: 'User denied the chain change.',
	}
} as const

export const openChangeChainDialog = async (
	simulationServicesOwner: SimulationServicesOwner,
	websiteTabConnections: WebsiteTabConnections,
	request: InterceptedRequest,
	simulationMode: boolean,
	website: Website,
	params: SwitchEthereumChainParams,
) => {
	if (openedDialog !== undefined || pendForUserReply || isSignerChainChangePending() || chainChangeResolutionInProgress) return userDeniedChange

	pendForUserReply = new Future<ChainChangeConfirmation>()

	const onCloseWindowOrTab = async (popupOrTab: PopupOrTabId) => { // check if user has closed the window on their own, if so, reject signature
		if (openedDialog === undefined || openedDialog.id !== popupOrTab.id || openedDialog.type !== popupOrTab.type) return
		openedDialog = undefined
		if (pendForUserReply === undefined) return
		resolveChainChange(simulationServicesOwner, websiteTabConnections, rejectMessage(await getRpcNetworkForChain(params.params[0].chainId), request.uniqueRequestIdentifier))
	}
	const onCloseWindow = async (id: number) => onCloseWindowOrTab({ type: 'popup' as const, id })
	const onCloseTab = async (id: number) => onCloseWindowOrTab({ type: 'tab' as const, id })

	try {
		const oldPromise = await getChainChangeConfirmationPromise()
		if (oldPromise !== undefined) {
			if (await getPopupOrTabById(oldPromise.popupOrTabId) !== undefined) return userDeniedChange
			await setChainChangeConfirmationPromise(undefined)
		}
		openedDialog = await openPopupOrTab({
			url: getHtmlFile('changeChain'),
			type: 'popup',
			height: 800,
			width: 600,
		})

		if (openedDialog !== undefined) {
			addWindowTabListeners(onCloseWindow, onCloseTab)
			await setChainChangeConfirmationPromise({
				website: website,
				popupOrTabId: openedDialog,
				request: request,
				simulationMode: simulationMode,
				rpcNetwork: await getRpcNetworkForChain(params.params[0].chainId),
			})
			await updateChainChangeViewWithPendingRequest()
		} else {
			await resolveChainChange(
				simulationServicesOwner,
				websiteTabConnections,
				rejectMessage(await getRpcNetworkForChain(params.params[0].chainId), request.uniqueRequestIdentifier),
			)
		}
		const reply = await pendForUserReply

		// forward message to content script
		const resolution = runExclusiveChainChangeResolution(async () => await resolve(simulationServicesOwner, websiteTabConnections, reply, simulationMode))
		return resolution.then((result) => result ?? userDeniedChange)
	} finally {
		removeWindowTabListeners(onCloseWindow, onCloseTab)
		pendForUserReply = undefined
		if (openedDialog) await closePopupOrTabById(openedDialog)
		openedDialog = undefined
	}
}

async function resolve(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, reply: ChainChangeConfirmation, simulationMode: boolean) {
	await setChainChangeConfirmationPromise(undefined)
	if (reply.data.accept) {
		return await changeActiveRpc(simulationServicesOwner, websiteTabConnections, reply.data.rpcNetwork, { source: 'dapp', simulationMode, signerTabId: reply.data.uniqueRequestIdentifier.requestSocket.tabId })
	}
	return userDeniedChange
}
