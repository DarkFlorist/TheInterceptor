import { EthereumAddress, EthereumData, EthereumQuantity, NonHexBigInt } from '../types/wire-types.js'
import * as funtypes from 'funtypes'
import { identifyAddress } from '../background/metadataUtils.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { type EnrichedGroupedSolidityType, type PureFlatGroupedSolidityType, type PureGroupedSolidityType, SignedBigInt, SolidityType, type SolidityVariable } from '../types/solidityType.js'
import { promiseAllMapAbortSafe } from './requests.js'
import type { AbiParameter } from './ethereumPrimitives.js'
import { assertNever } from './typescript.js'

type SolidityTypeCategory = 'address' | 'bool' | 'bytes' | 'fixedBytes' | 'signedInteger' | 'string' | 'unsignedInteger'

const solidityTypeCategories = {
	uint8: 'unsignedInteger',
	uint16: 'unsignedInteger',
	uint24: 'unsignedInteger',
	uint32: 'unsignedInteger',
	uint40: 'unsignedInteger',
	uint48: 'unsignedInteger',
	uint56: 'unsignedInteger',
	uint64: 'unsignedInteger',
	uint72: 'unsignedInteger',
	uint80: 'unsignedInteger',
	uint88: 'unsignedInteger',
	uint96: 'unsignedInteger',
	uint104: 'unsignedInteger',
	uint112: 'unsignedInteger',
	uint120: 'unsignedInteger',
	uint128: 'unsignedInteger',
	uint136: 'unsignedInteger',
	uint144: 'unsignedInteger',
	uint152: 'unsignedInteger',
	uint160: 'unsignedInteger',
	uint168: 'unsignedInteger',
	uint176: 'unsignedInteger',
	uint184: 'unsignedInteger',
	uint192: 'unsignedInteger',
	uint200: 'unsignedInteger',
	uint208: 'unsignedInteger',
	uint216: 'unsignedInteger',
	uint224: 'unsignedInteger',
	uint232: 'unsignedInteger',
	uint240: 'unsignedInteger',
	uint248: 'unsignedInteger',
	uint256: 'unsignedInteger',
	int8: 'signedInteger',
	int16: 'signedInteger',
	int24: 'signedInteger',
	int32: 'signedInteger',
	int40: 'signedInteger',
	int48: 'signedInteger',
	int56: 'signedInteger',
	int64: 'signedInteger',
	int72: 'signedInteger',
	int80: 'signedInteger',
	int88: 'signedInteger',
	int96: 'signedInteger',
	int104: 'signedInteger',
	int112: 'signedInteger',
	int120: 'signedInteger',
	int128: 'signedInteger',
	int136: 'signedInteger',
	int144: 'signedInteger',
	int152: 'signedInteger',
	int160: 'signedInteger',
	int168: 'signedInteger',
	int176: 'signedInteger',
	int184: 'signedInteger',
	int192: 'signedInteger',
	int200: 'signedInteger',
	int208: 'signedInteger',
	int216: 'signedInteger',
	int224: 'signedInteger',
	int232: 'signedInteger',
	int240: 'signedInteger',
	int248: 'signedInteger',
	int256: 'signedInteger',
	bytes1: 'fixedBytes',
	bytes2: 'fixedBytes',
	bytes3: 'fixedBytes',
	bytes4: 'fixedBytes',
	bytes5: 'fixedBytes',
	bytes6: 'fixedBytes',
	bytes7: 'fixedBytes',
	bytes8: 'fixedBytes',
	bytes9: 'fixedBytes',
	bytes10: 'fixedBytes',
	bytes11: 'fixedBytes',
	bytes12: 'fixedBytes',
	bytes13: 'fixedBytes',
	bytes14: 'fixedBytes',
	bytes15: 'fixedBytes',
	bytes16: 'fixedBytes',
	bytes17: 'fixedBytes',
	bytes18: 'fixedBytes',
	bytes19: 'fixedBytes',
	bytes20: 'fixedBytes',
	bytes21: 'fixedBytes',
	bytes22: 'fixedBytes',
	bytes23: 'fixedBytes',
	bytes24: 'fixedBytes',
	bytes25: 'fixedBytes',
	bytes26: 'fixedBytes',
	bytes27: 'fixedBytes',
	bytes28: 'fixedBytes',
	bytes29: 'fixedBytes',
	bytes30: 'fixedBytes',
	bytes31: 'fixedBytes',
	bytes32: 'fixedBytes',
	bool: 'bool',
	address: 'address',
	string: 'string',
	bytes: 'bytes',
} as const satisfies Record<SolidityType, SolidityTypeCategory>

function getSolidityTypeCategory(type: SolidityType) {
	return solidityTypeCategories[type]
}

export async function parseSolidityValueByTypeEnriched(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, type: SolidityType, value: unknown, isArray: boolean, useLocalStorage = true): Promise<EnrichedGroupedSolidityType> {
	const categorized = getSolidityTypeCategory(type)
	if (categorized === 'address') {
		if (isArray) return { type: 'address[]', value: await promiseAllMapAbortSafe(funtypes.ReadonlyArray(EthereumAddress).parse(value), (value) => identifyAddress(ethereumClientService, requestAbortController, value, useLocalStorage)) }
		return { type: 'address', value: await identifyAddress(ethereumClientService, requestAbortController, EthereumAddress.parse(value), useLocalStorage) }
	}
	const parsed = parseSolidityValueByTypePure(type, value, isArray)
	if (parsed.type === 'address' || parsed.type === 'address[]') throw new Error('parsed to address or address array')
	return parsed
}

const SignedIntegerType = funtypes.Union(NonHexBigInt, funtypes.Number, funtypes.BigInt, SignedBigInt)
const UnsignedIntegerType = funtypes.Union(NonHexBigInt, funtypes.Number, funtypes.BigInt, EthereumQuantity).withConstraint((number) => BigInt(number) >= 0n)
const removeSingleArraySuffix = (type: string) => type.replace(/\[[^\]]*\]$/, '')

const hasTupleComponents = (parameter: AbiParameter): parameter is AbiParameter & { readonly components: readonly AbiParameter[] } => {
	return 'components' in parameter
}

const hasHashValue = (value: unknown): value is { readonly hash: unknown } => {
	return typeof value === 'object' && value !== null && 'hash' in value
}

const isIndexedTopicHash = (value: unknown): value is string => {
	return typeof value === 'string' && /^0x[a-fA-F0-9]{64}$/.test(value)
}

const parseIndexedHash = (value: unknown): PureFlatGroupedSolidityType | undefined => {
	if (hasHashValue(value)) return { type: 'fixedBytes', value: EthereumData.parse(value.hash) }
	if (isIndexedTopicHash(value)) return { type: 'fixedBytes', value: EthereumData.parse(value) }
	return undefined
}

const isIndexedAbiParameter = (parameter: AbiParameter): parameter is AbiParameter & { readonly indexed: true } => {
	return 'indexed' in parameter && parameter.indexed === true
}

const getAbiParameterName = (parameter: AbiParameter, fallbackName: string | undefined) => {
	if (parameter.name !== undefined && parameter.name !== '') return parameter.name
	if (fallbackName !== undefined) return fallbackName
	if (parameter.name === '') return ''
	throw new Error('missing parameter name')
}

const getTupleComponentValue = (tupleValue: unknown, component: AbiParameter, index: number) => {
	if (Array.isArray(tupleValue)) return tupleValue[index]
	if (typeof tupleValue !== 'object' || tupleValue === null) throw new Error('tuple value is not an object or array')
	if (component.name !== undefined && component.name !== '') {
		const namedValue = Reflect.get(tupleValue, component.name)
		if (namedValue !== undefined) return namedValue
	}
	return Reflect.get(tupleValue, index)
}

const parseAbiParameterToSolidityVariable = (parameter: AbiParameter, value: unknown, fallbackName: string | undefined): SolidityVariable => {
	return {
		paramName: getAbiParameterName(parameter, fallbackName),
		typeValue: parseAbiParameterToSolidityValue(parameter, value),
	}
}

const parseTupleComponents = (components: readonly AbiParameter[], value: unknown) => {
	return components.map((component, index) => parseAbiParameterToSolidityVariable(component, getTupleComponentValue(value, component, index), `field${ index }`))
}

const parseTupleArray = (components: readonly AbiParameter[], value: unknown) => {
	if (!Array.isArray(value)) throw new Error('tuple array value is not an array')
	return value.map((tupleValue) => parseTupleComponents(components, tupleValue))
}

function parseAbiParameterToSolidityValue(parameter: AbiParameter, value: unknown): PureGroupedSolidityType {
	const scalarAbiType = removeSingleArraySuffix(parameter.type)
	const isArray = scalarAbiType !== parameter.type
	const indexedHash = isIndexedAbiParameter(parameter) ? parseIndexedHash(value) : undefined
	if (indexedHash !== undefined) return indexedHash
	if (scalarAbiType === 'tuple') {
		if (!hasTupleComponents(parameter)) throw new Error(`missing tuple components for ${ parameter.type }`)
		if (isArray) return { type: 'tuple[]', value: parseTupleArray(parameter.components, value) }
		return { type: 'tuple', value: parseTupleComponents(parameter.components, value) }
	}
	const verifiedSolidityType = SolidityType.safeParse(scalarAbiType)
	if (verifiedSolidityType.success === false) throw new Error(`unknown solidity type: ${ parameter.type }`)
	return parseSolidityValueByTypePure(verifiedSolidityType.value, value, isArray)
}

export function parseAbiParametersToSolidityVariables(parameters: readonly AbiParameter[], values: readonly unknown[]) {
	if (values.length !== parameters.length) throw new Error('ABI parameter/value length mismatch')
	return values.map((value, index) => {
		const parameter = parameters[index]
		if (parameter === undefined) throw new Error('missing ABI parameter')
		return parseAbiParameterToSolidityVariable(parameter, value, undefined)
	})
}

function parseSolidityValueByTypePure(type: SolidityType, value: unknown, isArray: boolean): PureFlatGroupedSolidityType {
	const categorized = getSolidityTypeCategory(type)
	if (isArray) {
		switch (categorized) {
			case 'address': return { type: `${ categorized }[]`, value: funtypes.ReadonlyArray(EthereumAddress).parse(value) }
			case 'bool': return { type: `${ categorized }[]`, value: funtypes.ReadonlyArray(funtypes.Union(NonHexBigInt, funtypes.Boolean)).parse(value).map((a) => a === 1n || a === true) }
			case 'bytes': return { type: `${ categorized }[]`, value: funtypes.ReadonlyArray(EthereumData).parse(value) }
			case 'fixedBytes': return { type: `${ categorized }[]`, value: funtypes.ReadonlyArray(EthereumData).parse(value) }
			case 'signedInteger': return { type: `${ categorized }[]`, value: funtypes.ReadonlyArray(SignedIntegerType).parse(value).map((x) => BigInt(x)) }
			case 'unsignedInteger': return { type: `${ categorized }[]`, value: funtypes.ReadonlyArray(UnsignedIntegerType).parse(value).map((x) => BigInt(x)) }
			case 'string': return { type: `${ categorized }[]`, value: funtypes.ReadonlyArray(funtypes.String).parse(value) }
			default: return assertNever(categorized)
		}
	}
	switch (categorized) {
		case 'address': return { type: categorized, value: EthereumAddress.parse(value) }
		case 'bool': {
			const parsed = funtypes.Union(NonHexBigInt, funtypes.Boolean).parse(value)
			return { type: categorized, value: parsed === 1n || parsed === true }
		}
		case 'bytes': return { type: categorized, value: EthereumData.parse(value) }
		case 'fixedBytes': return { type: categorized, value: EthereumData.parse(value) }
		case 'signedInteger': return { type: categorized, value: BigInt(SignedIntegerType.parse(value)) }
		case 'unsignedInteger': return { type: categorized, value: BigInt(UnsignedIntegerType.parse(value)) }
		case 'string': return { type: categorized, value: funtypes.String.parse(value) }
		default: return assertNever(categorized)
	}
}
