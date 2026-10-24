import { SafeMessage } from '../../safe/safeMessage.js'
import type { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import { stringifyJSONWithBigInts } from '../../utils/bigint.js'
import { type OpenSeaOrderMessage, type Permit2SignatureTransferKind, type Permit2Witness, PersonalSignRequestIdentifiedEIP712Message, type VisualizedPersonalSignRequest, findPermit2WitnessField, getPermit2SignatureTransferKind } from '../../types/personal-message-definitions.js'
import { assertNever } from '../../utils/typescript.js'
import { extractEIP712Message, validateEIP712Types } from '../../utils/eip712Parsing.js'
import { getRpcNetworkForChain, getTabState } from '../storageVariables.js'
import { getAddressesForSolidityTypes, identifyAddress } from '../metadataUtils.js'
import type { SignedMessageTransaction } from '../../types/visualizer-types.js'
import type { RpcNetwork } from '../../types/rpc.js'
import { getChainName } from '../../utils/constants.js'
import { parseInputData } from '../../simulation/parsing.js'
import { getMessageHashForPersonalSign } from '../../simulation/services/simulationPersonalSigning.js'
import { getMessageAndDomainHash, getSafeTxHash, isValidMessage } from '../../utils/eip712.js'
import { promiseAllMapAbortSafe } from '../../utils/requests.js'
import type { EIP712Message } from '../../types/eip721.js'

async function addMetadataToOpenSeaOrder(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, openSeaOrder: OpenSeaOrderMessage) {
	return {
		...openSeaOrder,
		zone: await identifyAddress(ethereumClientService, requestAbortController, openSeaOrder.zone),
		offerer: await identifyAddress(ethereumClientService, requestAbortController, openSeaOrder.offerer),
		offer: await promiseAllMapAbortSafe(openSeaOrder.offer, async (offer) => ({ ...offer, token: await identifyAddress(ethereumClientService, requestAbortController, offer.token) })),
		consideration: await promiseAllMapAbortSafe(openSeaOrder.consideration, async (offer) => ({ ...offer, token: await identifyAddress(ethereumClientService, requestAbortController, offer.token), recipient: await identifyAddress(ethereumClientService, requestAbortController, offer.recipient) }))
	 }
}

async function identifyPermitToken(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, tokenAddress: bigint) {
	const token = await identifyAddress(ethereumClientService, requestAbortController, tokenAddress)
	if (token.type === 'ERC721') throw new Error('Attempted to perform Permit to an ERC721')
	if (token.type === 'ERC1155') throw new Error('Attempted to perform Permit to an ERC1155')
	return token
}

async function extractPermit2Witness(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, typedData: EIP712Message, transferKind: Permit2SignatureTransferKind): Promise<Permit2Witness | undefined> {
	if (!transferKind.hasWitness) return undefined
	const witnessTypeField = findPermit2WitnessField(transferKind.structFields)
	if (witnessTypeField === undefined) throw new Error('Permit2 witness transfer must declare exactly one witness field besides permitted, spender, nonce and deadline')
	// The witness struct is integrator defined, so it is enriched with the generic EIP-712 extractor from the original request instead of a dedicated runtime type.
	const enrichedTypedData = await extractEIP712Message(ethereumClientService, requestAbortController, typedData)
	const witnessValue = enrichedTypedData.message[witnessTypeField.name]
	if (witnessValue === undefined) throw new Error(`Permit2 witness field "${ witnessTypeField.name }" is missing from the message`)
	return { fieldName: witnessTypeField.name, typeName: witnessTypeField.type, value: witnessValue }
}

export function getSigningQuarantineCodes(messageChainId: bigint | undefined, activeChainId: bigint, accountAddress: bigint, activeAddress: bigint, ownerAddress: bigint | undefined): { quarantine: boolean, quarantineReasons: readonly string[] } {
	const quarantineReasons: string[] = []
	if (messageChainId !== undefined && messageChainId !== activeChainId) quarantineReasons.push(`The signature request is for a different chain (${ getChainName(messageChainId) }) than what is currently active (${ getChainName(activeChainId) }).`)
	if (accountAddress !== activeAddress || (ownerAddress !== undefined && accountAddress !== ownerAddress)) quarantineReasons.push('The signature request is for an account that is different from your active address.')
	return { quarantine: quarantineReasons.length > 0, quarantineReasons }
}

export const getSignedMessageActiveAddress = (signedMessageTransaction: SignedMessageTransaction) =>
	signedMessageTransaction.activeAddress ?? signedMessageTransaction.fakeSignedFor

export async function craftPersonalSignPopupMessage(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, signedMessageTransaction: SignedMessageTransaction, rpcNetwork: RpcNetwork): Promise<VisualizedPersonalSignRequest> {
	const activeAddressWithMetadata = await identifyAddress(ethereumClientService, requestAbortController, getSignedMessageActiveAddress(signedMessageTransaction))
	const signerName = (await getTabState(signedMessageTransaction.request.uniqueRequestIdentifier.requestSocket.tabId)).signerName
	const basicParams = {
		website: signedMessageTransaction.website,
		created: signedMessageTransaction.created,
		simulationMode: signedMessageTransaction.simulationMode,
		messageIdentifier: signedMessageTransaction.messageIdentifier,
		activeAddress: activeAddressWithMetadata,
		signerName,
	}
	const originalParams = signedMessageTransaction
	const isValid = isValidMessage(signedMessageTransaction.originalRequestParameters)

	if (originalParams.originalRequestParameters.method === 'eth_signTypedData') {
		const account = await identifyAddress(ethereumClientService, requestAbortController, originalParams.originalRequestParameters.params[1])
		return {
			method: originalParams.originalRequestParameters.method,
			...basicParams,
			rpcNetwork,
			type: 'NotParsed' as const,
			message: stringifyJSONWithBigInts(originalParams.originalRequestParameters.params[0], 4),
			account,
			...getSigningQuarantineCodes(undefined, rpcNetwork.chainId, account.address, activeAddressWithMetadata.address, undefined),
			stringifiedMessage: stringifyJSONWithBigInts(originalParams.originalRequestParameters.params[0], 4),
			rawMessage: stringifyJSONWithBigInts(originalParams.originalRequestParameters.params[0]),
			isValidMessage: isValid.valid,
			messageHash: undefined,
		}
	}

	if (originalParams.originalRequestParameters.method === 'personal_sign') {
		const account = await identifyAddress(ethereumClientService, requestAbortController, originalParams.originalRequestParameters.params[1])
		return {
			method: originalParams.originalRequestParameters.method,
			...basicParams,
			rpcNetwork,
			type: 'NotParsed' as const,
			message: originalParams.originalRequestParameters.params[0],
			account,
			...getSigningQuarantineCodes(undefined, rpcNetwork.chainId, account.address, activeAddressWithMetadata.address, undefined),
			stringifiedMessage: stringifyJSONWithBigInts(originalParams.originalRequestParameters.params[0], 4),
			rawMessage: originalParams.originalRequestParameters.params[0],
			isValidMessage: isValid.valid,
			messageHash: getMessageHashForPersonalSign(originalParams.originalRequestParameters),
		}
	}
	const namedParams = { param: originalParams.originalRequestParameters.params[1], account: originalParams.originalRequestParameters.params[0] }
	const account = await identifyAddress(ethereumClientService, requestAbortController, namedParams.account)
	const maybeParsed = PersonalSignRequestIdentifiedEIP712Message.safeParse(namedParams.param)
	if (isValid.valid === false) {
		return {
			method: originalParams.originalRequestParameters.method,
			...basicParams,
			rpcNetwork,
			type: 'NotParsed' as const,
			message: stringifyJSONWithBigInts(namedParams.param, 4),
			account,
			quarantine: true, quarantineReasons: [isValid.reason],
			stringifiedMessage: stringifyJSONWithBigInts(namedParams.param, 4),
			rawMessage: stringifyJSONWithBigInts(namedParams.param),
			isValidMessage: isValid.valid,
			messageHash: undefined,
		}
	}

	if (maybeParsed.success === false) {
		const hashes = getMessageAndDomainHash(originalParams.originalRequestParameters)
		const safeMessage = SafeMessage.safeParse({ typedData: namedParams.param, review: signedMessageTransaction.safeMessageReview })
		// if we fail to parse the message, that means it's a message type we do not identify, let's just show it as a nonidentified EIP712 message
		if (validateEIP712Types(namedParams.param) === false) throw new Error('Not a valid EIP712 Message')
		const message = await extractEIP712Message(ethereumClientService, requestAbortController, namedParams.param)
		const { chainId } = message.domain
		const chainid = chainId?.type === 'unsignedInteger' ? chainId.value : undefined
		return {
			method: originalParams.originalRequestParameters.method,
			...basicParams,
			rpcNetwork: chainid !== undefined && rpcNetwork.chainId !== chainid ? await getRpcNetworkForChain(chainid) : rpcNetwork,
			...(safeMessage.success ? { type: 'SafeMessage' as const, review: safeMessage.value.review } : { type: 'EIP712' as const }),
			message,
			account,
			...getSigningQuarantineCodes(chainid, rpcNetwork.chainId, account.address, activeAddressWithMetadata.address, undefined),
			stringifiedMessage: stringifyJSONWithBigInts(namedParams.param, 4),
			rawMessage: stringifyJSONWithBigInts(namedParams.param),
			isValidMessage: isValid.valid,
			...hashes,
		}
	}
	const hashes = getMessageAndDomainHash(originalParams.originalRequestParameters)
	const parsed = maybeParsed.value
	switch (parsed.primaryType) {
		case 'Permit': {
			const token = await identifyPermitToken(ethereumClientService, requestAbortController, parsed.domain.verifyingContract)
			const owner = await identifyAddress(ethereumClientService, requestAbortController, parsed.message.owner)
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
				...getSigningQuarantineCodes(parsed.domain.chainId, rpcNetwork.chainId, account.address, activeAddressWithMetadata.address, owner.address),
				stringifiedMessage: stringifyJSONWithBigInts(namedParams.param, 4),
				rawMessage: stringifyJSONWithBigInts(namedParams.param),
				isValidMessage: isValid.valid,
				...hashes,
			}
		}
		case 'PermitSingle': {
			const token = await identifyPermitToken(ethereumClientService, requestAbortController, parsed.message.details.token)
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
				...getSigningQuarantineCodes(parsed.domain.chainId, rpcNetwork.chainId, account.address, activeAddressWithMetadata.address, undefined),
				stringifiedMessage: stringifyJSONWithBigInts(namedParams.param, 4),
				rawMessage: stringifyJSONWithBigInts(namedParams.param),
				isValidMessage: isValid.valid,
				...hashes,
			}
		}
		case 'PermitBatch': return {
			method: originalParams.originalRequestParameters.method,
			...basicParams,
			rpcNetwork: rpcNetwork.chainId !== parsed.domain.chainId ? await getRpcNetworkForChain(parsed.domain.chainId) : rpcNetwork,
			type: 'Permit2Batch' as const,
			message: parsed,
			account,
			details: await promiseAllMapAbortSafe(parsed.message.details, async (details) => ({ ...details, token: await identifyPermitToken(ethereumClientService, requestAbortController, details.token) })),
			spender: await identifyAddress(ethereumClientService, requestAbortController, parsed.message.spender),
			verifyingContract: await identifyAddress(ethereumClientService, requestAbortController, parsed.domain.verifyingContract),
			...getSigningQuarantineCodes(parsed.domain.chainId, rpcNetwork.chainId, account.address, activeAddressWithMetadata.address, undefined),
			stringifiedMessage: stringifyJSONWithBigInts(namedParams.param, 4),
			rawMessage: stringifyJSONWithBigInts(namedParams.param),
			isValidMessage: isValid.valid,
			...hashes,
		}
		case 'PermitTransferFrom':
		case 'PermitBatchTransferFrom':
		case 'PermitWitnessTransferFrom':
		case 'PermitBatchWitnessTransferFrom': {
			const transferKind = getPermit2SignatureTransferKind(parsed)
			return {
				method: originalParams.originalRequestParameters.method,
				...basicParams,
				rpcNetwork: rpcNetwork.chainId !== parsed.domain.chainId ? await getRpcNetworkForChain(parsed.domain.chainId) : rpcNetwork,
				type: 'Permit2SignatureTransfer' as const,
				message: parsed,
				account,
				permitted: await promiseAllMapAbortSafe(transferKind.permitted, async (permission) => ({ ...permission, token: await identifyPermitToken(ethereumClientService, requestAbortController, permission.token) })),
				spender: await identifyAddress(ethereumClientService, requestAbortController, parsed.message.spender),
				verifyingContract: await identifyAddress(ethereumClientService, requestAbortController, parsed.domain.verifyingContract),
				witness: await extractPermit2Witness(ethereumClientService, requestAbortController, namedParams.param, transferKind),
				...getSigningQuarantineCodes(parsed.domain.chainId, rpcNetwork.chainId, account.address, activeAddressWithMetadata.address, undefined),
				// The parsed message drops the witness and its struct types, so show the original request like the generic EIP-712 path does.
				stringifiedMessage: stringifyJSONWithBigInts(namedParams.param, 4),
				rawMessage: stringifyJSONWithBigInts(namedParams.param),
				isValidMessage: isValid.valid,
				...hashes,
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
				parsedMessageDataAddressBookEntries: await promiseAllMapAbortSafe(addressesInEventsAndInputData, (address) => identifyAddress(ethereumClientService, requestAbortController, address)),
				isValidMessage: isValid.valid,
				...hashes,
				safeTxHash: getSafeTxHash(parsed),
			}
		}
		case 'OrderComponents': return {
			method: originalParams.originalRequestParameters.method,
			...basicParams,
			type: 'OrderComponents' as const,
			rpcNetwork: rpcNetwork.chainId !== parsed.domain.chainId ? await getRpcNetworkForChain(parsed.domain.chainId) : rpcNetwork,
			message: await addMetadataToOpenSeaOrder(ethereumClientService, requestAbortController, parsed.message),
			account,
			...getSigningQuarantineCodes(parsed.domain.chainId, rpcNetwork.chainId, account.address, activeAddressWithMetadata.address, undefined),
			stringifiedMessage: stringifyJSONWithBigInts(parsed, 4),
			rawMessage: stringifyJSONWithBigInts(parsed),
			isValidMessage: isValid.valid,
			...hashes,
		}
		default: assertNever(parsed)
	}
}
