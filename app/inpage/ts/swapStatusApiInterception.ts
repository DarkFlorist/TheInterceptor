import { nextSiteHttpApiRequestId } from './siteHttpApiRequestId.js'
import type { ApplyPreparedSiteHttpApiInterception, SiteHttpApiContext } from './siteHttpApiInterception.js'
import { readApiJson, simulatedApiResponse } from './simulatedApiResponse.js'

const isStatusEnvelope = (value: unknown): value is { readonly swaps: readonly unknown[] } => typeof value === 'object' && value !== null && 'swaps' in value && Array.isArray(value.swaps)
const isPendingClassicSwap = (value: unknown): value is { readonly swapType: 'CLASSIC', readonly status: string, readonly txHash: string } => typeof value === 'object' && value !== null && 'swapType' in value && value.swapType === 'CLASSIC' && 'status' in value && typeof value.status === 'string' && ['NOT_FOUND', 'PENDING'].includes(value.status) && 'txHash' in value && typeof value.txHash === 'string' && /^0x[0-9a-f]{64}$/i.test(value.txHash)
const isReceipt = (value: unknown): value is { readonly from: string, readonly transactionHash: string, readonly status: '0x0' | '0x1' } => typeof value === 'object' && value !== null && 'from' in value && typeof value.from === 'string' && 'transactionHash' in value && typeof value.transactionHash === 'string' && 'status' in value && (value.status === '0x0' || value.status === '0x1')

// Trading API status polling is not JSON-RPC. Classic transaction statuses can be derived from receipts; bridge and user-operation settlement cannot.
export async function prepareSwapStatusApiInterception(request: Request, context: SiteHttpApiContext): Promise<ApplyPreparedSiteHttpApiInterception | undefined> {
	const url = new URL(request.url)
	if (context.address === undefined) return undefined
	const chains = url.searchParams.getAll('chainId')
	const chain = chains[0] ?? '1'
	if (chains.length > 1 || !/^[1-9][0-9]{0,77}$/.test(chain) || BigInt(chain) !== BigInt(context.chainId)) return undefined
	return async (http, requestRpc) => {
		const response = await http.sendOriginal()
		if (!response.ok) return response
		const data = await readApiJson(response)
		if (!isStatusEnvelope(data)) return response
		let changed = false
		const swaps = await Promise.all(data.swaps.map(async (swap: unknown) => {
			if (!isPendingClassicSwap(swap)) return swap
			const receipt = await requestRpc(context.chainId, { jsonrpc: '2.0', id: nextSiteHttpApiRequestId(), method: 'eth_getTransactionReceipt', params: [swap.txHash] })
			if (!isReceipt(receipt) || receipt.from.toLowerCase() !== context.address?.toLowerCase() || receipt.transactionHash.toLowerCase() !== swap.txHash.toLowerCase()) return swap
			changed = true
			return { ...swap, status: receipt.status === '0x1' ? 'SUCCESS' : 'FAILED' }
		}))
		return changed ? simulatedApiResponse(response, request.url, { ...data, swaps }) : response
	}
}
