// Independent wire fixture, not an SDK implementation. Keep request/version literals here separate from production protocol helpers so the tests can catch envelope drift without installing wallet packages.
export const GNOSIS_SAFE_APPS_TEST_SDK_VERSION = '9.1.0'
let nextRequestId = 0

export function createGnosisSafeAppsTestClient({ allowedDomains }: { readonly allowedDomains?: readonly RegExp[] } = {}) {
	const host = window
	return {
		getSafeInfo(signal?: AbortSignal): Promise<unknown> {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) { reject(signal.reason); return }
				const id = `safe-test-${ ++nextRequestId }`
				const cleanup = () => { host.removeEventListener('message', receive); signal?.removeEventListener('abort', abort) }
				const abort = () => { cleanup(); reject(signal?.reason) }
				const receive = (event: MessageEvent<unknown>) => {
					const payload = event.data
					if (event.source !== host.parent || allowedDomains?.some((domain) => domain.test(event.origin)) === false) return
					if (typeof payload !== 'object' || payload === null || !('id' in payload) || payload.id !== id || !('version' in payload) || typeof payload.version !== 'string' || !/^[1-9][0-9]*\./.test(payload.version) || !('success' in payload) || typeof payload.success !== 'boolean') return
					cleanup()
					if (!payload.success) { reject(new Error('error' in payload ? String(payload.error) : 'Gnosis Safe request failed')); return }
					resolve('data' in payload ? payload.data : undefined)
				}
				host.addEventListener('message', receive)
				signal?.addEventListener('abort', abort, { once: true })
				try { host.parent.postMessage({ id, method: 'getSafeInfo', env: { sdkVersion: GNOSIS_SAFE_APPS_TEST_SDK_VERSION } }, '*') }
				catch (error: unknown) { cleanup(); reject(error) }
			})
		},
	}
}

// Model the observed abort-or-reject deadline shape used by Lido's detector and connector; this deliberately does not import their timeout implementation.
export function withGnosisSafeAppsTestDeadline<T>(request: (signal: AbortSignal) => Promise<T>, timeout: number): Promise<T> {
	const host = window
	const controller = new AbortController()
	return new Promise((resolve, reject) => {
		const timer = host.setTimeout(() => { controller.abort(new Error('Gnosis Safe discovery timed out')); reject(controller.signal.reason) }, timeout)
		request(controller.signal).then(resolve, reject).finally(() => host.clearTimeout(timer))
	})
}

export async function discoverGnosisSafeTestAccount({ allowedDomains, timeout = 5_000 }: { readonly allowedDomains?: readonly RegExp[], readonly timeout?: number } = {}) {
	const client = createGnosisSafeAppsTestClient({ allowedDomains })
	const info = await withGnosisSafeAppsTestDeadline((signal) => client.getSafeInfo(signal), timeout)
	if (typeof info !== 'object' || info === null || !('safeAddress' in info) || typeof info.safeAddress !== 'string' || !('chainId' in info) || typeof info.chainId !== 'number') throw new Error('Invalid Gnosis Safe account discovery response')
	return { safeAddress: info.safeAddress, chainId: info.chainId }
}
