import type { RPCReply } from '../types/interceptor-messages.js'
import { RecoverableMessageSignature, type PersonalEcRecover } from '../types/JsonRpc-types.js'
import type { SignedMessageTransaction } from '../types/visualizer-types.js'
import type { InterceptedRequest } from '../utils/requests.js'
import { JSON_RPC_ERROR_CODE_INVALID_PARAMS } from '../utils/constants.js'
import { hexOrUtf8StringToBytes } from '../utils/ethereumBytes.js'
import { hashMessage, type Hex } from '../utils/ethereumPrimitives.js'
import { tryRecoverAddress } from '../utils/ethereumRecovery.js'
import { findSimulatedPersonalSignSigner } from '../simulation/services/simulationPersonalSigning.js'

const invalidPersonalEcRecoverRequest = (message: string): RPCReply => ({
	type: 'result',
	method: 'personal_ecRecover',
	error: { code: JSON_RPC_ERROR_CODE_INVALID_PARAMS, message },
})

export function getPersonalEcRecoverParseFailureReply(request: InterceptedRequest): RPCReply | undefined {
	if (request.method !== 'personal_ecRecover') return undefined
	return invalidPersonalEcRecoverRequest('Invalid personal_ecRecover parameters. Expected a message string and a 65 byte or 64 byte compact signature.')
}

// Recovery decodes its message like MetaMask's personal_ecRecover (eth-sig-util legacyToBuffer), so it agrees with MetaMask on every signature the simulation did not produce.
const hashPersonalEcRecoverMessage = (message: string) => hashMessage({ raw: hexOrUtf8StringToBytes(message) })

const recoverSigner = async (messageHash: Hex, signature: RecoverableMessageSignature) => {
	const recovery = await tryRecoverAddress({ hash: messageHash, signature })
	return recovery.type === 'recovered' ? BigInt(recovery.address) : undefined
}

// Any page can compute a mock signature, so only messages the requesting website itself simulated-signed may resolve to a simulated signer, keeping other websites' signers hidden. For a Safe this signer is its simulation owner, validated against the Safe's public owner list, just as a real owner signature recovers to that owner; Safe signing mode's stack holds no messages, so its wallet-selected owner never reaches this lookup.
const getMessagesSignedForWebsite = (simulatedSignedMessages: readonly SignedMessageTransaction[], requestingWebsiteOrigin: string) => simulatedSignedMessages.filter((signedMessage) => signedMessage.website.websiteOrigin === requestingWebsiteOrigin)

// Generous for any real personal_sign message (1 MiB of hex-encoded bytes) and checked before any decoding or hashing, because a page reaches this handler without a confirmation dialog.
export const MAX_PERSONAL_EC_RECOVER_MESSAGE_LENGTH = 2 + 2 * 1024 * 1024

// Answered locally in every mode: recovery is pure computation. Signatures the simulation handed out for personal_sign resolve to their simulated signer instead of the mock signing key, keeping the simulation consistent for the page: only messages on the simulation stack match, which the user put there by approving a simulated signing or importing a stack in the popup, and only for the website origin stored with the message; for an approved signing this repeats the signer the simulated personal_sign reply already gave that website. Anyone recovering the signature outside the Interceptor gets the public mock key address, so no real signature verification is affected.
export async function personalEcRecover(request: PersonalEcRecover, simulatedSignedMessages: readonly SignedMessageTransaction[], requestingWebsiteOrigin: string): Promise<RPCReply> {
	const [message, signature] = request.params
	if (message.length > MAX_PERSONAL_EC_RECOVER_MESSAGE_LENGTH) return invalidPersonalEcRecoverRequest(`Invalid personal_ecRecover message. Messages longer than ${ MAX_PERSONAL_EC_RECOVER_MESSAGE_LENGTH } characters (1 MiB of hex-encoded bytes) are not supported.`)
	const messageHash = hashPersonalEcRecoverMessage(message)
	const websiteSignedMessages = getMessagesSignedForWebsite(simulatedSignedMessages, requestingWebsiteOrigin)
	// With nothing this website simulated-signed there is no simulated signer to find, so the lookup is skipped.
	const simulatedSigner = websiteSignedMessages.length === 0 ? undefined : await findSimulatedPersonalSignSigner(websiteSignedMessages, message, messageHash, signature)
	const signer = simulatedSigner ?? await recoverSigner(messageHash, signature)
	if (signer === undefined) return invalidPersonalEcRecoverRequest('Invalid personal_ecRecover signature. The signature does not recover to any address.')
	return { type: 'result', method: request.method, result: signer }
}
