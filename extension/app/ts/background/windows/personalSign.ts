import { addressString, stringifyJSONWithBigInts } from '../../utils/bigint.js'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import { PersonalSign } from '../../utils/interceptor-messages.js'
import { AddressBookEntry, AddressInfo } from '../../utils/user-interface-types.js'
import { EIP2612Message, Permit2, PersonalSignParams, SignTypedDataParams } from '../../utils/wire-types.js'
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

function getAddressMetadataForEIP2612Message(message: EIP2612Message, addressInfos: readonly AddressInfo[] | undefined) : [string, AddressBookEntry][] {
	return [
		[addressString(message.message.owner), getAddressMetaData(message.message.owner, addressInfos)],
		[addressString(message.message.spender), getAddressMetaData(message.message.spender, addressInfos)],
		[addressString(message.domain.verifyingContract), getAddressMetaData(message.domain.verifyingContract, addressInfos)],
	]
}

function getAddressMetadataForPermitMessage(message: Permit2, addressInfos: readonly AddressInfo[] | undefined): [string, AddressBookEntry][] {
	return [
		[addressString(message.message.details.token), getAddressMetaData(message.message.details.token, addressInfos)],
		[addressString(message.message.spender), getAddressMetaData(message.message.spender, addressInfos)],
		[addressString(message.domain.verifyingContract), getAddressMetaData(message.domain.verifyingContract, addressInfos)],
	]
}

export async function openPersonalSignDialog(requestId: number, simulationMode: boolean, params: PersonalSignParams | SignTypedDataParams) {

	if (openedPersonalSignDialogWindow !== null && openedPersonalSignDialogWindow.id) {
		await browser.windows.remove(openedPersonalSignDialogWindow.id)
	}
	pendingPersonalSign = new Future<PersonalSign>()

	if (params.method === 'personal_sign') {
		window.interceptor.personalSignDialog =  {
			simulationMode: simulationMode,
			requestId: requestId,
			message: params.params[0],
			account: addressString(params.params[1]),
			method: params.method,
			addressBookEntries: [],
		}
	} else {
		if (params.params[1].primaryType === 'Permit') {
			const parsed = EIP2612Message.parse(params.params[1])
			window.interceptor.personalSignDialog =  {
				simulationMode: simulationMode,
				requestId: requestId,
				message: stringifyJSONWithBigInts(parsed.message),
				account: addressString(params.params[0]),
				method: params.method,
				addressBookEntries: getAddressMetadataForEIP2612Message(parsed, window.interceptor.settings?.addressInfos),
				eip2612Message: parsed,
			}
		} else if(params.params[1].primaryType === 'PermitSingle') {
			const parsed = Permit2.parse(params.params[1])
			window.interceptor.personalSignDialog =  {
				simulationMode: simulationMode,
				requestId: requestId,
				message: stringifyJSONWithBigInts(parsed.message),
				account: addressString(params.params[0]),
				method: params.method,
				addressBookEntries: getAddressMetadataForPermitMessage(parsed, window.interceptor.settings?.addressInfos),
				permit2: parsed,
			}
		} else {
			window.interceptor.personalSignDialog =  {
				simulationMode: simulationMode,
				requestId: requestId,
				message: stringifyJSONWithBigInts(params.params[1]),
				account: addressString(params.params[0]),
				method: params.method,
				addressBookEntries: [],
			}
		}
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
			requestId,
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
	if (reply.options.accept) {
		if (simulationMode) {
			const result = await personalSignWithSimulator(params)
			if (result === undefined) return {
				error: {
					code: METAMASK_ERROR_USER_REJECTED_REQUEST,
					message: 'Interceptor not ready'
				}
			}
			return { result: result }
		}
		return { forward: true as const }
	}
	return {
		error: {
			code: METAMASK_ERROR_USER_REJECTED_REQUEST,
			message: 'Interceptor Personal Signature: User denied personal signature.'
		}
	}
}
