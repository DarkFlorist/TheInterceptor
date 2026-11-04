import type { PersonalSignParams, SignMessageParams } from '../../types/jsonRpc-signing-types.js'
import type { SignedMessageTransaction } from '../../types/visualizer-types.js'
import type { EthereumAddress } from '../../types/wire-types.js'
import { bytes32String } from '../../utils/bigint.js'
import { bytesFromHex, isHexString, stringToBytes } from '../../utils/ethereumBytes.js'
import { hashMessage, hashTypedData, privateKeyToAccount } from '../../utils/ethereumPrimitives.js'
import { assertNever } from '../../utils/typescript.js'

const MOCK_PUBLIC_PRIVATE_KEY = 0x1n
const MOCK_SIMULATION_PRIVATE_KEY = 0x2n
const ADDRESS_FOR_PRIVATE_KEY_ONE = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdfn

// The one decoding of a personal_sign message string into the bytes that get signed, shared by simulated personal_sign and personal_ecRecover so a simulated signature is found again by its message hash. Decodes like MetaMask (eth-sig-util legacyToBuffer): a 0x-prefixed hex string is raw bytes, left-padded to whole bytes, and any other string is UTF-8 text.
const getPersonalSignMessageBytes = (message: string) => {
	if (!isHexString(message)) return stringToBytes(message)
	return bytesFromHex(message.length % 2 === 0 ? message : `0x0${ message.slice(2) }`)
}

export const hashPersonalSignMessage = (message: string) => hashMessage({ raw: getPersonalSignMessageBytes(message) })

export const getMessageHashForPersonalSign = (params: PersonalSignParams) => hashPersonalSignMessage(params.params[0])

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
			signature: await account.signMessage({ message: { raw: getPersonalSignMessageBytes(params.params[0]) } }),
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
