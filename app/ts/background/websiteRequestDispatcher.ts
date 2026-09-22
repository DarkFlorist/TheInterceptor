import type { InterceptedRequest } from '../utils/requests.js'

const SIGNER_CALLBACK_METHODS = new Set(['connected_to_signer', 'eth_accounts_reply', 'signer_chainChanged', 'signer_reply', 'wallet_switchEthereumChain_reply'])

// Each connection owns its capacity. Signer replies must be able to settle requests that are already occupying all of it.
export function createWebsiteRequestDispatcher(maxPendingRequests = 40) {
	let pendingRequests = 0
	return async <T>(request: InterceptedRequest, handle: () => Promise<T>, refuse: () => T | Promise<T>): Promise<T> => {
		if (request.interceptorInternalRequest === true && SIGNER_CALLBACK_METHODS.has(request.method)) return await handle()
		if (pendingRequests >= maxPendingRequests) return await refuse()
		pendingRequests += 1
		try {
			return await handle()
		} finally {
			pendingRequests -= 1
		}
	}
}
