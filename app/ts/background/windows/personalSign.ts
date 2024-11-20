import { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import { stringifyJSONWithBigInts } from '../../utils/bigint.js'
import { OpenSeaOrderMessage, PersonalSignRequestIdentifiedEIP712Message, VisualizedPersonalSignRequest } from '../../types/personal-message-definitions.js'
import { assertNever } from '../../utils/typescript.js'
import { extractEIP712Message, validateEIP712Types } from '../../utils/eip712Parsing.js'
import { getRpcNetworkForChain, getTabState } from '../storageVariables.js'
import { getAddressesForSolidityTypes, identifyAddress } from '../metadataUtils.js'
import { AddressBookEntry } from '../../types/addressBookTypes.js'
import { SignedMessageTransaction } from '../../types/visualizer-types.js'
import { RpcNetwork } from '../../types/rpc.js'
import { getChainName } from '../../utils/constants.js'
import { parseInputData } from '../../simulation/simulator.js'
import { isValidMessage } from '../../simulation/services/SimulationModeEthereumClientService.js'

async function addMetadataToOpenSeaOrder(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, openSeaOrder: OpenSeaOrderMessage) {
	return {
		...openSeaOrder,
		zone: await identifyAddress(ethereumClientService, requestAbortController, openSeaOrder.zone),
		offerer: await identifyAddress(ethereumClientService, requestAbortController, openSeaOrder.offerer),
		offer: await Promise.all(openSeaOrder.offer.map( async (offer) => ({ ...offer, token: await identifyAddress(ethereumClientService, requestAbortController, offer.token) }))),
		consideration: await Promise.all(openSeaOrder.consideration.map(async (offer) => ({ ...offer, token: await identifyAddress(ethereumClientService, requestAbortController, offer.token), recipient: await identifyAddress(ethereumClientService, requestAbortController, offer.recipient) })))
	}
}

export async function craftPersonalSignPopupMessage(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, signedMessageTransaction: SignedMessageTransaction, rpcNetwork: RpcNetwork): Promise<VisualizedPersonalSignRequest> {
	const activeAddressWithMetadata = await identifyAddress(ethereumClientService, requestAbortController, signedMessageTransaction.fakeSignedFor)
	const signerName = (await getTabState(signedMessageTransaction.request.uniqueRequestIdentifier.requestSocket.tabId)).signerName
	const basicParams = { ...signedMessageTransaction, activeAddress: activeAddressWithMetadata, signerName }
	const originalParams = signedMessageTransaction

	const getQuarrantineCodes = async (messageChainId: bigint, account: AddressBookEntry, activeAddress: AddressBookEntry, owner: AddressBookEntry | undefined): Promise<{ quarantine: boolean, quarantineReasons: readonly string[] }> => {
		const quarantineReasons: string[] = []
		if (messageChainId !== rpcNetwork.chainId) quarantineReasons.push(`The signature request is for a different chain (${ getChainName(messageChainId) }) than what is currently active (${ getChainName(rpcNetwork.chainId) }).`)
		if (account.address !== activeAddress.address || (owner !== undefined && account.address !== owner.address)) quarantineReasons.push('The signature request is for an account that is different from your active address.')
		return { quarantine: quarantineReasons.length > 0, quarantineReasons }
	}
	if (originalParams.originalRequestParameters.method === 'eth_signTypedData') {
		return {
			method: originalParams.originalRequestParameters.method,
			...basicParams,
			rpcNetwork,
			type: 'NotParsed' as const,
			message: stringifyJSONWithBigInts(originalParams.originalRequestParameters.params[0], 4),
			account: await identifyAddress(ethereumClientService, requestAbortController, originalParams.originalRequestParameters.params[1]),
			quarantine: false,
			quarantineReasons: [],
			stringifiedMessage: stringifyJSONWithBigInts(originalParams.originalRequestParameters.params[0], 4),
			rawMessage: stringifyJSONWithBigInts(originalParams.originalRequestParameters.params[0]),
			isValidMessage: isValidMessage(signedMessageTransaction.originalRequestParameters, originalParams.originalRequestParameters.params[1])
		}
	}

	if (originalParams.originalRequestParameters.method === 'personal_sign') {
		return {
			method: originalParams.originalRequestParameters.method,
			...basicParams,
			rpcNetwork,
			type: 'NotParsed' as const,
			message: originalParams.originalRequestParameters.params[0],
			account: await identifyAddress(ethereumClientService, requestAbortController, originalParams.originalRequestParameters.params[1]),
			quarantine: false,
			quarantineReasons: [],
			stringifiedMessage: stringifyJSONWithBigInts(originalParams.originalRequestParameters.params[0], 4),
			rawMessage: originalParams.originalRequestParameters.params[0],
			isValidMessage: isValidMessage(signedMessageTransaction.originalRequestParameters, originalParams.originalRequestParameters.params[1])
		}
	}
	const namedParams = { param: originalParams.originalRequestParameters.params[1], account: originalParams.originalRequestParameters.params[0] }
	const account = await identifyAddress(ethereumClientService, requestAbortController, namedParams.account)

	const maybeParsed = PersonalSignRequestIdentifiedEIP712Message.safeParse(namedParams.param)
	if (maybeParsed.success === false) {
		// if we fail to parse the message, that means it's a message type we do not identify, let's just show it as a nonidentified EIP712 message
		if (validateEIP712Types(namedParams.param) === false) throw new Error('Not a valid EIP712 Message')
		try {
			const message = await extractEIP712Message(ethereumClientService, requestAbortController, namedParams.param)
			const chainid = message.domain.chainId?.type === 'unsignedInteger' ? message.domain.chainId.value : undefined
			return {
				method: originalParams.originalRequestParameters.method,
				...basicParams,
				rpcNetwork: chainid !== undefined && rpcNetwork.chainId !== chainid ? await getRpcNetworkForChain(chainid) : rpcNetwork,
				type: 'EIP712' as const,
				message,
				account,
				...chainid === undefined ? { quarantine: false, quarantineReasons: [] } : await getQuarrantineCodes(chainid, account, activeAddressWithMetadata, undefined),
				stringifiedMessage: stringifyJSONWithBigInts(namedParams.param, 4),
				rawMessage: stringifyJSONWithBigInts(namedParams.param),
				isValidMessage: isValidMessage(signedMessageTransaction.originalRequestParameters, account.address)
			}
		} catch(e: unknown) {
			console.error(e)
			throw new Error('Not a valid EIP712 Message')
		}
	}
	const parsed = maybeParsed.value
	switch (parsed.primaryType) {
		case 'Permit': {
			const token = await identifyAddress(ethereumClientService, requestAbortController, parsed.domain.verifyingContract)
			const owner = await identifyAddress(ethereumClientService, requestAbortController, parsed.message.owner)
			if (token.type === 'ERC721') throw 'Attempted to perform Permit to an ERC721'
			if (token.type === 'ERC1155') throw 'Attempted to perform Permit to an ERC1155'
			return {
				method: originalParams.originalRequestParameters.method,
				...basicParams,
				rpcNetwork: rpcNetwork.chainId !== parsed.domain.chainId ? await getRpcNetworkForChain(parsed.domain.chainId) : rpcNetwork,
				type: 'Permit' as const,
				message: parsed,
				account,
				owner,
				spender: await identifyAddress(ethereumClientService, requestAbortController, parsed.message.spender),
				verifyingContract: token,
				...await getQuarrantineCodes(BigInt(parsed.domain.chainId), account, activeAddressWithMetadata, owner),
				rawMessage: stringifyJSONWithBigInts(parsed, 4),
				stringifiedMessage: stringifyJSONWithBigInts(parsed, 4),
				isValidMessage: isValidMessage(signedMessageTransaction.originalRequestParameters, account.address)
			}
		}
		case 'PermitSingle': {
			const token = await identifyAddress(ethereumClientService, requestAbortController, parsed.message.details.token)
			if (token.type === 'ERC721') throw 'Attempted to perform Permit to an ERC721'
			if (token.type === 'ERC1155') throw 'Attempted to perform Permit to an ERC1155'
			return {
				method: originalParams.originalRequestParameters.method,
				...basicParams,
				rpcNetwork: rpcNetwork.chainId !== parsed.domain.chainId ? await getRpcNetworkForChain(parsed.domain.chainId) : rpcNetwork,
				type: 'Permit2' as const,
				message: parsed,
				account,
				token: token,
				spender: await identifyAddress(ethereumClientService, requestAbortController, parsed.message.spender),
				verifyingContract: await identifyAddress(ethereumClientService, requestAbortController, parsed.domain.verifyingContract),
				...await getQuarrantineCodes(parsed.domain.chainId, account, activeAddressWithMetadata, undefined),
				stringifiedMessage: stringifyJSONWithBigInts(parsed, 4),
				rawMessage: stringifyJSONWithBigInts(parsed),
				isValidMessage: isValidMessage(signedMessageTransaction.originalRequestParameters, parsed.message.spender)
			}
		}
		case 'SafeTx': {
			const addresses = {
				to: await identifyAddress(ethereumClientService, requestAbortController, parsed.message.to),
				gasToken: await identifyAddress(ethereumClientService, requestAbortController, parsed.message.gasToken),
				refundReceiver: await identifyAddress(ethereumClientService, requestAbortController, parsed.message.refundReceiver),
				verifyingContract: await identifyAddress(ethereumClientService, requestAbortController, parsed.domain.verifyingContract),
			}
			const parsedMessageData = await parseInputData({ to: parsed.message.to, value: 0n, input: parsed.message.data }, ethereumClientService, requestAbortController)
			const addressesInEventsAndInputData = getAddressesForSolidityTypes(parsedMessageData.type === 'Parsed' ? parsedMessageData.args : [])
			return {
				method: originalParams.originalRequestParameters.method,
				...basicParams,
				rpcNetwork: parsed.domain.chainId !== undefined && rpcNetwork.chainId !== parsed.domain.chainId ? await getRpcNetworkForChain(parsed.domain.chainId) : rpcNetwork,
				type: 'SafeTx' as const,
				message: parsed,
				account,
				...addresses,
				quarantine: false,
				quarantineReasons: [],
				stringifiedMessage: stringifyJSONWithBigInts(parsed, 4),
				rawMessage: stringifyJSONWithBigInts(parsed),
				parsedMessageData,
				parsedMessageDataAddressBookEntries: await Promise.all(addressesInEventsAndInputData.map((address) => identifyAddress(ethereumClientService, requestAbortController, address))),
				isValidMessage: isValidMessage(signedMessageTransaction.originalRequestParameters, account.address)
			}
		}
		case 'OrderComponents': return {
			method: originalParams.originalRequestParameters.method,
			...basicParams,
			type: 'OrderComponents' as const,
			rpcNetwork: rpcNetwork.chainId !== parsed.domain.chainId ? await getRpcNetworkForChain(parsed.domain.chainId) : rpcNetwork,
			message: await addMetadataToOpenSeaOrder(ethereumClientService, requestAbortController, parsed.message),
			account,
			...await getQuarrantineCodes(parsed.domain.chainId, account, activeAddressWithMetadata, undefined),
			stringifiedMessage: stringifyJSONWithBigInts(parsed, 4),
			rawMessage: stringifyJSONWithBigInts(parsed),
			isValidMessage: isValidMessage(signedMessageTransaction.originalRequestParameters, account.address)
		}
		default: assertNever(parsed)
	}
}
