import { createContract, events } from 'micro-eth-signer/advanced/abi.js'
import {
	bytesFromHex,
	bytesToHex,
	ensureHex,
	getAddress,
	keccak256,
	stringToBytes,
	stripHexPrefix,
	type Hex,
} from './ethereumBytes.js'
import { getRecordProperty, isRecord } from './runtimeTypeGuards.js'

export {
	bytesToHex,
	concat,
	getAddress,
	isAddress,
	keccak256,
	stringToBytes,
	type Hex,
} from './ethereumBytes.js'
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
		? TFirst extends { readonly name: infer TName extends string }
			? TName extends '' ? false : AbiParametersHaveNames<TRest>
			: false
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
type AbiEventParameterToOutputType<TParameter extends AbiParameter> = TParameter['indexed'] extends true
	? TParameter['type'] extends 'string' | 'bytes' | `${ string }[${ string }]` | 'tuple' | `tuple${ string }` ? Hex : AbiParameterToOutputType<TParameter>
	: AbiParameterToOutputType<TParameter>
type AbiEventParametersToOutputTuple<TParameters extends readonly AbiParameter[]> = {
	readonly [TIndex in keyof TParameters]: TParameters[TIndex] extends AbiParameter ? AbiEventParameterToOutputType<TParameters[TIndex]> : never
}
type AbiEventParametersToOutputObject<TParameters extends readonly AbiParameter[]> = {
	readonly [TParameter in TParameters[number] as TParameter['name'] extends string ? TParameter['name'] : never]: AbiEventParameterToOutputType<TParameter>
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
type AbiEventForName<TAbi extends Abi, TName extends string> = Extract<TAbi[number], { readonly type: 'event', readonly name: TName }>
type AbiEventInputs<TAbi extends Abi, TName extends string> = AbiEventForName<TAbi, TName>['inputs']
type AbiEventArgs<TParameters extends readonly AbiParameter[]> = number extends TParameters['length']
	? readonly unknown[] | Record<string, unknown>
	: TParameters extends readonly []
		? Readonly<Record<string, never>>
		: AbiParametersHaveNames<TParameters> extends true
			? AbiEventParametersToOutputObject<TParameters>
			: AbiEventParametersToOutputTuple<TParameters>
type LooseAbiEventArgs<TArgs> = TArgs extends readonly unknown[]
	? { readonly [TIndex in keyof TArgs]: TArgs[TIndex] | undefined }
	: TArgs extends Record<string, unknown> ? Partial<TArgs> : TArgs
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
	TEventName extends ContractEventName<TAbi>,
	_TTopics extends readonly Hex[],
	_TData extends Hex,
	TStrict extends boolean,
> = TEventName extends ContractEventName<TAbi>
	? {
		readonly eventName: TEventName
		readonly args: TStrict extends true
			? AbiEventArgs<AbiEventInputs<TAbi, TEventName>>
			: LooseAbiEventArgs<AbiEventArgs<AbiEventInputs<TAbi, TEventName>>>
	}
	: never

type AbiCodecMethod = {
	readonly encodeInput: (value?: unknown) => Uint8Array
	readonly decodeOutput: (bytes: Uint8Array) => unknown
}

const ABI_CODEC_FUNCTION_NAME = '__interceptor_abi_codec'
const HEX_INTEGER_STRING_REGEX = /^0x[0-9a-fA-F]+$/u
const DECIMAL_INTEGER_STRING_REGEX = /^-?[0-9]+$/u
const INTEGER_REGEX = /^(u?)int([0-9]*)$/u
const FIXED_BYTES_REGEX = /^bytes([1-9]|[12][0-9]|3[0-2])$/u

const parseIntegerString = (value: string): bigint | undefined => {
	if (DECIMAL_INTEGER_STRING_REGEX.test(value) || HEX_INTEGER_STRING_REGEX.test(value)) return BigInt(value)
	return undefined
}

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
	if (!isRecord(contract)) throw new Error('Failed to create ABI codec')
	const method = contract[ABI_CODEC_FUNCTION_NAME]
	if (!isRecord(method)) throw new Error('Failed to create ABI codec')
	const encodeInput = getRecordProperty(method, 'encodeInput')
	const decodeOutput = getRecordProperty(method, 'decodeOutput')
	if (typeof encodeInput !== 'function' || typeof decodeOutput !== 'function') throw new Error('Invalid ABI codec')
	return {
		encodeInput: (value) => encodeInput(value),
		decodeOutput: (bytes) => decodeOutput(bytes),
	}
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
			if (isRecord(value)) {
				return Object.fromEntries(components.map((component) => {
					if (component.name === undefined) throw new Error('Named tuple component is missing a name')
					return [component.name, normalizeAbiInputValue(component, value[component.name])]
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
		if (isRecord(value) && hasNamedComponents(parameter)) {
			const components = parameter.components
			return Object.fromEntries(components.map((component) => {
				if (component.name === undefined) throw new Error('Named tuple component is missing a name')
				return [component.name, normalizeAbiOutputValue(component, value[component.name])]
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
	let topicIndex = 1
	const decodedEntries = parameters.map((parameter) => {
		if (parameter.indexed !== true) return [parameter, undefined] as const
		const topic = topics[topicIndex]
		if (topic === undefined) throw new Error(`Missing indexed event topic for ${ parameter.name ?? parameter.type }`)
		topicIndex += 1
		return [parameter, decodeIndexedEventTopic(parameter, topic)] as const
	})
	if (parameters.every((parameter) => parameter.name !== undefined && parameter.name !== '')) {
		return Object.fromEntries(decodedEntries.flatMap(([parameter, value]) => {
			if (parameter.indexed !== true) return []
			return [[parameter.name, normalizeAbiOutputValue(parameter, value)]]
		}))
	}
	return decodedEntries.map(([parameter, value]) => parameter.indexed === true ? normalizeAbiOutputValue(parameter, value) : undefined)
}

export const encodeAbiParameters = (parameters: readonly AbiParameter[], values: readonly unknown[]): Hex => {
	if (parameters.length !== values.length) throw new Error(`ABI value count mismatch: expected ${ parameters.length }, got ${ values.length }`)
	if (parameters.length === 0) return '0x'
	const encoded = abiCodec(parameters).encodeInput(normalizeAbiInputValues(parameters, values)).slice(4)
	return bytesToHex(encoded)
}

export const ABI_DATA_DECODE_ERROR_CODE = 'abi_data_decode_failed'

export const isAbiDataDecodeError = (error: unknown): boolean => {
	return isRecord(error) && getRecordProperty(error, 'code') === ABI_DATA_DECODE_ERROR_CODE
}

const createAbiDataDecodeError = (cause: unknown) => {
	return Object.assign(new Error('Failed to decode ABI data'), { code: ABI_DATA_DECODE_ERROR_CODE, cause })
}

export const decodeAbiParameters = (parameters: readonly AbiParameter[], data: Hex): readonly unknown[] => {
	const encoded = bytesFromHex(ensureHex(data, 'ABI data'))
	if (parameters.length === 0) {
		if (encoded.length !== 0) throw new Error('Cannot decode non-empty ABI data with no parameters')
		return []
	}
	const codec = abiCodec(parameters)
	let decoded: unknown
	try {
		decoded = codec.decodeOutput(encoded)
	} catch (error) {
		throw createAbiDataDecodeError(error)
	}
	return normalizeAbiOutputValues(parameters, decoded)
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

export function decodeEventLog<const TAbi extends Abi, const TStrict extends boolean = true>(parameters: {
	readonly abi: TAbi
	readonly data: Hex
	readonly topics: readonly Hex[]
	readonly strict?: TStrict
}): DecodeEventLogReturnType<TAbi, ContractEventName<TAbi>, Hex[], Hex, TStrict>
export function decodeEventLog({
	abi,
	data,
	topics,
	strict = true,
}: {
	readonly abi: Abi
	readonly data: Hex
	readonly topics: readonly Hex[]
	readonly strict?: boolean
}) {
	const signature = topics[0]
	if (signature === undefined) throw new Error('Missing event signature topic')
	const fragment = abi.find((item): item is AbiEvent => item.type === 'event' && toEventSelector(formatAbiItem(item)) === signature)
	if (fragment === undefined) throw new Error(`Unknown event signature ${ signature }`)
	const decoder = events([fragment])
	const decoderValue: unknown = decoder
	if (!isRecord(decoderValue)) throw new Error(`Failed to create event decoder for ${ fragment.name }`)
	const method = decoderValue[fragment.name]
	if (!isRecord(method)) throw new Error(`Failed to create event decoder for ${ fragment.name }`)
	const decode = getRecordProperty(method, 'decode')
	if (typeof decode !== 'function') throw new Error(`Failed to create event decoder for ${ fragment.name }`)
	const decoded = (() => {
		try {
			return decode([...topics], data)
		} catch (error) {
			if (strict !== false) throw error
			return decodeIndexedEventTopics(fragment.inputs, topics)
		}
	})()
	return {
		eventName: fragment.name,
		args: normalizeNamedOrIndexedAbiOutput(fragment.inputs, decoded),
	}
}

export const toFunctionSelector = (signature: string | AbiItem): Hex => {
	const formatted = typeof signature === 'string' ? signature : formatAbiItem(signature)
	return `0x${ stripHexPrefix(keccak256(stringToBytes(formatted))).slice(0, 8) }`
}

export const toEventSelector = (signature: string | AbiItem): Hex => {
	const formatted = typeof signature === 'string' ? signature : formatAbiItem(signature)
	return keccak256(stringToBytes(formatted))
}
