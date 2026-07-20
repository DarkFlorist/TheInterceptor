import { assertNever } from './typescript.js'
import { EthereumAddress, EthereumData, EthereumQuantity, NonHexBigInt } from '../types/wire-types.js'
import * as funtypes from 'funtypes'
import { identifyAddress } from '../background/metadataUtils.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { type EnrichedGroupedSolidityType, type PureFlatGroupedSolidityType, type PureGroupedSolidityType, SignedBigInt, SolidityType, type SolidityVariable } from '../types/solidityType.js'
import { promiseAllMapAbortSafe } from './requests.js'
import type { AbiParameter } from './ethereumPrimitives.js'

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
		case 'uint256': return 'unsignedInteger'
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
		case 'int256': return 'signedInteger'
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

export function parseAbiParameterToSolidityValue(parameter: AbiParameter, value: unknown): PureGroupedSolidityType {
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

export function parseSolidityValueByTypePure(type: SolidityType, value: unknown, isArray: boolean): PureFlatGroupedSolidityType {
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
			default: assertNever(categorized)
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
		default: assertNever(categorized)
	}
}
