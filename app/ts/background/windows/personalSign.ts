import { QUARANTINE_CODE } from '../../simulation/protectors/quarantine-codes.js'
import { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import { stringifyJSONWithBigInts } from '../../utils/bigint.js'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import { PersonalSign, UserAddressBook, PersonalSignRequest, PendingPersonalSignPromise } from '../../utils/interceptor-messages.js'
import { OpenSeaOrderMessage, PersonalSignRequestIdentifiedEIP712Message } from '../../utils/personal-message-definitions.js'
import { assertNever } from '../../utils/typescript.js'
import { AddressBookEntry, SignerName, Website, WebsiteTabConnections } from '../../utils/user-interface-types.js'
import { OldSignTypedDataParams, PersonalSignParams, SignTypedDataParams } from '../../utils/JsonRpc-types.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { extractEIP712Message, validateEIP712Types } from '../../utils/eip712Parsing.js'
import { getAddressMetaData, getTokenMetadata } from '../metadataUtils.js'
import { getPendingPersonalSignPromise, getRpcNetwork, getRpcNetworkForChain, getSignerName, setPendingPersonalSignPromise } from '../storageVariables.js'
import { getSettings } from '../settings.js'
import { PopupOrTab, addWindowTabListener, browserTabsQueryById, closePopupOrTab, openPopupOrTab, removeWindowTabListener } from '../../components/ui-utils.js'
import { simulatePersonalSign } from '../../simulation/services/SimulationModeEthereumClientService.js'
import { InterceptedRequest, UniqueRequestIdentifier, doesUniqueRequestIdentifiersMatch } from '../../utils/requests.js'
import { replyToInterceptedRequest } from '../messageSending.js'

let pendingPersonalSign: Future<PersonalSign> | undefined = undefined

let openedDialog: PopupOrTab | undefined = undefined

export async function resolvePersonalSign(websiteTabConnections: WebsiteTabConnections, confirmation: PersonalSign) {
	if (pendingPersonalSign !== undefined) {
		pendingPersonalSign.resolve(confirmation)
	} else {
		const data = await getPendingPersonalSignPromise()
		if (data === undefined || !doesUniqueRequestIdentifiersMatch(confirmation.data.uniqueRequestIdentifier, data.request.uniqueRequestIdentifier)) return
		const resolved = await resolve(confirmation, data.simulationMode, data.params)
		replyToInterceptedRequest(websiteTabConnections, { ...data.params, ...resolved, uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
	}
	if (openedDialog) await closePopupOrTab(openedDialog)
	openedDialog = undefined
}

export async function updatePendingPersonalSignViewWithPendingRequests(ethereumClientService: EthereumClientService) {
	const personalSignPromise = await getPendingPersonalSignPromise()
	if (personalSignPromise === undefined) throw new Error('Missing personal sign promise from local storage')
	return await sendPopupMessageToOpenWindows(await craftPersonalSignPopupMessage(ethereumClientService, personalSignPromise, await getSignerName()))
}

function rejectMessage(uniqueRequestIdentifier: UniqueRequestIdentifier) {
	return {
		method: 'popup_personalSign',
		data: {
			uniqueRequestIdentifier,
			accept: false,
		},
	} as const
}

function reject(signingParams: PersonalSignParams | SignTypedDataParams | OldSignTypedDataParams,) {
	return {
		method: signingParams.method,
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

export async function craftPersonalSignPopupMessage(ethereumClientService: EthereumClientService, personalSignPromise: PendingPersonalSignPromise, signerName: SignerName): Promise<PersonalSignRequest> {
	const settings = await getSettings()
	const userAddressBook = settings.userAddressBook
	const activeAddressWithMetadata = getAddressMetaData(personalSignPromise.activeAddress, userAddressBook)
	const basicParams = {
		activeAddress: activeAddressWithMetadata,
		simulationMode: personalSignPromise.simulationMode,
		request: personalSignPromise.request,
		signerName,
		website: personalSignPromise.website,
	}
	const originalParams = personalSignPromise.params

	const getQuarrantineCodes = async (messageChainId: bigint, account: AddressBookEntry, activeAddress: AddressBookEntry, owner: AddressBookEntry | undefined): Promise<{ quarantine: boolean, quarantineCodes: readonly QUARANTINE_CODE[] }> => {
		let quarantineCodes: QUARANTINE_CODE[] = []
		if (BigInt(messageChainId) !== settings.rpcNetwork.chainId) {
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
				rpcNetwork: await getRpcNetwork(),
				type: 'NotParsed',
				message: stringifyJSONWithBigInts(originalParams.params[0], 4),
				account: getAddressMetaData(originalParams.params[1], userAddressBook),
				quarantine: false,
				quarantineCodes: [],
			}
		}
	}

	if (originalParams.method === 'personal_sign') {
		return {
			method: 'popup_personal_sign_request',
			data: {
				originalParams,
				...basicParams,
				rpcNetwork: await getRpcNetwork(),
				type: 'NotParsed',
				message: originalParams.params[0],
				account: getAddressMetaData(originalParams.params[1], userAddressBook),
				quarantine: false,
				quarantineCodes: [],
			}
		}
	}
	const namedParams = { param: originalParams.params[1], account: originalParams.params[0] }
	const account = getAddressMetaData(namedParams.account, userAddressBook)
	
	const maybeParsed = PersonalSignRequestIdentifiedEIP712Message.safeParse(namedParams.param)
	if (maybeParsed.success === false) {
		// if we fail to parse the message, that means it's a message type we do not identify, let's just show it as a nonidentified EIP712 message
		if (validateEIP712Types(namedParams.param) === false) throw new Error('Not a valid EIP712 Message')
		const message = extractEIP712Message(namedParams.param, userAddressBook)
		const chainid = message.domain.chainId?.type === 'integer' ? BigInt(message.domain.chainId?.value) : undefined

		return {
			method: 'popup_personal_sign_request',
			data: {
				originalParams,
				...basicParams,
				rpcNetwork: chainid !== undefined ? await getRpcNetworkForChain(chainid) : await getRpcNetwork(),
				type: 'EIP712',
				message,
				account,
				...chainid === undefined ? { quarantine: false, quarantineCodes: [] } : await getQuarrantineCodes(chainid, account, activeAddressWithMetadata, undefined),
			}
		}
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
					rpcNetwork: await getRpcNetworkForChain(parsed.domain.chainId),
					type: 'Permit',
					message: parsed,
					account,
					addressBookEntries: {
						owner,
						spender: getAddressMetaData(parsed.message.spender, userAddressBook),
						verifyingContract: token,
					},
					...await getQuarrantineCodes(BigInt(parsed.domain.chainId), account, activeAddressWithMetadata, owner),
				}
			}
		}
		case 'PermitSingle': {
			const token = await getTokenMetadata(ethereumClientService, parsed.message.details.token)
			if (token.type === 'NFT') throw 'Attempted to perform Permit2 to an NFT'
			return {
				method: 'popup_personal_sign_request',
				data: {
					originalParams,
					...basicParams,
					rpcNetwork: await getRpcNetworkForChain(parsed.domain.chainId),
					type: 'Permit2',
					message: parsed,
					account,
					addressBookEntries: {
						token: token,
						spender: getAddressMetaData(parsed.message.spender, userAddressBook),
						verifyingContract: getAddressMetaData(parsed.domain.verifyingContract, userAddressBook)
					},
					...await getQuarrantineCodes(parsed.domain.chainId, account, activeAddressWithMetadata, undefined),
				}
			}
		}
		case 'SafeTx': return {
			method: 'popup_personal_sign_request',
			data: {
				originalParams,
				...basicParams,
				rpcNetwork: parsed.domain.chainId !== undefined ? await getRpcNetworkForChain(parsed.domain.chainId) : await getRpcNetwork(),
				type: 'SafeTx',
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
		}
		case 'OrderComponents': return {
			method: 'popup_personal_sign_request',
			data: {
				originalParams,
				...basicParams,
				type: 'OrderComponents',
				rpcNetwork: await getRpcNetworkForChain(parsed.domain.chainId),
				message: await addMetadataToOpenSeaOrder(ethereumClientService, parsed.message, userAddressBook),
				account,
				...await getQuarrantineCodes(parsed.domain.chainId, account, activeAddressWithMetadata, undefined),
			}
		}
		default: assertNever(parsed)
	}
}

export const openPersonalSignDialog = async (
	ethereumClientService: EthereumClientService,
	websiteTabConnections: WebsiteTabConnections,
	signingParams: PersonalSignParams | SignTypedDataParams | OldSignTypedDataParams,
	request: InterceptedRequest,
	simulationMode: boolean,
	website: Website,
	activeAddress: bigint | undefined
) => {
	if (pendingPersonalSign !== undefined) return reject(signingParams)

	const onCloseWindow = (windowId: number) => {
		if (openedDialog?.windowOrTab.id !== windowId) return
		if (pendingPersonalSign === undefined) return
		openedDialog = undefined
		return resolvePersonalSign(websiteTabConnections, rejectMessage(request.uniqueRequestIdentifier))
	}

	if (activeAddress === undefined) return reject(signingParams)

	pendingPersonalSign = new Future<PersonalSign>()
	try {
		const oldPromise = await getPendingPersonalSignPromise()
		if (oldPromise !== undefined) {
			if (await browserTabsQueryById(oldPromise.dialogId) !== undefined) {
				return reject(signingParams)
			} else {
				await setPendingPersonalSignPromise(undefined)
			}
		}

		openedDialog = await openPopupOrTab({
			url: getHtmlFile('personalSign'),
			type: 'popup',
			height: 800,
			width: 600,
		})
		if (openedDialog?.windowOrTab.id !== undefined) {
			addWindowTabListener(onCloseWindow)

			await setPendingPersonalSignPromise({
				website: website,
				dialogId: openedDialog?.windowOrTab.id,
				request: request,
				simulationMode: simulationMode,
				params: signingParams,
				activeAddress,
			})
			await updatePendingPersonalSignViewWithPendingRequests(ethereumClientService)
		} else {
			await resolvePersonalSign(websiteTabConnections, rejectMessage(request.uniqueRequestIdentifier))
		}

		const reply = await pendingPersonalSign

		return resolve(reply, simulationMode, signingParams)
	} finally {
		removeWindowTabListener(onCloseWindow)
		pendingPersonalSign = undefined
	}
}

async function resolve(reply: PersonalSign, simulationMode: boolean, signingParams: PersonalSignParams | SignTypedDataParams | OldSignTypedDataParams) {
	await setPendingPersonalSignPromise(undefined)
	// forward message to content script
	if (reply.data.accept) {
		if (simulationMode) {
			const result = await simulatePersonalSign(signingParams)
			if (result === undefined) return reject(signingParams)
			return { result, method: signingParams.method }
		}
		return { forward: true, ...signingParams } as const
	}
	return reject(signingParams)
}
