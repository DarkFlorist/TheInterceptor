import { EIP712Message, EIP712Types, Eip712Number } from '../types/eip721.js'
import { EthereumAddress, EthereumData } from '../types/wire-types.js'
import { String } from 'funtypes'
import { JSONEncodeableObject, typeJSONEncodeable } from './json.js'
import { SafeTx } from '../types/personal-message-definitions.js'
import { SignMessageParams, SignTypedDataParams } from '../types/jsonRpc-signing-types.js'
import { ethers } from 'ethers'
import { addressString } from './bigint.js'
import { assertNever, modifyObject } from './typescript.js'

type TypeDefinition = ({ name: string, type: string, primaryType: true } | { name: string, typeName: string, baseType: string, type: TypeDefinition[], primaryType: false })
type SolidityTypeTree = Record<string, TypeDefinition[]>

const isValidSolidityType = (type: string, validStructNames: readonly string[]): boolean => {
	const identifierPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/

	// Handle tuple types, e.g. tuple(uint256,MyStruct) or tuple(uint256,MyStruct)[]
	if (type.startsWith('tuple(')) return false

	// Handle arrays (e.g. MyType[2][], Custom[5][])
	const match = type.match(/^([^\[]+)(\[(?!0\])[0-9]*\](\[(?!0\])[0-9]*\])*)$/)
	if (match) {
		const base = match[1] // "array"
		const brackets = match[2] // "[][][]"
		// Remove first bracket set only
		if (base === undefined || brackets === undefined) return false
		const remaining = brackets.replace(/^(\[(?!0\])[0-9]*\])/, '')
		const innerType = base + remaining
		return isValidSolidityType(innerType, validStructNames)
	}

	// At this point, type is supposed to be an identifier
	if (!identifierPattern.test(type)) return false

	// Reject reserved-but-invalid type names, e.g. uint3, bytes33, fixed129x19, etc.
	if (isInvalidReservedType(type)) return false

	// If the type starts with a reserved built-in prefix,
	// then it is a built-in type and is valid
	if (/^(u?int|bytes|u?fixed|address|bool|string|function)/.test(type)) return true
	// Otherwise, it is a custom type; check if it is in the valid struct names list
	return validStructNames.includes(type)
}

const isInvalidReservedType = (type: string): boolean => {
	const validWidths = new Set(Array.from({ length: 32 }, (_, i) => ((i + 1) * 8).toString()))
	if (/^u?int[0-9]+$/.test(type)) {
		const width = type.match(/[0-9]+/)?.[0]
		return width !== undefined && !validWidths.has(width)
	}
	if (/^bytes[0-9]+$/.test(type)) {
		const size = parseInt(type.slice(5))
		return isNaN(size) || size < 1 || size > 32
	}
	if (/^u?fixed[0-9]+x[0-9]+$/.test(type)) {
		const nums = type.match(/[0-9]+/g)
		if (!Array.isArray(nums)) return true
		const mRaw = nums.at(0)
		const nRaw = nums.at(1)
		if (mRaw === undefined || nRaw === undefined) return true
		const m = parseInt(mRaw)
		const n = parseInt(nRaw)
		const mValid = validWidths.has(m.toString())
		const nValid = !isNaN(n) && n >= 0 && n <= 80
		return !(mValid && nValid)
	}
	const reserved = ['address', 'bool', 'string', 'function', 'bytes']
	if (reserved.includes(type)) return false
	if (/^(u?int|u?fixed)/.test(type)) return true
	return false
}

const validateTypeValue = (typeStr: string, value: typeJSONEncodeable, solidityTypeTree: SolidityTypeTree): { valid: true } | { valid: false, reason: string } => {
	// Check for tuple types e.g. tuple(uint256,MyStruct) or tuple(uint256,MyStruct)[]
	if (typeStr.startsWith('tuple(')) return { valid: false, reason: 'tuples are not supported'}

	// Check for array types (non-tuple arrays)
	const arrayMatch = typeStr.match(/^([^\[]+)(\[(?!0\])[0-9]*\](\[(?!0\])[0-9]*\])*)$/)
	if (arrayMatch) {
		const base = arrayMatch[1] // "array"
		const brackets = arrayMatch[2] // "[][][]"
		if (base === undefined || brackets === undefined) return { valid: false, reason: 'base or brackets were undefined'}
		const remaining = brackets.replace(/^(\[(?!0\])[0-9]*\])/, '')
		const innerType = base + remaining
		const arrayLength = (brackets: string | undefined) => {
			if (brackets === undefined) return undefined
			const lengthMatch = brackets.match(/\[(\d*)\]$/)
			return lengthMatch && lengthMatch[1] !== '' && lengthMatch[1] !== undefined ? parseInt(lengthMatch[1]) : undefined
		}
		const expectedLength = arrayLength(arrayMatch[2])
		if (!Array.isArray(value)) return { valid: false, reason: `invalid array: ${ JSON.stringify(value) }` }

		if (expectedLength !== undefined && value.length > expectedLength) return { valid: false, reason: `expected array of length ${ expectedLength }, got ${ value.length }` }
		for (const elem of value) {
			const valid = validateTypeValue(innerType, elem, solidityTypeTree)
			if (valid.valid === false) return valid
		}
		return { valid: true }
	}
	// Now typeStr is expected to be a primitive or custom type
	return validatePrimitiveOrStruct(typeStr, value, solidityTypeTree)
}

const getBaseType = (typeStr: string): string => typeStr.match(/^([^\[]+)/)?.[1] ?? typeStr

const validatePrimitiveOrStruct = (typeStr: string, value: typeJSONEncodeable, solidityTypeTree: SolidityTypeTree): { valid: true } | { valid: false, reason: string } => {
	const identifierPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/
	if (!identifierPattern.test(typeStr)) return { valid: false, reason: `invalid type: ${ typeStr }` }

	// Check for integer types, e.g. uint128 or int256
	const intRegex = /^(u?)int(\d+)$/
	const intMatch = typeStr.match(intRegex)
	if (intMatch) {
		// Use BigInt to check numeric ranges
		const isUnsigned = intMatch[1] === 'u'
		if (!intMatch[2]) return { valid: false, reason: `intMatch was undefined` }
		const bitWidth = parseInt(intMatch[2])
		// For unsigned: range is 0 to 2^width - 1
		// For signed: range is -2^(width-1) to 2^(width-1) - 1
		const min = isUnsigned ? 0n : -(2n ** BigInt(bitWidth - 1))
		const max = isUnsigned ? (2n ** BigInt(bitWidth)) - 1n : (2n ** BigInt(bitWidth - 1)) - 1n

		let bigValue: bigint
		if (typeof value === 'number') {
			if (!Number.isInteger(value)) return { valid: false, reason: `${ JSON.stringify(value) } wasn't integer` }
			bigValue = BigInt(value)
		} else if (typeof value === 'string') {
			const parsed = Eip712Number.safeParse(value) // todo, does the quantity need to be in hex format?
			if (!parsed.success) return { valid: false, reason: `${ JSON.stringify(value) } wasn't integer` }
			bigValue = parsed.value
		} else {
			return { valid: false, reason: `${ JSON.stringify(value) } wasn't integer` }
		}
		const valid = (bigValue >= min && bigValue <= max)
		return valid ? { valid: true } : { valid: false, reason: `${ JSON.stringify(value) } is out of bounds of ${ typeStr }` }
	}

	// Check for bytes types like bytes32
	const fixedBytesRegex = /^bytes(\d+)$/
	const fixedBytesMatch = typeStr.match(fixedBytesRegex)
	if (fixedBytesMatch) {
		if (!fixedBytesMatch[1]) return { valid: false, reason: 'not valid bytes' }
		const expectedSize = parseInt(fixedBytesMatch[1])
		// Value must be a hex string with 2 + 2*expectedSize characters (0x + hex digits)
		const valid = typeof value === 'string' && /^0x[a-fA-F0-9]*$/.test(value) && value.length === 2 + expectedSize * 2
		return valid ? { valid: true } : { valid: false, reason: `${ value } is invalid bytes string` }
	}

	// Check for bytes type
	const bytesRegex = /^bytes$/
	const bytesMatch = typeStr.match(bytesRegex)
	if (bytesMatch) {
		return typeof value === 'string' && /^0x[a-fA-F0-9]*$/.test(value) ? { valid: true } : { valid: false, reason: `${ value } is invalid bytes string` }
	}

	// Check for fixed point numbers (simplistic check)
	const fixedRegex = /^(u?)fixed(\d+)x(\d+)$/
	const fixedMatch = typeStr.match(fixedRegex)
	if (fixedMatch) {
		//todo, this is probably incorrect
		return typeof value === 'number' ? { valid: true} : { valid: false, reason: `${ value } is invalid fixed number` }
	}

	// Other built-in types
	if (typeStr === 'bool') return typeof value === 'boolean' ? { valid: true } : { valid: false, reason: `${ value } is not boolean` }
	if (typeStr === 'string') return typeof value === 'string' ? { valid: true } : { valid: false, reason: `${ value } is not string` }
	if (typeStr === 'address') return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value) ? { valid: true } : { valid: false, reason: `${ value } is not address` }
	if (typeStr === 'function') return { valid: false, reason: 'cannot decode function type' }

	// For custom struct types, the type must be in validStructNames and the value must be an object (but not an array or null)
	const typeTree = solidityTypeTree[typeStr]
	if (typeTree !== undefined) {
		if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			const entries = Object.entries(value)
			for (const [entryName, entryValue] of entries) {
				if (entryValue === undefined) return { valid: false, reason: 'entry is invalid' }
				const typeDefinition = typeTree.find((leaf) => leaf.name === entryName)
				if (typeDefinition === undefined) return { valid: false, reason: `did not find type for: ${ entryName }` }
				if (typeDefinition.primaryType) {
					const valid = validateTypeValue(typeDefinition.type, entryValue, {})
					if (valid.valid === false) return valid
				} else {
					const valid = validateTypeValue(typeDefinition.typeName, entryValue, { [typeDefinition.baseType]: typeDefinition.type })
					if (valid.valid === false) return valid
				}
			}
			return { valid: true }
		}
		return { valid: false, reason: `value ${ JSON.stringify(value) } not matching type object` }
	}

	// If typeStr starts with a reserved built-in prefix but wasn't caught by above rules, reject it
	if (/^(u?int|bytes|u?fixed|address|bool|string|function)/.test(typeStr)) return { valid: false, reason: `${ typeStr } is invalid type` }

	// Otherwise, unknown type: reject
	return { valid: false, reason: `type not recognized: ${ JSON.stringify(typeStr) }` }
}

const areNamesUnique = (items: readonly { name: string, type: string }[]): boolean => {
	const seen = new Set<string>()
	for (const item of items) {
		if (seen.has(item.name)) return false
		seen.add(item.name)
	}
	return true
}

const simplifyTypesToSolidityTypesOnly = (root: string, nonExtractedTypes: EIP712Types): { valid: true, tree: SolidityTypeTree } | { valid: false, reason: string } => {
	const structNames = Object.keys(nonExtractedTypes)
	let extracted: SolidityTypeTree = {}
	const subSimplifyTypesToSolidityTypes = (root: string, nonExtractedTypes: EIP712Types, depth: number): { valid: true, TypeDefinitionArray: TypeDefinition[] } | { valid: false, reason: string } => {
		if (depth > 10) return { valid: false, reason: 'stack too deep' }
		const rootType = nonExtractedTypes[root]
		const nonExtractedTypesArray = Object.entries(nonExtractedTypes)
		if (rootType === undefined) return { valid: false, reason: 'stack too deep' }
		if (!areNamesUnique(rootType)) return { valid: false, reason: 'not unique type names' }
		let extractedTypes: TypeDefinition[] = []
		for (const currentType of rootType) {
			if (!isValidSolidityType(currentType.type, structNames)) return { valid: false, reason: `unknown type: ${ currentType.type }` }
			const baseType = getBaseType(currentType.type)
			const struct = nonExtractedTypesArray.find(([typeName, _rest]) => typeName === baseType)
			if (struct === undefined) {
				extractedTypes.push({ name: currentType.name, type: currentType.type, primaryType: true })
				continue
			}
			const newRoot = struct[0]
			const existing = extracted[newRoot]
			if (existing !== undefined) {
				extractedTypes.push({ name: currentType.name, baseType: newRoot, typeName: currentType.type, type: existing, primaryType: false })
				continue
			}
			const simplified = subSimplifyTypesToSolidityTypes(newRoot, nonExtractedTypes, depth + 1)
			if (!simplified.valid) return simplified
			extractedTypes.push({ name: currentType.name, primaryType: false, baseType: newRoot, typeName: currentType.type, type: simplified.TypeDefinitionArray })
		}
		extracted[root] = extractedTypes
		return { valid: true, TypeDefinitionArray: extractedTypes }
	}
	const valid = subSimplifyTypesToSolidityTypes(root, nonExtractedTypes, 0)
	if (!valid.valid) return valid
	return { valid: true, tree: extracted }
}

export const verifyEip712Message = (maybeEip712Message: EIP712Message): { valid: true } | { valid: false, reason: string } => {
	if (Object.values(maybeEip712Message).length !== 4) return { valid: false, reason: `EIP712 message should only have 4 fields` }

	// EIP712Domain
	// todo, order is also enforced
	const validEIP712DomainEntries = [
		{ name: 'name', type: 'string' },
		{ name: 'version', type: 'string' },
		{ name: 'chainId', type: 'uint256' },
		{ name: 'verifyingContract', type: 'address' }
	]
	const eip712Domain = maybeEip712Message.types['EIP712Domain']
	if (eip712Domain === undefined) return { valid: false, reason: 'EIP712Domain does not exist' }

	for (const expectedEntry of validEIP712DomainEntries) {
		const entry = eip712Domain.find((entry) => entry.name === expectedEntry.name)
		if (entry !== undefined && entry.type !== expectedEntry.type) {
			return { valid: false, reason: `EIP712Domain type error: expected entry ${ expectedEntry.name } to be type ${ expectedEntry.type } but got type ${ entry.type }` }
		}
	}

	// domain matches its typing
	if ('chainId' in maybeEip712Message.domain && !Eip712Number.safeParse(maybeEip712Message.domain['chainId']).success) return { valid: false, reason: 'EIP712Domain.chainId is in wrong type' }
	if ('version' in maybeEip712Message.domain && !String.safeParse(maybeEip712Message.domain['version']).success) return { valid: false, reason: 'EIP712Domain.version is in wrong type' }
	if ('verifyingContract' in maybeEip712Message.domain && !EthereumAddress.safeParse(maybeEip712Message.domain['verifyingContract']).success) return { valid: false, reason: 'EIP712Domain.verifyingContract is in wrong type' }
	if ('name' in maybeEip712Message.domain && !String.safeParse(maybeEip712Message.domain['name']).success) return { valid: false, reason: 'EIP712Domain.name is in wrong type' }

	// domain fields exist in valid in types
	const domainArray = Object.entries(maybeEip712Message.domain)
	if (domainArray.some(([name, _value]) => !validEIP712DomainEntries.some((validEntry) => validEntry.name === name))) return { valid: false, reason: 'domain has a type that is not in EIP712Domain type' }

	const validateTypes = (message: JSONEncodeableObject, primaryType: string, types: EIP712Types): { valid: true } | { valid: false, reason: string } => {
		const extractedTypes = simplifyTypesToSolidityTypesOnly(primaryType, types)
		if (extractedTypes.valid === false) return extractedTypes
		const extractedPrimary = extractedTypes.tree[primaryType]
		if (extractedPrimary === undefined) return { valid: false, reason: 'Failed to extract primary type' }
		const fieldsArray = Object.entries(message)
		for (const field of fieldsArray) {
			if (field[0] === undefined) return { valid: false, reason: 'Field was invalid' }
			if (field[1] === undefined) return { valid: false, reason: 'Field was invalid' }
			const type = extractedPrimary.find((type) => type.name === field[0])
			if (type === undefined) return { valid: false, reason: `Failed to find type for ${ field[0] }` }
			if (type.primaryType) {
				const valid = validateTypeValue(type.type, field[1], {})
				if (valid.valid === false) return { valid: false, reason: `${ field[0] }: ${ JSON.stringify(field[1]) } is invalid: ${ valid.reason }` }
			} else {
				const valid = validateTypeValue(type.typeName, field[1], { [type.baseType]: type.type })
				if (valid.valid === false) return { valid: false, reason: `${ field[0] }: ${ JSON.stringify(field[1]) } is invalid ${ valid.reason }` }
			}
		}
		return { valid: true }
	}

	// validate domain
	const validDomain = validateTypes(maybeEip712Message.domain, 'EIP712Domain', maybeEip712Message.types)
	if (!validDomain.valid) return { valid: false, reason: `EIP712Domain was invalid: ${ validDomain.reason }` }
	// validate message
	const validMessage = validateTypes(maybeEip712Message.message, maybeEip712Message.primaryType, maybeEip712Message.types)
	if (!validMessage.valid) return { valid: false, reason: `Message was invalid: ${ validMessage.reason }` }
	return { valid: true }
}

export type SignatureWithFakeSignerAddress = { originalRequestParameters: SignMessageParams, fakeSignedFor: EthereumAddress }
export type MessageHashAndSignature = { signature: string, messageHash: string }

export const getSafeTxHash = (safeTx: SafeTx) => {
	const eip721SafeTxType = {
		SafeTx: [
			{ type: 'address', name: 'to' },
			{ type: 'uint256', name: 'value' },
			{ type: 'bytes', name: 'data' },
			{ type: 'uint8', name: 'operation' },
			{ type: 'uint256', name: 'safeTxGas' },
			{ type: 'uint256', name: 'baseGas' },
			{ type: 'uint256', name: 'gasPrice' },
			{ type: 'address', name: 'gasToken' },
			{ type: 'address', name: 'refundReceiver' },
			{ type: 'uint256', name: 'nonce' },
		],
	}
	const serializedMessage = {
		to: EthereumAddress.serialize(safeTx.message.to),
		value: safeTx.message.value,
		data: EthereumData.serialize(safeTx.message.data),
		operation: safeTx.message.operation,
		safeTxGas: safeTx.message.safeTxGas,
		baseGas: safeTx.message.baseGas,
		gasPrice: safeTx.message.gasPrice,
		gasToken: EthereumAddress.serialize(safeTx.message.gasToken),
		refundReceiver: EthereumAddress.serialize(safeTx.message.refundReceiver),
		nonce: safeTx.message.nonce
	}
	return ethers.TypedDataEncoder.hash({ verifyingContract: addressString(safeTx.domain.verifyingContract), chainId: safeTx.domain.chainId }, eip721SafeTxType, serializedMessage)
}

const extractPrimaryTypesUsedInMessage = (eip712Message: EIP712Message) => {
	const types = simplifyTypesToSolidityTypesOnly(eip712Message.primaryType, eip712Message.types)
	if (!types.valid) throw new Error('could not extract types')

	function pickKeys<T extends Record<string, any>, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
		const result = {} as Pick<T, K>
		for (const key of keys) {
			if (key in obj) {
				result[key] = obj[key]
			}
		}
		return result
	}

	const usedTypes = Object.keys(types.tree)
	return modifyObject(eip712Message, { types: pickKeys(eip712Message.types, usedTypes) })
}

export const getMessageAndDomainHash = (params: SignTypedDataParams) => {
	const { types, primaryType, domain, message } = params.params[1]
	if (!types[primaryType]) throw new Error('primary type missing from eip712 message')
	const domainHash = ethers.TypedDataEncoder.hashDomain(domain)
	const mutated = extractPrimaryTypesUsedInMessage(params.params[1])
	if (mutated === undefined) throw new Error('failed to extract primary types from eip712 message')
	const mutableTypes: Record<string, ethers.TypedDataField[]> = Object.fromEntries(Object.entries(mutated.types).map(([key, fields]) => [key, fields ? [...fields] : []]))
	const messageHash = ethers.TypedDataEncoder.from(mutableTypes).hash(message)
	return { messageHash, domainHash }
}

export const isValidMessage = (params: SignMessageParams): { valid: true} | { valid: false, reason: string } => {
	switch (params.method) {
		case 'eth_signTypedData': return { valid: false, reason: 'No support for eth_signTypedData' }
		case 'eth_signTypedData_v1':
		case 'eth_signTypedData_v2':
		case 'eth_signTypedData_v3':
		case 'eth_signTypedData_v4': return verifyEip712Message(params.params[1])
		case 'personal_sign': return { valid: true }
		default: assertNever(params)
	}
}
