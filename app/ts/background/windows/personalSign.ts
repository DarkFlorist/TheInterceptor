import { SafeMessage } from '../../safe/safeMessage.js'
import { stringifyJSONWithBigInts } from '../../utils/bigint.js'
import { type OpenSeaOrderMessage, type Permit2SignatureTransferKind, type Permit2Witness, PersonalSignRequestIdentifiedEIP712Message, type VisualizedPersonalSignRequest, findPermit2WitnessField, getPermit2SignatureTransferKind } from '../../types/personal-message-definitions.js'
import { assertNever } from '../../utils/typescript.js'
import { extractEIP712Message, validateEIP712Types } from '../../utils/eip712Parsing.js'
import { getTabState } from '../storageVariables.js'
import { getRpcNetworkForChain } from '../rpcListStorage.js'
import { getAddressesForSolidityTypes } from '../metadataUtils.js'
import type { IdentifyAddress } from '../../types/metadataLookups.js'
import type { SignedMessageTransaction } from '../../types/visualizer-types.js'
import type { RpcNetwork } from '../../types/rpc.js'
import { getChainName } from '../../utils/constants.js'
import { parseInputData } from '../../simulation/parsing.js'
import { getMessageHashForPersonalSign } from '../../simulation/services/simulationPersonalSigning.js'
import { getMessageAndDomainHash, getSafeTxHash, isValidMessage } from '../../utils/eip712.js'
import { promiseAllMapAbortSafe } from '../../utils/requests.js'
import type { EIP712Message } from '../../types/eip721.js'
import { decodePersonalSignMessage } from '../../utils/personalSignMessage.js'
import { getSiweLookalikeQuarantineReasons, getSiweQuarantineReasons, parseSiweMessage } from '../../utils/siwe.js'

async function addMetadataToOpenSeaOrder(identify: IdentifyAddress, openSeaOrder: OpenSeaOrderMessage) {
	return {
		...openSeaOrder,
		zone: await identify(openSeaOrder.zone),
		offerer: await identify(openSeaOrder.offerer),
		offer: await promiseAllMapAbortSafe(openSeaOrder.offer, async (offer) => ({ ...offer, token: await identify(offer.token) })),
		consideration: await promiseAllMapAbortSafe(openSeaOrder.consideration, async (offer) => ({ ...offer, token: await identify(offer.token), recipient: await identify(offer.recipient) }))
	 }
}

// Rejects only tokens positively identified as NFTs. Contracts that do not answer the ERC20 and ERC165 probes, addresses without code and address book contacts pass, and the signing page shows them under the unidentified token warning.
async function identifyPermitToken(identify: IdentifyAddress, tokenAddress: bigint) {
	const token = await identify(tokenAddress)
	if (token.type === 'ERC721') throw new Error('Attempted to perform Permit to an ERC721')
	if (token.type === 'ERC1155') throw new Error('Attempted to perform Permit to an ERC1155')
	return token
}

async function extractPermit2Witness(identify: IdentifyAddress, typedData: EIP712Message, transferKind: Permit2SignatureTransferKind): Promise<Permit2Witness | undefined> {
	if (!transferKind.hasWitness) return undefined
	const witnessTypeField = findPermit2WitnessField(transferKind.structFields)
	if (witnessTypeField === undefined) throw new Error('Permit2 witness transfer must declare exactly one witness field besides permitted, spender, nonce and deadline')
	// The witness struct is integrator defined, so it is enriched with the generic EIP-712 extractor from the original request instead of a dedicated runtime type.
	const enrichedTypedData = await extractEIP712Message(identify, typedData)
	const witnessValue = enrichedTypedData.message[witnessTypeField.name]
	if (witnessValue === undefined) throw new Error(`Permit2 witness field "${ witnessTypeField.name }" is missing from the message`)
	return { fieldName: witnessTypeField.name, typeName: witnessTypeField.type, value: witnessValue }
}

// The signed payload exactly as the website sent it, never a parsed form whose bigints would be re-encoded as hex, so the raw message view means the same for every message type.
const serializeSignedPayload = (signedPayload: unknown) => ({ stringifiedMessage: stringifyJSONWithBigInts(signedPayload, 4), rawMessage: stringifyJSONWithBigInts(signedPayload) })

export function getSigningQuarantineCodes(messageChainId: bigint | undefined, activeChainId: bigint, accountAddress: bigint, activeAddress: bigint, ownerAddress: bigint | undefined, additionalReasons: readonly string[] = []): { quarantine: boolean, quarantineReasons: readonly string[] } {
	const quarantineReasons = [...additionalReasons]
	if (messageChainId !== undefined && messageChainId !== activeChainId) quarantineReasons.push(`The signature request is for a different chain (${ getChainName(messageChainId) }) than what is currently active (${ getChainName(activeChainId) }).`)
	if (accountAddress !== activeAddress) quarantineReasons.push('The signature request is for an account that is different from your active address.')
	if (ownerAddress !== undefined && accountAddress !== ownerAddress) quarantineReasons.push('The account named in the message differs from the signing account.')
	return { quarantine: quarantineReasons.length > 0, quarantineReasons }
}

export const getSignedMessageActiveAddress = (signedMessageTransaction: SignedMessageTransaction) =>
	signedMessageTransaction.activeAddress ?? signedMessageTransaction.fakeSignedFor

export async function craftPersonalSignPopupMessage(identify: IdentifyAddress, signedMessageTransaction: SignedMessageTransaction, rpcNetwork: RpcNetwork): Promise<VisualizedPersonalSignRequest> {
	const activeAddressWithMetadata = await identify(getSignedMessageActiveAddress(signedMessageTransaction))
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
		const account = await identify(originalParams.originalRequestParameters.params[1])
		return {
			method: originalParams.originalRequestParameters.method,
			...basicParams,
			rpcNetwork,
			type: 'NotParsed' as const,
			message: stringifyJSONWithBigInts(originalParams.originalRequestParameters.params[0], 4),
			account,
			...getSigningQuarantineCodes(undefined, rpcNetwork.chainId, account.address, activeAddressWithMetadata.address, undefined),
			...serializeSignedPayload(originalParams.originalRequestParameters.params[0]),
			isValidMessage: isValid.valid,
			messageHash: undefined,
		}
	}

	if (originalParams.originalRequestParameters.method === 'personal_sign') {
		const account = await identify(originalParams.originalRequestParameters.params[1])
		const decodedMessage = decodePersonalSignMessage(originalParams.originalRequestParameters.params[0])
		const siweMessage = parseSiweMessage(decodedMessage)
		const personalSignParams = {
			method: originalParams.originalRequestParameters.method,
			...basicParams,
			rpcNetwork,
			account,
			rawMessage: originalParams.originalRequestParameters.params[0],
			isValidMessage: isValid.valid,
			messageHash: getMessageHashForPersonalSign(originalParams.originalRequestParameters),
		}
		if (siweMessage !== undefined) {
			return {
				...personalSignParams,
				type: 'SignInWithEthereum' as const,
				message: siweMessage,
				signInAccount: await identify(siweMessage.address),
				...getSigningQuarantineCodes(siweMessage.chainId, rpcNetwork.chainId, account.address, activeAddressWithMetadata.address, siweMessage.address, getSiweQuarantineReasons(siweMessage, signedMessageTransaction.requestOrigin)),
				stringifiedMessage: decodedMessage,
			}
		}
		return {
			...personalSignParams,
			type: 'NotParsed' as const,
			message: originalParams.originalRequestParameters.params[0],
			...getSigningQuarantineCodes(undefined, rpcNetwork.chainId, account.address, activeAddressWithMetadata.address, undefined, getSiweLookalikeQuarantineReasons(decodedMessage)),
			stringifiedMessage: stringifyJSONWithBigInts(originalParams.originalRequestParameters.params[0], 4),
		}
	}
	const namedParams = { param: originalParams.originalRequestParameters.params[1], account: originalParams.originalRequestParameters.params[0] }
	const account = await identify(namedParams.account)
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
			...serializeSignedPayload(namedParams.param),
			isValidMessage: isValid.valid,
			messageHash: undefined,
		}
	}

	if (maybeParsed.success === false) {
		const hashes = getMessageAndDomainHash(originalParams.originalRequestParameters)
		const safeMessage = SafeMessage.safeParse({ typedData: namedParams.param, review: signedMessageTransaction.safeMessageReview })
		// if we fail to parse the message, that means it's a message type we do not identify, let's just show it as a nonidentified EIP712 message
		if (validateEIP712Types(namedParams.param) === false) throw new Error('Not a valid EIP712 Message')
		const message = await extractEIP712Message(identify, namedParams.param)
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
			...serializeSignedPayload(namedParams.param),
			isValidMessage: isValid.valid,
			...hashes,
		}
	}
	const hashes = getMessageAndDomainHash(originalParams.originalRequestParameters)
	const parsed = maybeParsed.value
	switch (parsed.primaryType) {
		case 'Permit': {
			const token = await identifyPermitToken(identify, parsed.domain.verifyingContract)
			const owner = await identify(parsed.message.owner)
			return {
				method: originalParams.originalRequestParameters.method,
				...basicParams,
				rpcNetwork: rpcNetwork.chainId !== parsed.domain.chainId ? await getRpcNetworkForChain(parsed.domain.chainId) : rpcNetwork,
				type: 'Permit' as const,
				message: parsed,
				account,
				owner,
				spender: await identify(parsed.message.spender),
				verifyingContract: token,
				...getSigningQuarantineCodes(parsed.domain.chainId, rpcNetwork.chainId, account.address, activeAddressWithMetadata.address, owner.address),
				...serializeSignedPayload(namedParams.param),
				isValidMessage: isValid.valid,
				...hashes,
			}
		}
		case 'PermitSingle': {
			const token = await identifyPermitToken(identify, parsed.message.details.token)
			return {
				method: originalParams.originalRequestParameters.method,
				...basicParams,
				rpcNetwork: rpcNetwork.chainId !== parsed.domain.chainId ? await getRpcNetworkForChain(parsed.domain.chainId) : rpcNetwork,
				type: 'Permit2' as const,
				message: parsed,
				account,
				token: token,
				spender: await identify(parsed.message.spender),
				verifyingContract: await identify(parsed.domain.verifyingContract),
				...getSigningQuarantineCodes(parsed.domain.chainId, rpcNetwork.chainId, account.address, activeAddressWithMetadata.address, undefined),
				...serializeSignedPayload(namedParams.param),
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
			details: await promiseAllMapAbortSafe(parsed.message.details, async (details) => ({ ...details, token: await identifyPermitToken(identify, details.token) })),
			spender: await identify(parsed.message.spender),
			verifyingContract: await identify(parsed.domain.verifyingContract),
			...getSigningQuarantineCodes(parsed.domain.chainId, rpcNetwork.chainId, account.address, activeAddressWithMetadata.address, undefined),
			...serializeSignedPayload(namedParams.param),
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
				// `parsed` drops the witness and its struct types, so retain the full signing input.
				signedPayload: namedParams.param,
				isBatch: transferKind.isBatch,
				chainId: parsed.domain.chainId,
				nonce: parsed.message.nonce,
				deadline: parsed.message.deadline,
				account,
				permitted: await promiseAllMapAbortSafe(transferKind.permitted, async (permission) => ({ ...permission, token: await identifyPermitToken(identify, permission.token) })),
				spender: await identify(parsed.message.spender),
				verifyingContract: await identify(parsed.domain.verifyingContract),
				witness: await extractPermit2Witness(identify, namedParams.param, transferKind),
				...getSigningQuarantineCodes(parsed.domain.chainId, rpcNetwork.chainId, account.address, activeAddressWithMetadata.address, undefined),
				...serializeSignedPayload(namedParams.param),
				isValidMessage: isValid.valid,
				...hashes,
			}
		}
		case 'SafeTx': {
			const addresses = {
				to: await identify(parsed.message.to),
				gasToken: await identify(parsed.message.gasToken),
				refundReceiver: await identify(parsed.message.refundReceiver),
				verifyingContract: await identify(parsed.domain.verifyingContract),
			}
			const parsedMessageData = await parseInputData({ to: parsed.message.to, value: 0n, input: parsed.message.data }, identify)
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
				...serializeSignedPayload(namedParams.param),
				parsedMessageData,
				parsedMessageDataAddressBookEntries: await promiseAllMapAbortSafe(addressesInEventsAndInputData, (address) => identify(address)),
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
			message: await addMetadataToOpenSeaOrder(identify, parsed.message),
			account,
			...getSigningQuarantineCodes(parsed.domain.chainId, rpcNetwork.chainId, account.address, activeAddressWithMetadata.address, undefined),
			...serializeSignedPayload(namedParams.param),
			isValidMessage: isValid.valid,
			...hashes,
		}
		default: assertNever(parsed)
	}
}
