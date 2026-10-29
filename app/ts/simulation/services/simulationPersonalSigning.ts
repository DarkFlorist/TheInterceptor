import type { PersonalSignParams, SignMessageParams } from '../../types/jsonRpc-signing-types.js'
import { RecoverableMessageSignature } from '../../types/JsonRpc-types.js'
import type { SignedMessageTransaction } from '../../types/visualizer-types.js'
import type { EthereumAddress } from '../../types/wire-types.js'
import { bytes32String } from '../../utils/bigint.js'
import { hashMessage, hashTypedData, privateKeyToAccount } from '../../utils/ethereumPrimitives.js'
import { getMetaMaskPersonalSignMessageBytes } from '../../utils/personalSignMessage.js'
import { assertNever } from '../../utils/typescript.js'

const MOCK_PUBLIC_PRIVATE_KEY = 0x1n
const MOCK_SIMULATION_PRIVATE_KEY = 0x2n
const ADDRESS_FOR_PRIVATE_KEY_ONE = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdfn

// The Interceptor signs simulated personal_sign requests itself, so it reads every message one way, as MetaMask does, and the simulation-mode popup shows that same reading.
export const getMessageHashForPersonalSign = (params: PersonalSignParams) => hashMessage({ raw: getMetaMaskPersonalSignMessageBytes(params.params[0]) })

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
			signature: await account.signMessage({ message: { raw: getMetaMaskPersonalSignMessageBytes(params.params[0]) } }),
			messageHash: getMessageHashForPersonalSign(params)
		}
		default: assertNever(params)
	}
}

const areSameSignatures = (first: RecoverableMessageSignature, second: RecoverableMessageSignature) => first.r === second.r && first.s === second.s && first.yParity === second.yParity

// Simulated personal_sign replies are signed with public mock keys, so recovery resolves them to the simulated signer like the simulation's ecRecover precompile override does. Any page can compute a mock signature, so only messages the requesting website itself simulated-signed match, keeping other websites' signers hidden. For a Safe this signer is its simulation owner, validated against the Safe's public owner list, just as a real owner signature recovers to that owner; Safe signing mode's stack holds no messages, so its wallet-selected owner never reaches this lookup.
export const findSimulatedPersonalSignSigner = async (signedMessages: readonly SignedMessageTransaction[], messageHash: string, signature: RecoverableMessageSignature, requestingWebsiteOrigin: string) => {
	// Newest first: one message signed for different simulated signers yields a single shared mock-key signature, so the most recent signing wins.
	for (const signedMessage of [...signedMessages].reverse()) {
		const signRequest = signedMessage.originalRequestParameters
		if (signedMessage.website.websiteOrigin !== requestingWebsiteOrigin) continue
		// Compares hashes of the signed bytes, so personal_ecRecover's reading of its message string only has to agree with personal_sign's on which bytes were signed, not on how the strings are written.
		if (signRequest.method !== 'personal_sign' || getMessageHashForPersonalSign(signRequest) !== messageHash) continue
		const simulatedSignature = RecoverableMessageSignature.parse((await simulatePersonalSign(signRequest, signedMessage.fakeSignedFor)).signature)
		if (areSameSignatures(simulatedSignature, signature)) return signedMessage.fakeSignedFor
	}
	return undefined
}
