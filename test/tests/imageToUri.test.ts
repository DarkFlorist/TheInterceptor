import * as assert from 'assert'
import { afterAll, afterEach, describe, test } from 'bun:test'
import { imageToUri } from '../../app/ts/utils/imageToUri.js'

type FetchImplementation = (url: string) => Promise<Response>
type MockFileReaderState = {
	result: string | ArrayBuffer | undefined
	onabort: (() => void) | undefined
	onerror: (() => void) | undefined
	onloadend: (() => void) | undefined
	readAsDataURL: (_blob: Blob) => void
}

const originalFetch = globalThis.fetch
const originalFileReader = globalThis.FileReader

let fetchImplementation: FetchImplementation = async () => new Response(new Blob(['default']), { status: 200, headers: { 'content-type': 'image/png' } })

function installSuccessfulFileReader(result: string) {
	function SuccessfulFileReader(this: MockFileReaderState) {
		this.result = undefined
		this.onabort = undefined
		this.onerror = undefined
		this.onloadend = undefined
		this.readAsDataURL = () => {
			this.result = result
			this.onloadend?.()
		}
	}

	Object.defineProperty(globalThis, 'FileReader', {
		configurable: true,
		writable: true,
		value: SuccessfulFileReader,
	})
}

Object.defineProperty(globalThis, 'fetch', {
	configurable: true,
	writable: true,
	value: async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		return await fetchImplementation(url)
	},
})

afterEach(() => {
	fetchImplementation = async () => new Response(new Blob(['default']), { status: 200, headers: { 'content-type': 'image/png' } })
	Object.defineProperty(globalThis, 'FileReader', {
		configurable: true,
		writable: true,
		value: originalFileReader,
	})
})

afterAll(() => {
	Object.defineProperty(globalThis, 'fetch', {
		configurable: true,
		writable: true,
		value: originalFetch,
	})
	Object.defineProperty(globalThis, 'FileReader', {
		configurable: true,
		writable: true,
		value: originalFileReader,
	})
})

describe('imageToUri', () => {
	test('returns a data uri for a successful image fetch', async () => {
		installSuccessfulFileReader('data:image/png;base64,b2s=')
		fetchImplementation = async () => new Response(new Blob(['ok'], { type: 'image/png' }), { status: 200, headers: { 'content-type': 'image/png' } })

		const result = await imageToUri('https://example.test/success.png')

		assert.equal(result.failureReason, undefined)
		assert.equal(result.data?.startsWith('data:image/png;base64,'), true)
	})

	test('classifies fetch rejections', async () => {
		fetchImplementation = async () => { throw new TypeError('Failed to fetch') }

		const result = await imageToUri('https://example.test/fail.png')

		assert.equal(result.data, undefined)
		assert.equal(result.failureReason, 'fetch failed (Failed to fetch)')
	})

	test('classifies non-ok responses', async () => {
		fetchImplementation = async () => new Response('missing', { status: 404, statusText: 'Not Found', headers: { 'content-type': 'image/png' } })

		const result = await imageToUri('https://example.test/404.png')

		assert.equal(result.data, undefined)
		assert.equal(result.failureReason, 'HTTP 404 Not Found')
	})

	test('classifies non-image responses', async () => {
		fetchImplementation = async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })

		const result = await imageToUri('https://example.test/not-image')

		assert.equal(result.data, undefined)
		assert.equal(result.failureReason, 'response was not an image (text/html)')
	})

	test('classifies oversized data uris', async () => {
		installSuccessfulFileReader('data:image/png;base64,dG9vLWJpZw==')
		fetchImplementation = async () => new Response(new Blob(['too-big'], { type: 'image/png' }), { status: 200, headers: { 'content-type': 'image/png' } })

		const result = await imageToUri('https://example.test/too-big.png', 5)

		assert.equal(result.data, undefined)
		assert.equal(result.failureReason, 'image data exceeded 5 bytes')
	})

	test('classifies file reader failures', async () => {
		function FailingFileReader(this: MockFileReaderState) {
			this.result = undefined
			this.onabort = undefined
			this.onerror = undefined
			this.onloadend = undefined
			this.readAsDataURL = () => this.onerror?.()
		}

		Object.defineProperty(globalThis, 'FileReader', {
			configurable: true,
			writable: true,
			value: FailingFileReader,
		})
		fetchImplementation = async () => new Response(new Blob(['ok'], { type: 'image/png' }), { status: 200, headers: { 'content-type': 'image/png' } })

		const result = await imageToUri('https://example.test/reader-fail.png')

		assert.equal(result.data, undefined)
		assert.equal(result.failureReason, 'file reader failed')
	})
})
