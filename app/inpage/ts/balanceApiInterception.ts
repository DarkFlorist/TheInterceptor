import { balanceOfData, allowanceData } from './erc20CallData.js'
import { createSiteSimulationTokenRequest } from '../../shared/ts/siteSimulationTokenProtocol.js'
import { nextSiteHttpApiRequestId } from './siteHttpApiRequestId.js'
import { SIMULATION_NATIVE_TOKEN_ADDRESS, type SiteHttpApiRouteMatch } from '../../shared/ts/siteBehaviorPolicy.js'
import type { ApplyPreparedSiteHttpApiInterception, SiteHttpApiContext } from './siteHttpApiInterception.js'
import { isJsonRecord, readApiJson, simulatedApiResponse } from './simulatedApiResponse.js'

type Balance = { readonly balance: string, readonly allowance: string }
const isBalance = (value: unknown): value is Balance => typeof value === 'object' && value !== null && 'balance' in value && typeof value.balance === 'string' && /^[0-9]+$/.test(value.balance) && 'allowance' in value && typeof value.allowance === 'string' && /^[0-9]+$/.test(value.allowance)
const isAddress = (value: string) => /^0x[0-9a-f]{40}$/i.test(value)
const isAddressList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((address: unknown) => typeof address === 'string' && isAddress(address))
const decimalQuantity = (value: unknown) => {
	if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value) || value.length > 66) throw new Error('Invalid simulated balance or allowance.')
	return BigInt(value).toString()
}

// This vendor API is not JSON-RPC: its path declares the chain, spender and account, and its response uses decimal quantities. Keep its wire adapter separate from generic RPC detection. Only the selected simulation account is overlaid.
export async function prepareBalanceApiInterception(request: Request, context: SiteHttpApiContext, matchedRoute: SiteHttpApiRouteMatch): Promise<ApplyPreparedSiteHttpApiInterception | undefined> {
	if (context.address === undefined) return undefined
	const parameters = matchedRoute.parameters
	if (parameters.kind !== 'balance') return undefined
	const { chainId, spender, account } = parameters
	if (chainId !== BigInt(context.chainId) || account.toLowerCase() !== context.address.toLowerCase()) return undefined
	return async (http, requestRpc) => {
		const response = await http.sendOriginal()
		if (!response.ok) return response
		const data = await readApiJson(response)
		if (!isJsonRecord(data)) return response
		const balances: Record<string, Balance> = {}
		for (const [token, value] of Object.entries(data)) {
			if (!isAddress(token) || !isBalance(value)) return response
			balances[token] = value
		}
		const simulatedTokens = await requestRpc(context.chainId, createSiteSimulationTokenRequest('addresses', nextSiteHttpApiRequestId()))
		if (!isAddressList(simulatedTokens)) throw new Error('Invalid simulated token list.')
		// Preserve vendor key spelling; normalization identifies tokens only for matching and RPC calls.
		const knownTokens = new Set(Object.keys(balances).map((token) => token.toLowerCase()))
		for (const token of simulatedTokens) {
			const normalized = token.toLowerCase()
			if (knownTokens.has(normalized)) continue
			balances[normalized] = { balance: '0', allowance: '0' }
			knownTokens.add(normalized)
		}
		if (!knownTokens.has(SIMULATION_NATIVE_TOKEN_ADDRESS)) balances[SIMULATION_NATIVE_TOKEN_ADDRESS] = { balance: '0', allowance: (2n ** 256n - 1n).toString() }
		const rpc = async (method: string, params: readonly unknown[]) => decimalQuantity(await requestRpc(context.chainId, { jsonrpc: '2.0', id: nextSiteHttpApiRequestId(), method, params }))
		const result = Object.fromEntries(await Promise.all(Object.entries(balances).map(async ([token, value]) => [token, token.toLowerCase() === SIMULATION_NATIVE_TOKEN_ADDRESS
			? { ...value, balance: await rpc('eth_getBalance', [account, 'latest']) }
			: { ...value, balance: await rpc('eth_call', [{ to: token.toLowerCase(), data: balanceOfData(account) }, 'latest']), allowance: await rpc('eth_call', [{ to: token.toLowerCase(), data: allowanceData(account, spender) }, 'latest']) }
		])))
		return simulatedApiResponse(response, request.url, result)
	}
}
