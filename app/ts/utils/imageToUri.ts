import { Future } from './future.js'

export type ImageToUriResult = {
	data: string | undefined
	failureReason: string | undefined
}

const imageToUriFailed = (failureReason: string): ImageToUriResult => ({ data: undefined, failureReason })
const imageToUriSucceeded = (data: string): ImageToUriResult => ({ data, failureReason: undefined })

async function readBlobAsDataUrl(blob: Blob): Promise<ImageToUriResult> {
	const reader = new FileReader()
	const future = new Future<ImageToUriResult>

	reader.onloadend = () => {
		if (typeof reader.result !== 'string') return future.resolve(imageToUriFailed('file reader failed'))
		return future.resolve(imageToUriSucceeded(reader.result))
	}
	reader.onerror = () => future.resolve(imageToUriFailed('file reader failed'))
	reader.onabort = () => future.resolve(imageToUriFailed('file reader aborted'))
	reader.readAsDataURL(blob)
	return await future
}

export async function imageToUri(url: string, maxSizeInBytes = 1048576): Promise<ImageToUriResult> {
	try {
		const response = await fetch(url)
		if (!response.ok) return imageToUriFailed(`HTTP ${ response.status }${ response.statusText === '' ? '' : ` ${ response.statusText }` }`)
		const contentType = response.headers.get('content-type')
		if (contentType !== null && !contentType.startsWith('image/')) return imageToUriFailed(`response was not an image (${ contentType })`)
		const blob = await response.blob()
		const result = await readBlobAsDataUrl(blob)
		if (result.failureReason !== undefined || result.data === undefined) return result
		if (result.data.length > maxSizeInBytes) return imageToUriFailed(`image data exceeded ${ maxSizeInBytes } bytes`)
		return result
	} catch (error) {
		if (error instanceof Error) return imageToUriFailed(`fetch failed (${ error.message })`)
		throw error
	}
}
