import { Future } from './future.js'
import { fetchWithTimeout } from './requests.js'

export type ImageToUriResult = {
	data: string | undefined
	failureReason: string | undefined
}

const imageToUriFailed = (failureReason: string): ImageToUriResult => ({
	data: undefined,
	failureReason,
})
const imageToUriSucceeded = (data: string): ImageToUriResult => ({
	data,
	failureReason: undefined,
})
const imageTooLarge = (maxSizeInBytes: number) =>
	imageToUriFailed(`image data exceeded ${maxSizeInBytes} bytes`)

async function readBlobAsDataUrl(blob: Blob): Promise<ImageToUriResult> {
	const reader = new FileReader()
	const future = new Future<ImageToUriResult>()

	reader.onloadend = () => {
		if (typeof reader.result !== 'string')
			return future.resolve(imageToUriFailed('file reader failed'))
		return future.resolve(imageToUriSucceeded(reader.result))
	}
	reader.onerror = () => future.resolve(imageToUriFailed('file reader failed'))
	reader.onabort = () => future.resolve(imageToUriFailed('file reader aborted'))
	reader.readAsDataURL(blob)
	return await future
}

function parseContentLength(contentLength: string | null): number | undefined {
	if (contentLength === null) return undefined
	const parsed = Number.parseInt(contentLength, 10)
	if (!Number.isFinite(parsed) || parsed < 0) return undefined
	return parsed
}

async function readBlobWithSizeLimit(
	response: Response,
	maxSizeInBytes: number,
): Promise<Blob | ImageToUriResult> {
	const contentLength = parseContentLength(
		response.headers.get('content-length'),
	)
	if (contentLength !== undefined && contentLength > maxSizeInBytes)
		return imageTooLarge(maxSizeInBytes)
	if (response.body === null) {
		const blob = await response.blob()
		if (blob.size > maxSizeInBytes) return imageTooLarge(maxSizeInBytes)
		return blob
	}
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let receivedBytes = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			if (value === undefined) continue
			receivedBytes += value.byteLength
			if (receivedBytes > maxSizeInBytes) {
				await reader.cancel('image exceeded size limit')
				return imageTooLarge(maxSizeInBytes)
			}
			chunks.push(value)
		}
	} finally {
		reader.releaseLock()
	}
	return new Blob(chunks, {
		type: response.headers.get('content-type') ?? undefined,
	})
}

export async function imageToUri(
	url: string,
	maxSizeInBytes = 1048576,
): Promise<ImageToUriResult> {
	try {
		const response = await fetchWithTimeout(url, undefined, 15_000)
		if (!response.ok)
			return imageToUriFailed(
				`HTTP ${response.status}${response.statusText === '' ? '' : ` ${response.statusText}`}`,
			)
		const contentType = response.headers.get('content-type')
		if (contentType !== null && !contentType.startsWith('image/'))
			return imageToUriFailed(`response was not an image (${contentType})`)
		const blob = await readBlobWithSizeLimit(response, maxSizeInBytes)
		if (!(blob instanceof Blob)) return blob
		const result = await readBlobAsDataUrl(blob)
		if (result.failureReason !== undefined || result.data === undefined)
			return result
		if (result.data.length > maxSizeInBytes)
			return imageTooLarge(maxSizeInBytes)
		return result
	} catch (error) {
		if (error instanceof Error)
			return imageToUriFailed(`fetch failed (${error.message})`)
		throw error
	}
}
