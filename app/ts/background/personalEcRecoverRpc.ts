import type { RPCReply } from '../types/interceptor-messages.js'
import { RecoverableMessageSignature, type PersonalEcRecover } from '../types/JsonRpc-types.js'
import type { SignedMessageTransaction } from '../types/visualizer-types.js'
import type { InterceptedRequest } from '../utils/requests.js'
import { JSON_RPC_ERROR_CODE_INVALID_PARAMS } from '../utils/constants.js'
import { hexOrUtf8StringToBytes } from '../utils/ethereumBytes.js'
import { hashMessage, type Hex } from '../utils/ethereumPrimitives.js'
import { tryRecoverAddress } from '../utils/ethereumRecovery.js'
import { getSimulatedMessageSignature } from '../simulation/services/simulationPersonalSigning.js'

const invalidPersonalEcRecoverRequest = (message: string): RPCReply => ({
	type: 'result',
	method: 'personal_ecRecover',
	error: { code: JSON_RPC_ERROR_CODE_INVALID_PARAMS, message },
})

export function getPersonalEcRecoverParseFailureReply(request: InterceptedRequest): RPCReply | undefined {
	if (request.method !== 'personal_ecRecover') return undefined
	return invalidPersonalEcRecoverRequest('Invalid personal_ecRecover parameters. Expected a message string and a 65 byte or 64 byte compact signature.')
}

// Recovery decodes its message like MetaMask's personal_ecRecover (eth-sig-util legacyToBuffer). This is deliberately separate from how simulated personal_sign decodes the message it signs: the simulated signer lookup compares this hash with the hash simulated signing reports for the bytes it actually signed, so the two decodings only have to agree on the bytes, not on how a string is written. Like MetaMask, personal_ecRecover('12', signature) hashes the text '12', so it does not match a personal_sign('12') signature, which signed the byte 0x12.
const hashPersonalEcRecoverMessage = (message: string) => hashMessage({ raw: hexOrUtf8StringToBytes(message) })

const recoverSigner = async (messageHash: Hex, signature: RecoverableMessageSignature) => {
	const recovery = await tryRecoverAddress({ hash: messageHash, signature })
	return recovery.type === 'recovered' ? BigInt(recovery.address) : undefined
}

const areSameSignatures = (first: RecoverableMessageSignature, second: RecoverableMessageSignature) => first.r === second.r && first.s === second.s && first.yParity === second.yParity

// Any page can compute a mock signature, so only messages the requesting website itself simulated-signed may resolve to a simulated signer, keeping other websites' signers hidden. For a Safe this signer is its simulation owner, validated against the Safe's public owner list, just as a real owner signature recovers to that owner; Safe signing mode's stack holds no messages, so its wallet-selected owner never reaches this lookup.
const getMessagesSignedForWebsite = (simulatedSignedMessages: readonly SignedMessageTransaction[], requestingWebsiteOrigin: string) => simulatedSignedMessages.filter((signedMessage) => signedMessage.website.websiteOrigin === requestingWebsiteOrigin)

const findSimulatedPersonalSignSigner = async (signedMessages: readonly SignedMessageTransaction[], messageHash: Hex, signature: RecoverableMessageSignature) => {
	// Newest first: one message signed for different simulated signers yields a single shared mock-key signature, so the most recent signing wins.
	for (const signedMessage of [...signedMessages].reverse()) {
		if (signedMessage.originalRequestParameters.method !== 'personal_sign') continue
		const simulatedSignature = await getSimulatedMessageSignature(signedMessage)
		// The hash simulated signing computed from the bytes it signed, so 'hello' and '0x68656c6c6f' both find a message stacked as '0x68656c6c6f'.
		if (simulatedSignature.messageHash !== messageHash) continue
		if (areSameSignatures(RecoverableMessageSignature.parse(simulatedSignature.signature), signature)) return simulatedSignature.signer
	}
	return undefined
}

// Answered locally in every mode: recovery is pure computation. Signatures the simulation handed out for personal_sign resolve to their simulated signer instead of the mock signing key, keeping the simulation consistent for the page: only messages on the simulation stack match, which the user put there by approving a simulated signing or importing a stack in the popup, and only for the website origin stored with the message; for an approved signing this repeats the signer the simulated personal_sign reply already gave that website. Anyone recovering the signature outside the Interceptor gets the public mock key address, so no real signature verification is affected.
export async function personalEcRecover(request: PersonalEcRecover, simulatedSignedMessages: readonly SignedMessageTransaction[], requestingWebsiteOrigin: string): Promise<RPCReply> {
	const [message, signature] = request.params
	const messageHash = hashPersonalEcRecoverMessage(message)
	const signer = await findSimulatedPersonalSignSigner(getMessagesSignedForWebsite(simulatedSignedMessages, requestingWebsiteOrigin), messageHash, signature) ?? await recoverSigner(messageHash, signature)
	if (signer === undefined) return invalidPersonalEcRecoverRequest('Invalid personal_ecRecover signature. The signature does not recover to any address.')
	return { type: 'result', method: request.method, result: signer }
}
