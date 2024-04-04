import { AbiCoder } from 'ethers'
import { Result } from 'ethers'
import { ErrorFragment, Fragment, Interface, JsonFragment, ErrorDescription } from 'ethers'

const ERROR_STRING_PREFIX = '0x08c379a0' // Error(string)
const PANIC_CODE_PREFIX = '0x4e487b71' // Panic(uint256)

type DecodedError = {
	type: ErrorType
	reason: string | undefined
	data: string | undefined
	fragment: ErrorFragment | undefined
	selector: string | undefined
	name: string | undefined
	signature: string | undefined
	args?: Result
}

enum ErrorType {
	EmptyError = 'EmptyError',
	RevertError = 'RevertError',
	PanicError = 'PanicError',
	CustomError = 'CustomError',
	UserRejectError = 'UserRejectError',
	RpcError = 'RpcError',
	UnknownError = 'UnknownError',
}

type ErrorResultFormatterParam = {
	data: string | undefined
	reason?: string
	args?: Result
	fragment?: ErrorFragment
	selector?: string
	name?: string
}
	
type ErrorResultFormatter = (params: ErrorResultFormatterParam) => DecodedError
	
const formatReason = (reason: string | undefined | undefined, defaultReason: string | undefined ): string | undefined => (reason && reason.trim() !== '' ? reason : defaultReason)
	
const baseErrorResult: (params: ErrorResultFormatterParam & { type: ErrorType } ) => DecodedError = ({ type, data, reason, fragment, args, selector, name }) => {
	const res: DecodedError = {
		type,
		reason: formatReason(reason, undefined),
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

const emptyErrorResult: ErrorResultFormatter = ({ data }) => baseErrorResult({ type: ErrorType.EmptyError, data })
const userRejectErrorResult: ErrorResultFormatter = ({ data = undefined, reason }) => baseErrorResult({ type: ErrorType.UserRejectError, reason: formatReason(reason, 'User has rejected the transaction'), data })
const revertErrorResult: ErrorResultFormatter = ({ data, reason, fragment, args }) => baseErrorResult({ type: ErrorType.RevertError, reason, data, fragment, args })
const unknownErrorResult: ErrorResultFormatter = ({ data, reason, name }) => baseErrorResult({ type: ErrorType.UnknownError, reason: formatReason(reason, 'Unknown error'), data, name })
const panicErrorResult: ErrorResultFormatter = ({ data, reason, args }) => baseErrorResult({ type: ErrorType.PanicError, reason, data, args })
const customErrorResult: ErrorResultFormatter = ({ data, reason, fragment, args }) => {
	const selector = data && data.slice(0, 10)
	return baseErrorResult({ type: ErrorType.CustomError, reason: formatReason(reason, `No ABI for custom error ${ selector }`), data, fragment, args, selector, name: selector })
}
const rpcErrorResult: ErrorResultFormatter = ({ reason, name }) => baseErrorResult({ type: ErrorType.RpcError, reason: formatReason(reason, 'Error from JSON RPC provider'), data: undefined, name: name?.toString() ?? undefined })

type ErrorHandlerErrorInfo = { errorInterface: Interface | undefined; error: Error }

interface ErrorHandler {
	predicate: (data: string | undefined, error: Error) => boolean
	handle: (data: string, errorInfo: ErrorHandlerErrorInfo) => DecodedError
}

class EmptyErrorHandler implements ErrorHandler {
	public predicate(data: string | undefined): boolean { return data === '0x' }
	public handle(data: string): DecodedError { return emptyErrorResult({ data }) }
}

class RevertErrorHandler implements ErrorHandler {
	public predicate(data: string | undefined): boolean { return data !== undefined && data.startsWith(ERROR_STRING_PREFIX) }
	public handle(data: string): DecodedError {
		const encodedReason = data.slice(ERROR_STRING_PREFIX.length)
		const abi = new AbiCoder()
		try {
			const fragment = ErrorFragment.from('Error(string)')
			const args = abi.decode(fragment.inputs, `0x${ encodedReason }`)
			const reason = args[0] as string
			return revertErrorResult({ data, fragment, reason, args })
		} catch (e) {
			return unknownErrorResult({ reason: 'Unknown error returned', data })
		}
	}
}

class PanicErrorHandler implements ErrorHandler {
	public predicate(data?: string): boolean { return data !== undefined && data.startsWith(PANIC_CODE_PREFIX) }
	public handle(data: string): DecodedError {
		const encodedReason = data.slice(PANIC_CODE_PREFIX.length)
		const abi = new AbiCoder()
		try {
			const fragment = ErrorFragment.from('Panic(uint256)')
			const args = abi.decode(fragment.inputs, `0x${encodedReason}`)
			const reason = panicErrorCodeToReason(args[0] as bigint) ?? 'Unknown panic code'
			return panicErrorResult({ data, fragment, reason, args })
		} catch (e) {
			return unknownErrorResult({ reason: 'Unknown panic error', data })
		}
	}
}

class CustomErrorHandler implements ErrorHandler {
	public predicate(data?: string): boolean { return data !== undefined && data !== '0x' && !data?.startsWith(ERROR_STRING_PREFIX) && data?.startsWith(PANIC_CODE_PREFIX) }
	public handle(data: string, { errorInterface }: ErrorHandlerErrorInfo): DecodedError {
		const result: Parameters<typeof customErrorResult>[0] = { data }
		if (errorInterface === undefined) return customErrorResult(result)
		const customError = errorInterface.parseError(data)
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

class UserRejectionHandler implements ErrorHandler {
	public predicate(data: string | undefined, error: Error): boolean { return !data && error?.message?.includes('rejected transaction') }
	public handle(_data: string, { error }: ErrorHandlerErrorInfo): DecodedError { return userRejectErrorResult({ data: undefined, reason: error.message ?? 'The transaction was rejected' }) }
}

class RpcErrorHandler implements ErrorHandler {
	public predicate(data: string | undefined, error: Error): boolean { return data !== undefined && error.message.length > 0 && !error?.message?.includes('rejected transaction') && (error as any).code !== undefined }

	public handle(_data: string, { error }: ErrorHandlerErrorInfo): DecodedError {
		const rpcError = error as any
		const reason = rpcError.info?.error?.message ?? rpcError.shortMessage ?? rpcError.message
		return rpcErrorResult({ data: undefined, name: rpcError.code, reason })
	}
}

export class ErrorDecoder {
	private readonly errorHandlers: ErrorHandler[] = []

	private constructor(handlers: ErrorHandler[], public readonly errorInterface: Interface | undefined) {
		this.errorHandlers = handlers.map((handler) => ({ predicate: handler.predicate, handle: handler.handle }))
	}

	private getDataFromError(error: Error): string | undefined {
		const errorData = (error as any).data ?? (error as any).error?.data
		if (errorData === undefined) return undefined
		let returnData = typeof errorData === 'string' ? errorData : errorData.data
		if (typeof returnData === 'object' && returnData.data) returnData = returnData.data
		if (returnData === undefined || typeof returnData !== 'string') return undefined
		return returnData
	}

	public decode(error: Error | unknown): DecodedError {
		if (!(error instanceof Error)) return unknownErrorResult({ data: undefined, reason: typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : 'Invalid error' })
		const returnData = this.getDataFromError(error)
		for (const { predicate, handle } of this.errorHandlers) {
			if (predicate(returnData, error) && returnData !== undefined) return handle(returnData, { errorInterface: this.errorInterface, error })
		}
		return unknownErrorResult({ data: returnData, reason: (error as any)?.message ?? 'Unexpected error', name: error?.name })
	}

	public static create(errorInterfaces?: ReadonlyArray<Fragment[] | JsonFragment[] | Interface>, opts: { additionalErrorHandlers?: ErrorHandler[] } = {}): ErrorDecoder {
		const { additionalErrorHandlers } = opts
		let errorInterface: Interface | undefined
		if (errorInterfaces) {
			const errorFragments = errorInterfaces.flatMap((iface) => {
				if (iface instanceof Interface) return iface.fragments.filter((fragment) => ErrorFragment.isFragment(fragment))
				return (iface as Fragment[]).filter((fragment) => fragment.type === 'error' || ErrorFragment.isFragment(fragment) )
			})
			errorInterface = new Interface(errorFragments)
		}
		const handlers = [
			new EmptyErrorHandler(),
			new RevertErrorHandler(),
			new PanicErrorHandler(),
			new CustomErrorHandler(),
			new UserRejectionHandler(),
			new RpcErrorHandler(),
			...(additionalErrorHandlers ?? []),
		]
		return new ErrorDecoder(handlers, errorInterface)
	}
}