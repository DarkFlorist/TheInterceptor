import * as funtypes from 'funtypes'
import { EthereumAddress } from '../types/wire-types.js'
import { EIP712Message, Eip712Number, EIP712Types } from '../types/eip721.js'
import { encodeFunctionCall } from '../utils/abiRuntime.js'
import { bytesFromHex, bytesToHex, ensureHex } from '../utils/ethereumBytes.js'
import { JsonRpcResponseError } from '../utils/errors.js'
import { verifyEip712Message } from '../utils/eip712.js'
import { JSONEncodeableObject, isJSON } from '../utils/json.js'
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
}).And(funtypes.ReadonlyPartial({ safeMessageIsTypedData: funtypes.Boolean })).withConstraint((value) => value.message.message === getSafeMessageDigest(value.safeMessageText, value.safeMessageIsTypedData))

export function parseSafeTypedMessage(message: string) {
	// Safe Apps permits omitting primaryType and EIP712Domain; normalize those before strict EIP-712 validation.
	if (!isJSON(message)) throw createSafeContractValidationFailure('The Safe typed message is not valid JSON.')
	const input = funtypes.ReadonlyObject({ types: EIP712Types, domain: JSONEncodeableObject, message: JSONEncodeableObject }).And(funtypes.ReadonlyPartial({ primaryType: funtypes.String })).safeParse(JSON.parse(message))
	if (!input.success) throw createSafeContractValidationFailure('The Safe typed message is not valid EIP-712 data.')
	const { EIP712Domain } = input.value.types
	const domainFields = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }, { name: 'salt', type: 'bytes32' }]
	const types = { ...input.value.types, EIP712Domain: EIP712Domain ?? domainFields.filter(({ name }) => name in input.value.domain) }
	const referenced = new Set(Object.entries(types).filter(([name]) => name !== 'EIP712Domain').flatMap(([, fields]) => (fields ?? []).map(({ type }) => type.replace(/\[.*$/u, ''))))
	const roots = Object.keys(types).filter((name) => name !== 'EIP712Domain' && !referenced.has(name))
	const primaryType = input.value.primaryType ?? (roots.length === 1 ? roots[0] : undefined)
	if (primaryType === undefined) throw createSafeContractValidationFailure('The Safe typed message requires an unambiguous primaryType.')
	const parsed = EIP712Message.safeParse(JSON.stringify({ ...input.value, types, primaryType }))
	if (!parsed.success) throw createSafeContractValidationFailure('The Safe typed message is not valid EIP-712 data.')
	const valid = verifyEip712Message(parsed.value)
	if (!valid.valid) throw createSafeContractValidationFailure(`Invalid Safe typed message: ${ valid.reason }`)
	return parsed.value
}

export function getSafeMessageDigest(message: string, isTypedData = false) {
	return isTypedData ? hashTypedData(parseSafeTypedMessage(message)) : hashMessage(message)
}

export function createSafeMessageTypedData(chainId: bigint, safeAddress: bigint, message: string, isTypedData = false) {
	return {
		types: {
			SafeMessage: [{ name: 'message', type: 'bytes' }],
			EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
		},
		primaryType: 'SafeMessage',
		domain: { chainId: chainId.toString(), verifyingContract: addressString(safeAddress) },
		safeMessageText: message,
		...(isTypedData ? { safeMessageIsTypedData: true } : {}),
		message: { message: getSafeMessageDigest(message, isTypedData) },
	}
}

export async function validateSafeMessageForSigning(ethereum: EthereumClientService, safeAddress: bigint, owner: bigint, message: SafeMessage, expectedVersion?: string) {
	if (message.domain.chainId !== ethereum.getChainId() || message.domain.verifyingContract !== safeAddress) throw createSafeContractValidationFailure('The Safe message is for a different account or chain.')
	const { snapshot, ownerValidator } = await validateSafeOwnerIsEoa(ethereum, safeAddress, owner)
	if (expectedVersion !== undefined && snapshot.state.version !== expectedVersion) throw createSafeContractValidationFailure('The Safe version changed after this message was reviewed.')
	const typedData = createSafeMessageTypedData(message.domain.chainId, safeAddress, message.safeMessageText, message.safeMessageIsTypedData)
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

export async function assertSafeMessageSignatureValid(ethereum: EthereumClientService, safeAddress: bigint, message: string, signature: string, blockNumber: bigint, isTypedData = false) {
	const result = await callSafeMessageHandler(ethereum, safeAddress, encodeFunctionCall(SAFE_MESSAGE_ABI, 'isValidSignature', [getSafeMessageDigest(message, isTypedData), ensureHex(signature, 'Safe message signature')]), blockNumber)
	if (bytesToHex(result).slice(0, 10) !== '0x1626ba7e') throw createSafeContractValidationFailure('The Safe fallback handler did not accept the collected message signatures.')
}
