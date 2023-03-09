import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import { ChainChangeConfirmation, PopupMessage, SignerChainChangeConfirmation, } from '../../utils/interceptor-messages.js'
import { Website } from '../../utils/user-interface-types.js'
import { changeActiveChain } from '../background.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'

let pendForUserReply: Future<ChainChangeConfirmation> | undefined = undefined
let pendForSignerReply: Future<SignerChainChangeConfirmation> | undefined = undefined

let openedWindow: browser.windows.Window | null = null

export async function resolveChainChange(confirmation: ChainChangeConfirmation) {
	if (pendForUserReply !== undefined) pendForUserReply.resolve(confirmation)
	pendForUserReply = undefined
}

export async function resolveSignerChainChange(confirmation: SignerChainChangeConfirmation) {
	if (pendForSignerReply !== undefined) pendForSignerReply.resolve(confirmation)
	pendForSignerReply = undefined
}

function rejectMessage(requestId: number) {
	return {
		method: 'popup_changeChainDialog',
		options: {
			requestId,
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

export const openChangeChainDialog = async (requestId: number, simulationMode: boolean, website: Website, chainId: bigint) => {
	if (openedWindow !== null || pendForUserReply || pendForSignerReply) {
		return userDeniedChange
	}
	pendForUserReply = new Future<ChainChangeConfirmation>()

	const changeChainWindowReadyAndListening = async function popupMessageListener(msg: unknown) {
		const message = PopupMessage.parse(msg)
		if ( message.method !== 'popup_changeChainReadyAndListening') return
		browser.runtime.onMessage.removeListener(changeChainWindowReadyAndListening)
		return sendPopupMessageToOpenWindows({
			method: 'popup_ChangeChainRequest',
			data: {
				requestId: requestId,
				chainId: chainId,
				website: website,
				simulationMode: simulationMode,
			}
		})
	}
	browser.runtime.onMessage.addListener(changeChainWindowReadyAndListening)

	openedWindow = await browser.windows.create(
		{
			url: getHtmlFile('changeChain'),
			type: 'popup',
			height: 400,
			width: 520,
		}
	)

	if (openedWindow) {
		const windowClosed = () => { // check if user has closed the window on their own, if so, reject signature
			browser.windows.onRemoved.removeListener(windowClosed)
			openedWindow = null
			if (pendForUserReply === undefined) return
			resolveChainChange(rejectMessage(requestId))
		}
		browser.windows.onRemoved.addListener(windowClosed)
	} else {
		resolveChainChange(rejectMessage(requestId))
	}
	pendForSignerReply = undefined
	const reply = await pendForUserReply

	// forward message to content script
	if (reply.options.accept && reply.options.requestId === requestId) {
		if (simulationMode) {
			await changeActiveChain(chainId)
			return { result: null }
		}
		pendForSignerReply = new Future<SignerChainChangeConfirmation>() // when not in simulation mode, we need to get reply from the signer too
		await changeActiveChain(chainId)
		const signerReply = await pendForSignerReply
		if (signerReply.options.accept && signerReply.options.chainId === chainId) {
			return { result: null }
		}
	}
	return userDeniedChange
}
