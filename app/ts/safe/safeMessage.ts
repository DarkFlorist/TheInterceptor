import * as funtypes from 'funtypes'
import { EthereumAddress } from '../types/wire-types.js'
import { Eip712Number } from '../types/eip721.js'
import { encodeFunctionCall } from '../utils/abiRuntime.js'
import { bytesFromHex, bytesToHex, ensureHex } from '../utils/ethereumBytes.js'
import { JsonRpcResponseError } from '../utils/errors.js'
import { addressString } from '../utils/bigint.js'
import { hashMessage, hashTypedData, type Hex } from '../utils/ethereumPrimitives.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { createSafeContractValidationFailure, validateSafeOwnerIsEoa } from './safeCore.js'

export const SAFE_MESSAGE_ABI = [
	{ type: 'function', name: 'getMessageHash', stateMutability: 'view', inputs: [{ name: 'message', type: 'bytes' }], outputs: [{ name: 'messageHash', type: 'bytes32' }] },
	{ type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'signature', type: 'bytes' }], outputs: [{ name: 'magicValue', type: 'bytes4' }] },
] as const

export type SafeMessage = funtypes.Static<typeof SafeMessage>
export const SafeMessage = funtypes.ReadonlyObject({
	types: funtypes.ReadonlyObject({
		SafeMessage: funtypes.ReadonlyTuple(funtypes.ReadonlyObject({ name: funtypes.Literal('message'), type: funtypes.Literal('bytes') })),
		EIP712Domain: funtypes.ReadonlyTuple(
			funtypes.ReadonlyObject({ name: funtypes.Literal('chainId'), type: funtypes.Literal('uint256') }),
			funtypes.ReadonlyObject({ name: funtypes.Literal('verifyingContract'), type: funtypes.Literal('address') }),
		),
	}),
	primaryType: funtypes.Literal('SafeMessage'),
	domain: funtypes.ReadonlyObject({ chainId: Eip712Number, verifyingContract: EthereumAddress }),
	// Review metadata is outside the signed fields and must match the signed message hash.
	safeMessageText: funtypes.String,
	message: funtypes.ReadonlyObject({ message: funtypes.String }),
}).withConstraint((value) => value.message.message === hashMessage(value.safeMessageText))

export function createSafeMessageTypedData(chainId: bigint, safeAddress: bigint, message: string) {
	return {
		types: {
			SafeMessage: [{ name: 'message', type: 'bytes' }],
			EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
		},
		primaryType: 'SafeMessage',
		domain: { chainId: chainId.toString(), verifyingContract: addressString(safeAddress) },
		safeMessageText: message,
		message: { message: hashMessage(message) },
	}
}

export async function validateSafeMessageForSigning(ethereum: EthereumClientService, safeAddress: bigint, owner: bigint, message: SafeMessage, expectedVersion?: string) {
	if (message.domain.chainId !== ethereum.getChainId() || message.domain.verifyingContract !== safeAddress) throw createSafeContractValidationFailure('The Safe message is for a different account or chain.')
	const { snapshot, ownerValidator } = await validateSafeOwnerIsEoa(ethereum, safeAddress, owner)
	if (expectedVersion !== undefined && snapshot.state.version !== expectedVersion) throw createSafeContractValidationFailure('The Safe version changed after this message was reviewed.')
	const typedData = createSafeMessageTypedData(message.domain.chainId, safeAddress, message.safeMessageText)
	const signingHash = BigInt(hashTypedData(typedData))
	const contractHash = await callSafeMessageHandler(ethereum, safeAddress, encodeFunctionCall(SAFE_MESSAGE_ABI, 'getMessageHash', [typedData.message.message]), snapshot.blockNumber)
	if (contractHash.length !== 32 || BigInt(bytesToHex(contractHash)) !== signingHash) throw createSafeContractValidationFailure('The locally computed Safe message hash does not match the Safe fallback handler.')
	return { typedData, signingHash, safeState: snapshot.state, ownerValidator }
}

async function callSafeMessageHandler(ethereum: EthereumClientService, safeAddress: bigint, input: Hex, blockNumber: bigint) {
	try {
		return await ethereum.call({ to: safeAddress, input: bytesFromHex(input) }, blockNumber, undefined)
	} catch (error) {
		if (error instanceof JsonRpcResponseError) throw createSafeContractValidationFailure(`The Safe message fallback handler rejected this request: ${ error.message }`)
		throw error
	}
}

export async function assertSafeMessageSignatureValid(ethereum: EthereumClientService, safeAddress: bigint, message: string, signature: string, blockNumber: bigint) {
	const result = await callSafeMessageHandler(ethereum, safeAddress, encodeFunctionCall(SAFE_MESSAGE_ABI, 'isValidSignature', [hashMessage(message), ensureHex(signature, 'Safe message signature')]), blockNumber)
	if (bytesToHex(result).slice(0, 10) !== '0x1626ba7e') throw createSafeContractValidationFailure('The Safe fallback handler did not accept the collected message signatures.')
}
