import { createSiteSimulationTokenRequest } from '../../shared/ts/siteSimulationTokenProtocol.js'
import { aggregatePortfolioGroup, applyPortfolioValueDelta, portfolioQuantityAmount, portfolioQuantityValue, portfolioValueDelta, type PortfolioValueContribution } from './portfolioAggregation.js'
import { nextSiteHttpApiRequestId } from './siteHttpApiRequestId.js'
import { SIMULATION_NATIVE_TOKEN_ADDRESS, type SiteHttpApiRouteMatch } from '../../shared/ts/siteBehaviorPolicy.js'
import type { ApplyPreparedSiteHttpApiInterception, SiteHttpApiContext } from './siteHttpApiInterception.js'
import { isJsonRecord, readApiJson, simulatedApiResponse } from './simulatedApiResponse.js'

type JsonObject = Record<string, unknown>
type Token = { readonly chainId: number, readonly address: string, readonly decimals: number }
type BalanceRow = { readonly source: JsonObject, readonly token: Token, readonly raw: string }
type TokenMetadata = { readonly address: string, readonly name: string, readonly symbol: string, readonly decimals: string }
const field = (value: unknown, key: string): unknown => isJsonRecord(value) ? Reflect.get(value, key) : undefined
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const address = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value)
const nativeAddress = '0x0000000000000000000000000000000000000000'
const apiAddress = (value: string) => value.toLowerCase() === SIMULATION_NATIVE_TOKEN_ADDRESS ? nativeAddress : value.toLowerCase()
const isMetadata = (value: unknown): value is TokenMetadata => typeof value === 'object' && value !== null && 'address' in value && address(value.address) && 'name' in value && typeof value.name === 'string' && 'symbol' in value && typeof value.symbol === 'string' && 'decimals' in value && typeof value.decimals === 'string' && /^0x[0-9a-f]{1,2}$/i.test(value.decimals)
const isMetadataList = (value: unknown): value is readonly TokenMetadata[] => Array.isArray(value) && value.every(isMetadata)
const jsonArray = (value: unknown): readonly unknown[] | undefined => Array.isArray(value) ? value : undefined
const numeric = (value: unknown) => finite(value) ? value : 0
const withoutPositionChanges = (value: JsonObject) => {
	const result = { ...value }
	for (const key of ['totalValueAbsoluteChange1d', 'totalValuePercentChange1d', 'absoluteChange1d', 'percentChange1d']) Reflect.deleteProperty(result, key)
	return result
}
const hidden = (value: unknown) => field(value, 'isHidden') === true
const contribution = (row: BalanceRow): PortfolioValueContribution => ({ chainId: row.token.chainId, isHidden: hidden(row.source), valueUsd: numeric(field(row.source, 'valueUsd')) })

function parseBalance(value: unknown, tokenValue: unknown): BalanceRow | undefined {
	if (!isJsonRecord(value)) return undefined
	const chainId = field(tokenValue, 'chainId')
	const tokenAddress = field(tokenValue, 'address')
	const decimals = field(tokenValue, 'decimals')
	const raw = field(field(value, 'amount'), 'raw')
	if (!Number.isSafeInteger(chainId) || typeof chainId !== 'number' || typeof tokenAddress !== 'string' || !Number.isInteger(decimals) || typeof decimals !== 'number' || decimals < 0 || decimals > 255 || typeof raw !== 'string' || !/^[0-9]{1,78}$/.test(raw)) return undefined
	return { source: value, token: { chainId, address: tokenAddress, decimals }, raw }
}

const parseBalances = (rows: readonly unknown[] | undefined) => rows?.map((row) => parseBalance(row, field(row, 'token')))

const amount = (raw: bigint, decimals: number) => ({ raw: raw.toString(), amount: portfolioQuantityAmount({ raw, decimals }) })

// Indexed portfolio APIs carry amounts in several views. Update only the selected account and chain, preserve other chains and hidden holdings, and derive aggregates from the same balance changes.
export async function preparePortfolioApiInterception(request: Request, context: SiteHttpApiContext, matchedRoute: SiteHttpApiRouteMatch): Promise<ApplyPreparedSiteHttpApiInterception | undefined> {
	if (matchedRoute.route.adapter !== 'portfolio') return undefined
	const summary = matchedRoute.route.responseKind === 'walletBalances'
	const selectedAddress = context.address
	if (selectedAddress === undefined) return undefined
	const body = await readApiJson(new Response(await request.clone().text()))
	const accounts = jsonArray(field(field(body, 'walletAccount'), 'platformAddresses'))
	const chains = jsonArray(field(body, 'chainIds'))
	const chainId = Number(BigInt(context.chainId))
	if (!Number.isSafeInteger(chainId)) return undefined
	if (!isJsonRecord(body) || accounts?.length !== 1 || typeof field(accounts[0], 'address') !== 'string' || String(field(accounts[0], 'address')).toLowerCase() !== selectedAddress.toLowerCase() || !chains?.includes(chainId)) return undefined
	const modifier = field(field(body, 'modifier'), 'address')
	if (modifier !== undefined && (typeof modifier !== 'string' || modifier.toLowerCase() !== selectedAddress.toLowerCase())) return undefined
	return async (http, requestRpc) => {
		const response = await http.sendOriginal()
		if (!response.ok) return response
		const data = await readApiJson(response)
		if (!isJsonRecord(data)) return response
		const portfolioResponse = summary ? await http.sendDerived('portfolio', { walletAccount: field(body, 'walletAccount'), chainIds: chains, modifier: field(body, 'modifier'), multichain: false, useSubstreamData: true }) : response
		if (!portfolioResponse.ok) throw new Error('Could not read indexed token balances for the simulated portfolio summary.')
		const portfolioData = summary ? await readApiJson(portfolioResponse) : data
		const portfolio = field(portfolioData, 'portfolio')
		const groups = jsonArray(field(portfolio, 'multichainBalances'))
		const flat = jsonArray(field(portfolio, 'balances'))
		if (!isJsonRecord(portfolio) || (flat === undefined && groups === undefined)) return response
		if (groups?.some((group) => !isJsonRecord(group) || jsonArray(field(group, 'chainBalances')) === undefined)) return response
		const groupedRows = groups?.flatMap((group) => (jsonArray(field(group, 'chainBalances')) ?? []).map((row) => isJsonRecord(group) && isJsonRecord(row) ? { ...row, token: { ...group, ...row }, priceUsd: field(group, 'priceUsd'), pricePercentChange1d: field(group, 'pricePercentChange1d'), isHidden: hidden(group) || hidden(row) } : undefined))
		const flatBalances = parseBalances(flat)
		const groupedBalances = parseBalances(groupedRows)
		if ([...flatBalances ?? [], ...groupedBalances ?? []].some((row) => row === undefined || row.token.chainId === chainId && !address(row.token.address))) return response
		const parsed = flatBalances !== undefined && (flatBalances.length > 0 || groups === undefined) ? flatBalances : groupedBalances ?? []
		const metadata = await requestRpc(context.chainId, createSiteSimulationTokenRequest('metadata', nextSiteHttpApiRequestId()))
		if (!isMetadataList(metadata)) throw new Error('Invalid simulated portfolio token metadata.')
		const newTokens = metadata.filter((token) => !parsed.some((row) => row?.token.chainId === chainId && apiAddress(row.token.address) === apiAddress(token.address)))
		const prices = new Map<string, number>()
		if (newTokens.length > 0) {
			const priceResponse = await http.sendDerived('tokenPrices', { tokens: newTokens.map((token) => ({ chainId, address: apiAddress(token.address) })) })
			// A missing market quote does not erase a simulated holding or invent its dollar value.
			if (priceResponse.ok) for (const price of jsonArray(field(await readApiJson(priceResponse), 'tokenPrices')) ?? []) {
				const tokenAddress = field(price, 'address')
				const quote = field(price, 'priceUsd')
				if (field(price, 'chainId') === chainId && address(tokenAddress) && finite(quote) && quote >= 0) prices.set(apiAddress(tokenAddress), quote)
			}
		}
		const updatedRows = await Promise.all([...parsed, ...newTokens.map((token) => parseBalance({ amount: { raw: '0' } }, { chainId, address: apiAddress(token.address), decimals: Number(BigInt(token.decimals)), name: token.name, symbol: token.symbol, type: apiAddress(token.address) === nativeAddress ? 'TOKEN_TYPE_NATIVE' : 'TOKEN_TYPE_ERC20' }))].map(async (row) => {
			if (row === undefined) throw new Error('Invalid simulated portfolio balance row.')
			if (row.token.chainId !== chainId) return row
			const tokenAddress = apiAddress(row.token.address)
			const reply = await requestRpc(context.chainId, { jsonrpc: '2.0', id: nextSiteHttpApiRequestId(), method: tokenAddress === nativeAddress ? 'eth_getBalance' : 'eth_call', params: tokenAddress === nativeAddress ? [selectedAddress, 'latest'] : [{ to: tokenAddress, data: `0x70a08231${ selectedAddress.slice(2).padStart(64, '0') }` }, 'latest'] })
			if (typeof reply !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(reply)) throw new Error('Invalid simulated portfolio balance.')
			const raw = BigInt(reply)
			const isNew = newTokens.find((token) => apiAddress(token.address) === tokenAddress)
			if (isNew !== undefined && raw === 0n) return undefined
			const quantity = amount(raw, row.token.decimals)
			const price = finite(field(row.source, 'priceUsd')) ? field(row.source, 'priceUsd') : prices.get(tokenAddress)
			const nextValue = portfolioQuantityValue({ raw, decimals: row.token.decimals }, finite(price) ? price : undefined)
			const sourceToken = field(row.source, 'token')
			const updated = { ...withoutPositionChanges(row.source), token: { ...(isJsonRecord(sourceToken) ? sourceToken : isNew), ...row.token, ...(isNew === undefined ? {} : { name: isNew.name, symbol: isNew.symbol, type: tokenAddress === nativeAddress ? 'TOKEN_TYPE_NATIVE' : 'TOKEN_TYPE_ERC20' }) }, amount: quantity, ...(finite(price) ? { priceUsd: price, valueUsd: nextValue } : {}) }
			if (!finite(price)) Reflect.deleteProperty(updated, 'valueUsd')
			return { ...row, source: updated, raw: raw.toString() }
		}))
		const updatedBalances = updatedRows.filter((row) => row !== undefined)
		const balances = updatedBalances.map((row) => row.source)
		const deltaUsd = portfolioValueDelta(chainId, parsed.filter((row) => row !== undefined).map(contribution), updatedBalances.map(contribution))
		const total = applyPortfolioValueDelta(numeric(field(portfolio, 'totalValueUsd')), deltaUsd)
		if (summary) {
			const balance = field(data, 'balance')
			const tokens = field(balance, 'tokens')
			const all = field(balance, 'total')
			if (!isJsonRecord(balance) || !isJsonRecord(tokens) || !isJsonRecord(all)) return response
			return simulatedApiResponse(response, request.url, { ...data, balance: { ...balance, tokens: { ...withoutPositionChanges(tokens), valueUsd: applyPortfolioValueDelta(numeric(field(tokens, 'valueUsd')), deltaUsd) }, total: { ...withoutPositionChanges(all), valueUsd: applyPortfolioValueDelta(numeric(field(all, 'valueUsd')), deltaUsd) } } })
		}
		if (groups === undefined) return simulatedApiResponse(response, request.url, { ...data, portfolio: { ...withoutPositionChanges(portfolio), balances, totalValueUsd: total } })
		const remaining = new Set(balances.filter((row) => field(field(row, 'token'), 'chainId') === chainId))
		const updatedGroups = groups.map((group) => {
			if (!isJsonRecord(group)) return group
			const originalRows = jsonArray(field(group, 'chainBalances')) ?? []
			const chainBalances = originalRows.map((row) => {
				const updated = [...remaining].find((candidate) => address(field(field(candidate, 'token'), 'address')) && address(field(row, 'address')) && apiAddress(String(field(field(candidate, 'token'), 'address'))) === apiAddress(String(field(row, 'address'))) && field(field(candidate, 'token'), 'chainId') === field(row, 'chainId'))
				if (updated === undefined || !isJsonRecord(row)) return row
				remaining.delete(updated)
				return { ...withoutPositionChanges(row), amount: field(updated, 'amount'), valueUsd: field(updated, 'valueUsd') }
			})
			// A token already grouped on another chain keeps one group when simulation adds this chain.
			for (const updated of remaining) {
				const updatedToken = field(updated, 'token')
				const updatedAddress = field(updatedToken, 'address')
				if (!address(updatedAddress) || !originalRows.some((row) => {
					const existingAddress = field(row, 'address')
					return address(existingAddress) && apiAddress(existingAddress) === apiAddress(updatedAddress)
				})) continue
				chainBalances.push({ chainId, address: updatedAddress, decimals: field(updatedToken, 'decimals'), amount: field(updated, 'amount'), valueUsd: field(updated, 'valueUsd') })
				remaining.delete(updated)
			}
			const totals = aggregatePortfolioGroup(chainBalances.map((row) => ({
				raw: BigInt(String(field(field(row, 'amount'), 'raw'))),
				decimals: numeric(field(row, 'decimals')),
				isHidden: hidden(row) || hidden(group),
				valueUsd: numeric(field(row, 'valueUsd')),
			})))
			return { ...withoutPositionChanges(group), chainBalances, totalAmount: amount(totals.quantity.raw, totals.quantity.decimals), totalValueUsd: totals.valueUsd }
		})
		for (const row of remaining) {
			const token = field(row, 'token')
			if (!isJsonRecord(token)) continue
			const quantity = field(field(row, 'amount'), 'amount')
			updatedGroups.push({ ...token, totalAmount: { raw: field(field(row, 'amount'), 'raw'), amount: quantity }, priceUsd: field(row, 'priceUsd'), totalValueUsd: field(row, 'valueUsd'), chainBalances: [{ chainId, address: field(token, 'address'), decimals: field(token, 'decimals'), amount: field(row, 'amount'), valueUsd: field(row, 'valueUsd') }] })
		}
		return simulatedApiResponse(response, request.url, { ...data, portfolio: { ...withoutPositionChanges(portfolio), multichainBalances: updatedGroups, ...flat === undefined ? {} : { balances }, totalValueUsd: total } })
	}
}
