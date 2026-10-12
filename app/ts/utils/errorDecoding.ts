import type { Abi, AbiItem } from './ethereumPrimitives.js'
import { reportLocalRecoveryBestEffort } from './errors.js'
import type { ErrorWithCodeAndOptionalData } from '../types/error.js'
import { decodeAbiValues, decodeErrorLoose, normalizeAbi, type AbiLike } from './abiRuntime.js'

const ERROR_STRING_PREFIX = '0x08c379a0' // Error(string)
const PANIC_CODE_PREFIX = '0x4e487b71' // Panic(uint256)
const isHexData = (value: string): value is `0x${ string }` => value.startsWith('0x')

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

const formatReason = (reason: string, defaultReason: string) => reason.trim() !== '' ? reason : defaultReason

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
const revertErrorResult = ({ data, reason, fragment, args, selector, name, signature }: ErrorResultFormatterParam) => baseErrorResult({ type: ErrorType.RevertError, reason, data, fragment, args, selector, name, signature })
const unknownErrorResult = ({ data, reason, name }: ErrorResultFormatterParam) => baseErrorResult({ type: ErrorType.UnknownError, reason: formatReason(reason, 'Unknown error'), data, name })
const panicErrorResult = ({ data, reason, fragment, args, selector, name, signature }: ErrorResultFormatterParam) => baseErrorResult({ type: ErrorType.PanicError, reason, data, fragment, args, selector, name, signature })
const customErrorResult = ({ data, reason, fragment, args, selector, name, signature }: ErrorResultFormatterParam) => {
	const resolvedSelector = selector ?? data?.slice(0, 10)
	return baseErrorResult({
		type: ErrorType.CustomError,
		reason: formatReason(reason, `No ABI for custom error ${ resolvedSelector }`),
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

// Source: https://docs.uniswap.org/contracts/v3/reference/error-codes plus the require strings in Uniswap/v3-core and Uniswap/v3-periphery.
// Self-explanatory periphery strings that unrelated contracts also use, such as 'Transaction too old', 'Not approved' and 'Invalid token ID', are deliberately not attributed to Uniswap.
const uniswapV3RevertReasonToExplanation = (revertReason: string): string | undefined => {
	switch (revertReason) {
		case 'LOK': return 'The pool is locked, either because the call re-entered the pool or because the pool has not been initialized'
		case 'TLU': return 'The lower tick must be below the upper tick'
		case 'TLM': return 'The lower tick must be greater than or equal to the minimum tick'
		case 'TUM': return 'The upper tick must be less than or equal to the maximum tick'
		case 'AI': return 'The pool is already initialized'
		case 'M0': return 'Mint failed because the pool did not receive the required amount of token0'
		case 'M1': return 'Mint failed because the pool did not receive the required amount of token1'
		case 'AS': return 'The swap amount cannot be zero'
		case 'SPL': return 'The swap price limit is on the wrong side of the current price or outside the supported range'
		case 'IIA': return 'Insufficient input amount: the pool did not receive enough input tokens during the swap callback'
		case 'L': return 'A flash loan requires the pool to have liquidity greater than zero'
		case 'F0': return 'The flash loan did not repay the borrowed token0 plus the fee'
		case 'F1': return 'The flash loan did not repay the borrowed token1 plus the fee'
		case 'LS': return 'Liquidity subtraction underflowed because more liquidity was removed than exists'
		case 'LA': return 'Liquidity addition overflowed'
		case 'OLD': return 'The requested oracle observation is older than the oldest stored observation'
		case 'I': return 'The pool has not been initialized'
		case 'NP': return 'Cannot burn from a position with zero liquidity'
		case 'LO': return 'The liquidity at this tick would exceed the maximum allowed liquidity per tick'
		case 'T': return 'The tick is outside the minimum and maximum supported tick'
		case 'R': return 'The square root price is outside the minimum and maximum supported price'
		case 'TF': return 'The pool failed to transfer tokens'
		case 'STF': return 'Token transfer from the sender via safeTransferFrom failed, usually due to insufficient token balance or allowance'
		case 'ST': return 'Token transfer via safeTransfer failed'
		case 'SA': return 'Token approval via safeApprove failed'
		case 'STE': return 'Ether transfer via safeTransferETH failed'
		case 'Too little received': return 'The swap output is below the minimum amount out, usually because the price moved beyond the slippage tolerance'
		case 'Too much requested': return 'The swap input is above the maximum amount in, usually because the price moved beyond the slippage tolerance'
		case 'Price slippage check': return 'The token amounts added or removed are below the minimum amounts, usually because the price moved beyond the slippage tolerance'
		case 'Not cleared': return 'The position must have zero liquidity and no uncollected tokens before it can be burned'
		default: return undefined
	}
}

// Uniswap V3 short codes such as 'T' or 'L' can also come from unrelated contracts, and they bubble up through routers, aggregators and V3 forks, so the explanation is appended as a hint labeled 'possible' next to the unchanged original reason instead of being scoped to known Uniswap addresses.
const explainRevertReason = (reason: string) => {
	const uniswapV3Explanation = uniswapV3RevertReasonToExplanation(reason)
	if (uniswapV3Explanation === undefined) return reason
	return `${ reason } - possible Uniswap V3 error: ${ uniswapV3Explanation }`
}

const getErrorAbiItem = (abi: Abi): ErrorAbiItem | undefined => {
	const item = abi[0]
	if (item === undefined || item.type !== 'error') return undefined
	return item
}

const handleEmptyError = (error: ErrorWithCodeAndOptionalData) => emptyErrorResult({ data: error.data, reason: error.message })

const handleRevertError = (error: ErrorWithCodeAndOptionalData) => {
	if (error.data === undefined) return unknownErrorResult({ reason: 'Unknown error returned', data: '0x' })
	const encodedReason = `0x${ error.data.slice(ERROR_STRING_PREFIX.length) }` as const
	const fragment = getErrorAbiItem(ErrorStringABI)
	if (fragment === undefined) return unknownErrorResult({ reason: 'Unknown error returned', data: error.data })
	try {
		const args = decodeAbiValues(fragment.inputs ?? [], encodedReason)
		const [reason] = args
		return revertErrorResult({
			data: error.data,
			fragment,
			reason: typeof reason === 'string' ? explainRevertReason(reason) : 'Unknown error returned',
			args,
			selector: ERROR_STRING_PREFIX,
			name: 'Error',
			signature: 'Error(string)',
		})
	} catch {
		return unknownErrorResult({ reason: 'Unknown error returned', data: error.data })
	}
}

const handlePanicError = (error: ErrorWithCodeAndOptionalData) => {
	if (error.data === undefined) return unknownErrorResult({ reason: 'Unknown error returned', data: '0x' })
	const encodedReason = `0x${ error.data.slice(PANIC_CODE_PREFIX.length) }` as const
	const fragment = getErrorAbiItem(PanicABI)
	if (fragment === undefined) return unknownErrorResult({ reason: 'Unknown panic error', data: error.data })
	try {
		const args = decodeAbiValues(fragment.inputs ?? [], encodedReason)
		const [errorCode] = args
		const reason = typeof errorCode === 'bigint' ? panicErrorCodeToReason(errorCode) ?? 'Unknown panic code' : 'Unknown panic code'
		return panicErrorResult({
			data: error.data,
			fragment,
			reason,
			args,
			selector: PANIC_CODE_PREFIX,
			name: 'Panic',
			signature: 'Panic(uint256)',
		})
	} catch {
		return unknownErrorResult({ reason: 'Unknown panic error', data: error.data })
	}
}

const handleCustomError = (errorAbis: readonly AbiLike[], error: ErrorWithCodeAndOptionalData) => {
	const result: Parameters<typeof customErrorResult>[0] = { data: error.data, reason: error.message }
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
		return unknownErrorResult({ data: error.data, reason: error.message, name: 'unknown' })
	} catch (decodingError: unknown) {
		reportLocalRecoveryBestEffort(decodingError, { code: 'ethereum_error_decode_failed', message: 'Returning an unknown decoded error result.' })
		return unknownErrorResult({ data: error.data, reason: `Failed to decode error: ${ error.message }`, name: 'unknown' })
	}
}
