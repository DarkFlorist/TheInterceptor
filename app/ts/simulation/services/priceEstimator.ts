import { Interface } from 'ethers'
import { MULTICALL3, Multicall3ABI } from '../../utils/constants.js'
import { EthereumClientService } from './EthereumClientService.js'
import { TokenPriceEstimate } from '../../types/visualizer-types.js'
import { calculatePricesFromUniswapLikeReturnData, calculateUniswapLikePools, constructUniswapLikeSpotCalls } from '../../utils/uniswap.js'
import { addressString, stringToUint8Array } from '../../utils/bigint.js'
import { Erc20TokenEntry } from '../../types/addressBookTypes.js'
import { getWithDefault } from '../../utils/typescript.js'

interface TokenDecimals {
	address: bigint,
	decimals: bigint,
}

interface CachedTokenPriceEstimate {
	estimate: TokenPriceEstimate | undefined,
	estimateCalculated: Date
}
const IMulticall3 = new Interface(Multicall3ABI)

export class TokenPriceService {
	private cachedPrices = new Map<string, Map<string, CachedTokenPriceEstimate> > // quoteTokenAddress -> tokenAddress -> TokenPriceEstimate
	public cacheAge: number
	private ethereumClientService: EthereumClientService
	constructor(ethereumClientService: EthereumClientService, cacheAge: number) {
		this.cacheAge = cacheAge
		this.ethereumClientService = ethereumClientService
	}

	public cleanUpCacheIfNeeded() {
		const currentTime = new Date()
		this.cachedPrices.forEach((quoteTokenAddressCache, quoteTokenAddressString)  => {
			quoteTokenAddressCache.forEach((estimate, tokenAddressString) => {
				if (currentTime.getTime() - estimate.estimateCalculated.getTime() > this.cacheAge) {
					quoteTokenAddressCache.delete(tokenAddressString)
				}
			})
			if (quoteTokenAddressCache.size === 0) this.cachedPrices.delete(quoteTokenAddressString)
		})
	}

	private async getTokenPrice(requestAbortController: AbortController | undefined, token: TokenDecimals, quoteToken: Erc20TokenEntry) {
		const poolAddresses = calculateUniswapLikePools(token.address, quoteToken.address)
		if (!poolAddresses) return undefined

		const uniswapSpotCalls = constructUniswapLikeSpotCalls(token.address, quoteToken.address, poolAddresses)

		const callData = stringToUint8Array(IMulticall3.encodeFunctionData('aggregate3', [uniswapSpotCalls]))
		const callTransaction = { type: '1559', to: MULTICALL3, value: 0n, input: callData, }
		const multicallReturnData: { success: boolean, returnData: string }[] = IMulticall3.decodeFunctionResult('aggregate3', await this.ethereumClientService.call(callTransaction, 'latest', requestAbortController))[0]
		const prices = calculatePricesFromUniswapLikeReturnData(multicallReturnData, poolAddresses)
		if (prices.length === 0) return undefined
		return {
			token,
			quoteToken,
			// Use pool with most TVL
			price: prices.reduce((highestLiq, p) => p.liquidity > highestLiq.liquidity ? p : highestLiq).price
		}
	}

	public async estimateEthereumPricesForTokens (requestAbortController: AbortController | undefined, quoteToken: Erc20TokenEntry, tokens: TokenDecimals[]) : Promise<TokenPriceEstimate[]> {
		if (tokens.length === 0) return []
		this.cleanUpCacheIfNeeded()
		const quoteTokenAddressString = addressString(quoteToken.address)
		const tokenPricePromises: Promise<TokenPriceEstimate | undefined>[] = tokens.map(async (token) => {
			const tokenAddressString = addressString(token.address)
			if (token.address === quoteToken.address) return { token, quoteToken, price: 10n ** quoteToken.decimals }
			const cachedEstimate = this.cachedPrices.get(quoteTokenAddressString)?.get(tokenAddressString)
			if (cachedEstimate !== undefined && (cachedEstimate.estimate === undefined || cachedEstimate.estimate.token.decimals === token.decimals)) {
				return cachedEstimate.estimate
			}
			const estimate = await this.getTokenPrice(requestAbortController, token, quoteToken)
			const quoteTokenAddressCache = getWithDefault(this.cachedPrices, quoteTokenAddressString, new Map<string, CachedTokenPriceEstimate>() )
			quoteTokenAddressCache.set(tokenAddressString, { estimate, estimateCalculated: new Date() })
			this.cachedPrices.set(quoteTokenAddressString, quoteTokenAddressCache)
			return estimate
		})
		return (await Promise.all(tokenPricePromises)).filter((tokenPrice): tokenPrice is TokenPriceEstimate => tokenPrice !== undefined)
	}
}

export function getTokenAmountsWorth(tokenAmount: bigint, tokenPriceEstimate: TokenPriceEstimate) {
	return (tokenPriceEstimate.price * tokenAmount) / (10n ** (tokenPriceEstimate.quoteToken.decimals))
}
