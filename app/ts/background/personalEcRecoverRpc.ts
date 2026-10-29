import type { RPCReply } from '../types/interceptor-messages.js'
import type { PersonalEcRecover, RecoverableMessageSignature } from '../types/JsonRpc-types.js'
import type { SignedMessageTransaction } from '../types/visualizer-types.js'
import type { InterceptedRequest } from '../utils/requests.js'
import { JSON_RPC_ERROR_CODE_INVALID_PARAMS } from '../utils/constants.js'
import { hashMessage, tryRecoverAddress, type Hex } from '../utils/ethereumPrimitives.js'
import { getPersonalEcRecoverMessageBytes } from '../utils/personalSignMessage.js'
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

const recoverSigner = async (messageHash: Hex, signature: RecoverableMessageSignature) => {
	const recovery = await tryRecoverAddress({ hash: messageHash, signature })
	return recovery.type === 'recovered' ? BigInt(recovery.address) : undefined
}

// Answered locally in every mode: recovery is pure computation. Signatures the simulation handed out for personal_sign resolve to their simulated signer instead of the mock signing key, keeping the simulation consistent for the page: only messages on the simulation stack match, which the user put there by approving a simulated signing or importing a stack in the popup, and only for the website origin stored with the message; for an approved signing this repeats the signer the simulated personal_sign reply already gave that website. Anyone recovering the signature outside the Interceptor gets the public mock key address, so no real signature verification is affected.
export async function personalEcRecover(request: PersonalEcRecover, simulatedSignedMessages: readonly SignedMessageTransaction[], requestingWebsiteOrigin: string): Promise<RPCReply> {
	const [message, signature] = request.params
	// The simulated signer lookup compares message hashes, so it matches whichever encoding the dapp uses for the bytes simulated personal_sign signed. Like MetaMask, personal_ecRecover('12', signature) hashes the text '12', so it does not match a personal_sign('12') signature, which signed the byte 0x12.
	const messageHash = hashMessage({ raw: getPersonalEcRecoverMessageBytes(message) })
	const signer = await findSimulatedPersonalSignSigner(simulatedSignedMessages, messageHash, signature, requestingWebsiteOrigin) ?? await recoverSigner(messageHash, signature)
	if (signer === undefined) return invalidPersonalEcRecoverRequest('Invalid personal_ecRecover signature. The signature does not recover to any address.')
	return { type: 'result', method: request.method, result: signer }
}
