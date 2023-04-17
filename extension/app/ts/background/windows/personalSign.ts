import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import { HandleSimulationModeReturnValue, InterceptedRequest, PersonalSign, ExternalPopupMessage, Settings, UserAddressBook } from '../../utils/interceptor-messages.js'
import { Website, WebsiteSocket, WebsiteTabConnections } from '../../utils/user-interface-types.js'
import { EIP2612Message, Permit2, PersonalSignParams, SignTypedDataParams } from '../../utils/wire-types.js'
import { personalSignWithSimulator, sendMessageToContentScript } from '../background.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { getAddressMetaData } from '../metadataUtils.js'
import { getPendingPersonalSignPromise, setPendingPersonalSignPromise } from '../settings.js'

let pendingPersonalSign: Future<PersonalSign> | undefined = undefined

let openedPersonalSignDialogWindow: browser.windows.Window | null = null

export async function resolvePersonalSign(websiteTabConnections: WebsiteTabConnections, confirmation: PersonalSign) {
	if (pendingPersonalSign !== undefined) {
		pendingPersonalSign.resolve(confirmation)
	} else {
		const data = await getPendingPersonalSignPromise()
		if (data === undefined || confirmation.options.requestId !== data.request.requestId) return
		const resolved = await resolve(confirmation, data.simulationMode, data.params)
		sendMessageToContentScript(websiteTabConnections, data.socket, resolved, data.request)
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

function reject() {
	return {
		error: {
			code: METAMASK_ERROR_USER_REJECTED_REQUEST,
			message: 'Interceptor Personal Signature: User denied personal signature.'
		}
	}
}

export function craftPersonalSignPopupMessage(params: PersonalSignParams | SignTypedDataParams, activeAddress: bigint, userAddressBook: UserAddressBook, simulationMode: boolean, requestId: number) {
	if (params.method === 'personal_sign') {
		return {
			method: 'popup_personal_sign_request',
			data: {
				activeAddress,
				type: 'NotParsed' as const,
				simulationMode,
				requestId,
				message: params.params[0],
				account: getAddressMetaData(params.params[1], userAddressBook),
				method: params.method,
				params,
			}
		} as const
	}

	if (params.params[1].primaryType === 'Permit') {
		const parsed = EIP2612Message.parse(params.params[1])
		return {
			method: 'popup_personal_sign_request',
			data: {
				activeAddress,
				type: 'Permit' as const,
				simulationMode: simulationMode,
				requestId: requestId,
				message: parsed,
				account: getAddressMetaData(params.params[0], userAddressBook),
				method: params.method,
				addressBookEntries: {
					owner: getAddressMetaData(parsed.message.owner, userAddressBook),
					spender: getAddressMetaData(parsed.message.spender, userAddressBook),
					verifyingContract: getAddressMetaData(parsed.domain.verifyingContract, userAddressBook)
				},
				params: params
			}
		} as const
	}

	if (params.params[1].primaryType === 'PermitSingle') {
		const parsed = Permit2.parse(params.params[1])
		return {
			method: 'popup_personal_sign_request',
			data: {
				activeAddress,
				type: 'Permit2' as const,
				simulationMode: simulationMode,
				requestId: requestId,
				message: parsed,
				account: getAddressMetaData(params.params[0], userAddressBook),
				method: params.method,
				addressBookEntries: {
					token: getAddressMetaData(parsed.message.details.token, userAddressBook),
					spender: getAddressMetaData(parsed.message.spender, userAddressBook),
					verifyingContract: getAddressMetaData(parsed.domain.verifyingContract, userAddressBook)
				},
				params: params
			}
		} as const
	}
	return {
		method: 'popup_personal_sign_request',
		data: {
			activeAddress,
			type: 'EIP712' as const,
			simulationMode: simulationMode,
			requestId: requestId,
			message: params.params[1],
			account: getAddressMetaData(params.params[0], userAddressBook),
			method: params.method,
			params: params
		}
	} as const
}

export const openPersonalSignDialog = async (
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	params: PersonalSignParams | SignTypedDataParams,
	request: InterceptedRequest,
	simulationMode: boolean,
	website: Website,
	settings: Settings,
): Promise<HandleSimulationModeReturnValue> => {
	if (pendingPersonalSign !== undefined) return reject()

	const onCloseWindow = (windowId: number) => {
		if (openedPersonalSignDialogWindow === null || openedPersonalSignDialogWindow.id !== windowId) return
		if (pendingPersonalSign === undefined) return
		openedPersonalSignDialogWindow = null
		return resolvePersonalSign(websiteTabConnections, rejectMessage(request.requestId))
	}

	const activeAddress = simulationMode ? settings.activeSimulationAddress : settings.activeSigningAddress
	if (activeAddress === undefined) return reject()
	const personalSignWindowReadyAndListening = async function popupMessageListener(msg: unknown) {
		const message = ExternalPopupMessage.parse(msg)
		if (message.method !== 'popup_personalSignReadyAndListening') return
		browser.runtime.onMessage.removeListener(personalSignWindowReadyAndListening)
		return await sendPopupMessageToOpenWindows(craftPersonalSignPopupMessage(params, activeAddress, settings.userAddressBook, simulationMode, request.requestId))
	}

	pendingPersonalSign = new Future<PersonalSign>()
	try {
		const oldPromise = await getPendingPersonalSignPromise()
		if (oldPromise !== undefined) {
			if ((await browser.tabs.query({ windowId: oldPromise.dialogId })).length > 0) {
				return reject()
			} else {
				await setPendingPersonalSignPromise(undefined)
			}
		}

		browser.runtime.onMessage.addListener(personalSignWindowReadyAndListening)

		openedPersonalSignDialogWindow = await browser.windows.create({
			url: getHtmlFile('personalSign'),
			type: 'popup',
			height: 600,
			width: 600,
		})
		if (openedPersonalSignDialogWindow && openedPersonalSignDialogWindow.id !== undefined) {
			browser.windows.onRemoved.addListener(onCloseWindow)

			await setPendingPersonalSignPromise({
				website: website,
				dialogId: openedPersonalSignDialogWindow.id,
				socket: socket,
				request: request,
				simulationMode: simulationMode,
				params: params,
			})
		} else {
			await resolvePersonalSign(websiteTabConnections, rejectMessage(request.requestId))
		}

		const reply = await pendingPersonalSign

		return resolve(reply, simulationMode, params)
	} finally {
		browser.runtime.onMessage.removeListener(personalSignWindowReadyAndListening)
		browser.runtime.onMessage.removeListener(onCloseWindow)
		pendingPersonalSign = undefined
	}
}

async function resolve(reply: PersonalSign, simulationMode: boolean, params: PersonalSignParams | SignTypedDataParams) {
	await setPendingPersonalSignPromise(undefined)
	// forward message to content script
	if (reply.options.accept) {
		if (simulationMode) {
			const result = await personalSignWithSimulator(params)
			if (result === undefined) return reject()
			return { result: result }
		}
		return { forward: true as const }
	}
	return reject()
}
