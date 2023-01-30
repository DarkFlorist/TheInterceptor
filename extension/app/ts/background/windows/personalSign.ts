import { stringifyJSONWithBigInts } from '../../utils/bigint.js'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import { PersonalSign, PopupMessage } from '../../utils/interceptor-messages.js'
import { EIP2612Message, Permit2, PersonalSignParams, SignTypedDataParams } from '../../utils/wire-types.js'
import { personalSignWithSimulator } from '../background.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { getAddressMetaData } from '../metadataUtils.js'

let pendingPersonalSign: Future<PersonalSign> | undefined = undefined

let openedPersonalSignDialogWindow: browser.windows.Window | null = null

export async function resolvePersonalSign(confirmation: PersonalSign) {
	if (pendingPersonalSign !== undefined) pendingPersonalSign.resolve(confirmation)
	pendingPersonalSign = undefined

	if (openedPersonalSignDialogWindow !== null && openedPersonalSignDialogWindow.id) {
		await browser.windows.remove(openedPersonalSignDialogWindow.id)
	}
	openedPersonalSignDialogWindow = null
}

function rejectMessage(requestId: number) {
	return {
		method: 'popup_personalSign',
		options: {
			requestId,
			accept: false,
		},
	} as const
}

export const openPersonalSignDialog = async (requestId: number, simulationMode: boolean, params: PersonalSignParams | SignTypedDataParams) => {
	if (openedPersonalSignDialogWindow !== null && openedPersonalSignDialogWindow.id) {
		await browser.windows.remove(openedPersonalSignDialogWindow.id)
		if (pendingPersonalSign) await pendingPersonalSign // wait for previous to clean up
	}

	const activeAddress = simulationMode ? window.interceptor.settings?.activeSimulationAddress : window.interceptor.settings?.activeSigningAddress
	if ( activeAddress === undefined) {
		return { result: {
			error: {
				code: METAMASK_ERROR_USER_REJECTED_REQUEST,
				message: 'Interceptor not ready'
			}
		} }
	}

	pendingPersonalSign = new Future<PersonalSign>()

	const personalSignWindowReadyAndListening = async function popupMessageListener(msg: unknown) {
		const message = PopupMessage.parse(msg)
		if ( message.method !== 'popup_personalSignReadyAndListening') return
		browser.runtime.onMessage.removeListener(personalSignWindowReadyAndListening)

		if (params.method === 'personal_sign') {
			return sendPopupMessageToOpenWindows({
				message: 'popup_personal_sign_request',
				data: {
					activeAddress,
					type: 'NotParsed' as const,
					simulationMode: simulationMode,
					requestId: requestId,
					message: params.params[0],
					account: getAddressMetaData(params.params[1], window.interceptor.settings?.addressInfos),
					method: params.method,
				}
			})
		}

		if (params.params[1].primaryType === 'Permit') {
			const parsed = EIP2612Message.parse(params.params[1])
			return sendPopupMessageToOpenWindows({
				message: 'popup_personal_sign_request',
				data: {
					activeAddress,
					type: 'Permit' as const,
					simulationMode: simulationMode,
					requestId: requestId,
					message: parsed,
					account: getAddressMetaData(params.params[0], window.interceptor.settings?.addressInfos),
					method: params.method,
					addressBookEntries: {
						owner: getAddressMetaData(parsed.message.owner, window.interceptor.settings?.addressInfos),
						spender: getAddressMetaData(parsed.message.spender, window.interceptor.settings?.addressInfos),
						verifyingContract: getAddressMetaData(parsed.domain.verifyingContract, window.interceptor.settings?.addressInfos)
					},
				}
			})
		}

		if (params.params[1].primaryType === 'PermitSingle') {
			const parsed = Permit2.parse(params.params[1])
			return sendPopupMessageToOpenWindows({
				message: 'popup_personal_sign_request',
				data: {
					activeAddress,
					type: 'Permit2' as const,
					simulationMode: simulationMode,
					requestId: requestId,
					message: parsed,
					account: getAddressMetaData(params.params[0], window.interceptor.settings?.addressInfos),
					method: params.method,
					addressBookEntries: {
						token: getAddressMetaData(parsed.message.details.token, window.interceptor.settings?.addressInfos),
						spender: getAddressMetaData(parsed.message.spender, window.interceptor.settings?.addressInfos),
						verifyingContract: getAddressMetaData(parsed.domain.verifyingContract, window.interceptor.settings?.addressInfos)
					},
				}
			})
		}

		return sendPopupMessageToOpenWindows({
			message: 'popup_personal_sign_request',
			data: {
				activeAddress,
				type: 'NotParsed' as const,
				simulationMode: simulationMode,
				requestId: requestId,
				message: stringifyJSONWithBigInts(params.params[1]),
				account: getAddressMetaData(params.params[0], window.interceptor.settings?.addressInfos),
				method: params.method,
			}
		})
	}
	browser.runtime.onMessage.addListener(personalSignWindowReadyAndListening)

	openedPersonalSignDialogWindow = await browser.windows.create(
		{
			url: '../html/personalSign.html',
			type: 'popup',
			height: 400,
			width: 520,
		}
	)
	if (openedPersonalSignDialogWindow) {
		browser.windows.onRemoved.addListener( () => { // check if user has closed the window on their own, if so, reject signature
			if (pendingPersonalSign === undefined) return
			openedPersonalSignDialogWindow = null
			return resolvePersonalSign(rejectMessage(requestId))
		} )
	} else {
		resolvePersonalSign(rejectMessage(requestId))
	}

	const reply = await pendingPersonalSign
	browser.runtime.onMessage.removeListener(personalSignWindowReadyAndListening)

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
