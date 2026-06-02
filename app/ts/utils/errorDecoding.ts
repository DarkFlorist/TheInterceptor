import type { Abi, AbiItem } from 'viem'
import { printError } from './errors.js'
import type { ErrorWithCodeAndOptionalData } from '../types/error.js'
import { decodeAbiValues, decodeErrorLoose, normalizeAbi, type AbiLike } from './abiRuntime.js'

const ERROR_STRING_PREFIX = '0x08c379a0' // Error(string)
const PANIC_CODE_PREFIX = '0x4e487b71' // Panic(uint256)
const isHexData = (value: string): value is `0x${string}` => value.startsWith('0x')

const ErrorStringABI = [
	{
		type: 'error',
		name: 'Error',
		inputs: [{ name: 'message', type: 'string' }],
	},
] as const satisfies Abi

const PanicABI = [
	{
		type: 'error',
		name: 'Panic',
		inputs: [{ name: 'code', type: 'uint256' }],
	},
] as const satisfies Abi

enum ErrorType {
	EmptyError = 'EmptyError',
	RevertError = 'RevertError',
	PanicError = 'PanicError',
	CustomError = 'CustomError',
	UnknownError = 'UnknownError',
}

type ErrorAbiItem = Extract<AbiItem, { type: 'error' }>

type DecodedError = {
	type: ErrorType
	reason: string
	data: string | undefined
	fragment: ErrorAbiItem | undefined
	selector: string | undefined
	name: string | undefined
	signature: string | undefined
	args?: readonly unknown[]
}

type ErrorResultFormatterParam = {
	data: string | undefined
	reason: string
	args?: readonly unknown[]
	fragment?: ErrorAbiItem
	selector?: string
	name?: string
	signature?: string
}

const formatReason = (reason: string, defaultReason: string) => (reason.trim() !== '' ? reason : defaultReason)

const baseErrorResult = ({ type, data, reason, fragment, args, selector, name, signature }: ErrorResultFormatterParam & { type: ErrorType }): DecodedError => ({
	type,
	reason: formatReason(reason, 'Unknown error'),
	data: data ?? undefined,
	fragment,
	args,
	selector: selector ?? undefined,
	name: name ?? undefined,
	signature: signature ?? undefined,
})

const emptyErrorResult = ({ data, reason }: ErrorResultFormatterParam) => baseErrorResult({ type: ErrorType.EmptyError, data, reason })
const revertErrorResult = ({ data, reason, fragment, args, selector, name, signature }: ErrorResultFormatterParam) =>
	baseErrorResult({
		type: ErrorType.RevertError,
		reason,
		data,
		fragment,
		args,
		selector,
		name,
		signature,
	})
const unknownErrorResult = ({ data, reason, name }: ErrorResultFormatterParam) =>
	baseErrorResult({
		type: ErrorType.UnknownError,
		reason: formatReason(reason, 'Unknown error'),
		data,
		name,
	})
const panicErrorResult = ({ data, reason, fragment, args, selector, name, signature }: ErrorResultFormatterParam) =>
	baseErrorResult({
		type: ErrorType.PanicError,
		reason,
		data,
		fragment,
		args,
		selector,
		name,
		signature,
	})
const customErrorResult = ({ data, reason, fragment, args, selector, name, signature }: ErrorResultFormatterParam) => {
	const resolvedSelector = selector ?? data?.slice(0, 10)
	return baseErrorResult({
		type: ErrorType.CustomError,
		reason: formatReason(reason, `No ABI for custom error ${resolvedSelector}`),
		data,
		fragment,
		args,
		selector: resolvedSelector,
		name: name ?? resolvedSelector,
		signature,
	})
}

const panicErrorCodeToReason = (errorCode: bigint): string | undefined => {
	switch (errorCode) {
		case 0x0n:
			return 'Generic compiler inserted panic'
		case 0x1n:
			return 'Assertion error'
		case 0x11n:
			return 'Arithmetic operation underflowed or overflowed outside of an unchecked block'
		case 0x12n:
			return 'Division or modulo division by zero'
		case 0x21n:
			return 'Tried to convert a value into an enum, but the value was too big or negative'
		case 0x22n:
			return 'Incorrectly encoded storage byte array'
		case 0x31n:
			return '.pop() was called on an empty array'
		case 0x32n:
			return 'Array accessed at an out-of-bounds or negative index'
		case 0x41n:
			return 'Too much memory was allocated, or an array was created that is too large'
		case 0x51n:
			return 'Called a zero-initialized variable of internal function type'
		default:
			return undefined
	}
}

const getErrorAbiItem = (abi: Abi): ErrorAbiItem | undefined => {
	const item = abi[0]
	if (item === undefined || item.type !== 'error') return undefined
	return item
}

const handleEmptyError = (error: ErrorWithCodeAndOptionalData) => emptyErrorResult({ data: error.data, reason: error.message })

const handleRevertError = (error: ErrorWithCodeAndOptionalData) => {
	if (error.data === undefined) return unknownErrorResult({ reason: 'Unknown error returned', data: '0x' })
	const encodedReason = `0x${error.data.slice(ERROR_STRING_PREFIX.length)}` as const
	const fragment = getErrorAbiItem(ErrorStringABI)
	if (fragment === undefined)
		return unknownErrorResult({
			reason: 'Unknown error returned',
			data: error.data,
		})
	try {
		const args = decodeAbiValues(fragment.inputs ?? [], encodedReason)
		const [reason] = args
		return revertErrorResult({
			data: error.data,
			fragment,
			reason: typeof reason === 'string' ? reason : 'Unknown error returned',
			args,
			selector: ERROR_STRING_PREFIX,
			name: 'Error',
			signature: 'Error(string)',
		})
	} catch (decodeError) {
		if (decodeError instanceof Error) console.warn('Failed to decode Error(string) revert payload', decodeError)
		return unknownErrorResult({
			reason: 'Unknown error returned',
			data: error.data,
		})
	}
}

const handlePanicError = (error: ErrorWithCodeAndOptionalData) => {
	if (error.data === undefined) return unknownErrorResult({ reason: 'Unknown error returned', data: '0x' })
	const encodedReason = `0x${error.data.slice(PANIC_CODE_PREFIX.length)}` as const
	const fragment = getErrorAbiItem(PanicABI)
	if (fragment === undefined)
		return unknownErrorResult({
			reason: 'Unknown panic error',
			data: error.data,
		})
	try {
		const args = decodeAbiValues(fragment.inputs ?? [], encodedReason)
		const [errorCode] = args
		const reason = typeof errorCode === 'bigint' ? (panicErrorCodeToReason(errorCode) ?? 'Unknown panic code') : 'Unknown panic code'
		return panicErrorResult({
			data: error.data,
			fragment,
			reason,
			args,
			selector: PANIC_CODE_PREFIX,
			name: 'Panic',
			signature: 'Panic(uint256)',
		})
	} catch (decodeError) {
		if (decodeError instanceof Error) console.warn('Failed to decode Panic(uint256) revert payload', decodeError)
		return unknownErrorResult({
			reason: 'Unknown panic error',
			data: error.data,
		})
	}
}

const handleCustomError = (errorAbis: readonly AbiLike[], error: ErrorWithCodeAndOptionalData) => {
	const result: Parameters<typeof customErrorResult>[0] = {
		data: error.data,
		reason: error.message,
	}
	if (error.data === undefined || !isHexData(error.data)) return customErrorResult(result)
	const errorItems = errorAbis.flatMap((abi) => normalizeAbi(abi).filter((item): item is ErrorAbiItem => item.type === 'error'))
	const customError = decodeErrorLoose(errorItems, error.data)
	if (customError === undefined || customError.fragment.type !== 'error') return customErrorResult(result)
	return customErrorResult({
		...result,
		fragment: customError.fragment,
		reason: customError.name,
		args: customError.args,
		selector: customError.selector,
		name: customError.name,
		signature: customError.signature,
	})
}

export const decodeEthereumError = (errorAbis: readonly AbiLike[], error: ErrorWithCodeAndOptionalData): DecodedError => {
	try {
		if (error.data === '0x') return handleEmptyError(error)
		if (error.data?.startsWith(ERROR_STRING_PREFIX)) return handleRevertError(error)
		if (error.data?.startsWith(PANIC_CODE_PREFIX)) return handlePanicError(error)
		if (error.data !== undefined) return handleCustomError(errorAbis, error)
		return unknownErrorResult({
			data: error.data,
			reason: error.message,
			name: 'unknown',
		})
	} catch (decodingError: unknown) {
		printError(decodingError)
		return unknownErrorResult({
			data: error.data,
			reason: `Failed to decode error: ${error.message}`,
			name: 'unknown',
		})
	}
}
