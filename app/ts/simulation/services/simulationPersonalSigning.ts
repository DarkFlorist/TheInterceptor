import type { PersonalSignParams, SignMessageParams } from '../../types/jsonRpc-signing-types.js'
import type { SignedMessageTransaction } from '../../types/visualizer-types.js'
import type { EthereumAddress } from '../../types/wire-types.js'
import { bytes32String } from '../../utils/bigint.js'
import { hashMessage, hashTypedData, privateKeyToAccount } from '../../utils/ethereumPrimitives.js'
import { getMetaMaskPersonalSignMessageBytes } from '../../utils/personalSignMessage.js'
import { assertNever } from '../../utils/typescript.js'

const MOCK_PUBLIC_PRIVATE_KEY = 0x1n
const MOCK_SIMULATION_PRIVATE_KEY = 0x2n
const ADDRESS_FOR_PRIVATE_KEY_ONE = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdfn

// The bytes simulated personal_sign signs. The Interceptor signs these requests itself, so it reads every message one way, as MetaMask does, and the simulation-mode popup shows that same reading. Both the simulated signature and its message hash come from these bytes, so the hash always describes exactly what was signed. Stored messages carry no decoding version, so a signature handed out before this reading was adopted is rebuilt differently, and then recovers to the mock key's address, for the few messages the old reading signed differently: any two-character message such as '0x', '12' or 'hi', and digit strings or other forms that BigInt parsed. That is the limit: well-formed 0x hex reads the same, every other message failed to sign before, and simulated signatures are throwaway, so no version is kept.
const getSimulatedPersonalSignBytes = (message: string) => getMetaMaskPersonalSignMessageBytes(message)

const hashSimulatedPersonalSignMessage = (message: string) => hashMessage({ raw: getSimulatedPersonalSignBytes(message) })

export const getMessageHashForPersonalSign = (params: PersonalSignParams) => hashSimulatedPersonalSignMessage(params.params[0])

// Even-length hex with a 0x or 0X prefix, the only form whose signing decoding the signer lookup applies to a recovered message. Other messages match by their exact string or by MetaMask's reading, so recovering '12' keeps MetaMask's reading of it as text instead of finding a signing of the byte 0x12.
const isEvenLengthHexMessage = (message: string) => /^0[xX](?:[0-9a-fA-F]{2})*$/u.test(message)

// The hash simulated personal_sign signs for a hex message, decoded exactly as signing decodes it, or undefined when the message is not even-length hex.
export const getSimulatedPersonalSignHashOfHexMessage = (message: string) => isEvenLengthHexMessage(message) ? hashSimulatedPersonalSignMessage(message) : undefined

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

// The single definition of how a simulated signing maps to its signer: the simulation signs with a public mock key, and the resulting message hash and signature stand for the simulated signer. The ecRecover precompile override (EthereumClientService.getBlockStateCall) and personal_ecRecover both resolve simulated signatures through this, each applying its own choice of which signed messages to consider at its call site.
export const getSimulatedMessageSignature = async (signedMessage: Pick<SignedMessageTransaction, 'originalRequestParameters' | 'fakeSignedFor'>) => {
	const { messageHash, signature } = await simulatePersonalSign(signedMessage.originalRequestParameters, signedMessage.fakeSignedFor)
	return { messageHash, signature, signer: signedMessage.fakeSignedFor }
}
