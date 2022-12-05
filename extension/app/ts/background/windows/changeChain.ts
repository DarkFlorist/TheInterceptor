import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants'
import { Future } from '../../utils/future'
import { ChainChangeConfirmation, InterceptedRequest, } from '../../utils/interceptor-messages'
import { changeActiveChain } from '../background'

let pendForUserReply: Future<ChainChangeConfirmation> | undefined = undefined
let pendForSignerReply: Future<ChainChangeConfirmation> | undefined = undefined

let openedWindow: browser.windows.Window | null = null

export async function resolveChainChange(confirmation: ChainChangeConfirmation) {
	if (pendForUserReply !== undefined) pendForUserReply.resolve(confirmation)
	pendForUserReply = undefined

	if (openedWindow !== null && openedWindow.id) {
		await browser.windows.remove(openedWindow.id)
	}
	window.interceptor.changeChainDialog = undefined
	openedWindow = null
}

export async function resolveSignerChainChange(confirmation: ChainChangeConfirmation) {
	if (openedWindow !== null && openedWindow.id) {
		await browser.windows.remove(openedWindow.id)
	}
	if (pendForSignerReply !== undefined) pendForSignerReply.resolve(confirmation)
	pendForSignerReply = undefined
	window.interceptor.changeChainDialog = undefined
	openedWindow = null
}

export async function openChangeChainDialog(port: browser.runtime.Port, request: InterceptedRequest, chainId: bigint) {
	if (window.interceptor.settings === undefined) return
	if (port.sender === undefined) return
	if (port.sender.url === undefined) return
	if (openedWindow !== null && openedWindow.id) {
		await browser.windows.remove(openedWindow.id)
	}
	pendForUserReply = new Future<ChainChangeConfirmation>()

	window.interceptor.changeChainDialog = {
		requestToConfirm: request,
		chainId: chainId.toString(),
		origin: (new URL(port.sender.url)).hostname,
		icon: port.sender?.tab?.favIconUrl,
		simulationMode: window.interceptor.settings.simulationMode,
	}

	openedWindow = await browser.windows.create(
		{
			url: '../html/changeChain.html',
			type: 'popup',
			height: 400,
			width: 520,
		}
	)

	const reject = {
		method: 'popup_changeChainDialog',
		options: {
			request,
			accept: false
		}
	} as const

	if (openedWindow) {
		browser.windows.onRemoved.addListener( () => { // check if user has closed the window on their own, if so, reject signature
			if (pendForUserReply === undefined) return
			window.interceptor.changeChainDialog = undefined
			openedWindow = null
			resolveChainChange(reject)
		} )
	} else {
		resolveChainChange(reject)
	}
	pendForSignerReply = undefined
	const reply = await pendForUserReply

	// forward message to content script
	if(reply.options.accept) {
		await changeActiveChain(chainId)
		pendForSignerReply = new Future<ChainChangeConfirmation>() // we need to get reply from the signer too, if we are using signer, if signer is not used, interceptor replies to this
		const signerReply = await pendForSignerReply
		if (signerReply.options.accept) {
			return port.postMessage({
				interceptorApproved: true,
				requestId: request.requestId,
				options: request.options,
				result: []
			})
		}
	}
	return port.postMessage({
		interceptorApproved: false,
		requestId: request.requestId,
		options: request.options,
		error: {
			code: METAMASK_ERROR_USER_REJECTED_REQUEST,
			message: 'User denied the chain change.'
		}
	})
}
