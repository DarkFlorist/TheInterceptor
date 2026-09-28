import type { InterceptedRequest } from '../utils/requests.js'

const SIGNER_CALLBACK_METHODS = new Set(['connected_to_signer', 'eth_accounts_reply', 'signer_chainChanged', 'signer_reply', 'wallet_switchEthereumChain_reply'])

// One dispatcher is shared by all connections. An origin cannot gain capacity by opening frames or reconnecting, and cannot occupy the whole global budget.
export function createWebsiteRequestDispatcher({ maxPendingRequests = 40, maxPendingRequestsPerOrigin = 20 } = {}) {
	let pendingRequests = 0
	const pendingRequestsByOrigin = new Map<string, number>()
	return async <T>(websiteOrigin: string, request: InterceptedRequest, handle: () => Promise<T>, refuse: () => T | Promise<T>): Promise<T> => {
		// Completion callbacks bypass both limits so saturated requests can still release their capacity.
		if (request.interceptorInternalRequest === true && SIGNER_CALLBACK_METHODS.has(request.method)) return await handle()
		const originPendingRequests = pendingRequestsByOrigin.get(websiteOrigin) ?? 0
		if (pendingRequests >= maxPendingRequests || originPendingRequests >= maxPendingRequestsPerOrigin) return await refuse()
		pendingRequests += 1
		pendingRequestsByOrigin.set(websiteOrigin, originPendingRequests + 1)
		try {
			return await handle()
		} finally {
			pendingRequests -= 1
			const remaining = (pendingRequestsByOrigin.get(websiteOrigin) ?? 1) - 1
			if (remaining === 0) pendingRequestsByOrigin.delete(websiteOrigin)
			else pendingRequestsByOrigin.set(websiteOrigin, remaining)
		}
	}
}
