import { prepareSiteHttpApiInterception, shouldWaitForSiteHttpContext } from './siteHttpApiAdapters.js'
import type { RpcRead } from './siteHttpApiInterception.js'
export type { RpcRead } from './siteHttpApiInterception.js'

type InterceptionContext = { readonly origin: string, readonly chainId: string, readonly methods: readonly string[], readonly chainRoutedProxyPaths: readonly string[], readonly address?: string }
type FetchWindow = { readonly location: { readonly origin: string }, fetch: typeof fetch }
type RpcObject = { readonly jsonrpc?: unknown, readonly id?: unknown, readonly method?: unknown, readonly params?: unknown, readonly chainId?: unknown, readonly methods?: unknown, readonly result?: unknown, readonly code?: unknown, readonly message?: unknown, readonly data?: unknown, readonly origin?: unknown, readonly chainRoutedProxyPaths?: unknown, readonly address?: unknown }
const isRpcObject = (value: unknown): value is RpcObject => typeof value === 'object' && value !== null
const isChainId = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)
const proxyChainId = (value: unknown) => {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return `0x${ BigInt(value).toString(16) }`
	if (typeof value === 'string' && value.length <= 128 && (/^0x[0-9a-f]+$/i.test(value) || /^[0-9]+$/.test(value))) return `0x${ BigInt(value).toString(16) }`
	return undefined
}
const normalizeChainId = (value: string) => `0x${ BigInt(value).toString(16) }`

async function readJson(response: Pick<Response, 'json'>): Promise<unknown> {
	try { return await response.json() } catch (error: unknown) {
		if (error instanceof SyntaxError) return undefined
		throw error
	}
}

function parseRpcRead(value: unknown, methods: readonly string[]): RpcRead | undefined {
	if (!isRpcObject(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string' || !methods.includes(value.method)) return undefined
	const id = value.id
	if (id !== null && typeof id !== 'string' && (typeof id !== 'number' || !Number.isFinite(id))) return undefined
	const params = value.params
	if (params !== undefined && !Array.isArray(params)) return undefined
	return { jsonrpc: '2.0', id, method: value.method, ...(params === undefined ? {} : { params }) }
}

// Aborting the HTTP request stops its response immediately; a read already sent to the background can finish without publishing to the aborted request.
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason)
	return new Promise((resolve, reject) => {
		const abort = () => { reject(signal.reason); signal.removeEventListener('abort', abort) }
		signal.addEventListener('abort', abort, { once: true })
		promise.then((value) => { signal.removeEventListener('abort', abort); resolve(value) }, (error: unknown) => { signal.removeEventListener('abort', abort); reject(error) })
	})
}

// Only an approved simulation session publishes a site behavior context. Every intercepted read is also admitted in the background against live permissions, mode, chain and a read-only method policy.
export function installRpcReadInterception(windowObject: FetchWindow, requestRpc: (chainId: string, request: RpcRead) => Promise<unknown>, captureBeforeContext = false) {
	let context: InterceptionContext | undefined
	let installedByUs = false
	let disposed = false
	let initialContextPending = captureBeforeContext
	const initialContextWaiters = new Set<() => void>()
	const resolveInitialContext = () => {
		initialContextPending = false
		for (const resolve of initialContextWaiters) resolve()
	}
	const waitForInitialContext = async () => {
		if (!initialContextPending) return
		await new Promise<void>((resolve) => {
			const finish = () => { clearTimeout(timeout); initialContextWaiters.delete(finish); resolve() }
			// A missing background must not stall the website. Only the first publication can hold startup reads; later revocations never wait.
			const timeout = setTimeout(resolveInitialContext, 1000)
			initialContextWaiters.add(finish)
		})
	}
	const nativeFetch = windowObject.fetch
	const hasFetch = typeof nativeFetch === 'function'
	const send: typeof fetch = (input, init) => nativeFetch.call(windowObject, input, init)
	const endpoints = new Map<string, { readonly expires: number, readonly chain: Promise<string | undefined> }>()
	const getEndpointChain = async (request: Request) => {
		const headers = new Headers(request.headers)
		headers.delete('content-length')
		headers.set('content-type', 'application/json')
		// Headers and credentials can select a different RPC behind the same URL. The key stays in memory and is never logged.
		const headerEntries: string[][] = []
		headers.forEach((value, key) => { headerEntries.push([key, value]) })
		const key = JSON.stringify([request.url, headerEntries, request.credentials])
		const waitForProbe = async (entry: { readonly chain: Promise<string | undefined> }) => {
			try {
				const chain = await withAbort(entry.chain, request.signal)
				// Gateway authorization can become ready after its first probe. Cache verified chains, never a failed startup identification.
				if (chain === undefined && endpoints.get(key) === entry) endpoints.delete(key)
				return chain
			} catch (error: unknown) {
				if (endpoints.get(key) === entry) endpoints.delete(key)
				// A failed identification probe must not prevent the caller's original transport. Simulated-read failures never enter this path.
				if (!request.signal.aborted && error instanceof TypeError && ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed'].includes(error.message)) return undefined
				throw error
			}
		}
		const cached = endpoints.get(key)
		if (cached !== undefined && cached.expires > Date.now()) return await waitForProbe(cached)
		const chain = (async () => {
			const response = await send(request.url, { method: 'POST', headers, credentials: request.credentials, mode: request.mode, cache: 'no-store', body: JSON.stringify({ jsonrpc: '2.0', id: 'interceptor-chain-probe', method: 'eth_chainId', params: [] }) })
			if (!response.ok) return undefined
			const data = await readJson(response)
			return isRpcObject(data) && data.id === 'interceptor-chain-probe' && isChainId(data.result) ? normalizeChainId(data.result) : undefined
		})()
		const entry = { expires: Date.now() + 30_000, chain }
		if (endpoints.size >= 64) {
			const oldest = endpoints.keys().next().value
			if (oldest !== undefined) endpoints.delete(oldest)
		}
		endpoints.set(key, entry)
		return await waitForProbe(entry)
	}
	const interceptedFetch: typeof fetch = async (input, init) => {
		const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
		if (initialContextPending && shouldWaitForSiteHttpContext(method, new URL(String(input instanceof Request ? input.url : input), windowObject.location.origin).href)) await waitForInitialContext()
		const selected = context
		if (selected === undefined) return await send(input, init)
		const request = new Request(input, init)
		if (request.signal.aborted) throw request.signal.reason
		const apiResponse = await withAbort((async () => {
			const apply = await prepareSiteHttpApiInterception(request, selected)
			return apply === undefined ? undefined : await apply((request) => send(request), requestRpc)
		})(), request.signal)
		if (apiResponse !== undefined) {
			if (context !== selected) throw new Error('The site simulation session changed before its HTTP API reply.')
			return apiResponse
		}
		if (request.method !== 'POST' || !/^https?:/.test(request.url)) return await send(request)
		const text = await request.clone().text()
		if (text.length > 1_000_000) return await send(request)
		const value = await readJson({ json: async () => JSON.parse(text) })
		const url = new URL(request.url)
		// Configured same-origin chain-routed HTTP APIs omit JSON-RPC IDs and carry an explicit chainId. They are not JSON-RPC notifications.
		const proxy = url.origin === windowObject.location.origin && selected.chainRoutedProxyPaths.includes(url.pathname.replace(/\/$/, '')) && isRpcObject(value) && value.jsonrpc === undefined && value.id === undefined
		const declaredChain = proxy && isRpcObject(value) ? proxyChainId(value.chainId) : undefined
		const candidates: readonly unknown[] = proxy && isRpcObject(value) ? [{ ...value, jsonrpc: '2.0', id: Date.now() }] : Array.isArray(value) ? value : [value]
		const reads = candidates.map((candidate) => parseRpcRead(candidate, selected.methods))
		// Notifications, mixed read/write batches, malformed envelopes and duplicate IDs retain their original transport semantics.
		if (reads.length === 0 || reads.some((read) => read === undefined) || new Set(reads.map((read) => read?.id)).size !== reads.length) return await send(request)
		if (proxy && declaredChain === undefined) return await send(request)
		const chain = proxy ? declaredChain : await getEndpointChain(request)
		if (chain === undefined || chain !== selected.chainId || context !== selected) return await send(request)
		const replies = await withAbort(Promise.all(reads.map(async (read) => {
			if (read === undefined) throw new Error('Missing admitted site RPC read.')
			try { return { jsonrpc: '2.0', id: read.id, result: await requestRpc(chain, read) } } catch (error: unknown) {
				// RPC failures remain failures; never replace them with live-chain data from the original endpoint.
				if (!isRpcObject(error) || typeof error.code !== 'number' || typeof error.message !== 'string') throw error
				return { jsonrpc: '2.0', id: read.id, error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } }
			}
		})), request.signal)
		if (context !== selected) throw new Error('The site simulation session changed before its RPC reply.')
		const response = new Response(JSON.stringify(Array.isArray(value) ? replies : replies[0]), { status: 200, headers: { 'content-type': 'application/json', 'x-interceptor-simulation': 'true' } })
		Object.defineProperty(response, 'url', { value: request.url })
		return response
	}
	// Approved document-start hosting can capture fetch before SDK clients retain it. Context remains the sole authority to overlay a read, including through retained references.
	const installFetchHook = () => {
		if (disposed || !hasFetch || installedByUs || windowObject.fetch !== nativeFetch) return
		windowObject.fetch = interceptedFetch
		installedByUs = true
	}
	// Local ownership tracks our assignment; the identity check only protects later page instrumentation from being overwritten.
	const restoreFetchHook = () => {
		if (!installedByUs) return
		if (windowObject.fetch === interceptedFetch) windowObject.fetch = nativeFetch
		installedByUs = false
	}
	if (captureBeforeContext) installFetchHook()
	return {
		setContext(value: unknown) {
			if (disposed) return false
			resolveInitialContext()
			const address = isRpcObject(value) && typeof value.address === 'string' && /^0x[0-9a-f]{40}$/i.test(value.address) ? value.address.toLowerCase() : undefined
			const next = hasFetch && isRpcObject(value) && value.origin === windowObject.location.origin && typeof value.origin === 'string' && Array.isArray(value.chainRoutedProxyPaths) && value.chainRoutedProxyPaths.every((path) => typeof path === 'string' && path.startsWith('/')) && isChainId(value.chainId) && Array.isArray(value.methods) && value.methods.every((method) => typeof method === 'string') ? { origin: value.origin, chainId: normalizeChainId(value.chainId), methods: value.methods, chainRoutedProxyPaths: value.chainRoutedProxyPaths, address } : undefined
			if (next?.chainId === context?.chainId && JSON.stringify([next?.methods, next?.chainRoutedProxyPaths, next?.address]) === JSON.stringify([context?.methods, context?.chainRoutedProxyPaths, context?.address])) {
				// A provisional inactive context must not remove the early passthrough hook before SDK clients capture it.
				return context !== undefined
			}
			const wasActive = context !== undefined
			context = next
			endpoints.clear()
			// Reuse retained hooks without replacing page instrumentation layered above them. Reinstall only when our original transport is still exposed.
			if (next !== undefined && !wasActive) installFetchHook()
			else if (next === undefined && wasActive) restoreFetchHook()
			return context !== undefined
		},
		dispose() { disposed = true; context = undefined; resolveInitialContext(); endpoints.clear(); restoreFetchHook() },
	}
}
