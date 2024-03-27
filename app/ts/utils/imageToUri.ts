import { isFailedToFetchError } from './errors.js'
import { Future } from './future.js'

export async function imageToUri(url: string, maxSizeInBytes = 1048576) {
	try {
		const response = await fetch(url)
		const blob = await response.blob()
		const reader = new FileReader()
		const future = new Future<string | undefined>

		reader.onloadend = () => future.resolve(reader.result === null ? undefined : reader.result as string)
		reader.onerror = () => future.resolve(undefined)
		reader.onabort = () => future.resolve(undefined)
		reader.readAsDataURL(blob)
		const data = await future

		if (data === undefined || data.length > maxSizeInBytes) return undefined
		return data
	} catch (error) {
		if (error instanceof Error) {
			console.warn(error)
			if (isFailedToFetchError(error)) return undefined
		}
		throw error

	}
}
