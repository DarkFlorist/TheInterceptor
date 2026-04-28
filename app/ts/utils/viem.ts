import {
	decodeAbiParameters,
	decodeErrorResult,
	decodeEventLog,
	decodeFunctionData,
	decodeFunctionResult,
	encodeAbiParameters,
	encodeFunctionData,
	encodeFunctionResult,
	encodePacked,
	formatAbiItem,
	formatUnits as viemFormatUnits,
	getAddress as viemGetAddress,
	getCreate2Address as viemGetCreate2Address,
	hashMessage as viemHashMessage,
	hashStruct as viemHashStruct,
	hashTypedData as viemHashTypedData,
	isAddress as viemIsAddress,
	keccak256 as viemKeccak256,
	parseAbiItem,
	parseAbiParameters,
	parseTransaction as viemParseTransaction,
	recoverAddress as viemRecoverAddress,
	serializeTransaction,
	stringToBytes,
	toFunctionSelector,
	toRlp,
	validateTypedData as viemValidateTypedData,
} from 'viem/utils'
import { namehash } from 'viem/ens'
import { normalize as normalizeEnsName } from 'viem/ens'
import { privateKeyToAccount } from 'viem/accounts'

export type HexString = `0x${ string }`
export type AbiParameter = { name?: string, type?: string, components?: readonly AbiParameter[], [key: string]: unknown }
export type AbiItem = { type: string, name?: string, inputs?: readonly AbiParameter[], outputs?: readonly AbiParameter[], [key: string]: unknown }
type Abi = readonly AbiItem[]
export type InterfaceAbi = string | readonly (string | AbiItem)[]
export type Result = any[] & Record<string, any> & { toObject(): Record<string, any> }

type AbiParameterLike = string | AbiParameter
type ParsedDescription = {
	args: Result
	fragment: AbiItem
	name: string
	signature: string
}

const toNamedResult = (params: readonly AbiParameter[] | undefined, valuesInput: unknown): Result => {
	const values = Array.isArray(valuesInput) ? [...valuesInput] : [valuesInput]
	const named: Record<string, unknown> = {}
	for (const [index, value] of values.entries()) {
		const param = params?.[index]
		if (param?.name !== undefined && param.name !== '') {
			named[param.name] = value
		}
	}
	const result = values as Result
	for (const [name, value] of Object.entries(named)) {
		result[name] = value
	}
	Object.defineProperty(result, 'toObject', {
		enumerable: false,
		value: () => ({ ...named }),
	})
	return result
}

const normalizeAbiParametersInput = (params: readonly AbiParameterLike[]) => {
	if (params.length === 0) return [] as const
	if (params.every((param) => typeof param === 'string')) return parseAbiParameters((params as readonly string[]).join(', ')) as unknown as readonly AbiParameter[]
	return params.map((param) => typeof param === 'string' ? parseAbiParameters(param)[0]! : param) as unknown as readonly AbiParameter[]
}

const normalizeAbi = (abiLike: InterfaceAbi): Abi => {
	if (typeof abiLike === 'string') {
		return normalizeAbi(JSON.parse(abiLike) as InterfaceAbi)
	}
	return abiLike.map((item) => typeof item === 'string' ? parseAbiItem(item) : item) as Abi
}

const isNamedAbiItem = (item: AbiItem, type: string) => item.type === type && typeof item.name === 'string'

const findAbiItemByName = (
	abi: Abi,
	type: string,
	name: string,
	argsLength: number | undefined = undefined,
) => {
	const candidates = abi.filter((item) => isNamedAbiItem(item, type) && item.name === name)
	if (argsLength === undefined || candidates.length <= 1) return candidates[0]
	return candidates.find((item) => item.inputs?.length === argsLength) ?? candidates[0]
}

const toHexString = (value: string | Uint8Array): HexString => typeof value === 'string' ? value as HexString : `0x${ Array.from(value).map((byte) => byte.toString(16).padStart(2, '0')).join('') }`
const stripSingleArraySuffix = (type: string) => type.replace(/\[[^\]]*\]$/, '')
const isTupleType = (type: string | undefined) => type !== undefined && stripSingleArraySuffix(type).startsWith('tuple')
const eip712DomainFieldTypes = {
	name: 'string',
	version: 'string',
	chainId: 'uint256',
	verifyingContract: 'address',
	salt: 'bytes32',
} as const

const encodeValueForParameter = (parameter: AbiParameter | undefined, value: unknown): unknown => {
	if (parameter === undefined || parameter.type === undefined) return value
	if (parameter.type.endsWith(']')) {
		if (!Array.isArray(value)) return value
		const innerType = stripSingleArraySuffix(parameter.type)
		return value.map((entry) => encodeValueForParameter({ ...parameter, type: innerType }, entry))
	}
	if (!isTupleType(parameter.type) || parameter.components === undefined) return value
	if (Array.isArray(value)) {
		return parameter.components.map((component, index) => encodeValueForParameter(component, value[index]))
	}
	if (value !== null && typeof value === 'object') {
		return parameter.components.map((component) => encodeValueForParameter(component, (value as Record<string, unknown>)[component.name ?? '']))
	}
	return value
}

const encodeValuesForParameters = (parameters: readonly AbiParameter[] | undefined, values: readonly unknown[]) => {
	if (parameters === undefined) return values
	return values.map((value, index) => encodeValueForParameter(parameters[index], value))
}

export class Interface {
	public readonly abi: Abi

	constructor(abiLike: InterfaceAbi) {
		this.abi = normalizeAbi(abiLike)
	}

	public readonly encodeFunctionData = (functionName: string, args: readonly unknown[] = []) => {
		const fragment = findAbiItemByName(this.abi, 'function', functionName, args.length)
		return encodeFunctionData({
			abi: this.abi as any,
			functionName,
			args: encodeValuesForParameters(fragment?.inputs, args) as any,
		})
	}

	public readonly encodeFunctionResult = (functionName: string, result: readonly unknown[] = []) => {
		const fragment = findAbiItemByName(this.abi, 'function', functionName)
		const normalizedResult = encodeValuesForParameters(fragment?.outputs, result)
		return encodeFunctionResult({
			abi: this.abi as any,
			functionName,
			result: fragment?.outputs?.length === 1 && normalizedResult.length === 1 ? normalizedResult[0] as any : normalizedResult as any,
		})
	}

	public readonly decodeFunctionResult = (functionName: string, data: string | Uint8Array) => {
		const fragment = findAbiItemByName(this.abi, 'function', functionName)
		if (fragment === undefined) throw new Error(`Unknown function ${ functionName }`)
		const decoded = decodeFunctionResult({
			abi: this.abi as any,
			functionName,
			data: toHexString(data),
		}) as unknown
		const values = fragment.outputs?.length === 1 ? [decoded] : decoded
		return toNamedResult(fragment.outputs, values)
	}

	public readonly getFunction = (nameOrSelector: string) => {
		if (nameOrSelector.startsWith('0x') && nameOrSelector.length === 10) {
			return this.abi.find((item) => item.type === 'function' && toFunctionSelector(formatAbiItem(item as any)) === nameOrSelector) ?? null
		}
		return findAbiItemByName(this.abi, 'function', nameOrSelector) ?? null
	}

	public readonly hasFunction = (functionName: string) => this.getFunction(functionName) !== null

	public readonly decodeFunctionData = (functionNameOrFragment: string | AbiItem, data: string | Uint8Array) => {
		const decoded = decodeFunctionData({
			abi: this.abi as any,
			data: toHexString(data),
		}) as { functionName: string, args?: readonly unknown[] }
		const fragment = typeof functionNameOrFragment === 'string'
			? this.getFunction(functionNameOrFragment === decoded.functionName ? decoded.functionName : functionNameOrFragment)
			: functionNameOrFragment
		if (fragment === null) throw new Error(`Unknown function ${ typeof functionNameOrFragment === 'string' ? functionNameOrFragment : 'unknown function' }`)
		return toNamedResult(fragment.inputs, decoded.args ?? [])
	}

	public readonly parseTransaction = (transaction: { data: string | Uint8Array, value?: bigint }) => {
		const decoded = decodeFunctionData({
			abi: this.abi as any,
			data: toHexString(transaction.data),
		}) as { functionName: string, args?: readonly unknown[] }
		const fragment = findAbiItemByName(this.abi, 'function', decoded.functionName, decoded.args?.length)
		if (fragment === undefined) throw new Error(`Unknown function ${ decoded.functionName }`)
		return {
			args: toNamedResult(fragment.inputs, decoded.args ?? []),
			fragment,
			name: decoded.functionName,
			signature: formatAbiItem(fragment as any),
			value: transaction.value ?? 0n,
		}
	}

	public readonly parseLog = (log: { data: string | Uint8Array, topics: readonly string[] }): ParsedDescription => {
		const decoded = decodeEventLog({
			abi: this.abi as any,
			data: toHexString(log.data),
			topics: [...log.topics] as any,
			strict: false,
		}) as { eventName?: string, args?: readonly unknown[] | Record<string, unknown> }
		if (decoded.eventName === undefined) throw new Error('Unknown event')
		const fragment = findAbiItemByName(this.abi, 'event', decoded.eventName, Array.isArray(decoded.args) ? decoded.args.length : undefined)
		if (fragment === undefined) throw new Error(`Unknown event ${ decoded.eventName }`)
		const args = Array.isArray(decoded.args)
			? toNamedResult(fragment.inputs, decoded.args)
			: toNamedResult(fragment.inputs, fragment.inputs?.map((input) => {
				const decodedArgs = decoded.args as Record<string, unknown> | undefined
				return input.name === '' ? undefined : decodedArgs?.[input.name ?? '']
			}))
		return {
			args,
			fragment,
			name: decoded.eventName,
			signature: formatAbiItem(fragment as any),
		}
	}

	public readonly parseError = (data: string | Uint8Array) => {
		const decoded = decodeErrorResult({
			abi: this.abi as any,
			data: toHexString(data),
		}) as { errorName: string, args?: readonly unknown[] }
		const fragment = findAbiItemByName(this.abi, 'error', decoded.errorName, decoded.args?.length)
		if (fragment === undefined) return null
		return {
			args: toNamedResult(fragment.inputs, decoded.args ?? []),
			fragment,
			name: decoded.errorName,
			selector: toFunctionSelector(formatAbiItem(fragment as any)),
			signature: formatAbiItem(fragment as any),
		}
	}

	public readonly getErrorAbiItems = () => this.abi.filter((item) => item.type === 'error')
}

class DefaultAbiCoder {
	public readonly encode = (params: readonly AbiParameterLike[], values: readonly unknown[]) => {
		return encodeAbiParameters(normalizeAbiParametersInput(params), values as never)
	}

	public readonly decode = (params: readonly AbiParameterLike[], data: HexString) => {
		const normalized = normalizeAbiParametersInput(params)
		return toNamedResult(normalized, decodeAbiParameters(normalized as any, data))
	}
}

const defaultAbiCoder = new DefaultAbiCoder()

export class AbiCoder {
	public readonly encode = defaultAbiCoder.encode
	public readonly decode = defaultAbiCoder.decode

	public static readonly defaultAbiCoder = () => defaultAbiCoder
}

export class Signature {
	public static readonly from = (signature: string) => {
		const stripped = signature.startsWith('0x') ? signature.slice(2) : signature
		if (stripped.length !== 130) throw new Error('Unsupported signature length')
		const r = `0x${ stripped.slice(0, 64) }` as HexString
		const s = `0x${ stripped.slice(64, 128) }` as HexString
		const rawV = Number.parseInt(stripped.slice(128, 130), 16)
		const yParity = rawV >= 27 ? rawV - 27 : rawV
		return {
			r,
			s,
			v: BigInt(rawV >= 27 ? rawV : yParity + 27),
			yParity,
		}
	}
}

export const toUtf8Bytes = (value: string) => stringToBytes(value)
export const solidityPacked = (types: readonly string[], values: readonly unknown[]) => encodePacked(types as any, values as any)
export const getCreate2Address = (from: string, salt: string | Uint8Array, initCodeHash: string) => viemGetCreate2Address({ from, salt: typeof salt === 'string' ? salt : toHexString(salt), bytecodeHash: initCodeHash } as any)
export const formatUnits = (value: bigint, decimals: number | bigint) => viemFormatUnits(value, typeof decimals === 'bigint' ? Number(decimals) : decimals)
export const getAddress = viemGetAddress
export const isAddress = (address: string) => viemIsAddress(address, { strict: false })
export const isValidName = (name: string) => {
	try {
		normalizeEnsName(name)
		return true
	} catch {
		return false
	}
}
export const encodeRlp = (value: readonly unknown[]) => toRlp(value as any)
export const parseSerializedTransaction = (serializedTransaction: string) => viemParseTransaction(serializedTransaction as any)
export const keccak256 = (value: string | Uint8Array) => viemKeccak256(typeof value === 'string' ? value as HexString : value)
export const hashMessage = (message: any) => viemHashMessage(message)
export const hashDomain = (parameters: { domain: Record<string, unknown>, types?: Record<string, readonly AbiParameter[]> }) => {
	const types = parameters.types?.['EIP712Domain'] !== undefined
		? { EIP712Domain: parameters.types['EIP712Domain'] }
		: { EIP712Domain: Object.entries(eip712DomainFieldTypes).filter(([name]) => parameters.domain[name] !== undefined).map(([name, type]) => ({ name, type })) }
	return viemHashStruct({ data: parameters.domain, primaryType: 'EIP712Domain', types } as any)
}
export const hashStruct = (parameters: any) => viemHashStruct(parameters)
export const hashTypedData = (parameters: any) => viemHashTypedData(parameters)
export const recoverAddress = (hash: string | Uint8Array, signature: unknown) => viemRecoverAddress({ hash: typeof hash === 'string' ? hash as HexString : hash, signature: signature as any })
export const recoverTransactionAddress = async (parameters: { serializedTransaction: string, signature?: unknown }) => {
	const parsed = viemParseTransaction(parameters.serializedTransaction as any) as Record<string, unknown>
	const signature = parameters.signature ?? (('r' in parsed && 's' in parsed) ? {
		r: parsed['r'],
		s: parsed['s'],
		...(parsed['yParity'] !== undefined ? { yParity: parsed['yParity'] } : parsed['v'] !== undefined ? { v: parsed['v'] } : {}),
	} : undefined)
	if (signature === undefined) throw new Error('Serialized transaction is missing a signature')
	const { r: _r, s: _s, v: _v, yParity: _yParity, ...unsignedTransaction } = parsed
	const unsignedSerializedTransaction = serializeTransaction(unsignedTransaction as any)
	return await viemRecoverAddress({ hash: viemKeccak256(unsignedSerializedTransaction), signature: signature as any })
}
export const validateTypedData = (parameters: any) => viemValidateTypedData(parameters)

export const ethers = {
	AbiCoder,
	Interface,
	Signature,
	encodeRlp,
	formatUnits,
	getAddress,
	isAddress,
	keccak256,
	namehash,
	recoverAddress,
	signatureFrom: Signature.from,
	solidityPacked,
	toUtf8Bytes,
}

export { namehash, privateKeyToAccount }
