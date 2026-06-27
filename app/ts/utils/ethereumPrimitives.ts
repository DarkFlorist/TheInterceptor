import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex as nobleBytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { addr, eip191Signer, Transaction } from 'micro-eth-signer'
import { createContract, events } from 'micro-eth-signer/advanced/abi.js'
import { RLP } from 'micro-eth-signer/core/rlp.js'
import { initSig, sign as signDigestWithMicro } from 'micro-eth-signer/utils.js'
import { ens_normalize as normalizeEnsNameWithLocalData } from './ensNormalize.js'

export type Hex = `0x${ string }`
export type RLPInput = unknown
export type AbiStateMutability = 'pure' | 'view' | 'nonpayable' | 'payable'
export type AbiParameter = {
	readonly name?: string
	readonly type: string
	readonly components?: readonly AbiParameter[]
	readonly indexed?: boolean
	readonly internalType?: string
}
export type AbiFunction = {
	readonly type: 'function'
	readonly name: string
	readonly inputs: readonly AbiParameter[]
	readonly outputs: readonly AbiParameter[]
	readonly stateMutability?: AbiStateMutability
}
export type AbiEvent = {
	readonly type: 'event'
	readonly name: string
	readonly inputs: readonly AbiParameter[]
	readonly anonymous?: boolean
}
export type AbiError = {
	readonly type: 'error'
	readonly name: string
	readonly inputs: readonly AbiParameter[]
}
export type AbiConstructor = {
	readonly type: 'constructor'
	readonly inputs: readonly AbiParameter[]
	readonly stateMutability?: AbiStateMutability
}
export type AbiFallback = {
	readonly type: 'fallback' | 'receive'
	readonly stateMutability?: AbiStateMutability
}
export type AbiItem = AbiFunction | AbiEvent | AbiError | AbiConstructor | AbiFallback
export type Abi = readonly AbiItem[]
export type AbiItemType = AbiItem['type']
export type ContractFunctionName<TAbi extends Abi> = Extract<TAbi[number], { readonly type: 'function' }>['name'] & string
export type ContractEventName<TAbi extends Abi> = Extract<TAbi[number], { readonly type: 'event' }>['name'] & string
type AbiIntegerType = `${ 'uint' | 'int' }${ string }`
type AbiParameterWithType<TParameter extends AbiParameter, TType extends string> = TParameter extends { readonly components: infer TComponents extends readonly AbiParameter[] }
	? { readonly type: TType, readonly components: TComponents }
	: { readonly type: TType }
type AbiParametersHaveNames<TParameters extends readonly AbiParameter[]> = TParameters extends readonly []
	? true
	: TParameters extends readonly [infer TFirst extends AbiParameter, ...infer TRest extends readonly AbiParameter[]]
		? TFirst['name'] extends string ? AbiParametersHaveNames<TRest> : false
		: boolean
type AbiParametersToInputTuple<TParameters extends readonly AbiParameter[]> = {
	readonly [TIndex in keyof TParameters]: TParameters[TIndex] extends AbiParameter ? AbiParameterToInputType<TParameters[TIndex]> : never
}
type AbiParametersToOutputTuple<TParameters extends readonly AbiParameter[]> = {
	readonly [TIndex in keyof TParameters]: TParameters[TIndex] extends AbiParameter ? AbiParameterToOutputType<TParameters[TIndex]> : never
}
type AbiParametersToInputObject<TParameters extends readonly AbiParameter[]> = {
	readonly [TParameter in TParameters[number] as TParameter['name'] extends string ? TParameter['name'] : never]: AbiParameterToInputType<TParameter>
}
type AbiParametersToOutputObject<TParameters extends readonly AbiParameter[]> = {
	readonly [TParameter in TParameters[number] as TParameter['name'] extends string ? TParameter['name'] : never]: AbiParameterToOutputType<TParameter>
}
type AbiParameterToInputType<TParameter extends AbiParameter> = string extends TParameter['type']
	? unknown
	: TParameter['type'] extends `${ infer TElementType }[${ string }]`
		? readonly AbiParameterToInputType<AbiParameterWithType<TParameter, TElementType>>[]
		: TParameter['type'] extends 'tuple' | `tuple${ string }`
			? TParameter['components'] extends readonly AbiParameter[]
				? AbiParametersHaveNames<TParameter['components']> extends true
					? AbiParametersToInputObject<TParameter['components']> | AbiParametersToInputTuple<TParameter['components']>
					: AbiParametersToInputTuple<TParameter['components']>
				: readonly unknown[]
			: TParameter['type'] extends 'address' ? string
				: TParameter['type'] extends 'string' ? string
					: TParameter['type'] extends 'bool' ? boolean
						: TParameter['type'] extends 'bytes' | `bytes${ number }` ? Hex | Uint8Array
							: TParameter['type'] extends AbiIntegerType ? bigint | number | string
								: unknown
type AbiParameterToOutputType<TParameter extends AbiParameter> = string extends TParameter['type']
	? unknown
	: TParameter['type'] extends `${ infer TElementType }[${ string }]`
		? readonly AbiParameterToOutputType<AbiParameterWithType<TParameter, TElementType>>[]
		: TParameter['type'] extends 'tuple' | `tuple${ string }`
			? TParameter['components'] extends readonly AbiParameter[]
				? AbiParametersHaveNames<TParameter['components']> extends true
					? AbiParametersToOutputObject<TParameter['components']>
					: AbiParametersToOutputTuple<TParameter['components']>
				: readonly unknown[]
			: TParameter['type'] extends 'address' | 'bytes' | `bytes${ number }` ? Hex
				: TParameter['type'] extends 'string' ? string
					: TParameter['type'] extends 'bool' ? boolean
						: TParameter['type'] extends AbiIntegerType ? bigint
							: unknown
type AbiFunctionForName<TAbi extends Abi, TName extends string> = Extract<TAbi[number], { readonly type: 'function', readonly name: TName }>
type AbiFunctionInputs<TAbi extends Abi, TName extends string> = AbiFunctionForName<TAbi, TName>['inputs']
type AbiFunctionOutputs<TAbi extends Abi, TName extends string> = AbiFunctionForName<TAbi, TName>['outputs']
export type ContractFunctionArgs<
	TAbi extends Abi,
	_TStateMutability extends AbiStateMutability,
	_TName extends ContractFunctionName<TAbi>,
> = AbiFunctionInputs<TAbi, _TName> extends readonly AbiParameter[] ? AbiParametersToInputTuple<AbiFunctionInputs<TAbi, _TName>> : readonly unknown[]
export type ContractFunctionReturnType<
	TAbi extends Abi,
	_TStateMutability extends AbiStateMutability,
	TName extends string,
> = AbiFunctionOutputs<TAbi, TName> extends readonly []
	? readonly []
	: AbiFunctionOutputs<TAbi, TName> extends readonly [infer TOnlyOutput extends AbiParameter]
		? AbiParameterToOutputType<TOnlyOutput>
		: AbiFunctionOutputs<TAbi, TName> extends readonly AbiParameter[] ? AbiParametersToOutputTuple<AbiFunctionOutputs<TAbi, TName>> : unknown
export type DecodeFunctionDataReturnType<TAbi extends Abi> = {
	readonly functionName: ContractFunctionName<TAbi>
	readonly args: readonly unknown[]
}
export type DecodeEventLogReturnType<
	TAbi extends Abi,
	_TEventName extends ContractEventName<TAbi>,
	_TTopics extends readonly Hex[],
	_TData extends Hex,
	_TStrict extends boolean,
> = {
	readonly eventName: ContractEventName<TAbi>
	readonly args?: readonly unknown[] | Record<string, unknown>
}

type AbiCodecMethod = {
	readonly encodeInput: (value?: unknown) => Uint8Array
	readonly decodeOutput: (bytes: Uint8Array) => unknown
}

type TypedDataField = {
	readonly name: string
	readonly type: string
}

type TypedData = {
	readonly types: { readonly EIP712Domain?: readonly TypedDataField[] } & Record<string, readonly TypedDataField[] | undefined>
	readonly primaryType: string
	readonly domain: Record<string, unknown>
	readonly message: Record<string, unknown>
}

type HashStructParameters = {
	readonly data: Record<string, unknown>
	readonly primaryType: string
	readonly types: Record<string, readonly TypedDataField[] | undefined>
}

const ABI_CODEC_FUNCTION_NAME = '__interceptor_abi_codec'
const HEX_REGEX = /^0x[0-9a-fA-F]*$/u
const HEX_INTEGER_STRING_REGEX = /^0x[0-9a-fA-F]+$/u
const DECIMAL_INTEGER_STRING_REGEX = /^-?[0-9]+$/u
const INTEGER_REGEX = /^(u?)int([0-9]*)$/u
const FIXED_BYTES_REGEX = /^bytes([1-9]|[12][0-9]|3[0-2])$/u
const PACKED_ARRAY_TYPE_REGEX = /^(.*)\[([0-9]*)\]$/u
const PACKED_ARRAY_ELEMENT_BYTES = 32
const DOMAIN_FIELD_TYPES = {
	name: 'string',
	version: 'string',
	chainId: 'uint256',
	verifyingContract: 'address',
	salt: 'bytes32',
} as const
const encodeRlpWithMicro = RLP.encode as (value: unknown) => Uint8Array
const prepareMicroTransaction = Transaction.prepare as (data: Record<string, unknown>) => { readonly toHex: (includeSignature?: boolean) => string }
const createMicroTransaction = (
	type: string,
	raw: Record<string, unknown>,
	strict: boolean,
	allowSignatureFields: boolean,
) => Reflect.construct(Transaction, [type, raw, strict, allowSignatureFields]) as { readonly toHex: (includeSignature?: boolean) => string }

const ensureHex = (value: string, name = 'hex'): Hex => {
	if (!HEX_REGEX.test(value)) throw new Error(`${ name } must be a 0x-prefixed hex string`)
	if (value.length % 2 !== 0) throw new Error(`${ name } must have an even number of hex digits`)
	return value as Hex
}

const stripHexPrefix = (value: Hex) => value.slice(2)

const bytesFromHex = (value: Hex) => hexToBytes(stripHexPrefix(value))

const bytesFromHexOrBytes = (value: Hex | Uint8Array): Uint8Array => value instanceof Uint8Array ? value : bytesFromHex(ensureHex(value))

const isHex = (value: Hex | Uint8Array): value is Hex => typeof value === 'string'

const bytes32FromBigint = (value: bigint): Hex => {
	if (value < 0n || value >= 2n ** 256n) throw new Error('Value is out of bytes32 range')
	return `0x${ value.toString(16).padStart(64, '0') }`
}

const parseIntegerString = (value: string): bigint | undefined => {
	if (DECIMAL_INTEGER_STRING_REGEX.test(value) || HEX_INTEGER_STRING_REGEX.test(value)) return BigInt(value)
	return undefined
}

const integerToMinimalBytes = (value: number | bigint): Uint8Array => {
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Number "${ value }" is not in safe integer range`)
		return integerToMinimalBytes(BigInt(value))
	}
	if (value < 0n) throw new Error(`Number "${ value }" is not in safe integer range`)
	const hex = value.toString(16)
	return hexToBytes(hex.length % 2 === 0 ? hex : `0${ hex }`)
}

const bytesFromTypedDataPrimitive = (value: unknown): Uint8Array => {
	if (value instanceof Uint8Array) return value
	if (typeof value === 'boolean') return new Uint8Array([value ? 1 : 0])
	if (typeof value === 'number' || typeof value === 'bigint') return integerToMinimalBytes(value)
	if (typeof value === 'string') {
		if (HEX_REGEX.test(value)) {
			const hex = stripHexPrefix(value as Hex)
			return hexToBytes(hex.length % 2 === 0 ? hex : `0${ hex }`)
		}
		return utf8ToBytes(value)
	}
	return utf8ToBytes(String(value))
}

const bytesFromTypedDataString = (value: unknown): Uint8Array => typeof value === 'string' ? utf8ToBytes(value) : bytesFromTypedDataPrimitive(value)

const canonicalAbiType = (type: string): string => {
	if (type.startsWith('uint[') || type === 'uint') return type.replace(/^uint/u, 'uint256')
	if (type.startsWith('int[') || type === 'int') return type.replace(/^int/u, 'int256')
	return type
}

const splitTopLevel = (input: string): string[] => {
	const parts: string[] = []
	let depth = 0
	let start = 0
	for (let index = 0; index < input.length; index++) {
		const char = input[index]
		if (char === '(') depth++
		if (char === ')') depth--
		if (depth < 0) throw new Error(`Unexpected ")" in ${ input }`)
		if (char !== ',' || depth !== 0) continue
		parts.push(input.slice(start, index).trim())
		start = index + 1
	}
	if (depth !== 0) throw new Error(`Unbalanced parentheses in ${ input }`)
	const finalPart = input.slice(start).trim()
	return finalPart === '' ? parts : [...parts, finalPart]
}

const findMatchingParen = (input: string, openIndex: number): number => {
	let depth = 0
	for (let index = openIndex; index < input.length; index++) {
		const char = input[index]
		if (char === '(') depth++
		if (char === ')') depth--
		if (depth === 0) return index
	}
	throw new Error(`Unbalanced parentheses in ${ input }`)
}

const tupleParameterFrom = (
	rawParameter: string,
	components: readonly AbiParameter[],
	suffixAndName: string,
	indexed: boolean,
): AbiParameter => {
	const match = suffixAndName.match(/^((?:\[[0-9]*\])*)(?:\s*([A-Za-z_$][A-Za-z0-9_$]*))?$/u)
	if (match === null) throw new Error(`Invalid tuple ABI parameter: ${ rawParameter }`)
	return {
		type: `tuple${ match[1] ?? '' }`,
		components,
		...(match[2] === undefined ? {} : { name: match[2] }),
		...(indexed ? { indexed } : {}),
	}
}

const parseAbiParameter = (rawParameter: string): AbiParameter => {
	const withoutLocation = rawParameter.trim()
		.replace(/\s+(memory|calldata|storage)(?=\s|$)/gu, '')
		.replace(/\baddress\s+payable\b/gu, 'address')
	const indexed = /(^|\s)indexed(\s|$)/u.test(withoutLocation)
	const parameter = withoutLocation.replace(/(^|\s)indexed(?=\s|$)/u, ' ').trim()
	if (parameter === '') throw new Error('Empty ABI parameter')
	if (parameter.startsWith('(')) {
		const closeIndex = findMatchingParen(parameter, 0)
		const components = parseAbiParameters(parameter.slice(1, closeIndex))
		return tupleParameterFrom(rawParameter, components, parameter.slice(closeIndex + 1).trim(), indexed)
	}
	if (parameter.startsWith('tuple(')) {
		const closeIndex = findMatchingParen(parameter, 'tuple'.length)
		const components = parseAbiParameters(parameter.slice('tuple('.length, closeIndex))
		return tupleParameterFrom(rawParameter, components, parameter.slice(closeIndex + 1).trim(), indexed)
	}
	const [type, name, ...extra] = parameter.split(/\s+/u)
	if (type === undefined || extra.length > 0) throw new Error(`Invalid ABI parameter: ${ rawParameter }`)
	return {
		type: canonicalAbiType(type),
		...(name === undefined ? {} : { name }),
		...(indexed ? { indexed } : {}),
	}
}

export const parseAbiParameters = (parameters: string): readonly AbiParameter[] => {
	const trimmed = parameters.trim()
	if (trimmed === '') return []
	return splitTopLevel(trimmed).map(parseAbiParameter)
}

export const parseAbiItem = (item: string): AbiItem => {
	const trimmed = item.trim()
	if (trimmed.startsWith('constructor')) {
		const openIndex = trimmed.indexOf('(')
		if (openIndex === -1) throw new Error(`Invalid constructor ABI item: ${ item }`)
		const closeIndex = findMatchingParen(trimmed, openIndex)
		const rest = trimmed.slice(closeIndex + 1).trim()
		return {
			type: 'constructor',
			stateMutability: /\bpayable\b/u.test(rest) ? 'payable' : 'nonpayable',
			inputs: parseAbiParameters(trimmed.slice(openIndex + 1, closeIndex)),
		}
	}
	if (trimmed.startsWith('fallback')) {
		const openIndex = trimmed.indexOf('(')
		if (openIndex === -1) throw new Error(`Invalid fallback ABI item: ${ item }`)
		const closeIndex = findMatchingParen(trimmed, openIndex)
		return {
			type: 'fallback',
			stateMutability: /\bpayable\b/u.test(trimmed.slice(closeIndex + 1)) ? 'payable' : 'nonpayable',
		}
	}
	if (trimmed.startsWith('receive')) {
		const openIndex = trimmed.indexOf('(')
		if (openIndex === -1) throw new Error(`Invalid receive ABI item: ${ item }`)
		const closeIndex = findMatchingParen(trimmed, openIndex)
		return {
			type: 'receive',
			stateMutability: /\bpayable\b/u.test(trimmed.slice(closeIndex + 1)) ? 'payable' : 'nonpayable',
		}
	}
	if (trimmed.startsWith('function ')) {
		const afterKeyword = trimmed.slice('function '.length).trim()
		const openIndex = afterKeyword.indexOf('(')
		if (openIndex === -1) throw new Error(`Invalid function ABI item: ${ item }`)
		const closeIndex = findMatchingParen(afterKeyword, openIndex)
		const name = afterKeyword.slice(0, openIndex).trim()
		const rest = afterKeyword.slice(closeIndex + 1).trim()
		const returnsMatch = rest.match(/\breturns\s*\((.*)\)/u)
		const mutability = (['pure', 'view', 'payable', 'nonpayable'] as const).find((entry) => new RegExp(`\\b${ entry }\\b`, 'u').test(rest))
		return {
			type: 'function',
			name,
			stateMutability: mutability ?? 'nonpayable',
			inputs: parseAbiParameters(afterKeyword.slice(openIndex + 1, closeIndex)),
			outputs: returnsMatch === null ? [] : parseAbiParameters(returnsMatch[1] ?? ''),
		}
	}
	if (trimmed.startsWith('event ')) {
		const afterKeyword = trimmed.slice('event '.length).trim()
		const openIndex = afterKeyword.indexOf('(')
		if (openIndex === -1) throw new Error(`Invalid event ABI item: ${ item }`)
		const closeIndex = findMatchingParen(afterKeyword, openIndex)
		return {
			type: 'event',
			name: afterKeyword.slice(0, openIndex).trim(),
			inputs: parseAbiParameters(afterKeyword.slice(openIndex + 1, closeIndex)),
			...(afterKeyword.slice(closeIndex + 1).includes('anonymous') ? { anonymous: true } : {}),
		}
	}
	if (trimmed.startsWith('error ')) {
		const afterKeyword = trimmed.slice('error '.length).trim()
		const openIndex = afterKeyword.indexOf('(')
		if (openIndex === -1) throw new Error(`Invalid error ABI item: ${ item }`)
		const closeIndex = findMatchingParen(afterKeyword, openIndex)
		return {
			type: 'error',
			name: afterKeyword.slice(0, openIndex).trim(),
			inputs: parseAbiParameters(afterKeyword.slice(openIndex + 1, closeIndex)),
		}
	}
	throw new Error(`Unsupported ABI item: ${ item }`)
}

const formatAbiParameterType = (parameter: AbiParameter): string => {
	if (parameter.type.startsWith('tuple')) {
		if (parameter.components === undefined) throw new Error('Tuple ABI parameter is missing components')
		const components = parameter.components.map(formatAbiParameterType).join(',')
		return '(' + components + ')' + parameter.type.slice('tuple'.length)
	}
	return canonicalAbiType(parameter.type)
}

export const formatAbiItem = (item: AbiItem): string => {
	if (item.type !== 'function' && item.type !== 'event' && item.type !== 'error') throw new Error(`Cannot format ABI item type ${ item.type }`)
	return `${ item.name }(${ item.inputs.map(formatAbiParameterType).join(',') })`
}

const removeTopLevelParameterName = (parameter: AbiParameter): AbiParameter => {
	return {
		type: parameter.type,
		...(parameter.components === undefined ? {} : { components: parameter.components }),
		...(parameter.indexed === undefined ? {} : { indexed: parameter.indexed }),
		...(parameter.internalType === undefined ? {} : { internalType: parameter.internalType }),
	}
}

const abiCodec = (parameters: readonly AbiParameter[]): AbiCodecMethod => {
	const codecAbi = [{
		type: 'function',
		name: ABI_CODEC_FUNCTION_NAME,
		inputs: parameters.map(removeTopLevelParameterName),
		outputs: parameters.map(removeTopLevelParameterName),
	}] as const
	const contract = createContract(codecAbi)
	const method = Reflect.get(contract, ABI_CODEC_FUNCTION_NAME)
	if (typeof method !== 'object' || method === null) throw new Error('Failed to create ABI codec')
	if (!('encodeInput' in method) || !('decodeOutput' in method)) throw new Error('Invalid ABI codec')
	return method as AbiCodecMethod
}

const arrayChildParameter = (parameter: AbiParameter): AbiParameter => ({
	...parameter,
	type: parameter.type.replace(/\[[0-9]*\]$/u, ''),
})

const hasNamedComponents = (parameter: AbiParameter): parameter is AbiParameter & { readonly components: readonly (AbiParameter & { readonly name: string })[] } => {
	return parameter.components !== undefined && parameter.components.length > 0 && parameter.components.every((component) => component.name !== undefined && component.name !== '')
}

const normalizeAbiInputValue = (parameter: AbiParameter, value: unknown): unknown => {
	if (parameter.type.endsWith(']')) {
		if (!Array.isArray(value)) return value
		const child = arrayChildParameter(parameter)
		return value.map((entry) => normalizeAbiInputValue(child, entry))
	}
	if (parameter.type.startsWith('tuple')) {
		if (parameter.components === undefined) return value
		if (hasNamedComponents(parameter)) {
			const components = parameter.components
			if (Array.isArray(value)) {
				return Object.fromEntries(components.map((component, index) => {
					if (component.name === undefined) throw new Error('Named tuple component is missing a name')
					return [component.name, normalizeAbiInputValue(component, value[index])]
				}))
			}
			if (typeof value === 'object' && value !== null) {
				return Object.fromEntries(components.map((component) => {
					if (component.name === undefined) throw new Error('Named tuple component is missing a name')
					return [component.name, normalizeAbiInputValue(component, Reflect.get(value, component.name))]
				}))
			}
		}
		if (Array.isArray(value)) return parameter.components.map((component, index) => normalizeAbiInputValue(component, value[index]))
		return value
	}
	if (parameter.type === 'bytes' || FIXED_BYTES_REGEX.test(parameter.type)) {
		return typeof value === 'string' ? bytesFromHex(ensureHex(value, parameter.type)) : value
	}
	if (parameter.type === 'address' && typeof value === 'string') return getAddress(value)
	if (INTEGER_REGEX.test(parameter.type) && typeof value === 'string') return parseIntegerString(value) ?? value
	return value
}

const normalizeAbiInputValues = (parameters: readonly AbiParameter[], values: readonly unknown[]): unknown => {
	const normalized = parameters.map((parameter, index) => normalizeAbiInputValue(parameter, values[index]))
	if (parameters.length === 0) return undefined
	if (parameters.length === 1) return normalized[0]
	return normalized
}

const normalizeAbiOutputValue = (parameter: AbiParameter, value: unknown): unknown => {
	if (parameter.type.endsWith(']')) {
		if (!Array.isArray(value)) return value
		const child = arrayChildParameter(parameter)
		return value.map((entry) => normalizeAbiOutputValue(child, entry))
	}
	if (parameter.type.startsWith('tuple')) {
		if (parameter.components === undefined) return value
		if (Array.isArray(value)) return parameter.components.map((component, index) => normalizeAbiOutputValue(component, value[index]))
		if (typeof value === 'object' && value !== null && hasNamedComponents(parameter)) {
			const components = parameter.components
			return Object.fromEntries(components.map((component) => {
				if (component.name === undefined) throw new Error('Named tuple component is missing a name')
				return [component.name, normalizeAbiOutputValue(component, Reflect.get(value, component.name))]
			}))
		}
		return value
	}
	if (parameter.type === 'bytes' || FIXED_BYTES_REGEX.test(parameter.type)) {
		return value instanceof Uint8Array ? bytesToHex(value) : value
	}
	if (parameter.type === 'address' && typeof value === 'string') return getAddress(value)
	return value
}

const normalizeAbiOutputValues = (parameters: readonly AbiParameter[], decoded: unknown): readonly unknown[] => {
	if (parameters.length === 0) return []
	if (parameters.length === 1) return [normalizeAbiOutputValue(parameters[0]!, decoded)]
	if (!Array.isArray(decoded)) throw new Error('Expected decoded ABI tuple output')
	return parameters.map((parameter, index) => normalizeAbiOutputValue(parameter, decoded[index]))
}

const normalizeNamedOrIndexedAbiOutput = (parameters: readonly AbiParameter[], decoded: unknown): readonly unknown[] | Record<string, unknown> | undefined => {
	if (decoded === undefined) return undefined
	if (Array.isArray(decoded)) return parameters.map((parameter, index) => normalizeAbiOutputValue(parameter, decoded[index]))
	if (typeof decoded === 'object' && decoded !== null) {
		return Object.fromEntries(Object.entries(decoded).map(([key, value]) => {
			const parameter = parameters.find((entry) => entry.name === key)
			return [key, parameter === undefined ? value : normalizeAbiOutputValue(parameter, value)]
		}))
	}
	return decoded as readonly unknown[]
}

const isHashedIndexedEventParameter = (parameter: AbiParameter): boolean => parameter.type === 'string' || parameter.type === 'bytes' || parameter.type.endsWith(']') || parameter.type.startsWith('tuple')

const withoutIndexed = (parameter: AbiParameter): AbiParameter => ({
	type: parameter.type,
	...(parameter.name === undefined ? {} : { name: parameter.name }),
	...(parameter.components === undefined ? {} : { components: parameter.components }),
	...(parameter.internalType === undefined ? {} : { internalType: parameter.internalType }),
})

const decodeIndexedEventTopic = (parameter: AbiParameter, topic: Hex): unknown => {
	if (isHashedIndexedEventParameter(parameter)) return topic
	return decodeAbiParameters([withoutIndexed(parameter)], topic)[0]
}

const decodeIndexedEventTopics = (parameters: readonly AbiParameter[], topics: readonly Hex[]): readonly unknown[] | Record<string, unknown> => {
	const indexedParameters = parameters.filter((parameter) => parameter.indexed === true)
	const decodedEntries = indexedParameters.map((parameter, index) => {
		const topic = topics[index + 1]
		if (topic === undefined) throw new Error(`Missing indexed event topic for ${ parameter.name ?? parameter.type }`)
		return [parameter, decodeIndexedEventTopic(parameter, topic)] as const
	})
	if (indexedParameters.every((parameter) => parameter.name !== undefined && parameter.name !== '')) {
		return Object.fromEntries(decodedEntries.map(([parameter, value]) => [parameter.name, normalizeAbiOutputValue(parameter, value)]))
	}
	return decodedEntries.map(([parameter, value]) => normalizeAbiOutputValue(parameter, value))
}

export const encodeAbiParameters = (parameters: readonly AbiParameter[], values: readonly unknown[]): Hex => {
	if (parameters.length !== values.length) throw new Error(`ABI value count mismatch: expected ${ parameters.length }, got ${ values.length }`)
	if (parameters.length === 0) return '0x'
	const encoded = abiCodec(parameters).encodeInput(normalizeAbiInputValues(parameters, values)).slice(4)
	return bytesToHex(encoded)
}

export const decodeAbiParameters = (parameters: readonly AbiParameter[], data: Hex): readonly unknown[] => {
	const encoded = bytesFromHex(ensureHex(data, 'ABI data'))
	if (parameters.length === 0) {
		if (encoded.length !== 0) throw new Error('Cannot decode non-empty ABI data with no parameters')
		return []
	}
	return normalizeAbiOutputValues(parameters, abiCodec(parameters).decodeOutput(encoded))
}

export const decodeFunctionData = <const TAbi extends Abi>({ abi, data }: { readonly abi: TAbi, readonly data: Hex }): DecodeFunctionDataReturnType<TAbi> => {
	const selector = data.slice(0, 10)
	const fragment = abi.find((item): item is Extract<TAbi[number], { readonly type: 'function' }> => item.type === 'function' && toFunctionSelector(formatAbiItem(item)) === selector)
	if (fragment === undefined) throw new Error(`Unknown function selector ${ selector }`)
	return {
		functionName: fragment.name as ContractFunctionName<TAbi>,
		args: decodeAbiParameters(fragment.inputs, `0x${ data.slice(10) }`),
	}
}

export const decodeEventLog = <const TAbi extends Abi, const TStrict extends boolean = true>({
	abi,
	data,
	topics,
	strict = true as TStrict,
}: {
	readonly abi: TAbi
	readonly data: Hex
	readonly topics: readonly Hex[]
	readonly strict?: TStrict
}): DecodeEventLogReturnType<TAbi, ContractEventName<TAbi>, Hex[], Hex, TStrict> => {
	const signature = topics[0]
	if (signature === undefined) throw new Error('Missing event signature topic')
	const fragment = abi.find((item): item is Extract<TAbi[number], { readonly type: 'event' }> => item.type === 'event' && toEventSelector(formatAbiItem(item)) === signature)
	if (fragment === undefined) throw new Error(`Unknown event signature ${ signature }`)
	const decoder = events([fragment])
	const method = Reflect.get(decoder, fragment.name)
	if (typeof method !== 'object' || method === null || !('decode' in method)) throw new Error(`Failed to create event decoder for ${ fragment.name }`)
	const decoded = (() => {
		try {
			return (method as { readonly decode: (eventTopics: string[], eventData: string) => unknown }).decode([...topics], data)
		} catch (error) {
			if (strict !== false) throw error
			return decodeIndexedEventTopics(fragment.inputs, topics)
		}
	})()
	return {
		eventName: fragment.name as ContractEventName<TAbi>,
		args: normalizeNamedOrIndexedAbiOutput(fragment.inputs, decoded),
	}
}

export const encodePacked = (types: readonly string[], values: readonly unknown[]): Hex => {
	if (types.length !== values.length) throw new Error(`Packed value count mismatch: expected ${ types.length }, got ${ values.length }`)
	return bytesToHex(concatBytes(...types.map((type, index) => encodePackedValue(canonicalAbiType(type), values[index]))))
}

const splitPackedArrayType = (type: string) => {
	const match = type.match(PACKED_ARRAY_TYPE_REGEX)
	const itemType = match?.[1]
	const lengthText = match?.[2]
	if (itemType === undefined || lengthText === undefined) return undefined
	if (itemType === '') throw new Error(`Invalid packed array type ${ type }`)
	if (lengthText === '') return { itemType }
	const length = Number(lengthText)
	if (!Number.isSafeInteger(length)) throw new Error(`Invalid packed array length for ${ type }`)
	return { itemType, length }
}

const leftPadPackedArrayElement = (bytes: Uint8Array, padByte = 0) => {
	if (bytes.length >= PACKED_ARRAY_ELEMENT_BYTES) return bytes
	const padded = new Uint8Array(PACKED_ARRAY_ELEMENT_BYTES)
	if (padByte !== 0) padded.fill(padByte, 0, PACKED_ARRAY_ELEMENT_BYTES - bytes.length)
	padded.set(bytes, PACKED_ARRAY_ELEMENT_BYTES - bytes.length)
	return padded
}

const rightPadPackedArrayElement = (bytes: Uint8Array) => {
	if (bytes.length >= PACKED_ARRAY_ELEMENT_BYTES) return bytes
	const padded = new Uint8Array(PACKED_ARRAY_ELEMENT_BYTES)
	padded.set(bytes)
	return padded
}

const isNegativePackedSignedInteger = (type: string, value: unknown) => {
	const integerMatch = type.match(INTEGER_REGEX)
	if (integerMatch === null || integerMatch[1] === 'u') return false
	return BigInt(String(value)) < 0n
}

const encodePackedArrayElement = (type: string, value: unknown): Uint8Array => {
	const arrayType = splitPackedArrayType(type)
	if (arrayType !== undefined) return encodePackedArrayValue(arrayType.itemType, arrayType.length, value)
	if (type === 'bytes' || type === 'string') return encodePackedValue(type, value)
	const encoded = encodePackedValue(type, value)
	if (FIXED_BYTES_REGEX.test(type)) return rightPadPackedArrayElement(encoded)
	return leftPadPackedArrayElement(encoded, isNegativePackedSignedInteger(type, value) ? 0xff : 0)
}

const encodePackedArrayValue = (itemType: string, length: number | undefined, value: unknown): Uint8Array => {
	if (!Array.isArray(value)) throw new Error(`Packed array value for ${ itemType } must be an array`)
	if (length !== undefined && value.length !== length) throw new Error(`Packed array value for ${ itemType } must have ${ length } entries`)
	return concatBytes(...value.map((entry) => encodePackedArrayElement(itemType, entry)))
}

const encodePackedValue = (type: string, value: unknown): Uint8Array => {
	const arrayType = splitPackedArrayType(type)
	if (arrayType !== undefined) return encodePackedArrayValue(arrayType.itemType, arrayType.length, value)
	if (type === 'address') return bytesFromHex(ensureHex(getAddress(String(value)), 'address'))
	if (type === 'bool') return value === true ? new Uint8Array([1]) : value === false ? new Uint8Array([0]) : integerToBytes(BigInt(String(value)), 8, false)
	if (type === 'string') return utf8ToBytes(String(value))
	if (type === 'bytes') return bytesFromHex(ensureHex(String(value), 'bytes'))
	const fixedBytesMatch = type.match(FIXED_BYTES_REGEX)
	if (fixedBytesMatch !== null) {
		const size = Number(fixedBytesMatch[1])
		const bytes = bytesFromHex(ensureHex(String(value), type))
		if (bytes.length !== size) throw new Error(`${ type } value must be ${ size } bytes`)
		return bytes
	}
	const integerMatch = type.match(INTEGER_REGEX)
	if (integerMatch !== null) {
		const signed = integerMatch[1] !== 'u'
		const bits = integerMatch[2] === '' ? 256 : Number(integerMatch[2])
		if (!Number.isInteger(bits) || bits <= 0 || bits > 256 || bits % 8 !== 0) throw new Error(`Invalid integer type ${ type }`)
		return integerToBytes(typeof value === 'bigint' ? value : BigInt(String(value)), bits, signed)
	}
	throw new Error(`Packed encoding for ${ type } is not supported`)
}

const integerToBytes = (value: bigint, bits: number, signed: boolean): Uint8Array => {
	const byteLength = bits / 8
	const max = signed ? 2n ** BigInt(bits - 1) - 1n : 2n ** BigInt(bits) - 1n
	const min = signed ? -(2n ** BigInt(bits - 1)) : 0n
	if (value < min || value > max) throw new Error(`Integer value ${ value } is out of range for ${ bits } bits`)
	const encoded = value < 0n ? 2n ** BigInt(bits) + value : value
	const hex = encoded.toString(16).padStart(byteLength * 2, '0')
	return hexToBytes(hex)
}

export function concat(values: readonly Hex[]): Hex
export function concat(values: readonly (Hex | Uint8Array)[]): Hex | Uint8Array
export function concat(values: readonly (Hex | Uint8Array)[]): Hex | Uint8Array {
	if (values.every(isHex)) {
		return `0x${ values.map((value) => stripHexPrefix(ensureHex(value))).join('') }`
	}
	if (values.some(isHex)) throw new Error('Cannot concat hex strings and byte arrays')
	return concatBytes(...values.map((value) => bytesFromHexOrBytes(value)))
}

export const bytesToHex = (bytes: Uint8Array): Hex => `0x${ nobleBytesToHex(bytes) }`

export const stringToBytes = (value: string): Uint8Array => utf8ToBytes(value)

export const keccak256 = (value: Hex | Uint8Array): Hex => bytesToHex(keccak_256(bytesFromHexOrBytes(value)))

export const toFunctionSelector = (signature: string | AbiItem): Hex => {
	const formatted = typeof signature === 'string' ? signature : formatAbiItem(signature)
	return `0x${ stripHexPrefix(keccak256(stringToBytes(formatted))).slice(0, 8) }`
}

export const toEventSelector = (signature: string | AbiItem): Hex => {
	const formatted = typeof signature === 'string' ? signature : formatAbiItem(signature)
	return keccak256(stringToBytes(formatted))
}

export const getAddress = (address: string): Hex => {
	if (!addr.isValid(address)) throw new Error(`Address "${ address }" is invalid`)
	return addr.addChecksum(address) as Hex
}

export const isAddress = (address: string): boolean => addr.isValid(address)

export const getCreate2Address = ({ from, salt, bytecodeHash }: { readonly from: string, readonly salt: Hex, readonly bytecodeHash: Hex }): Hex => {
	const fromBytes = bytesFromHex(ensureHex(getAddress(from), 'from'))
	const saltBytes = bytesFromHex(ensureHex(salt, 'salt'))
	const bytecodeHashBytes = bytesFromHex(ensureHex(bytecodeHash, 'bytecodeHash'))
	if (saltBytes.length !== 32) throw new Error('CREATE2 salt must be 32 bytes')
	if (bytecodeHashBytes.length !== 32) throw new Error('CREATE2 bytecodeHash must be 32 bytes')
	const hash = keccak256(concatBytes(new Uint8Array([0xff]), fromBytes, saltBytes, bytecodeHashBytes))
	return getAddress(`0x${ stripHexPrefix(hash).slice(24) }`)
}

const assertValidRlpInput = (value: unknown): void => {
	if (typeof value === 'string') {
		ensureHex(value, 'RLP value')
		return
	}
	if (Array.isArray(value)) {
		for (const entry of value) assertValidRlpInput(entry)
		return
	}
	throw new Error('RLP value must be a hex string or array of RLP values')
}

export function toRlp(value: RLPInput, to?: 'hex'): Hex
export function toRlp(value: RLPInput, to: 'bytes'): Uint8Array
export function toRlp(value: RLPInput, to: 'hex' | 'bytes' = 'hex'): Hex | Uint8Array {
	assertValidRlpInput(value)
	const encoded = encodeRlpWithMicro(value)
	return to === 'bytes' ? encoded : bytesToHex(encoded)
}

export const namehash = (name: string): Hex => {
	let node: Uint8Array<ArrayBufferLike> = new Uint8Array(32)
	if (name === '') return bytesToHex(node)
	for (const label of name.split('.').reverse()) {
		if (label === '') throw new Error('ENS name contains an empty label')
		node = keccak_256(concatBytes(node, keccak_256(stringToBytes(label))))
	}
	return bytesToHex(node)
}

export const ens_normalize = (name: string) => {
	if (name === '') return ''
	try {
		return normalizeEnsNameWithLocalData(name)
	} catch (error) {
		if (error instanceof Error) throw new Error(`Invalid ENS name: ${ error.message }`)
		throw new Error('Invalid ENS name')
	}
}

export const hashMessage = (message: string | { readonly raw: Hex | Uint8Array }): Hex => {
	if (typeof message === 'string') return eip191Signer._getHash(message) as Hex
	return eip191Signer._getHash(bytesFromHexOrBytes(message.raw)) as Hex
}

const getTypedDataDependencies = (types: Record<string, readonly TypedDataField[] | undefined>, primaryType: string, found = new Set<string>()): Set<string> => {
	const fields = types[primaryType]
	if (fields === undefined) throw new Error(`Unknown EIP-712 type ${ primaryType }`)
	for (const field of fields) {
		const baseType = getBaseTypedDataType(field.type)
		if (baseType === primaryType || found.has(baseType) || types[baseType] === undefined) continue
		found.add(baseType)
		getTypedDataDependencies(types, baseType, found)
	}
	return found
}

const getBaseTypedDataType = (type: string) => type.replace(/\[[0-9]*\]/gu, '')

const encodeTypedDataType = (types: Record<string, readonly TypedDataField[] | undefined>, primaryType: string): string => {
	const fields = types[primaryType]
	if (fields === undefined) throw new Error(`Unknown EIP-712 type ${ primaryType }`)
	return `${ primaryType }(${ fields.map((field) => `${ field.type } ${ field.name }`).join(',') })`
}

const encodeType = (types: Record<string, readonly TypedDataField[] | undefined>, primaryType: string): string => {
	const dependencies = [...getTypedDataDependencies(types, primaryType)].sort()
	return [primaryType, ...dependencies].map((type) => encodeTypedDataType(types, type)).join('')
}

const splitArrayTypedDataType = (type: string): { readonly itemType: string } | undefined => {
	const match = type.match(/^(.+)\[[0-9]*\]$/u)
	return match?.[1] === undefined ? undefined : { itemType: match[1] }
}

const normalizeEip712PrimitiveValue = (type: string, value: unknown): unknown => {
	if (INTEGER_REGEX.test(type) && typeof value === 'string') return parseIntegerString(value) ?? value
	if ((type === 'bytes' || FIXED_BYTES_REGEX.test(type)) && typeof value === 'string') return bytesFromHex(ensureHex(value, type))
	return value
}

const encodeTypedDataValue = (
	type: string,
	value: unknown,
	types: Record<string, readonly TypedDataField[] | undefined>,
): { readonly abiType: string, readonly value: unknown } => {
	const arrayType = splitArrayTypedDataType(type)
	if (arrayType !== undefined) {
		if (!Array.isArray(value)) throw new Error(`Expected array value for ${ type }`)
		const encodedItems = value.map((entry) => {
			const encoded = encodeTypedDataValue(arrayType.itemType, entry, types)
			return bytesFromHex(encodeAbiParameters([{ type: encoded.abiType }], [encoded.value]))
		})
		return { abiType: 'bytes32', value: keccak256(concatBytes(...encodedItems)) }
	}
	if (types[type] !== undefined) {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Expected object value for ${ type }`)
		return { abiType: 'bytes32', value: hashStruct({ data: value as Record<string, unknown>, primaryType: type, types }) }
	}
		if (type === 'string') return { abiType: 'bytes32', value: keccak256(bytesFromTypedDataString(value)) }
		if (type === 'bytes') return { abiType: 'bytes32', value: keccak256(bytesFromTypedDataPrimitive(value)) }
	return { abiType: canonicalAbiType(type), value: normalizeEip712PrimitiveValue(canonicalAbiType(type), value) }
}

export const hashStruct = ({ data, primaryType, types }: HashStructParameters): Hex => {
	const fields = types[primaryType]
	if (fields === undefined) throw new Error(`Unknown EIP-712 type ${ primaryType }`)
	const encodedValues = fields.map((field) => {
		const value = data[field.name]
		if (value === undefined) throw new Error(`Missing EIP-712 value for ${ primaryType }.${ field.name }`)
		return encodeTypedDataValue(field.type, value, types)
	})
	return keccak256(encodeAbiParameters(
		[{ type: 'bytes32' }, ...encodedValues.map((entry) => ({ type: entry.abiType }))],
		[keccak256(stringToBytes(encodeType(types, primaryType))), ...encodedValues.map((entry) => entry.value)],
	))
}

const getDomainType = (domain: Record<string, unknown>): readonly TypedDataField[] => {
	return Object.entries(DOMAIN_FIELD_TYPES)
		.filter(([name]) => domain[name] !== undefined)
		.map(([name, type]) => ({ name, type }))
}

export const hashTypedData = (typedData: TypedData): Hex => {
	const domainHash = hashStruct({
		data: typedData.domain,
		primaryType: 'EIP712Domain',
		types: { EIP712Domain: typedData.types.EIP712Domain ?? getDomainType(typedData.domain) },
	})
	const messageHash = hashStruct({
		data: typedData.message,
		primaryType: typedData.primaryType,
		types: typedData.types,
	})
	return keccak256(concatBytes(bytesFromHex('0x1901'), bytesFromHex(domainHash), bytesFromHex(messageHash)))
}

const signDigest = (digest: Hex, privateKey: Hex): Hex => {
	const signature = signDigestWithMicro(bytesFromHex(digest), bytesFromHex(privateKey), false)
	const recovery = signature.recovery
	if (recovery !== 0 && recovery !== 1) throw new Error('Unexpected signature recovery bit')
	return `0x${ signature.toHex('compact') }${ recovery === 0 ? '1b' : '1c' }`
}

const normalizeSignatureYParity = (signature: { readonly yParity?: number, readonly v?: bigint | number }) => {
	if (signature.yParity !== undefined) {
		if (signature.yParity !== 0 && signature.yParity !== 1) throw new Error(`Invalid signature yParity ${ signature.yParity }`)
		return signature.yParity
	}
	if (signature.v === undefined) return 0
	const v = BigInt(signature.v)
	if (v === 0n || v === 1n) return Number(v)
	if (v === 27n || v === 28n) return Number(v - 27n)
	throw new Error(`Invalid signature v ${ v }`)
}

export const privateKeyToAccount = (privateKey: Hex) => {
	const address = addr.fromPrivateKey(privateKey) as Hex
	return {
		address,
		signMessage: async ({ message }: { readonly message: string | { readonly raw: Hex | Uint8Array } }) => {
			if (typeof message === 'string') return eip191Signer.sign(message, privateKey, false) as Hex
			return eip191Signer.sign(bytesFromHexOrBytes(message.raw), privateKey, false) as Hex
		},
		signTypedData: async (typedData: TypedData) => signDigest(hashTypedData(typedData), privateKey),
	}
}

export const recoverAddress = async ({ hash, signature }: {
	readonly hash: Hex | Uint8Array
	readonly signature: Hex | {
		readonly r: Hex | bigint
		readonly s: Hex | bigint
		readonly yParity?: number
		readonly v?: bigint | number
	}
}): Promise<Hex> => {
	const digest = bytesFromHexOrBytes(hash)
	const normalizedSignature = typeof signature === 'string'
		? signatureToParts(signature)
			: {
				r: typeof signature.r === 'bigint' ? signature.r : BigInt(signature.r),
				s: typeof signature.s === 'bigint' ? signature.s : BigInt(signature.s),
				yParity: normalizeSignatureYParity(signature),
			}
	const recoveredSignature = initSig({ r: normalizedSignature.r, s: normalizedSignature.s }, normalizedSignature.yParity)
	return addr.fromPublicKey(recoveredSignature.recoverPublicKey(digest).toBytes(false)) as Hex
}

const signatureToParts = (signature: Hex): { readonly r: bigint, readonly s: bigint, readonly yParity: number } => {
	const hex = stripHexPrefix(ensureHex(signature, 'signature'))
	if (hex.length !== 130) throw new Error('Signature must be 65 bytes')
	const recovery = Number.parseInt(hex.slice(128), 16)
	return {
		r: BigInt(`0x${ hex.slice(0, 64) }`),
		s: BigInt(`0x${ hex.slice(64, 128) }`),
		yParity: normalizeSignatureYParity({ v: recovery }),
	}
}

type SerializableTransaction = {
	readonly type?: 'eip1559' | 'legacy' | 'eip2930' | 'eip4844' | 'eip7702'
	readonly chainId?: number | bigint
	readonly nonce?: number | bigint
	readonly gas?: number | bigint
	readonly gasPrice?: bigint
	readonly maxFeePerGas?: bigint
	readonly maxPriorityFeePerGas?: bigint
	readonly to?: string | null
	readonly value?: bigint
	readonly data?: Hex
	readonly accessList?: readonly { readonly address: string, readonly storageKeys: readonly Hex[] }[]
}

type TransactionSignature = {
	readonly r: Hex | bigint
	readonly s: Hex | bigint
	readonly yParity?: number
	readonly v?: bigint | number
}

export const serializeTransaction = (transaction: SerializableTransaction, signature?: TransactionSignature): Hex => {
	const type = transaction.type ?? 'eip1559'
	if (type !== 'eip1559') throw new Error(`Unsupported transaction type ${ type }`)
	const raw = {
		type: 'eip1559',
		chainId: BigInt(transaction.chainId ?? 0),
		nonce: BigInt(transaction.nonce ?? 0),
		maxFeePerGas: transaction.maxFeePerGas ?? 0n,
		maxPriorityFeePerGas: transaction.maxPriorityFeePerGas ?? 0n,
		gasLimit: BigInt(transaction.gas ?? 0),
		to: transaction.to === undefined || transaction.to === null ? '0x' : transaction.to,
		value: transaction.value ?? 0n,
		data: transaction.data ?? '0x',
		accessList: (transaction.accessList ?? []).map((entry) => ({ address: entry.address, storageKeys: [...entry.storageKeys] })),
		...(signature === undefined ? {} : normalizeTransactionSignature(signature)),
	}
	const prepared = signature === undefined
		? prepareMicroTransaction(raw)
		: createMicroTransaction(type, raw, false, true)
	return prepared.toHex(signature !== undefined) as Hex
}

const normalizeTransactionSignature = (signature: TransactionSignature) => ({
	r: typeof signature.r === 'bigint' ? signature.r : BigInt(signature.r),
	s: typeof signature.s === 'bigint' ? signature.s : BigInt(signature.s),
	yParity: normalizeSignatureYParity(signature),
})

export const parseTransaction = (serializedTransaction: Hex) => {
	const parsed = Transaction.fromHex(serializedTransaction, false)
	if (parsed.type !== 'eip1559') throw new Error(`Unsupported transaction type ${ parsed.type }`)
	const raw = parsed.raw as {
		readonly chainId: bigint
		readonly nonce: bigint
		readonly maxPriorityFeePerGas: bigint
		readonly maxFeePerGas: bigint
		readonly gasLimit: bigint
		readonly to: string
		readonly value: bigint
		readonly data: string
		readonly accessList: readonly { readonly address: string, readonly storageKeys: readonly Hex[] }[]
		readonly r?: bigint
		readonly s?: bigint
		readonly yParity?: number
	}
	return {
		type: 'eip1559' as const,
		chainId: Number(raw.chainId),
		nonce: Number(raw.nonce),
		maxPriorityFeePerGas: raw.maxPriorityFeePerGas,
		maxFeePerGas: raw.maxFeePerGas,
		gas: raw.gasLimit,
		...(raw.to === '0x' ? {} : { to: raw.to.toLowerCase() as Hex }),
		...(raw.value === 0n ? {} : { value: raw.value }),
		...(raw.data === '0x' ? {} : { data: raw.data as Hex }),
		...(raw.accessList.length === 0 ? {} : {
			accessList: raw.accessList.map((entry) => ({
				address: entry.address.toLowerCase() as Hex,
				storageKeys: entry.storageKeys,
			})),
		}),
		...(raw.r !== undefined && raw.s !== undefined && raw.yParity !== undefined ? {
			r: bytes32FromBigint(raw.r),
			s: bytes32FromBigint(raw.s),
			yParity: raw.yParity,
			v: BigInt(raw.yParity + 27),
		} : {}),
	}
}

export const formatUnits = (amount: bigint, decimals: number): string => {
	if (!Number.isInteger(decimals) || decimals < 0) throw new Error('decimals must be a non-negative integer')
	const negative = amount < 0n
	const absolute = negative ? -amount : amount
	const base = 10n ** BigInt(decimals)
	const integer = absolute / base
	const fraction = absolute % base
	if (decimals === 0 || fraction === 0n) return `${ negative ? '-' : '' }${ integer }`
	const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/u, '')
	return `${ negative ? '-' : '' }${ integer }.${ fractionText }`
}
