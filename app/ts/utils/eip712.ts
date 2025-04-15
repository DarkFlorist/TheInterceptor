import { EIP712Message, EIP712Types } from '../types/eip721.js'
import { EthereumAddress, EthereumData, EthereumQuantity } from '../types/wire-types.js'
import { String } from 'funtypes'
import { JSONEncodeableObject, typeJSONEncodeable } from './json.js'
import { SafeTx } from '../types/personal-message-definitions.js'
import { SignMessageParams, SignTypedDataParams } from '../types/jsonRpc-signing-types.js'
import { ethers } from 'ethers'
import { addressString } from './bigint.js'
import { modifyObject } from './typescript.js'

// todo, SolidityType here should include arrays, fixed length arrays etc
type CompleteBasicSolidityType = string//SolidityType
type TypeField = ({ name: string, type: CompleteBasicSolidityType, primaryType: true } | { name: string, type: TypeField[], primaryType: false })
type SolidityTypeTree = Record<string, TypeField[]>

const isValidSolidityType = (type: string, validStructNames: readonly string[]): boolean => {
	const identifierPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/
	const arraySuffixPattern = /^(\[(?!0\])[0-9]*\])*$/  // valid: [], [1], [2][]; invalid: [0]

	// Handle tuple types, e.g. tuple(uint256,MyStruct) or tuple(uint256,MyStruct)[]
	if (type.startsWith('tuple(')) {
		const match = type.match(/^tuple\((.*)\)(\[(?!0\])[0-9]*\])*$/)
		if (!match) return false
		const inner = match[1]
		if (!inner) return false
		const components = splitTupleComponents(inner)
		if (components.length === 0) return false
		return components.every(c => isValidSolidityType(c.trim(), validStructNames))
	}

	// Handle arrays (e.g. MyType[2][], Custom[5][])
	const arrayMatch = type.match(/^([^\[]+)((\[(?!0\])[0-9]*\])*)$/)
	if (arrayMatch) {
		const base = arrayMatch[1]
		const suffix = arrayMatch[2]
		if (base === undefined || suffix === undefined) return false
		if (!arraySuffixPattern.test(suffix)) return false
		return isValidSolidityType(base, validStructNames)
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
	const reserved = ['address', 'bool', 'string', 'function']
	if (reserved.includes(type)) return false
	if (/^(u?int|bytes|u?fixed)/.test(type)) return true
	return false
}

const splitTupleComponents = (input: string): string[] => {
	const recurse = (remaining: string, acc: string[], current: string, depth: number): string[] => {
		if (remaining.length === 0) return [...acc, current].filter(s => s.trim() !== '')
		const char = remaining[0]
		const rest = remaining.slice(1)
		const nextDepth = char === '(' ? depth + 1 : char === ')' ? depth - 1 : depth
		if (char === ',' && depth === 0) return recurse(rest, [...acc, current], '', nextDepth)
		return recurse(rest, acc, current + char, nextDepth)
	}
	return recurse(input, [], '', 0)
}

const validateTypeValue = (typeStr: string, value: typeJSONEncodeable, solidityTypeTree: SolidityTypeTree): boolean => {
	// Check for tuple types e.g. tuple(uint256,MyStruct) or tuple(uint256,MyStruct)[]
	if (typeStr.startsWith('tuple(')) {
		const tupleRegex = /^tuple\((.*)\)(\[(?!0\])[0-9]*\])*$/
		const match = typeStr.match(tupleRegex)
		if (!match) return false
		const inner = match[1]
		if (!inner) return false
		const arraySuffix = match[2] || ''
		const components = splitTupleComponents(inner)
		if (components.length === 0) return false

		// Without an array suffix the value must be an array of the same length as the tuple components
		if (arraySuffix === '') {
			if (!Array.isArray(value)) return false
			if (value.length !== components.length) return false
			return value.every((v, i) => {
				const component = components[i]
				if (component === undefined) return false
				return validateTypeValue(component.trim(), v, solidityTypeTree)
			})
		}
		// With an array suffix, value is an array of tuple values
		else {
			if (!Array.isArray(value)) return false
			// Validate each element against the base tuple type (without the array suffix)
			const baseTupleType = `tuple(${inner})`
			return value.every(elem => validateTypeValue(baseTupleType, elem, solidityTypeTree))
		}
	}

	// Check for array types (non-tuple arrays)
	const arrayRegex = /^([^\[]+)((\[(?!0\])[0-9]*\])+)$/
	const arrayMatch = typeStr.match(arrayRegex)
	if (arrayMatch) {
		const baseType = arrayMatch[1]
		if (!Array.isArray(value)) return false
		if (baseType === undefined) return false
		return value.every(elem => validateTypeValue(baseType, elem, solidityTypeTree))
	}

	// Now typeStr is expected to be a primitive or custom type
	return validatePrimitiveOrStruct(typeStr, value, solidityTypeTree)
}

const validatePrimitiveOrStruct = (typeStr: string, value: typeJSONEncodeable, solidityTypeTree: SolidityTypeTree): boolean => {
	const identifierPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/
	if (!identifierPattern.test(typeStr)) return false

	// Check for integer types, e.g. uint128 or int256
	const intRegex = /^(u?)int(\d+)$/
	const intMatch = typeStr.match(intRegex)
	if (intMatch) {
		// Use BigInt to check numeric ranges
		const isUnsigned = intMatch[1] === 'u'
		if (!intMatch[2]) return false
		const bitWidth = parseInt(intMatch[2])
		// For unsigned: range is 0 to 2^width - 1
		// For signed: range is -2^(width-1) to 2^(width-1) - 1
		const min = isUnsigned ? 0n : -(2n ** BigInt(bitWidth - 1))
		const max = isUnsigned ? (2n ** BigInt(bitWidth)) - 1n : (2n ** BigInt(bitWidth - 1)) - 1n

		let bigValue: bigint
		if (typeof value === 'number') {
			if (!Number.isInteger(value)) return false
			bigValue = BigInt(value)
		} else if (typeof value === 'string') {
			const parsed = EthereumQuantity.safeParse(value) // todo, does the quantity need to be in hex format?
			if (!parsed.success) return false
			bigValue = parsed.value
		} else {
			return false
		}
		return (bigValue >= min && bigValue <= max)
	}

	// Check for bytes types like bytes32
	const bytesRegex = /^bytes(\d+)$/
	const bytesMatch = typeStr.match(bytesRegex)
	if (bytesMatch) {
		if (!bytesMatch[1]) return false
		const expectedSize = parseInt(bytesMatch[1])
		// Value must be a hex string with 2 + 2*expectedSize characters (0x + hex digits)
		return typeof value === 'string' && /^0x[a-fA-F0-9]+$/.test(value) && value.length === 2 + expectedSize * 2
	}

	// Check for fixed point numbers (simplistic check)
	const fixedRegex = /^(u?)fixed(\d+)x(\d+)$/
	const fixedMatch = typeStr.match(fixedRegex)
	if (fixedMatch) return typeof value === 'number' //todo, this is probably incorrect

	// Other built-in types
	if (typeStr === 'bool') return typeof value === 'boolean'
	if (typeStr === 'string') return typeof value === 'string'
	if (typeStr === 'address') return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value)
	if (typeStr === 'function') return false // cannot be decoded

	// TODO, verify struct
	// For custom struct types, the type must be in validStructNames and the value must be an object (but not an array or null)
	const typeTree = solidityTypeTree[typeStr]
	if (typeTree !== undefined) {
		if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			const entries = Object.entries(value)
			for (const [entryName, entryValue] of entries) {
				if (entryValue === undefined) return false
				const typeDefinition = typeTree.find((leaf) => leaf.name === entryName)
				if (typeDefinition === undefined) return false
				if (typeDefinition.primaryType) {
					if (!validatePrimitiveOrStruct(typeDefinition.type, entryValue, {})) return false
				} else {
					if (!validatePrimitiveOrStruct(typeDefinition.name, entryValue, { [typeDefinition.name]: typeDefinition.type })) return false
				}
			}
		}
	}

	// If typeStr starts with a reserved built-in prefix but wasn't caught by above rules, reject it
	if (/^(u?int|bytes|u?fixed|address|bool|string|function)/.test(typeStr)) return false

	// Otherwise, unknown type: reject
	return false
}

/*
const separateArraySuffix = (typeWithMaybeArraySuffix: string) => {
	const splitted = typeWithMaybeArraySuffix.split('[]')
	if (splitted.length === 1) return { arraylessType: typeWithMaybeArraySuffix, isArray: false }
	var matches = typeWithMaybeArraySuffix.match(/\[(.*?)\]/)
	if (matches) {
		var submatch = matches[1]
		const parsed = Number.safeParse(submatch)
		if (!parsed.success) throw new Error('was not a number')
		if (parsed.value <= 0) throw new Error('was negative or zero')
		return { arraylessType: splitted[0], isArray: true, arrayLength: parsed.value }
	}
	return { arraylessType: splitted[0], isArray: true }
}*/

export const verifyEip712Message = (maybeEip712Message: EIP712Message): { valid: true } | { valid: false, reason: string } => {
	const areNamesUnique = (items: readonly { name: string, type: string }[]): boolean => {
		const seen = new Set<string>()
		for (const item of items) {
			if (seen.has(item.name)) return false
			seen.add(item.name)
		}
		return true
	}
	/*
	const sortByName = (items: readonly { name: string, type: string }[]): { name: string, type: string }[] => {
		return [...items].sort((a, b) => {
			if (a.name < b.name) return -1
			if (a.name > b.name) return 1
			return 0
		})
	}*/

	// unique types
	const primaryTypes = maybeEip712Message.types[maybeEip712Message.primaryType]
	if (primaryTypes == undefined) return { valid: false, reason: 'missing primary type' }
	const typesArray = Object.entries(maybeEip712Message.types)
	if (typesArray.some(([_name, type]) => type === undefined || !areNamesUnique(type))) return { valid: false, reason: 'types were not unique' }
	if (areNamesUnique(primaryTypes)) return { valid: false, reason: 'types are not unique' }

	// EIP712Domain
	const validEIP712DomainEntries = [
		{ name: 'name', type: 'string' },
		{ name: 'version', type: 'string' },
		{ name: 'chainId', type: 'uint256' },
		{ name: 'verifyingContract', type: 'address' }
	]
	const eip712Domain = maybeEip712Message.types['EIP712Domain']
	if (eip712Domain === undefined) return { valid: false, reason: 'EIP712Domain doesn not exist' }

	if (validEIP712DomainEntries.some((expectedEntry) => !eip712Domain.some((entry) => entry.name === expectedEntry.name && entry.type === expectedEntry.type))) return { valid: false, reason: 'EIP712Domain type error' }

	// domain matches its typing
	if (!('chainId' in maybeEip712Message.domain && EthereumQuantity.safeParse(maybeEip712Message.domain['chainId']).success)
		|| !('name' in maybeEip712Message.domain && !String.safeParse(maybeEip712Message.domain['name']).success)
		|| !('version' in maybeEip712Message.domain && !String.safeParse(maybeEip712Message.domain['version']).success)
		|| !('verifyingContract' in maybeEip712Message.domain && !EthereumAddress.safeParse(maybeEip712Message.domain['verifyingContract']).success)
	) return { valid: false, reason: 'EIP712Domain types are wrong' }

	// domain fields exist in valid in types
	const domainArray = Object.entries(maybeEip712Message.domain)
	if (domainArray.some(([name, _value]) => !validEIP712DomainEntries.some((validEntry) => validEntry.name === name))) return { valid: false, reason: 'domain has a type that is not in EIP712Domain type' }

	//todo, change throws to types
	const simplifyTypesToSolidityTypesOnly = (root: string, nonExtractedTypes: EIP712Types): SolidityTypeTree => {
		const structNames = Object.keys(nonExtractedTypes)
		let extracted: SolidityTypeTree = {}
		const subSimplifyTypesToSolidityTypes = (root: string, nonExtractedTypes: EIP712Types, depth: number): TypeField[] => {
			if (depth > 10) throw new Error('too deep')
			const rootType = nonExtractedTypes[root]
			const nonExtractedTypesArray = Object.entries(nonExtractedTypes)
			if (rootType === undefined) throw new Error('root type missing')
			const extractedTypes: TypeField[] = rootType.map((currentType) => {
				if (!isValidSolidityType(currentType.type, structNames)) throw new Error(`not valid solidityType: ${currentType}`)
				const struct = nonExtractedTypesArray.find(([typeName, _rest]) => currentType.type === typeName)
				if (struct === undefined) return { name: currentType.name, type: currentType.type, primaryType: true } as { name: string, primaryType: true, type: CompleteBasicSolidityType } // TODO FIX, validate
				const existing = extracted[struct[0]]
				if (existing !== undefined) return { name: currentType.name, type: existing, primaryType: false }
				return { name: currentType.name, primaryType: false, type: subSimplifyTypesToSolidityTypes(struct[0], nonExtractedTypes, depth + 1) }
			})
			extracted[root] = extractedTypes
			return extractedTypes
		}
		subSimplifyTypesToSolidityTypes(root, nonExtractedTypes, 0)
		return extracted
	}

	const validateTypes = (message: JSONEncodeableObject, primaryType: string, types: EIP712Types) => {
		const extractedTypes = simplifyTypesToSolidityTypesOnly(primaryType, types)
		const fieldsArray = Object.entries(message)
		for (const field of fieldsArray) {
			if (field[1] === undefined) return false
			if (!validateTypeValue(field[0], field[1], extractedTypes)) return false
		}
		return true
	}

	// validate domain
	const validDomain = validateTypes(maybeEip712Message.domain, 'EIP712Domain', maybeEip712Message.types)
	if (!validDomain) return { valid: false, reason: 'EIP712Domain was invalid' }
	// validate message
	const validMessage = validateTypes(maybeEip712Message.message, maybeEip712Message.primaryType, maybeEip712Message.types)
	if (!validMessage) return { valid: false, reason: 'Message was invalid' }
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


export const extractPrimaryTypesUsedInMessage = (eip712Message: EIP712Message) => {
	const primaryTypes = eip712Message.types[eip712Message.primaryType]
	if (primaryTypes == undefined) return undefined
	return modifyObject(eip712Message, { types: { primaryType: primaryTypes } })
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
