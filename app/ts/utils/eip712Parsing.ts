import { UserAddressBook } from './interceptor-messages.js'
import { assertNever } from './typescript.js'
import { EthereumAddress, EthereumData, EthereumQuantity, NonHexBigInt } from './wire-types.js'
import { EIP712Message, JSONEncodeableObject } from './JsonRpc-types.js'
import * as funtypes from 'funtypes'
import { identifyAddress } from '../background/metadataUtils.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { AddressBookEntry } from './addressBookTypes.js'

type SolidityType = funtypes.Static<typeof SolidityType>
const SolidityType = funtypes.Union(
	funtypes.Literal('uint8'),
	funtypes.Literal('uint16'),
	funtypes.Literal('uint24'),
	funtypes.Literal('uint32'),
	funtypes.Literal('uint40'),
	funtypes.Literal('uint48'),
	funtypes.Literal('uint56'),
	funtypes.Literal('uint64'),
	funtypes.Literal('uint72'),
	funtypes.Literal('uint80'),
	funtypes.Literal('uint88'),
	funtypes.Literal('uint96'),
	funtypes.Literal('uint104'),
	funtypes.Literal('uint112'),
	funtypes.Literal('uint120'),
	funtypes.Literal('uint128'),
	funtypes.Literal('uint136'),
	funtypes.Literal('uint144'),
	funtypes.Literal('uint152'),
	funtypes.Literal('uint160'),
	funtypes.Literal('uint168'),
	funtypes.Literal('uint176'),
	funtypes.Literal('uint184'),
	funtypes.Literal('uint192'),
	funtypes.Literal('uint200'),
	funtypes.Literal('uint208'),
	funtypes.Literal('uint216'),
	funtypes.Literal('uint224'),
	funtypes.Literal('uint232'),
	funtypes.Literal('uint240'),
	funtypes.Literal('uint248'),
	funtypes.Literal('uint256'),
	funtypes.Literal('int8'),
	funtypes.Literal('int16'),
	funtypes.Literal('int24'),
	funtypes.Literal('int32'),
	funtypes.Literal('int40'),
	funtypes.Literal('int48'),
	funtypes.Literal('int56'),
	funtypes.Literal('int64'),
	funtypes.Literal('int72'),
	funtypes.Literal('int80'),
	funtypes.Literal('int88'),
	funtypes.Literal('int96'),
	funtypes.Literal('int104'),
	funtypes.Literal('int112'),
	funtypes.Literal('int120'),
	funtypes.Literal('int128'),
	funtypes.Literal('int136'),
	funtypes.Literal('int144'),
	funtypes.Literal('int152'),
	funtypes.Literal('int160'),
	funtypes.Literal('int168'),
	funtypes.Literal('int176'),
	funtypes.Literal('int184'),
	funtypes.Literal('int192'),
	funtypes.Literal('int200'),
	funtypes.Literal('int208'),
	funtypes.Literal('int216'),
	funtypes.Literal('int224'),
	funtypes.Literal('int232'),
	funtypes.Literal('int240'),
	funtypes.Literal('int248'),
	funtypes.Literal('int256'),
	funtypes.Literal('bytes1'),
	funtypes.Literal('bytes2'),
	funtypes.Literal('bytes3'),
	funtypes.Literal('bytes4'),
	funtypes.Literal('bytes5'),
	funtypes.Literal('bytes6'),
	funtypes.Literal('bytes7'),
	funtypes.Literal('bytes8'),
	funtypes.Literal('bytes9'),
	funtypes.Literal('bytes10'),
	funtypes.Literal('bytes11'),
	funtypes.Literal('bytes12'),
	funtypes.Literal('bytes13'),
	funtypes.Literal('bytes14'),
	funtypes.Literal('bytes15'),
	funtypes.Literal('bytes16'),
	funtypes.Literal('bytes17'),
	funtypes.Literal('bytes18'),
	funtypes.Literal('bytes19'),
	funtypes.Literal('bytes20'),
	funtypes.Literal('bytes21'),
	funtypes.Literal('bytes22'),
	funtypes.Literal('bytes23'),
	funtypes.Literal('bytes24'),
	funtypes.Literal('bytes25'),
	funtypes.Literal('bytes26'),
	funtypes.Literal('bytes27'),
	funtypes.Literal('bytes28'),
	funtypes.Literal('bytes29'),
	funtypes.Literal('bytes30'),
	funtypes.Literal('bytes31'),
	funtypes.Literal('bytes32'),
	funtypes.Literal('bool'),
	funtypes.Literal('address'),
	funtypes.Literal('string'),
	funtypes.Literal('bytes'),
)

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
		if (SolidityType.test(arraylessType.arraylessType)) continue
		if (Array.isArray(subMessage)) {
			if (subMessage.map((arrayElement) => validateEIP712TypesSubset(depth, arrayElement, arraylessType.arraylessType, types)).every((v) => v === true) === false) {
				return false
			}
		} else {
			if (!JSONEncodeableObject.test(subMessage)) return false
			if (validateEIP712TypesSubset(depth + 1, subMessage, arraylessType.arraylessType, types) === false) return false
		}
	}
	return true
}

export function validateEIP712Types(message: EIP712Message) {
	return validateEIP712TypesSubset(0, message.message, message.primaryType, message.types) && validateEIP712TypesSubset(0, message.domain, 'EIP712Domain', message.types)
}

export type GroupedSolidityType = funtypes.Static<typeof GroupedSolidityType>
export const GroupedSolidityType = funtypes.Union(
	funtypes.ReadonlyObject({ type: funtypes.Literal('integer'), value: EthereumQuantity }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('bytes'), value: EthereumData }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('fixedBytes'), value: EthereumData }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('bool'), value: funtypes.Boolean }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('string'), value: funtypes.String }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('address'), value: AddressBookEntry }),
	
	funtypes.ReadonlyObject({ type: funtypes.Literal('integer[]'), value: funtypes.ReadonlyArray(EthereumQuantity) }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('bytes[]'), value: funtypes.ReadonlyArray(EthereumData) }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('fixedBytes[]'), value: funtypes.ReadonlyArray(EthereumData) }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('bool[]'), value: funtypes.ReadonlyArray(funtypes.Boolean) }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('string[]'), value: funtypes.ReadonlyArray(funtypes.String) }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('address[]'), value: funtypes.ReadonlyArray(AddressBookEntry) }),
)

type typeEnrichedEIP712MessageRecord = GroupedSolidityType | { type: 'record', value: { [x: string]: typeEnrichedEIP712MessageRecord | undefined } } | { type: 'record[]', value: ReadonlyArray<{ [x: string]: typeEnrichedEIP712MessageRecord | undefined }> }
type EnrichedEIP712MessageRecord = funtypes.Static<typeof EnrichedEIP712MessageRecord>
const EnrichedEIP712MessageRecord: funtypes.Runtype<typeEnrichedEIP712MessageRecord> = funtypes.Lazy(() => funtypes.Union(
	GroupedSolidityType,
	funtypes.ReadonlyObject({ type: funtypes.Literal('record'), value: funtypes.ReadonlyRecord(funtypes.String, EnrichedEIP712MessageRecord) }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('record[]'), value: funtypes.ReadonlyArray(funtypes.ReadonlyRecord(funtypes.String, EnrichedEIP712MessageRecord)) }),
))

export type EnrichedEIP712Message = funtypes.Static<typeof EnrichedEIP712Message>
export const EnrichedEIP712Message = funtypes.ReadonlyRecord(
	funtypes.String,
	EnrichedEIP712MessageRecord,
)

export type EnrichedEIP712 = funtypes.Static<typeof EnrichedEIP712>
export const EnrichedEIP712 = funtypes.ReadonlyObject({
	message: EnrichedEIP712Message,
	domain: EnrichedEIP712Message,
})

function getSolidityTypeCategory(type: SolidityType) {
	switch(type) {
		case 'uint8': 
		case 'uint16': 
		case 'uint24': 
		case 'uint32': 
		case 'uint40': 
		case 'uint48': 
		case 'uint56': 
		case 'uint64': 
		case 'uint72': 
		case 'uint80': 
		case 'uint88': 
		case 'uint96': 
		case 'uint104': 
		case 'uint112': 
		case 'uint120': 
		case 'uint128': 
		case 'uint136': 
		case 'uint144': 
		case 'uint152': 
		case 'uint160': 
		case 'uint168': 
		case 'uint176': 
		case 'uint184': 
		case 'uint192': 
		case 'uint200': 
		case 'uint208': 
		case 'uint216': 
		case 'uint224': 
		case 'uint232': 
		case 'uint240': 
		case 'uint248': 
		case 'uint256': 
		case 'int8': 
		case 'int16': 
		case 'int24': 
		case 'int32': 
		case 'int40': 
		case 'int48': 
		case 'int56': 
		case 'int64': 
		case 'int72': 
		case 'int80': 
		case 'int88': 
		case 'int96': 
		case 'int104': 
		case 'int112': 
		case 'int120': 
		case 'int128': 
		case 'int136': 
		case 'int144': 
		case 'int152': 
		case 'int160': 
		case 'int168': 
		case 'int176': 
		case 'int184': 
		case 'int192': 
		case 'int200': 
		case 'int208': 
		case 'int216': 
		case 'int224': 
		case 'int232': 
		case 'int240': 
		case 'int248': 
		case 'int256': return 'integer'
		case 'bytes1': 
		case 'bytes2': 
		case 'bytes3': 
		case 'bytes4': 
		case 'bytes5': 
		case 'bytes6': 
		case 'bytes7': 
		case 'bytes8': 
		case 'bytes9': 
		case 'bytes10': 
		case 'bytes11': 
		case 'bytes12': 
		case 'bytes13': 
		case 'bytes14': 
		case 'bytes15': 
		case 'bytes16': 
		case 'bytes17': 
		case 'bytes18': 
		case 'bytes19': 
		case 'bytes20': 
		case 'bytes21': 
		case 'bytes22': 
		case 'bytes23': 
		case 'bytes24': 
		case 'bytes25': 
		case 'bytes26': 
		case 'bytes27': 
		case 'bytes28': 
		case 'bytes29': 
		case 'bytes30': 
		case 'bytes31': 
		case 'bytes32': return 'fixedBytes'
		case 'bool': return 'bool'
		case 'address': return 'address'
		case 'string': return 'string'
		case 'bytes': return 'bytes'
		default: assertNever(type)
	}
}

async function parseSolidityValueByType(ethereumClientService: EthereumClientService, type: SolidityType, value: unknown, userAddressBook: UserAddressBook, isArray: boolean, useLocalStorage: boolean = true): Promise<GroupedSolidityType> {	
	const categorized = getSolidityTypeCategory(type)
	if (isArray) {
		switch (categorized) {
			case 'address': return { type: `${ categorized }[]`, value: await Promise.all(funtypes.ReadonlyArray(EthereumAddress).parse(value).map((value) => identifyAddress(ethereumClientService, userAddressBook, value, useLocalStorage))) }
			case 'bool': return { type: `${ categorized }[]`, value: funtypes.ReadonlyArray(NonHexBigInt).parse(value).map((a) => a === 1n) }
			case 'bytes': return { type: `${ categorized }[]`, value: funtypes.ReadonlyArray(EthereumData).parse(value) }
			case 'fixedBytes': return { type: `${ categorized }[]`, value: funtypes.ReadonlyArray(EthereumData).parse(value) }
			case 'integer': return { type: `${ categorized }[]`, value: funtypes.ReadonlyArray(funtypes.Union(NonHexBigInt, funtypes.Number)).parse(value).map((x) => BigInt(x)) }
			case 'string': return { type: `${ categorized }[]`, value: funtypes.ReadonlyArray(funtypes.String).parse(value) }
			default: assertNever(categorized)
		}

	}
	switch (categorized) {
		case 'address': return { type: categorized, value: await identifyAddress(ethereumClientService, userAddressBook, EthereumAddress.parse(value), useLocalStorage) }
		case 'bool': return { type: categorized, value: NonHexBigInt.parse(value) === 1n }
		case 'bytes': return { type: categorized, value: EthereumData.parse(value) }
		case 'fixedBytes': return { type: categorized, value: EthereumData.parse(value) }
		case 'integer': return { type: categorized, value: BigInt(funtypes.Union(NonHexBigInt, funtypes.Number).parse(value)) }
		case 'string': return { type: categorized, value: funtypes.String.parse(value) }
		default: assertNever(categorized)
	}
}

async function extractEIP712MessageSubset(ethereumClientService: EthereumClientService, depth: number, message: JSONEncodeableObject, currentType: string, types: { [x: string]: readonly { readonly name: string, readonly type: string}[] | undefined }, userAddressBook: UserAddressBook, useLocalStorage: boolean = true): Promise<EnrichedEIP712Message> {
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
			return [key, await parseSolidityValueByType(ethereumClientService, SolidityType.parse(arraylessType.arraylessType), messageEntry, userAddressBook, arraylessType.isArray, useLocalStorage)]
		}
		if (arraylessType.isArray) {
			if (!Array.isArray(messageEntry)) throw new Error(`Type was defined to be an array but it was not: ${ messageEntry }`)
			return [key, { type: 'record[]', value: await Promise.all(messageEntry.map((subSubMessage) => extractEIP712MessageSubset(ethereumClientService, depth + 1, subSubMessage, arraylessType.arraylessType, types, userAddressBook, useLocalStorage))) }]
		}
		if (!JSONEncodeableObject.test(messageEntry)) throw new Error(`Not a JSON type: ${ messageEntry }`)
		return [key, { type: 'record', value: await extractEIP712MessageSubset(ethereumClientService, depth + 1, messageEntry, fullType, types, userAddressBook, useLocalStorage) }]
	}))
	return pairArray.reduce((accumulator, [key, value]) => ({ ...accumulator, [key]: value}), {} as Promise<EnrichedEIP712Message>)
}

export async function extractEIP712Message(ethereumClientService: EthereumClientService, message: EIP712Message, userAddressBook: UserAddressBook, useLocalStorage: boolean = true): Promise<EnrichedEIP712> {
	return {
		message: await extractEIP712MessageSubset(ethereumClientService, 0, message.message, message.primaryType, message.types, userAddressBook, useLocalStorage),
		domain: await extractEIP712MessageSubset(ethereumClientService, 0, message.domain, 'EIP712Domain', message.types, userAddressBook, useLocalStorage),
	}
}
