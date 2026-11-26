export const isJsonRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export async function readApiJson(response: Response): Promise<unknown> {
	try { return await response.clone().json() } catch (error: unknown) {
		if (error instanceof SyntaxError) return undefined
		throw error
	}
}

export function simulatedApiResponse(response: Response, url: string, value: unknown) {
	const headers = new Headers(response.headers)
	for (const name of ['content-length', 'content-encoding', 'etag']) headers.delete(name)
	headers.set('content-type', 'application/json')
	headers.set('cache-control', 'no-store')
	headers.set('x-interceptor-simulation', 'true')
	const overlaid = new Response(JSON.stringify(value), { status: response.status, statusText: response.statusText, headers })
	Object.defineProperty(overlaid, 'url', { value: url })
	return overlaid
}
