import { hexToBytes } from '@noble/hashes/utils'
import { RecoverableMessageSignature } from '../../types/JsonRpc-types.js'
import type { PersonalSignParams, SignMessageParams } from '../../types/jsonRpc-signing-types.js'
import type { SignedMessageTransaction, SimulationStateInputBlock } from '../../types/visualizer-types.js'
import type { EthereumAddress } from '../../types/wire-types.js'
import { bytes32String, stringToUint8Array } from '../../utils/bigint.js'
import { hashMessage, hashTypedData, privateKeyToAccount, type Hex } from '../../utils/ethereumPrimitives.js'
import { assertNever } from '../../utils/typescript.js'

const MOCK_PUBLIC_PRIVATE_KEY = 0x1n
const MOCK_SIMULATION_PRIVATE_KEY = 0x2n
const ADDRESS_FOR_PRIVATE_KEY_ONE = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdfn

// Even-length hex with a 0x or 0X prefix. stringToUint8Array decodes it to its hex digits' bytes, but through a BigInt shifted once per byte, which is quadratic in the message length, so these messages are decoded directly instead.
const isEvenLengthHexMessage = (message: string) => /^0[xX](?:[0-9a-fA-F]{2})*$/u.test(message)

// The bytes simulated personal_sign signs, the same as on main: hex directly, and any other string through stringToUint8Array, whose BigInt string grammar and fractional byte lengths ('12' decodes to no bytes, '0x123' throws) are too irregular to restate. Both the simulated signature and its message hash come from these bytes.
const getSimulatedPersonalSignBytes = (message: string) => isEvenLengthHexMessage(message) ? hexToBytes(message.slice(2)) : stringToUint8Array(message)

const hashSimulatedPersonalSignMessage = (message: string) => hashMessage({ raw: getSimulatedPersonalSignBytes(message) })

export const getMessageHashForPersonalSign = (params: PersonalSignParams) => hashSimulatedPersonalSignMessage(params.params[0])

export const simulatePersonalSign = async (params: SignMessageParams, signingAddress: EthereumAddress) => {
	const account = privateKeyToAccount(bytes32String(signingAddress === ADDRESS_FOR_PRIVATE_KEY_ONE ? MOCK_PUBLIC_PRIVATE_KEY : MOCK_SIMULATION_PRIVATE_KEY))
	switch (params.method) {
		case 'eth_signTypedData': throw new Error('No support for eth_signTypedData')
		case 'eth_signTypedData_v1':
		case 'eth_signTypedData_v2':
		case 'eth_signTypedData_v3':
		case 'eth_signTypedData_v4': {
			const messageHash = hashTypedData(params.params[1])
			const signature = await account.signTypedData(params.params[1])
			return { signature, messageHash }
		}
		case 'personal_sign': return {
			signature: await account.signMessage({ message: { raw: getSimulatedPersonalSignBytes(params.params[0]) } }),
			messageHash: getMessageHashForPersonalSign(params)
		}
		default: assertNever(params)
	}
}

const areSameSignatures = (first: RecoverableMessageSignature, second: RecoverableMessageSignature) => first.r === second.r && first.s === second.s && first.yParity === second.yParity

// The simulated signer whose personal_sign produced this signature over what a personal_ecRecover message names. A signing matches the same message string, which it decoded exactly as it would decode this one; the same hex bytes under its own decoding, which reads '0X6869' as 0x6869; or recoveredMessageHash, the hash of the bytes the caller's decoding gives, so 'hello' finds a signing of '0x68656c6c6f'. Non-hex messages are compared only as strings, never decoded here.
export const findSimulatedPersonalSignSigner = async (signedMessages: readonly SignedMessageTransaction[], message: string, recoveredMessageHash: Hex, signature: RecoverableMessageSignature) => {
	const hexMessageHash = isEvenLengthHexMessage(message) ? hashSimulatedPersonalSignMessage(message) : undefined
	// Newest first: one message signed for different simulated signers yields a single shared mock-key signature, so the most recent signing wins.
	for (const signedMessage of [...signedMessages].reverse()) {
		if (signedMessage.originalRequestParameters.method !== 'personal_sign') continue
		const simulatedSignature = await getSimulatedMessageSignature(signedMessage)
		const signsMessage = signedMessage.originalRequestParameters.params[0] === message || simulatedSignature.messageHash === hexMessageHash || simulatedSignature.messageHash === recoveredMessageHash
		if (signsMessage && areSameSignatures(RecoverableMessageSignature.parse(simulatedSignature.signature), signature)) return simulatedSignature.signer
	}
	return undefined
}

// How a simulation's blocks give their signed messages, shared by the ecRecover precompile override (one block at a time) and personal_ecRecover (across the stack) so both read the same messages.
export const getSignedMessagesOfBlocks = (blocks: readonly Pick<SimulationStateInputBlock, 'signedMessages'>[]) => blocks.flatMap((block) => block.signedMessages)

// The single definition of how a simulated signing maps to its signer: the simulation signs with a public mock key, and the resulting message hash and signature stand for the simulated signer. The ecRecover precompile override (EthereumClientService.getBlockStateCall) and personal_ecRecover both resolve simulated signatures through this, each applying its own choice of which signed messages to consider at its call site.
export const getSimulatedMessageSignature = async (signedMessage: Pick<SignedMessageTransaction, 'originalRequestParameters' | 'fakeSignedFor'>) => {
	const { messageHash, signature } = await simulatePersonalSign(signedMessage.originalRequestParameters, signedMessage.fakeSignedFor)
	return { messageHash, signature, signer: signedMessage.fakeSignedFor }
}
