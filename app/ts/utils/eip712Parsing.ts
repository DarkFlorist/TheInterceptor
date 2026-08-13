import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { JSONEncodeableObject } from '../utils/json.js'
import type { EIP712Message, EnrichedEIP712, EnrichedEIP712Message, EnrichedEIP712MessageRecord } from '../types/eip721.js'
import { parseSolidityValueByTypeEnriched } from './solidityTypes.js'
import { SolidityType } from '../types/solidityType.js'
import { promiseAllMapAbortSafe } from './requests.js'
import { MAX_EIP712_STRUCT_DEPTH } from './eip712.js'

function findType(name: string, types: readonly { readonly name: string, readonly type: string}[]) {
	return types.find((x) => x.name === name)?.type
}

type ParsedEIP712Type = {
	readonly baseType: string
	readonly arrayDimensions: readonly (number | undefined)[]
	readonly valid: boolean
}

function parseEIP712Type(typeWithMaybeArraySuffix: string): ParsedEIP712Type {
	let baseType = typeWithMaybeArraySuffix
	const arrayDimensions: (number | undefined)[] = []
	while (true) {
		const arrayMatch = /^(.*)\[(\d*)\]$/.exec(baseType)
		if (arrayMatch === null) return { baseType, arrayDimensions, valid: baseType.length !== 0 && !/[\[\]]/.test(baseType) }
		const nextBaseType = arrayMatch[1]
		const lengthText = arrayMatch[2]
		if (nextBaseType === undefined || lengthText === undefined || (lengthText !== '' && !/^[1-9][0-9]*$/.test(lengthText))) return { baseType, arrayDimensions, valid: false }
		baseType = nextBaseType
		arrayDimensions.push(lengthText === '' ? undefined : Number.parseInt(lengthText, 10))
	}
}

function validateEIP712Value(depth: number, value: unknown, parsedType: ParsedEIP712Type, types: { [x: string]: readonly { readonly name: string, readonly type: string}[] | undefined }): boolean {
	if (!parsedType.valid) return false
	if (parsedType.arrayDimensions.length !== 0) {
		if (!Array.isArray(value)) return false
		const expectedLength = parsedType.arrayDimensions[0]
		if (expectedLength !== undefined && value.length !== expectedLength) return false
		const nestedType = { baseType: parsedType.baseType, arrayDimensions: parsedType.arrayDimensions.slice(1), valid: true }
		return value.every((nestedValue) => validateEIP712Value(depth, nestedValue, nestedType, types))
	}
	if (SolidityType.test(parsedType.baseType)) return !Array.isArray(value)
	if (!JSONEncodeableObject.test(value)) return false
	return validateEIP712TypesSubset(depth + 1, value, parsedType.baseType, types)
}

function validateEIP712TypesSubset(depth: number, message: JSONEncodeableObject, currentType: string, types: { [x: string]: readonly { readonly name: string, readonly type: string}[] | undefined }): boolean {
	if (depth > MAX_EIP712_STRUCT_DEPTH) return false
	const currentTypes = types[currentType]
	if (currentTypes === undefined) return false
	const keys = Object.keys(message)
	for (const key of keys) {
		const fullType = findType(key, currentTypes)
		if (fullType === undefined) return false
		const subMessage = message[key]
		if (subMessage === undefined) return false
		if (!validateEIP712Value(depth, subMessage, parseEIP712Type(fullType), types)) return false
	}
	return true
}

export function validateEIP712Types(message: EIP712Message) {
	return validateEIP712TypesSubset(0, message.message, message.primaryType, message.types) && validateEIP712TypesSubset(0, message.domain, 'EIP712Domain', message.types)
}

function parseEIP712Array(value: unknown, expectedLength: number | undefined): readonly unknown[] {
	if (!Array.isArray(value)) throw new Error(`Type was defined to be an array but it was not: ${ value }`)
	if (expectedLength !== undefined && value.length !== expectedLength) throw new Error(`Array length was ${ value.length }, expected ${ expectedLength }`)
	return value
}

async function extractEIP712Value(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, depth: number, value: unknown, parsedType: ParsedEIP712Type, types: { [x: string]: readonly { readonly name: string, readonly type: string}[] | undefined }, useLocalStorage: boolean): Promise<EnrichedEIP712MessageRecord> {
	if (!parsedType.valid) throw new Error('EIP712 type contained an invalid array dimension')
	if (parsedType.arrayDimensions.length > 1) {
		const arrayValue = parseEIP712Array(value, parsedType.arrayDimensions[0])
		const nestedType = { baseType: parsedType.baseType, arrayDimensions: parsedType.arrayDimensions.slice(1), valid: true }
		return { type: 'nestedArray', value: await promiseAllMapAbortSafe(arrayValue, (nestedValue) => extractEIP712Value(ethereumClientService, requestAbortController, depth, nestedValue, nestedType, types, useLocalStorage)) }
	}
	if (SolidityType.test(parsedType.baseType)) {
		if (parsedType.arrayDimensions.length === 1) parseEIP712Array(value, parsedType.arrayDimensions[0])
		return parseSolidityValueByTypeEnriched(ethereumClientService, requestAbortController, parsedType.baseType, value, parsedType.arrayDimensions.length === 1, useLocalStorage)
	}
	if (parsedType.arrayDimensions.length === 1) {
		const arrayValue = parseEIP712Array(value, parsedType.arrayDimensions[0])
		return { type: 'record[]', value: await promiseAllMapAbortSafe(arrayValue, (nestedValue) => {
			if (!JSONEncodeableObject.test(nestedValue)) throw new Error('EIP712 record array contained a non-record value')
			return extractEIP712MessageSubset(ethereumClientService, requestAbortController, depth + 1, nestedValue, parsedType.baseType, types, useLocalStorage)
		}) }
	}
	if (!JSONEncodeableObject.test(value)) throw new Error(`Not a JSON record: ${ value }`)
	return { type: 'record', value: await extractEIP712MessageSubset(ethereumClientService, requestAbortController, depth + 1, value, parsedType.baseType, types, useLocalStorage) }
}

async function extractEIP712MessageSubset(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, depth: number, message: JSONEncodeableObject, currentType: string, types: { [x: string]: readonly { readonly name: string, readonly type: string}[] | undefined }, useLocalStorage = true): Promise<EnrichedEIP712Message> {
	if (depth > MAX_EIP712_STRUCT_DEPTH) throw new Error('Too deep EIP712 message')
	const currentTypes = types[currentType]
	if (currentTypes === undefined) throw new Error(`Types not found: ${ currentType }`)
	const messageEntries = Object.entries(message)
	const pairArray: [string, EnrichedEIP712MessageRecord][] = await promiseAllMapAbortSafe(Array.from(messageEntries), async([key, messageEntry]): Promise<[string, EnrichedEIP712MessageRecord]> => {
		if (messageEntry === undefined) throw new Error(`Subtype not found: ${ key }`)
		const fullType = findType(key, currentTypes)
		if (fullType === undefined) throw new Error(`Type not found for key: ${ key }`)
		return [key, await extractEIP712Value(ethereumClientService, requestAbortController, depth, messageEntry, parseEIP712Type(fullType), types, useLocalStorage)]
	})
	return pairArray.reduce((accumulator, [key, value]) => ({ ...accumulator, [key]: value }), {} as Promise<EnrichedEIP712Message>)
}

export async function extractEIP712Message(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, message: EIP712Message, useLocalStorage = true): Promise<EnrichedEIP712> {
	return {
		primaryType: message.primaryType,
		message: await extractEIP712MessageSubset(ethereumClientService, requestAbortController, 0, message.message, message.primaryType, message.types, useLocalStorage),
		domain: await extractEIP712MessageSubset(ethereumClientService, requestAbortController, 0, message.domain, 'EIP712Domain', message.types, useLocalStorage),
	}
}
