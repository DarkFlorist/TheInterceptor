import type { Abi, AbiEvent, AbiFunction, AbiItem, AbiParameter, AbiStateMutability, ContractEventName, ContractFunctionArgs, ContractFunctionName, ContractFunctionReturnType, DecodeEventLogReturnType, DecodeFunctionDataReturnType, Hex } from 'viem'
import { parseAbiItem, parseAbiParameters, decodeAbiParameters, decodeEventLog, decodeFunctionData, encodeAbiParameters, formatAbiItem, concat, bytesToHex, toEventSelector, toFunctionSelector } from './viem.js'
import { tryOrFalse } from './try.js'

export type AbiLike = string | readonly (string | AbiItem)[]

export type LooseParsedAbiCall = {
	readonly name: string
	readonly signature: string
	readonly fragment: AbiItem
	readonly args: readonly unknown[]
	readonly namedArgs: Record<string, unknown>
	readonly value: bigint
}

export type LooseParsedAbiEvent = {
	readonly name: string
	readonly signature: string
	readonly fragment: AbiItem
	readonly args: readonly unknown[]
	readonly namedArgs: Record<string, unknown>
}

export type LooseParsedAbiError = {
	readonly name: string
	readonly signature: string
	readonly selector: string
	readonly fragment: AbiItem
	readonly args: readonly unknown[]
	readonly namedArgs: Record<string, unknown>
}

type AbiParameterLike = string | AbiParameter
type AbiError = Extract<AbiItem, { type: 'error' }>

const isAbiItem = (value: unknown): value is AbiItem => {
	if (typeof value !== 'object' || value === null) return false
	if (!('type' in value)) return false
	return typeof value.type === 'string'
}

const isAbiFunction = (item: AbiItem): item is AbiFunction => item.type === 'function'
const isAbiEvent = (item: AbiItem): item is AbiEvent => item.type === 'event'
const isAbiError = (item: AbiItem): item is AbiError => item.type === 'error'
const hasComponents = (
	parameter: AbiParameter,
): parameter is AbiParameter & {
	readonly components: readonly AbiParameter[]
} => 'components' in parameter

const toHex = (value: Hex | Uint8Array): Hex => (value instanceof Uint8Array ? bytesToHex(value) : value)
const sliceHex = (value: Hex, start: number): Hex => (value.length <= start ? '0x' : `0x${ value.slice(start) }`)
const functionSelectorFromData = (data: Hex) => data.slice(0, 10)

const normalizeAbiArray = (abiEntries: readonly unknown[]): Abi => {
	return abiEntries.map((entry) => {
		if (typeof entry === 'string') return parseAbiItem(entry)
		if (isAbiItem(entry)) return entry
		throw new Error('Invalid ABI entry')
	})
}

const normalizeAbiParametersInput = (params: readonly AbiParameterLike[]): readonly AbiParameter[] => {
	if (params.length === 0) return []
	if (params.every((param) => typeof param === 'string')) return parseAbiParameters(params.join(', '))

	const normalized: AbiParameter[] = []
	for (const param of params) {
		if (typeof param !== 'string') {
			normalized.push(param)
			continue
		}
		const parsed = parseAbiParameters(param)
		if (parsed.length !== 1) throw new Error(`Expected a single ABI parameter, got ${ parsed.length }`)
		const [first] = parsed
		if (first === undefined) throw new Error('Failed to parse ABI parameter')
		normalized.push(first)
	}
	return normalized
}

const stripSingleArraySuffix = (type: string) => type.replace(/\[[^\]]*\]$/, '')
const isTupleType = (type: string | undefined) => type !== undefined && stripSingleArraySuffix(type).startsWith('tuple')

const encodeValueForParameter = (parameter: AbiParameter | undefined, value: unknown): unknown => {
	if (parameter === undefined || parameter.type === undefined) return value
	if (parameter.type.endsWith(']')) {
		if (!Array.isArray(value)) return value
		const innerType = stripSingleArraySuffix(parameter.type)
		return value.map((entry) => encodeValueForParameter({ ...parameter, type: innerType }, entry))
	}
	if (!isTupleType(parameter.type) || !hasComponents(parameter)) return value
	if (Array.isArray(value)) return parameter.components.map((component, index) => encodeValueForParameter(component, value[index]))
	if (typeof value === 'object' && value !== null) {
		return parameter.components.map((component) => encodeValueForParameter(component, Reflect.get(value, component.name ?? '')))
	}
	return value
}

const encodeValuesForParameters = (parameters: readonly AbiParameter[], values: readonly unknown[]) => {
	return values.map((value, index) => encodeValueForParameter(parameters[index], value))
}

const toNamedArgs = (params: readonly AbiParameter[], values: readonly unknown[]) => {
	const namedArgs: Record<string, unknown> = {}
	for (const [index, value] of values.entries()) {
		const param = params[index]
		if (param?.name !== undefined && param.name !== '') namedArgs[param.name] = value
	}
	return namedArgs
}

const getFunctionFragmentInternal = (abi: Abi, nameOrSelector: string, argsLength: number | undefined = undefined): AbiFunction | undefined => {
	const functions = abi.filter(isAbiFunction)
	const matches = nameOrSelector.startsWith('0x') && nameOrSelector.length === 10 ? functions.filter((item) => toFunctionSelector(formatAbiItem(item)) === nameOrSelector) : functions.filter((item) => item.name === nameOrSelector)
	if (matches.length <= 1 || argsLength === undefined) return matches[0]
	return matches.find((item) => item.inputs.length === argsLength) ?? matches[0]
}

const getEventFragmentInternal = (abi: Abi, selector: string): AbiEvent | undefined => {
	return abi.filter(isAbiEvent).find((item) => toEventSelector(formatAbiItem(item)) === selector)
}

const getErrorFragmentInternal = (abi: Abi, selector: string, argsLength: number | undefined = undefined): AbiError | undefined => {
	const errors = abi.filter(isAbiError)
	const matches = errors.filter((item) => toFunctionSelector(formatAbiItem(item)) === selector)
	if (matches.length <= 1 || argsLength === undefined) return matches[0]
	return matches.find((item) => item.inputs.length === argsLength) ?? matches[0]
}

const decodeValues = (params: readonly AbiParameter[], data: Hex): readonly unknown[] => {
	if (params.length === 0) return []
	return decodeAbiParameters(params, data)
}

const decodeFunctionOutputValuesLoose = (abiLike: AbiLike, functionName: string, data: Hex | Uint8Array) => {
	const abi = normalizeAbi(abiLike)
	const fragment = getFunctionFragmentInternal(abi, functionName)
	if (fragment === undefined) throw new Error(`Unknown function ${ functionName }`)
	const decoded = decodeValues(fragment.outputs, toHex(data))
	if (fragment.outputs.length === 1) return [decoded[0]]
	return decoded
}

const encodeFunctionCallUnchecked = (abi: Abi, functionName: string, args: readonly unknown[] = []): Hex => {
	const fragment = getFunctionFragmentInternal(abi, functionName, args.length)
	if (fragment === undefined) throw new Error(`Unknown function ${ functionName }`)
	const encodedArgs = encodeAbiParameters(fragment.inputs, encodeValuesForParameters(fragment.inputs, args))
	return concat([toFunctionSelector(formatAbiItem(fragment)), encodedArgs])
}

const encodeFunctionReturnUnchecked = (abi: Abi, functionName: string, values: readonly unknown[]): Hex => {
	const fragment = getFunctionFragmentInternal(abi, functionName)
	if (fragment === undefined) throw new Error(`Unknown function ${ functionName }`)
	const normalizedValues = fragment.outputs.length === 1 && values.length === 1 ? [values[0]] : values
	return encodeAbiParameters(fragment.outputs, encodeValuesForParameters(fragment.outputs, normalizedValues))
}

const decodeFunctionOutputUnchecked = (abi: Abi, functionName: string, data: Hex | Uint8Array) => {
	const fragment = getFunctionFragmentInternal(abi, functionName)
	if (fragment === undefined) throw new Error(`Unknown function ${ functionName }`)
	const decoded = decodeValues(fragment.outputs, toHex(data))
	return fragment.outputs.length === 1 ? decoded[0] : decoded
}

export const normalizeAbi = (abiLike: AbiLike): Abi => {
	if (typeof abiLike === 'string') {
		const parsed = JSON.parse(abiLike) as unknown
		if (!Array.isArray(parsed)) throw new Error('ABI JSON must be an array')
		return normalizeAbiArray(parsed)
	}
	return normalizeAbiArray(abiLike)
}

export const isValidAbiString = (abi: string) =>
	tryOrFalse(
		() => normalizeAbi(abi),
		(error) => error instanceof Error,
	)

export const hasFunction = <const TAbi extends Abi>(abi: TAbi, functionName: ContractFunctionName<TAbi>) => {
	return abi.some((item) => item.type === 'function' && item.name === functionName)
}

export function encodeFunctionCall<const TAbi extends Abi, const TName extends ContractFunctionName<TAbi>>(abi: TAbi, functionName: TName, args: ContractFunctionArgs<TAbi, AbiStateMutability, TName>): Hex
export function encodeFunctionCall(abi: Abi, functionName: string, args: readonly unknown[]): Hex {
	return encodeFunctionCallUnchecked(abi, functionName, args)
}

export function encodeFunctionReturn<const TAbi extends Abi, const TName extends ContractFunctionName<TAbi>>(abi: TAbi, functionName: TName, values: readonly unknown[]): Hex
export function encodeFunctionReturn(abi: Abi, functionName: string, values: readonly unknown[]): Hex {
	return encodeFunctionReturnUnchecked(abi, functionName, values)
}

export function decodeFunctionOutput<const TAbi extends Abi, const TName extends ContractFunctionName<TAbi>>(abi: TAbi, functionName: TName, data: Hex | Uint8Array): ContractFunctionReturnType<TAbi, AbiStateMutability, TName>
export function decodeFunctionOutput(abi: Abi, functionName: string, data: Hex | Uint8Array) {
	return decodeFunctionOutputUnchecked(abi, functionName, data)
}

export function decodeFunctionDataStrict<const TAbi extends Abi>(abi: TAbi, data: Hex | Uint8Array): DecodeFunctionDataReturnType<TAbi>
export function decodeFunctionDataStrict(abi: Abi, data: Hex | Uint8Array) {
	return decodeFunctionData({ abi, data: toHex(data) })
}

export const decodeEventStrict = <const TAbi extends Abi>(abi: TAbi, log: { data: Hex | Uint8Array; topics: readonly Hex[] }): DecodeEventLogReturnType<TAbi, ContractEventName<TAbi>, Hex[], Hex, true> => {
	if (log.topics.length === 0) {
		return decodeEventLog({
			abi,
			data: toHex(log.data),
			topics: [],
			strict: true,
		})
	}
	const [signature, ...args] = log.topics
	if (signature === undefined) throw new Error('Missing event signature')
	return decodeEventLog({
		abi,
		data: toHex(log.data),
		topics: [signature, ...args],
		strict: true,
	})
}

export const getFunctionFragmentLoose = (abiLike: AbiLike, nameOrSelector: string): AbiItem | undefined => {
	return getFunctionFragmentInternal(normalizeAbi(abiLike), nameOrSelector)
}

export const hasFunctionLoose = (abiLike: AbiLike, functionName: string) => getFunctionFragmentInternal(normalizeAbi(abiLike), functionName) !== undefined

export const encodeFunctionCallLoose = (abiLike: AbiLike, functionName: string, args: readonly unknown[] = []) => {
	return encodeFunctionCallUnchecked(normalizeAbi(abiLike), functionName, args)
}

export const decodeFunctionOutputLoose = (abiLike: AbiLike, functionName: string, data: Hex | Uint8Array) => {
	return decodeFunctionOutputValuesLoose(abiLike, functionName, data)
}

export const decodeFunctionOutputObjectLoose = (abiLike: AbiLike, functionName: string, data: Hex | Uint8Array) => {
	const abi = normalizeAbi(abiLike)
	const fragment = getFunctionFragmentInternal(abi, functionName)
	if (fragment === undefined) throw new Error(`Unknown function ${ functionName }`)
	const values = decodeFunctionOutputValuesLoose(abi, functionName, data)
	return toNamedArgs(fragment.outputs, values)
}

export const decodeCallDataLoose = (abiLike: AbiLike, data: Hex | Uint8Array, value = 0n): LooseParsedAbiCall | undefined => {
	const abi = normalizeAbi(abiLike)
	const encodedData = toHex(data)
	const fragment = getFunctionFragmentInternal(abi, functionSelectorFromData(encodedData))
	if (fragment === undefined) return undefined
	const args = decodeValues(fragment.inputs, sliceHex(encodedData, 10))
	return {
		name: fragment.name,
		signature: formatAbiItem(fragment),
		fragment,
		args,
		namedArgs: toNamedArgs(fragment.inputs, args),
		value,
	}
}

export const decodeEventLoose = (abiLike: AbiLike, log: { data: Hex | Uint8Array; topics: readonly Hex[] }): LooseParsedAbiEvent | undefined => {
	const abi = normalizeAbi(abiLike)
	const encodedData = toHex(log.data)
	const topics = [...log.topics]
	const selector = topics[0]
	if (selector === undefined) return undefined
	const fragment = getEventFragmentInternal(abi, selector)
	if (fragment === undefined) return undefined
	const eventTopics: [Hex, ...Hex[]] = [selector, ...topics.slice(1)]
	const decoded = decodeEventLog({
		abi,
		data: encodedData,
		topics: eventTopics,
		strict: false,
	})
	if (decoded.eventName === undefined) return undefined
	const args = Array.isArray(decoded.args) ? decoded.args : fragment.inputs.map((input) => (input.name === undefined || input.name === '' ? undefined : Reflect.get(decoded.args ?? {}, input.name)))
	const namedArgs = Array.isArray(decoded.args) ? toNamedArgs(fragment.inputs, decoded.args) : { ...(decoded.args ?? {}) }
	return {
		name: decoded.eventName,
		signature: formatAbiItem(fragment),
		fragment,
		args,
		namedArgs,
	}
}

export const decodeErrorLoose = (abiLike: AbiLike, data: Hex | Uint8Array): LooseParsedAbiError | undefined => {
	const abi = normalizeAbi(abiLike)
	const encodedData = toHex(data)
	const selector = functionSelectorFromData(encodedData)
	const fragment = getErrorFragmentInternal(abi, selector)
	if (fragment === undefined) return undefined
	const args = decodeValues(fragment.inputs, sliceHex(encodedData, 10))
	return {
		name: fragment.name,
		signature: formatAbiItem(fragment),
		selector,
		fragment,
		args,
		namedArgs: toNamedArgs(fragment.inputs, args),
	}
}

export const encodeAbiValues = (params: readonly string[] | readonly AbiParameter[], values: readonly unknown[]) => {
	return encodeAbiParameters(normalizeAbiParametersInput(params), values)
}

export const decodeAbiValues = (params: readonly string[] | readonly AbiParameter[], data: Hex) => {
	return decodeAbiParameters(normalizeAbiParametersInput(params), data)
}
