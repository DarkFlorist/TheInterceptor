import { JsonRpcResponseError, isFailedToFetchError } from '../utils/errors.js'
import { fetchWithTimeout } from '../utils/requests.js'
import type { JsonValue } from '../types/safeApps.js'

export const safeAppsServiceError = (message: string) => new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message } })

export async function requestSafeAppsGateway(path: string, service: 'balance' | 'message' | 'transaction', body?: JsonValue, allowMissing = false): Promise<unknown> {
	try {
		const response = await fetchWithTimeout(`https://safe-client.safe.global/v1/${ path }`, {
			credentials: 'omit', redirect: 'error',
			...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
		}, 15_000)
		if (allowMissing && response.status === 404) return undefined
		if (!response.ok) throw safeAppsServiceError(`The Safe ${ service } service could not complete this request (HTTP ${ response.status }).`)
		if (body !== undefined) return undefined
		try {
			return await response.json()
		} catch (error) {
			if (error instanceof SyntaxError) throw safeAppsServiceError(`The Safe ${ service } service returned invalid JSON.`)
			throw error
		}
	} catch (error) {
		if (isFailedToFetchError(error)) throw safeAppsServiceError(`The Safe ${ service } service could not be reached. Try again later.`)
		throw error
	}
}
