import type { DocumentRoute } from './browserTypes.js'

type PreparedDocumentResponse = {
	readonly statusCode: 200
	readonly headers: readonly { readonly name: string, readonly value: string }[]
	readonly bodyBase64: string
}

// Keep fixture matching and content identical across CDP and BiDi; the engines only adapt this response to their transport shapes.
export function prepareDocumentResponse(routes: readonly DocumentRoute[], requestUrl: unknown): PreparedDocumentResponse | undefined {
	if (typeof requestUrl !== 'string') return undefined
	const route = routes.find(({ url }) => url === requestUrl)
	if (route === undefined) return undefined
	const headers = new Map([['content-type', { name: 'Content-Type', value: 'text/html; charset=utf-8' }]])
	for (const [name, value] of Object.entries(route.headers ?? {})) headers.set(name.toLowerCase(), { name, value })
	return {
		statusCode: 200,
		headers: [...headers.values()],
		bodyBase64: Buffer.from(route.body).toString('base64'),
	}
}
