import { AbiCoder } from 'ethers'
import { Result } from 'ethers'
import { ErrorFragment, Interface, ErrorDescription } from 'ethers'
import { printError } from './errors.js'
import { ErrorWithCodeAndOptionalData } from '../types/error.js'

const ERROR_STRING_PREFIX = '0x08c379a0' // Error(string)
const PANIC_CODE_PREFIX = '0x4e487b71' // Panic(uint256)

enum ErrorType {
	EmptyError = 'EmptyError',
	RevertError = 'RevertError',
	PanicError = 'PanicError',
	CustomError = 'CustomError',
	UnknownError = 'UnknownError',
}

type DecodedError = {
	type: ErrorType
	reason: string
	data: string | undefined
	fragment: ErrorFragment | undefined
	selector: string | undefined
	name: string | undefined
	signature: string | undefined
	args?: Result
}

type ErrorResultFormatterParam = {
	data: string | undefined
	reason: string
	args?: Result
	fragment?: ErrorFragment
	selector?: string
	name?: string
}

type ErrorResultFormatter = (params: ErrorResultFormatterParam) => DecodedError

const formatReason = (reason: string, defaultReason: string): string => reason.trim() !== '' ? reason : defaultReason

const baseErrorResult: (params: ErrorResultFormatterParam & { type: ErrorType } ) => DecodedError = ({ type, data, reason, fragment, args, selector, name }) => {
	const res: DecodedError = {
		type,
		reason: formatReason(reason, 'Unknown error'),
		data: data ?? undefined,
		fragment: undefined,
		args: args ?? new Result(),
		selector: selector ?? undefined,
		name: name ?? undefined,
		signature: undefined,
	}
	if (fragment) return { ...res, ...new ErrorDescription(fragment, fragment.selector, args ?? new Result()) }
	return res
}

const emptyErrorResult: ErrorResultFormatter = ({ data, reason }) => baseErrorResult({ type: ErrorType.EmptyError, data, reason })
const revertErrorResult: ErrorResultFormatter = ({ data, reason, fragment, args }) => baseErrorResult({ type: ErrorType.RevertError, reason, data, fragment, args })
const unknownErrorResult: ErrorResultFormatter = ({ data, reason, name }) => baseErrorResult({ type: ErrorType.UnknownError, reason: formatReason(reason, 'Unknown error'), data, name })
const panicErrorResult: ErrorResultFormatter = ({ data, reason, args }) => baseErrorResult({ type: ErrorType.PanicError, reason, data, args })
const customErrorResult: ErrorResultFormatter = ({ data, reason, fragment, args }) => {
	const selector = data?.slice(0, 10)
	return baseErrorResult({ type: ErrorType.CustomError, reason: formatReason(reason, `No ABI for custom error ${ selector }`), data, fragment, args, selector, name: selector })
}

interface ErrorHandler {
	predicate: (error: ErrorWithCodeAndOptionalData) => boolean
	handle: (errorInterface: Interface | undefined, error: ErrorWithCodeAndOptionalData) => DecodedError
}

class EmptyErrorHandler implements ErrorHandler {
	public predicate(error: ErrorWithCodeAndOptionalData): boolean { return error.data === '0x' }
	public handle(_errorInterface: Interface | undefined, error: ErrorWithCodeAndOptionalData): DecodedError { return emptyErrorResult({ data: error.data, reason: error.message }) }
}

class RevertErrorHandler implements ErrorHandler {
	public predicate(error: ErrorWithCodeAndOptionalData): boolean { return error.data !== undefined && error.data.startsWith(ERROR_STRING_PREFIX) }
	public handle(_errorInterface: Interface | undefined, error: ErrorWithCodeAndOptionalData): DecodedError {
		if (error.data === undefined) return unknownErrorResult({ reason: 'Unknown error returned', data: '0x'})
		const encodedReason = error.data.slice(ERROR_STRING_PREFIX.length)
		const abi = new AbiCoder()
		try {
			const fragment = ErrorFragment.from('Error(string)')
			const args = abi.decode(fragment.inputs, `0x${ encodedReason }`)
			const reason = args[0] as string
			return revertErrorResult({ data: error.data, fragment, reason, args })
		} catch (e) {
			return unknownErrorResult({ reason: 'Unknown error returned', data: error.data })
		}
	}
}

class PanicErrorHandler implements ErrorHandler {
	public predicate(error: ErrorWithCodeAndOptionalData): boolean { return error.data !== undefined && error.data.startsWith(PANIC_CODE_PREFIX) }
	public handle(_errorInterface: Interface | undefined, error: ErrorWithCodeAndOptionalData): DecodedError {
		if (error.data === undefined) return unknownErrorResult({ reason: 'Unknown error returned', data: '0x'})
		const encodedReason = error.data.slice(PANIC_CODE_PREFIX.length)
		const abi = new AbiCoder()
		try {
			const fragment = ErrorFragment.from('Panic(uint256)')
			const args = abi.decode(fragment.inputs, `0x${encodedReason}`)
			const reason = panicErrorCodeToReason(args[0] as bigint) ?? 'Unknown panic code'
			return panicErrorResult({ data: error.data, fragment, reason, args })
		} catch (e) {
			return unknownErrorResult({ reason: 'Unknown panic error', data: error.data })
		}
	}
}

class CustomErrorHandler implements ErrorHandler {
	public predicate(error: ErrorWithCodeAndOptionalData): boolean { return error.data !== undefined && error.data !== '0x' && !error.data.startsWith(ERROR_STRING_PREFIX) && !error.data.startsWith(PANIC_CODE_PREFIX) }
	public handle(errorInterface: Interface | undefined, error: ErrorWithCodeAndOptionalData): DecodedError {
		const result: Parameters<typeof customErrorResult>[0] = { data: error.data, reason: error.message }
		if (errorInterface === undefined) return customErrorResult(result)
		if (error.data === undefined) return customErrorResult(result)
		const customError = errorInterface.parseError(error.data)
		if (customError === null) return customErrorResult(result)
		const { fragment, args, name: reason } = customError
		return customErrorResult({ ...result, fragment, reason, args })
	}
}

// From Hardhat's panic codes
// https://docs.soliditylang.org/en/v0.8.13/control-structures.html?highlight=panic#panic-via-assert-and-error-via-require
const panicErrorCodeToReason = (errorCode: bigint): string | undefined => {
	switch (errorCode) {
		case 0x0n: return 'Generic compiler inserted panic'
		case 0x1n: return 'Assertion error'
		case 0x11n: return 'Arithmetic operation underflowed or overflowed outside of an unchecked block'
		case 0x12n: return 'Division or modulo division by zero'
		case 0x21n: return 'Tried to convert a value into an enum, but the value was too big or negative'
		case 0x22n: return 'Incorrectly encoded storage byte array'
		case 0x31n: return '.pop() was called on an empty array'
		case 0x32n: return 'Array accessed at an out-of-bounds or negative index'
		case 0x41n: return 'Too much memory was allocated, or an array was created that is too large'
		case 0x51n: return 'Called a zero-initialized variable of internal function type'
		default: return undefined
	}
}

const handlers = [
	new EmptyErrorHandler(),
	new RevertErrorHandler(),
	new PanicErrorHandler(),
	new CustomErrorHandler(),
]
const errorHandlers: ErrorHandler[] = handlers.map((handler) => ({ predicate: handler.predicate, handle: handler.handle }))

export const decodeEthereumError = (errorInterfaces: readonly Interface[], error: ErrorWithCodeAndOptionalData): DecodedError => {
	try {
		const errorInterface = new Interface(errorInterfaces.flatMap((iface) => iface.fragments.filter((fragment) => ErrorFragment.isFragment(fragment))))
		for (const { predicate, handle } of errorHandlers) {
			if (predicate(error)) return handle(errorInterface, error)
		}
		return unknownErrorResult({ data: error.data, reason: error.message, name: 'unknown' })
	} catch (decodingError: unknown) {
		printError(decodingError)
		return unknownErrorResult({ data: error.data, reason: `Failed to decode error: ${ error.message }`, name: 'unknown' })
	}
}
