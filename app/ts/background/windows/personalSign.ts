import { QUARANTINE_CODE } from '../../simulation/protectors/quarantine-codes.js'
import { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import { stringifyJSONWithBigInts } from '../../utils/bigint.js'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import { HandleSimulationModeReturnValue, InterceptedRequest, PersonalSign, ExternalPopupMessage, Settings, UserAddressBook, PersonalSignRequest } from '../../utils/interceptor-messages.js'
import { OpenSeaOrderMessage, PersonalSignRequestIdentifiedEIP712Message } from '../../utils/personal-message-definitions.js'
import { assertNever } from '../../utils/typescript.js'
import { AddressBookEntry, SignerName, Website, WebsiteSocket, WebsiteTabConnections } from '../../utils/user-interface-types.js'
import { OldSignTypedDataParams, PersonalSignParams, SignTypedDataParams } from '../../utils/wire-types.js'
import { personalSignWithSimulator, sendMessageToContentScript } from '../background.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { extractEIP712Message, validateEIP712Types } from '../../utils/eip712Parsing.js'
import { getAddressMetaData, getTokenMetadata } from '../metadataUtils.js'
import { getPendingPersonalSignPromise, getSettings, getSignerName, setPendingPersonalSignPromise } from '../settings.js'

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

export async function addMetadataToOpenSeaOrder(ethereumClientService: EthereumClientService, openSeaOrder: OpenSeaOrderMessage, userAddressBook: UserAddressBook) {
	return {
		...openSeaOrder,
		zone: getAddressMetaData(openSeaOrder.zone, userAddressBook),
		offerer: getAddressMetaData(openSeaOrder.offerer, userAddressBook),
		offer: await Promise.all(openSeaOrder.offer.map( async (offer) => ({ ...offer, token: await getTokenMetadata(ethereumClientService, offer.token) }))),
		consideration: await Promise.all(openSeaOrder.consideration.map(async (offer) => ({ ...offer, token: await getTokenMetadata(ethereumClientService, offer.token), recipient: getAddressMetaData(offer.recipient, userAddressBook) })))
	 }
}

export async function craftPersonalSignPopupMessage(ethereumClientService: EthereumClientService, originalParams: PersonalSignParams | SignTypedDataParams | OldSignTypedDataParams, activeAddress: bigint, userAddressBook: UserAddressBook, simulationMode: boolean, requestId: number, signerName: SignerName, website: Website): Promise<PersonalSignRequest> {
	const activeAddressWithMetadata = getAddressMetaData(activeAddress, userAddressBook)
	const basicParams = {
		activeAddress: activeAddressWithMetadata,
		simulationMode,
		requestId,
		website,
		signerName,
		activeChainId: ethereumClientService.getChain(),
	}

	const getQuarrantineCodes = async (messageChainId: bigint, account: AddressBookEntry, activeAddress: AddressBookEntry, owner: AddressBookEntry | undefined): Promise<{ quarantine: boolean, quarantineCodes: readonly QUARANTINE_CODE[] }> => {
		let quarantineCodes: QUARANTINE_CODE[] = []
		if (BigInt(messageChainId) !== (await getSettings()).activeChain) {
			quarantineCodes.push('SIGNATURE_CHAIN_ID_DOES_NOT_MATCH')
		}
		if (account.address !== activeAddress.address || (owner != undefined && account.address !== owner.address)) {
			quarantineCodes.push('SIGNATURE_ACCOUNT_DOES_NOT_MATCH')
		}
		return {
			quarantine: quarantineCodes.length > 0,
			quarantineCodes,
		}
	}
	if (originalParams.method === 'eth_signTypedData') {
		return {
			method: 'popup_personal_sign_request',
			data: {
				originalParams,
				...basicParams,
				type: 'NotParsed' as const,
				message: stringifyJSONWithBigInts(originalParams.params[0], 4),
				account: getAddressMetaData(originalParams.params[1], userAddressBook),
				quarantine: false,
				quarantineCodes: [],
			}
		} as const
	}

	if (originalParams.method === 'personal_sign') {
		return {
			method: 'popup_personal_sign_request',
			data: {
				originalParams,
				...basicParams,
				type: 'NotParsed' as const,
				message: originalParams.params[0],
				account: getAddressMetaData(originalParams.params[1], userAddressBook),
				quarantine: false,
				quarantineCodes: [],
			}
		} as const
	}
	const namedParams = { param: originalParams.params[1], account: originalParams.params[0] }
	const account = getAddressMetaData(namedParams.account, userAddressBook)
	
	const maybeParsed = PersonalSignRequestIdentifiedEIP712Message.safeParse(namedParams.param)
	if (maybeParsed.success === false) {
		// if we fail to parse the message, that means it's a message type we do not identify, let's just show it as a nonidentified EIP712 message
		if (validateEIP712Types(namedParams.param) === false) throw new Error('Not a valid EIP712 Message')
		return {
			method: 'popup_personal_sign_request',
			data: {
				originalParams,
				...basicParams,
				type: 'EIP712' as const,
				message: extractEIP712Message(namedParams.param, userAddressBook),
				account,
				quarantine: false,
				quarantineCodes: []
			}
		} as const
	}
	const parsed = maybeParsed.value
	switch (parsed.primaryType) {
		case 'Permit': {
			const token = await getTokenMetadata(ethereumClientService, parsed.domain.verifyingContract)
			const owner = getAddressMetaData(parsed.message.owner, userAddressBook)
			if (token.type === 'NFT') throw 'Attempted to perform Permit to an NFT'
			return {
				method: 'popup_personal_sign_request',
				data: {
					originalParams,
					...basicParams,
					type: 'Permit' as const,
					message: parsed,
					account,
					addressBookEntries: {
						owner,
						spender: getAddressMetaData(parsed.message.spender, userAddressBook),
						verifyingContract: token,
					},
					...await getQuarrantineCodes(BigInt(parsed.domain.chainId), account, activeAddressWithMetadata, owner),
				}
			} as const
		}
		case 'PermitSingle': {
			const token = await getTokenMetadata(ethereumClientService, parsed.message.details.token)
			if (token.type === 'NFT') throw 'Attempted to perform Permit2 to an NFT'
			return {
				method: 'popup_personal_sign_request',
				data: {
					originalParams,
					...basicParams,
					type: 'Permit2' as const,
					message: parsed,
					account,
					addressBookEntries: {
						token: token,
						spender: getAddressMetaData(parsed.message.spender, userAddressBook),
						verifyingContract: getAddressMetaData(parsed.domain.verifyingContract, userAddressBook)
					},
					...await getQuarrantineCodes(parsed.domain.chainId, account, activeAddressWithMetadata, undefined),
				}
			} as const
		}
		case 'SafeTx': return {
			method: 'popup_personal_sign_request',
			data: {
				originalParams,
				...basicParams,
				type: 'SafeTx' as const,
				message: parsed,
				account,
				addressBookEntries: {
					to: getAddressMetaData(parsed.message.to, userAddressBook),
					gasToken: await getTokenMetadata(ethereumClientService, parsed.message.gasToken),
					refundReceiver: getAddressMetaData(parsed.message.refundReceiver, userAddressBook),
					verifyingContract: getAddressMetaData(parsed.domain.verifyingContract, userAddressBook),
				},
				quarantine: false,
				quarantineCodes: [],
			}
		} as const
		case 'OrderComponents': return {
			method: 'popup_personal_sign_request',
			data: {
				originalParams,
				...basicParams,
				type: 'OrderComponents' as const,
				message: await addMetadataToOpenSeaOrder(ethereumClientService, parsed.message, userAddressBook),
				account,
				...await getQuarrantineCodes(parsed.domain.chainId, account, activeAddressWithMetadata, undefined),
			}
		} as const
		default: assertNever(parsed)
	}
}

export const openPersonalSignDialog = async (
	ethereumClientService: EthereumClientService,
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	params: PersonalSignParams | SignTypedDataParams | OldSignTypedDataParams,
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
	const popupMessage = await craftPersonalSignPopupMessage(ethereumClientService, params, activeAddress, settings.userAddressBook, simulationMode, request.requestId, await getSignerName(), website)

	const personalSignWindowReadyAndListening = async function popupMessageListener(msg: unknown) {
		const message = ExternalPopupMessage.parse(msg)
		if (message.method !== 'popup_personalSignReadyAndListening') return
		browser.runtime.onMessage.removeListener(personalSignWindowReadyAndListening)
		return await sendPopupMessageToOpenWindows(popupMessage)
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
			height: 800,
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

async function resolve(reply: PersonalSign, simulationMode: boolean, params: PersonalSignParams | SignTypedDataParams | OldSignTypedDataParams) {
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
