import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { JSONEncodeableObject, JSONEncodeableObjectArray } from '../utils/json.js'
import { EIP712Message, EnrichedEIP712, EnrichedEIP712Message, EnrichedEIP712MessageRecord } from '../types/eip721.js'
import { parseSolidityValueByTypeEnriched } from './solidityTypes.js'
import { SolidityType } from '../types/solidityType.js'

function findType(name: string, types: readonly { readonly name: string, readonly type: string}[]) {
	return types.find((x) => x.name === name)?.type
}

function separateArraySuffix(typeWithMaybeArraySuffix: string) {
	const splitted = typeWithMaybeArraySuffix.split('[]')
	if (splitted.length === 1) return { arraylessType: typeWithMaybeArraySuffix, isArray: false }
	return { arraylessType: splitted[0], isArray: true }
}

function validateEIP712TypesSubset(depth: number, message: JSONEncodeableObject, currentType: string, types: { [x: string]: readonly { readonly name: string, readonly type: string}[] | undefined }): boolean {
	if (depth > 2) return false // do not allow too deep messages
	const currentTypes = types[currentType]
	if (currentTypes === undefined) return false
	const keys = Object.keys(message)
	for (const key of keys) {
		const fullType = findType(key, currentTypes)
		if (fullType === undefined) return false
		const subMessage = message[key]
		if (subMessage === undefined) return false
		const arraylessType = separateArraySuffix(fullType)
		if (arraylessType.isArray !== Array.isArray(subMessage)) return false
		const currentType = arraylessType.arraylessType
		if (SolidityType.test(currentType)) continue
		if (currentType === undefined) return false
		const jsonEncodeableArray = JSONEncodeableObjectArray.safeParse(subMessage)
		if (jsonEncodeableArray.success) {
			if (jsonEncodeableArray.value.map((arrayElement) => JSONEncodeableObject.test(arrayElement) ? validateEIP712TypesSubset(depth, arrayElement, currentType, types) : false).every((v) => v === true) === false) {
				return false
			}
		} else {
			if (!JSONEncodeableObject.test(subMessage)) return false
			if (validateEIP712TypesSubset(depth + 1, subMessage, currentType, types) === false) return false
		}
	}
	return true
}

export function validateEIP712Types(message: EIP712Message) {
	return validateEIP712TypesSubset(0, message.message, message.primaryType, message.types) && validateEIP712TypesSubset(0, message.domain, 'EIP712Domain', message.types)
}

async function extractEIP712MessageSubset(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, depth: number, message: JSONEncodeableObject, currentType: string, types: { [x: string]: readonly { readonly name: string, readonly type: string}[] | undefined }, useLocalStorage = true): Promise<EnrichedEIP712Message> {
	if (depth > 2) throw new Error('Too deep EIP712 message')
	const currentTypes = types[currentType]
	if (currentTypes === undefined) throw new Error(`Types not found: ${ currentType }`)
	const messageEntries = Object.entries(message)
	const pairArray: [string, EnrichedEIP712MessageRecord][] = await Promise.all(Array.from(messageEntries).map(async([key, messageEntry]) => {
		if (messageEntry === undefined) throw new Error(`Subtype not found: ${ key }`)
		const fullType = findType(key, currentTypes)
		if (fullType === undefined) throw new Error(`Type not found for key: ${ key }`)
		const arraylessType = separateArraySuffix(fullType)
		if (SolidityType.test(arraylessType.arraylessType)) {
			return [key, await parseSolidityValueByTypeEnriched(ethereumClientService, requestAbortController, SolidityType.parse(arraylessType.arraylessType), messageEntry, arraylessType.isArray, useLocalStorage)]
		}
		if (arraylessType.isArray) {
			const jsonEncodeableArray = JSONEncodeableObjectArray.safeParse(messageEntry)
			if (!jsonEncodeableArray.success) throw new Error(`Type was defined to be an array but it was not: ${ messageEntry }`)
			const currentType = arraylessType.arraylessType
			if (currentType === undefined) throw new Error(`array's type is missing`)
			return [key, { type: 'record[]', value: await Promise.all(jsonEncodeableArray.value.map((subSubMessage) => {
				if (JSONEncodeableObject.test(subSubMessage)) return extractEIP712MessageSubset(ethereumClientService, requestAbortController, depth + 1, subSubMessage, currentType, types, useLocalStorage)
				throw new Error('Too deep EIP712 message (object)')
			})) }]
		}
		if (!JSONEncodeableObject.test(messageEntry)) throw new Error(`Not a JSON type: ${ messageEntry }`)
		return [key, { type: 'record', value: await extractEIP712MessageSubset(ethereumClientService, requestAbortController, depth + 1, messageEntry, fullType, types, useLocalStorage) }]
	}))
	return pairArray.reduce((accumulator, [key, value]) => ({ ...accumulator, [key]: value }), {} as Promise<EnrichedEIP712Message>)
}

export async function extractEIP712Message(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, message: EIP712Message, useLocalStorage = true): Promise<EnrichedEIP712> {
	return {
		primaryType: message.primaryType,
		message: await extractEIP712MessageSubset(ethereumClientService, requestAbortController, 0, message.message, message.primaryType, message.types, useLocalStorage),
		domain: await extractEIP712MessageSubset(ethereumClientService, requestAbortController, 0, message.domain, 'EIP712Domain', message.types, useLocalStorage),
	}
}
