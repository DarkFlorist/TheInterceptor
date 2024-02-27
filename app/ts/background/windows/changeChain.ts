import { PopupOrTab, addWindowTabListeners, closePopupOrTabById, getPopupOrTabOnlyById, openPopupOrTab, removeWindowTabListeners } from '../../components/ui-utils.js'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import { ChainChangeConfirmation, SignerChainChangeConfirmation } from '../../types/interceptor-messages.js'
import { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { changeActiveRpc } from '../background.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { getChainChangeConfirmationPromise, getRpcNetworkForChain, setChainChangeConfirmationPromise } from '../storageVariables.js'
import { RpcNetwork } from '../../types/rpc.js'
import { InterceptedRequest, UniqueRequestIdentifier, doesUniqueRequestIdentifiersMatch } from '../../utils/requests.js'
import { replyToInterceptedRequest } from '../messageSending.js'
import { SwitchEthereumChainParams } from '../../types/JsonRpc-types.js'
import { Simulator } from '../../simulation/simulator.js'
import { PopupOrTabId, Website } from '../../types/websiteAccessTypes.js'

let pendForUserReply: Future<ChainChangeConfirmation> | undefined = undefined
let pendForSignerReply: Future<SignerChainChangeConfirmation> | undefined = undefined

let openedDialog: PopupOrTab | undefined = undefined

export async function updateChainChangeViewWithPendingRequest() {
	const promise = await getChainChangeConfirmationPromise()
	if (promise) sendPopupMessageToOpenWindows({ method: 'popup_ChangeChainRequest', data: promise })
	return
}

export async function resolveChainChange(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, confirmation: ChainChangeConfirmation) {
	if (pendForUserReply !== undefined) {
		pendForUserReply.resolve(confirmation)
		return
	}
	const data = await getChainChangeConfirmationPromise()
	if (data === undefined || !doesUniqueRequestIdentifiersMatch(confirmation.data.uniqueRequestIdentifier, data.request.uniqueRequestIdentifier)) throw new Error('Unique request identifier mismatch in change chain')
	const resolved = await resolve(simulator, websiteTabConnections, confirmation, data.simulationMode)
	replyToInterceptedRequest(websiteTabConnections, { type: 'result', method: 'wallet_switchEthereumChain' as const, ...resolved, uniqueRequestIdentifier: data.request.uniqueRequestIdentifier })
	if (openedDialog) await closePopupOrTabById(openedDialog)
	openedDialog = undefined
}

export async function resolveSignerChainChange(confirmation: SignerChainChangeConfirmation) {
	if (pendForSignerReply !== undefined) pendForSignerReply.resolve(confirmation)
	pendForSignerReply = undefined
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
	simulator: Simulator,
	websiteTabConnections: WebsiteTabConnections,
	request: InterceptedRequest,
	simulationMode: boolean,
	website: Website,
	params: SwitchEthereumChainParams,
) => {
	if (openedDialog !== undefined || pendForUserReply || pendForSignerReply) return userDeniedChange

	pendForUserReply = new Future<ChainChangeConfirmation>()

	const onCloseWindowOrTab = async (popupOrTab: PopupOrTabId) => { // check if user has closed the window on their own, if so, reject signature
		if (openedDialog === undefined || openedDialog.id !== popupOrTab.id || openedDialog.type !== popupOrTab.type) return
		openedDialog = undefined
		if (pendForUserReply === undefined) return
		resolveChainChange(simulator, websiteTabConnections, rejectMessage(await getRpcNetworkForChain(params.params[0].chainId), request.uniqueRequestIdentifier))
	}
	const onCloseWindow = async (id: number) => onCloseWindowOrTab({ type: 'popup' as const, id })
	const onCloseTab = async (id: number) => onCloseWindowOrTab({ type: 'tab' as const, id })

	try {
		const oldPromise = await getChainChangeConfirmationPromise()
		if (oldPromise !== undefined) {
			if (await getPopupOrTabOnlyById(oldPromise.popupOrTabId) !== undefined) {
				return userDeniedChange
			} else {
				await setChainChangeConfirmationPromise(undefined)
			}
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
			await resolveChainChange(simulator, websiteTabConnections, rejectMessage(await getRpcNetworkForChain(params.params[0].chainId), request.uniqueRequestIdentifier))
		}
		pendForSignerReply = undefined

		const reply = await pendForUserReply

		// forward message to content script
		return resolve(simulator, websiteTabConnections, reply, simulationMode)
	} finally {
		removeWindowTabListeners(onCloseWindow, onCloseTab)
		pendForUserReply = undefined
		if (openedDialog) await closePopupOrTabById(openedDialog)
		openedDialog = undefined
	}
}

async function resolve(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, reply: ChainChangeConfirmation, simulationMode: boolean) {
	await setChainChangeConfirmationPromise(undefined)
	if (reply.data.accept) {
		if (simulationMode) {
			await changeActiveRpc(simulator, websiteTabConnections, reply.data.rpcNetwork, simulationMode)
			return { result: null }
		}
		pendForSignerReply = new Future<SignerChainChangeConfirmation>() // when not in simulation mode, we need to get reply from the signer too
		await changeActiveRpc(simulator, websiteTabConnections, reply.data.rpcNetwork, simulationMode)
		const signerReply = await pendForSignerReply
		if (signerReply.data.accept && signerReply.data.chainId === reply.data.rpcNetwork.chainId) {
			return { result: null }
		}
	}
	return userDeniedChange
}
