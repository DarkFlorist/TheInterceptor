import { JsonRpcErrorResponse } from './wire-types'

export class ErrorWithData extends Error {
	public constructor(message: string, public data: unknown) {
		super(message)
		Object.setPrototypeOf(this, ErrorWithData)
	}
}

export class JsonRpcResponseError extends ErrorWithData {
	public readonly id: string | number
	public readonly code: number
	public constructor(jsonRpcResponse: JsonRpcErrorResponse) {
		super(jsonRpcResponse.error.message, jsonRpcResponse.error.data)
		this.code = jsonRpcResponse.error.code
		this.id = jsonRpcResponse.id
	}
}

export function exitOnError<P extends unknown[], R>(func: (...params: P) => R): (...params: P) => R {
	return (...params: P) => {
		try {
			return func(...params)
		} catch (error: unknown) {
			console.error('An error occurred.')
			if (typeof error === 'object' && error !== null && 'message' in error) console.error((error as any).message)
			if (typeof error === 'object' && error !== null && 'data' in error) console.error((error as any).data)
			console.error(error)
			debugger
			process.exit(1)
		}
	}
}

export function swallowAsyncErrors<P extends unknown[]>(func: (...params: P) => Promise<void>): (...params: P) => void {
	return (...params: P) => {
		func(...params).catch(error => {
			console.error('An error occurred.')
			if (typeof error === 'object' && error !== null && 'message' in error) console.error((error as any).message)
			if (typeof error === 'object' && error !== null && 'data' in error) console.error((error as any).data)
			console.error(error)
			debugger
		})
	}
}
