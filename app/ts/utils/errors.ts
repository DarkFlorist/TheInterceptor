import { sendPopupMessageToOpenWindows } from '../background/backgroundUtils.js'
import { setLatestUnexpectedError } from '../background/storageVariables.js'
import { JsonRpcErrorResponse } from '../types/JsonRpc-types.js'
import { NEW_BLOCK_ABORT } from './constants.js'

const errorWithDataBrand = Symbol('ErrorWithData')
const jsonRpcResponseErrorBrand = Symbol('JsonRpcResponseError')

export type ErrorWithData = Error & {
	readonly data: unknown
	readonly [errorWithDataBrand]: true
}

export function ErrorWithData(message: string, data: unknown): ErrorWithData {
	return Object.assign(new Error(message), {
		data,
		[errorWithDataBrand]: true as const,
	})
}

export type SerializedJsonRpcResponseError = {
	readonly jsonrpc: '2.0'
	readonly id: string | number
	readonly error: {
		readonly message: string
		readonly code: number
		readonly data?: string
	}
}

export type JsonRpcResponseError = Error & {
	readonly id: string | number
	readonly code: number
	readonly data: string | undefined
	readonly [jsonRpcResponseErrorBrand]: true
	serialize(): SerializedJsonRpcResponseError
}

export function JsonRpcResponseError(jsonRpcResponse: JsonRpcErrorResponse): JsonRpcResponseError {
	const message = jsonRpcResponse.error.message
	const code = jsonRpcResponse.error.code
	const id = jsonRpcResponse.id
	const data = jsonRpcResponse.error.data

	return Object.assign(new Error(message), {
		id,
		code,
		data,
		[jsonRpcResponseErrorBrand]: true as const,
		serialize: () => ({
			jsonrpc: '2.0' as const,
			id,
			error: {
				message,
				code,
				...(data !== undefined ? { data } : {}),
			},
		}),
	})
}

export function isJsonRpcResponseError(error: unknown): error is JsonRpcResponseError {
	return typeof error === 'object' && error !== null && jsonRpcResponseErrorBrand in error
}

export function isFailedToFetchError(error: Error) {
	if (error.message.includes('Fetch request timed out.') || error.message.includes('Failed to fetch') || error.message.includes('NetworkError when attempting to fetch resource')) return true
	return false
}

export const isNewBlockAbort = (error: Error) => error.message?.includes(NEW_BLOCK_ABORT)

export function printError(error: unknown) {
	console.error(error)
	if (error instanceof Error) {
		try {
			if ('data' in error) console.error('data: ', JSON.stringify(error.data))
			if ('code' in error) console.error('code: ', JSON.stringify(error.code))
		} catch(stringifyError) {
			console.error(stringifyError)
		}
	}
}

export async function handleUnexpectedError(error: unknown) {
	printError(error)
	console.trace()
	const errorMessage = {
		method: 'popup_UnexpectedErrorOccured' as const,
		data: {
			timestamp: new Date(),
			message: typeof error === 'object' && error !== null && 'message' in error && error.message !== undefined && typeof error.message === 'string' ? error.message : 'Please see The Interceptors console for more details on the error.'
		}
	}
	await setLatestUnexpectedError(errorMessage)
	await sendPopupMessageToOpenWindows(errorMessage)
}
