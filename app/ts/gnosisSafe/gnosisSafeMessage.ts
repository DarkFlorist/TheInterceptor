import { getGnosisSafeMessageDigest } from './gnosisSafeMessageData.js'
export { getGnosisSafeMessageDigest, parseGnosisSafeTypedMessage } from './gnosisSafeMessageData.js'
import { GnosisSafeMessageReview } from '../types/gnosisSafeReview.js'
import * as funtypes from 'funtypes'
import { EthereumAddress } from '../types/wire-types.js'
import { Eip712Number } from '../types/eip721.js'
import { encodeFunctionCall } from '../utils/abiRuntime.js'
import { bytesFromHex, bytesToHex, ensureHex } from '../utils/ethereumBytes.js'
import { JsonRpcResponseError } from '../utils/errors.js'
import { addressString } from '../utils/bigint.js'
import { hashTypedData, type Hex } from '../utils/ethereumPrimitives.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { createGnosisSafeContractValidationFailure, validateGnosisSafeOwnerIsEoa } from './gnosisSafeCore.js'

export const GNOSIS_SAFE_MESSAGE_ABI = [
	{ type: 'function', name: 'getMessageHash', stateMutability: 'view', inputs: [{ name: 'message', type: 'bytes' }], outputs: [{ name: 'messageHash', type: 'bytes32' }] },
	{ type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'signature', type: 'bytes' }], outputs: [{ name: 'magicValue', type: 'bytes4' }] },
] as const

const GnosisSafeMessageTypedData = funtypes.ReadonlyObject({
	types: funtypes.ReadonlyObject({
		SafeMessage: funtypes.ReadonlyTuple(funtypes.ReadonlyObject({ name: funtypes.Literal('message'), type: funtypes.Literal('bytes') })),
		EIP712Domain: funtypes.ReadonlyTuple(
			funtypes.ReadonlyObject({ name: funtypes.Literal('chainId'), type: funtypes.Literal('uint256') }),
			funtypes.ReadonlyObject({ name: funtypes.Literal('verifyingContract'), type: funtypes.Literal('address') }),
		),
	}),
	primaryType: funtypes.Literal('SafeMessage'),
	domain: funtypes.ReadonlyObject({ chainId: Eip712Number, verifyingContract: EthereumAddress }),
	message: funtypes.ReadonlyObject({ message: funtypes.String }),
})

export type GnosisSafeMessage = funtypes.Static<typeof GnosisSafeMessage>
export const GnosisSafeMessage = funtypes.ReadonlyObject({ typedData: GnosisSafeMessageTypedData, review: GnosisSafeMessageReview })
	.withConstraint(({ typedData, review }) => typedData.message.message === getGnosisSafeMessageDigest(review.text, review.isTypedData))

export function createGnosisSafeMessageTypedData(chainId: bigint, safeAddress: bigint, message: string, isTypedData = false) {
	return {
		types: {
			SafeMessage: [{ name: 'message', type: 'bytes' }],
			EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
		},
		primaryType: 'SafeMessage',
		domain: { chainId: chainId.toString(), verifyingContract: addressString(safeAddress) },
		message: { message: getGnosisSafeMessageDigest(message, isTypedData) },
	}
}

export async function validateGnosisSafeMessageForSigning(ethereum: EthereumClientService, safeAddress: bigint, owner: bigint, message: GnosisSafeMessage, expectedVersion?: string) {
	if (message.typedData.domain.chainId !== ethereum.getChainId() || message.typedData.domain.verifyingContract !== safeAddress) throw createGnosisSafeContractValidationFailure('The Gnosis Safe message is for a different account or chain.')
	const { snapshot, ownerValidator } = await validateGnosisSafeOwnerIsEoa(ethereum, safeAddress, owner)
	if (expectedVersion !== undefined && snapshot.state.version !== expectedVersion) throw createGnosisSafeContractValidationFailure('The Gnosis Safe version changed after this message was reviewed.')
	const typedData = createGnosisSafeMessageTypedData(message.typedData.domain.chainId, safeAddress, message.review.text, message.review.isTypedData)
	const signingHash = BigInt(hashTypedData(typedData))
	const contractHash = await callGnosisSafeMessageHandler(ethereum, safeAddress, encodeFunctionCall(GNOSIS_SAFE_MESSAGE_ABI, 'getMessageHash', [typedData.message.message]), snapshot.blockNumber)
	if (contractHash.length !== 32 || BigInt(bytesToHex(contractHash)) !== signingHash) throw createGnosisSafeContractValidationFailure('The locally computed Gnosis Safe message hash does not match the Gnosis Safe fallback handler.')
	return { typedData, signingHash, safeState: snapshot.state, ownerValidator }
}

async function callGnosisSafeMessageHandler(ethereum: EthereumClientService, safeAddress: bigint, input: Hex, blockNumber: bigint) {
	try {
		return await ethereum.call({ to: safeAddress, input: bytesFromHex(input) }, blockNumber, undefined)
	} catch (error) {
		if (error instanceof JsonRpcResponseError) throw createGnosisSafeContractValidationFailure(`The Gnosis Safe message fallback handler rejected this request: ${ error.message }`)
		throw error
	}
}

export async function assertGnosisSafeMessageSignatureValid(ethereum: EthereumClientService, safeAddress: bigint, message: string, signature: string, blockNumber: bigint, isTypedData = false) {
	const result = await callGnosisSafeMessageHandler(ethereum, safeAddress, encodeFunctionCall(GNOSIS_SAFE_MESSAGE_ABI, 'isValidSignature', [getGnosisSafeMessageDigest(message, isTypedData), ensureHex(signature, 'Gnosis Safe message signature')]), blockNumber)
	if (bytesToHex(result).slice(0, 10) !== '0x1626ba7e') throw createGnosisSafeContractValidationFailure('The Gnosis Safe fallback handler did not accept the collected message signatures.')
}
