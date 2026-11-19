import * as funtypes from 'funtypes'
import { EIP712Message, EIP712Types } from '../types/eip721.js'
import { isStackOverflowError } from '../utils/caughtErrors.js'
import { verifyEip712Message } from '../utils/eip712.js'
import { JSONEncodeableObject, isJSON } from '../utils/json.js'
import { hashMessage, hashTypedData } from '../utils/ethereumPrimitives.js'
import { createSafeValidationError } from './safeErrors.js'

const invalid = (message: string) => createSafeValidationError(message, 'safe_contract_validation')
const INVALID_SAFE_TYPED_DATA_MESSAGE = 'The Safe typed message is not valid EIP-712 data.'
const SafeTypedMessageFields = funtypes.ReadonlyObject({ types: EIP712Types, domain: JSONEncodeableObject, message: JSONEncodeableObject }).And(funtypes.ReadonlyPartial({ primaryType: funtypes.String }))

function parseSafeTypedMessageFields(message: string) {
	try {
		return SafeTypedMessageFields.safeParse(JSON.parse(message))
	} catch (error: unknown) {
		// The 100000 character limit on Safe Apps messages still allows about 49000 nesting levels.
		if (isStackOverflowError(error)) throw invalid(INVALID_SAFE_TYPED_DATA_MESSAGE)
		throw error
	}
}

export function parseSafeTypedMessage(message: string) {
	// Safe Apps permits omitting primaryType and EIP712Domain; normalize those before strict EIP-712 validation.
	if (!isJSON(message)) throw invalid('The Safe typed message is not valid JSON.')
	const input = parseSafeTypedMessageFields(message)
	if (!input.success) throw invalid(INVALID_SAFE_TYPED_DATA_MESSAGE)
	const { EIP712Domain } = input.value.types
	const domainFields = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }, { name: 'salt', type: 'bytes32' }]
	const types = { ...input.value.types, EIP712Domain: EIP712Domain ?? domainFields.filter(({ name }) => name in input.value.domain) }
	const referenced = new Set(Object.entries(types).filter(([name]) => name !== 'EIP712Domain').flatMap(([, fields]) => (fields ?? []).map(({ type }) => type.replace(/\[.*$/u, ''))))
	const roots = Object.keys(types).filter((name) => name !== 'EIP712Domain' && !referenced.has(name))
	const primaryType = input.value.primaryType ?? (roots.length === 1 ? roots[0] : undefined)
	if (primaryType === undefined) throw invalid('The Safe typed message requires an unambiguous primaryType.')
	const parsed = EIP712Message.safeParse(JSON.stringify({ ...input.value, types, primaryType }))
	if (!parsed.success) throw invalid(INVALID_SAFE_TYPED_DATA_MESSAGE)
	const valid = verifyEip712Message(parsed.value)
	if (!valid.valid) throw invalid(`Invalid Safe typed message: ${ valid.reason }`)
	return parsed.value
}

export function getSafeMessageDigest(message: string, isTypedData = false) {
	return isTypedData ? hashTypedData(parseSafeTypedMessage(message)) : hashMessage(message)
}
