import type { RPCReply } from '../types/interceptor-messages.js'
import type { PersonalEcRecover, RecoverableMessageSignature } from '../types/JsonRpc-types.js'
import type { SignedMessageTransaction } from '../types/visualizer-types.js'
import type { InterceptedRequest } from '../utils/requests.js'
import { JSON_RPC_ERROR_CODE_INVALID_PARAMS } from '../utils/constants.js'
import { hashMessage, recoverAddress, type Hex } from '../utils/ethereumPrimitives.js'
import { getPersonalEcRecoverMessageBytes } from '../utils/personalSignMessage.js'
import { findSimulatedPersonalSignSigner } from '../simulation/services/simulationPersonalSigning.js'

// The micro-eth-signer @noble/curves build throws these (including its 'infinify' typo) when caller-supplied r and s cannot be recovered: r or s outside 1..n-1, an r that is not a curve x-coordinate, or a recovery that lands on the point at infinity.
const UNRECOVERABLE_SIGNATURE_ERROR_PREFIXES = ['invalid signature r: ', 'invalid signature s: ', 'bad point: is not on curve', 'invalid recovery: point at infinify'] as const

const invalidPersonalEcRecoverRequest = (message: string): RPCReply => ({
	type: 'result',
	method: 'personal_ecRecover',
	error: { code: JSON_RPC_ERROR_CODE_INVALID_PARAMS, message },
})

export function getPersonalEcRecoverParseFailureReply(request: InterceptedRequest): RPCReply | undefined {
	if (request.method !== 'personal_ecRecover') return undefined
	return invalidPersonalEcRecoverRequest('Invalid personal_ecRecover parameters. Expected a message string and a 65 byte or 64 byte compact signature.')
}

const isUnrecoverableSignatureError = (error: unknown) => error instanceof Error && UNRECOVERABLE_SIGNATURE_ERROR_PREFIXES.some((prefix) => error.message.startsWith(prefix))

const recoverSigner = async (messageHash: Hex, signature: RecoverableMessageSignature) => {
	try {
		return BigInt(await recoverAddress({ hash: messageHash, signature }))
	} catch (error: unknown) {
		if (isUnrecoverableSignatureError(error)) return undefined
		throw error
	}
}

// Answered locally in every mode: recovery is pure computation. Signatures the simulation handed out for personal_sign resolve to their simulated signer instead of the mock signing key.
export async function personalEcRecover(request: PersonalEcRecover, simulatedSignedMessages: readonly SignedMessageTransaction[]): Promise<RPCReply> {
	const [message, signature] = request.params
	// The simulated signer lookup compares message hashes, so it matches whichever encoding the dapp uses for the bytes simulated personal_sign signed. Like MetaMask, personal_ecRecover('12', signature) hashes the text '12', so it does not match a personal_sign('12') signature, which signed the byte 0x12.
	const messageHash = hashMessage({ raw: getPersonalEcRecoverMessageBytes(message) })
	const signer = await findSimulatedPersonalSignSigner(simulatedSignedMessages, messageHash, signature) ?? await recoverSigner(messageHash, signature)
	if (signer === undefined) return invalidPersonalEcRecoverRequest('Invalid personal_ecRecover signature. The signature does not recover to any address.')
	return { type: 'result', method: request.method, result: signer }
}
