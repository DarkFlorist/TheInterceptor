import { isJsonRecord, readApiJson } from './simulatedApiResponse.js'

// Aborting a caller stops its response immediately; shared transport work may finish for other callers.
export function withRequestAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => { reject(signal.reason); signal.removeEventListener('abort', abort) }
		// Observe already-started transport even after cancellation; settling the rejected wrapper cannot publish a late result.
		if (signal.aborted) reject(signal.reason)
		else signal.addEventListener('abort', abort, { once: true })
		promise.then((value) => { signal.removeEventListener('abort', abort); resolve(value) }, (error: unknown) => { signal.removeEventListener('abort', abort); reject(error) })
	})
}

const isChainProbeReplyCandidate = (value: unknown): value is { readonly id?: unknown, readonly result?: unknown } => isJsonRecord(value)
const isProbeNetworkFailure = (error: unknown) => error instanceof TypeError && ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed'].includes(error.message)
const normalizeProbeChain = (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) ? `0x${ BigInt(value).toString(16) }` : undefined

// Endpoint identity and browser transport failures belong here; an identified chain never authorizes an overlay.
export function createRpcEndpointChainTransport(send: typeof fetch, now: () => number = Date.now) {
	const endpoints = new Map<string, { readonly expires: number, readonly chain: Promise<string | undefined> }>()
	return {
		clear: () => endpoints.clear(),
		async identify(request: Request) {
			const headers = new Headers(request.headers)
			headers.delete('content-length')
			headers.set('content-type', 'application/json')
			// Headers and credentials can select a different RPC behind the same URL. The key stays in memory and is never logged.
			const headerEntries: string[][] = []
			headers.forEach((value, key) => { headerEntries.push([key, value]) })
			const key = JSON.stringify([request.url, headerEntries, request.credentials])
			const waitForProbe = async (entry: { readonly chain: Promise<string | undefined> }) => {
				try {
					const chain = await withRequestAbort(entry.chain, request.signal)
					// Gateway authorization can become ready after its first probe. Cache verified chains, never a failed startup identification.
					if (chain === undefined && endpoints.get(key) === entry) endpoints.delete(key)
					return chain
				} catch (error: unknown) {
					if (endpoints.get(key) === entry) endpoints.delete(key)
					// Only identification failures may preserve native transport. Simulated-read errors never pass through this classifier.
					if (!request.signal.aborted && isProbeNetworkFailure(error)) return undefined
					throw error
				}
			}
			const cached = endpoints.get(key)
			if (cached !== undefined && cached.expires > now()) return await waitForProbe(cached)
			const chain = (async () => {
				const response = await send(request.url, { method: 'POST', headers, credentials: request.credentials, mode: request.mode, cache: 'no-store', body: JSON.stringify({ jsonrpc: '2.0', id: 'interceptor-chain-probe', method: 'eth_chainId', params: [] }) })
				if (!response.ok) return undefined
				const data = await readApiJson(response)
				return isChainProbeReplyCandidate(data) && data.id === 'interceptor-chain-probe' ? normalizeProbeChain(data.result) : undefined
			})()
			const entry = { expires: now() + 30_000, chain }
			// Keep the existing insertion-order cap, including shared in-flight entries.
			if (endpoints.size >= 64) {
				const oldest = endpoints.keys().next().value
				if (oldest !== undefined) endpoints.delete(oldest)
			}
			endpoints.set(key, entry)
			return await waitForProbe(entry)
		},
	}
}
