import { addressString } from '../../utils/bigint.js'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import { InterceptedRequest, PersonalSign } from '../../utils/interceptor-messages.js'
import { AddressInfo } from '../../utils/user-interface-types.js'
import { AddressMetadata } from '../../utils/visualizer-types.js'
import { EIP2612Message, EthereumAddress } from '../../utils/wire-types.js'
import { personalSignWithSimulator } from '../background.js'
import { getAddressMetaData } from '../metadataUtils.js'

let pendingPersonalSign: Future<PersonalSign> | undefined = undefined

let openedPersonalSignDialogWindow: browser.windows.Window | null = null

export async function resolvePersonalSign(confirmation: PersonalSign) {
	if (pendingPersonalSign !== undefined) pendingPersonalSign.resolve(confirmation)
	pendingPersonalSign = undefined

	if (openedPersonalSignDialogWindow !== null && openedPersonalSignDialogWindow.id) {
		await browser.windows.remove(openedPersonalSignDialogWindow.id)
	}
	window.interceptor.personalSignDialog = undefined
	openedPersonalSignDialogWindow = null
}

function getAddressMetadataForEIP2612Message(message: EIP2612Message, addressInfos: readonly AddressInfo[] | undefined) : [string, AddressMetadata][] {
	return [
		[addressString(message.message.owner), getAddressMetaData(message.message.owner, addressInfos)],
		[addressString(message.message.spender), getAddressMetaData(message.message.spender, addressInfos)],
		[addressString(message.domain.verifyingContract), getAddressMetaData(message.domain.verifyingContract, addressInfos)],
	]
}


export async function openPersonalSignDialog(port: browser.runtime.Port, request: InterceptedRequest, simulationMode: boolean, message: string, account: EthereumAddress, method: 'personalSign' | 'v4') {

	if (openedPersonalSignDialogWindow !== null && openedPersonalSignDialogWindow.id) {
		await browser.windows.remove(openedPersonalSignDialogWindow.id)
	}
	pendingPersonalSign = new Future<PersonalSign>()

	if ( method === 'v4' ) {
		const parsed = EIP2612Message.parse(JSON.parse(message))
		window.interceptor.personalSignDialog =  {
			simulationMode: simulationMode,
			requestToConfirm: request,
			message: message,
			account: addressString(account),
			method: method,
			addressMetadata: getAddressMetadataForEIP2612Message(parsed, window.interceptor.settings?.addressInfos),
			eip2612Message: parsed,
		}
	}
	else if ( method === 'personalSign' ) {
		window.interceptor.personalSignDialog =  {
			simulationMode: simulationMode,
			requestToConfirm: request,
			message: message,
			account: addressString(account),
			method: method,
			addressMetadata: [],
		}
	} else {
		throw new Error('Unknown method');
	}

	openedPersonalSignDialogWindow = await browser.windows.create(
		{
			url: '../html/personalSign.html',
			type: 'popup',
			height: 400,
			width: 520,
		}
	)
	const rejectSign = {
		method: 'popup_personalSign',
		options: {
			request,
			accept: false
		}
	} as const
	if (openedPersonalSignDialogWindow) {
		browser.windows.onRemoved.addListener( () => { // check if user has closed the window on their own, if so, reject signature
			if (pendingPersonalSign === undefined) return
			window.interceptor.personalSignDialog = undefined
			openedPersonalSignDialogWindow = null
			resolvePersonalSign(rejectSign)
		} )
	} else {
		resolvePersonalSign(rejectSign)
	}

	const reply = await pendingPersonalSign

	// forward message to content script
	if(reply.options.accept) {
		if (simulationMode) {
			const result = await personalSignWithSimulator(message, account)
			if (result === undefined) return port.postMessage({
				interceptorApproved: false,
				requestId: request.requestId,
				options: request.options,
				error: {
					code: METAMASK_ERROR_USER_REJECTED_REQUEST,
					message: 'Interceptor not ready'
				}
			})

			return port.postMessage({
				interceptorApproved: true,
				requestId: request.requestId,
				options: request.options,
				result: result
			})
		}
		return port.postMessage({
			interceptorApproved: true,
			requestId: request.requestId,
			options: request.options
		})
	}
	return port.postMessage({
		interceptorApproved: false,
		requestId: request.requestId,
		options: request.options,
		error: {
			code: METAMASK_ERROR_USER_REJECTED_REQUEST,
			message: 'Interceptor Personal Signature: User denied personal signature.'
		}
	})
}
