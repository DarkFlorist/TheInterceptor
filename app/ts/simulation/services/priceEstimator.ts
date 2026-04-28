import { Interface } from 'ethers'
import { MULTICALL3, Multicall3ABI } from '../../utils/constants.js'
import { EthereumClientService } from './EthereumClientService.js'
import { TokenPriceEstimate } from '../../types/visualizer-types.js'
import { calculatePricesFromUniswapLikeReturnData, calculateUniswapLikePools, constructUniswapLikeSpotCalls } from '../../utils/uniswap.js'
import { addressString, stringToUint8Array } from '../../utils/bigint.js'
import { Erc20TokenEntry } from '../../types/addressBookTypes.js'
import { getWithDefault } from '../../utils/typescript.js'
import { promiseAllMapAbortSafe, silenceChromeUnCaughtPromise } from '../../utils/requests.js'

interface TokenDecimals {
	address: bigint,
	decimals: bigint,
}

interface CachedTokenPriceEstimate {
	estimate: TokenPriceEstimate | undefined,
	estimateCalculated: Date
}
const IMulticall3 = new Interface(Multicall3ABI)

export interface TokenPriceService {
	readonly cacheAge: number
	cleanUpCacheIfNeeded(): void
	estimateEthereumPricesForTokens(requestAbortController: AbortController | undefined, quoteToken: Erc20TokenEntry, tokens: TokenDecimals[]): Promise<TokenPriceEstimate[]>
}

export function TokenPriceService(ethereumClientService: EthereumClientService, cacheAge: number): TokenPriceService {
	const cachedPrices = new Map<string, Map<string, CachedTokenPriceEstimate>>()

	const cleanUpCacheIfNeeded = () => {
		const currentTime = new Date()
		cachedPrices.forEach((quoteTokenAddressCache, quoteTokenAddressString) => {
			quoteTokenAddressCache.forEach((estimate, tokenAddressString) => {
				if (currentTime.getTime() - estimate.estimateCalculated.getTime() > cacheAge) {
					quoteTokenAddressCache.delete(tokenAddressString)
				}
			})
			if (quoteTokenAddressCache.size === 0) cachedPrices.delete(quoteTokenAddressString)
		})
	}

	const getTokenPrice = async (requestAbortController: AbortController | undefined, token: TokenDecimals, quoteToken: Erc20TokenEntry) => {
		const poolAddresses = calculateUniswapLikePools(token.address, quoteToken.address)
		if (!poolAddresses) return undefined

		const uniswapSpotCalls = constructUniswapLikeSpotCalls(token.address, quoteToken.address, poolAddresses)

		const callData = stringToUint8Array(IMulticall3.encodeFunctionData('aggregate3', [uniswapSpotCalls]))
		const callTransaction = { type: '1559', to: MULTICALL3, value: 0n, input: callData } as const
		const multicallReturnData: { success: boolean, returnData: string }[] = IMulticall3.decodeFunctionResult('aggregate3', await ethereumClientService.call(callTransaction, 'latest', requestAbortController))[0]
		const prices = calculatePricesFromUniswapLikeReturnData(multicallReturnData, poolAddresses)
		if (prices.length === 0) return undefined
		return {
			token,
			quoteToken,
			price: prices.reduce((highestLiq, p) => p.liquidity > highestLiq.liquidity ? p : highestLiq).price
		}
	}

	const estimateEthereumPricesForTokens = async (
		requestAbortController: AbortController | undefined,
		quoteToken: Erc20TokenEntry,
		tokens: TokenDecimals[],
	): Promise<TokenPriceEstimate[]> => {
		if (tokens.length === 0) return []
		cleanUpCacheIfNeeded()
		const quoteTokenAddressString = addressString(quoteToken.address)
		return (await promiseAllMapAbortSafe(tokens, async (token) => {
			const tokenAddressString = addressString(token.address)
			if (token.address === quoteToken.address) return { token, quoteToken, price: 10n ** quoteToken.decimals }
			const cachedEstimate = cachedPrices.get(quoteTokenAddressString)?.get(tokenAddressString)
			if (cachedEstimate !== undefined && (cachedEstimate.estimate === undefined || cachedEstimate.estimate.token.decimals === token.decimals)) {
				return cachedEstimate.estimate
			}
			const estimate = await silenceChromeUnCaughtPromise(getTokenPrice(requestAbortController, token, quoteToken))
			const quoteTokenAddressCache = getWithDefault(cachedPrices, quoteTokenAddressString, new Map<string, CachedTokenPriceEstimate>())
			quoteTokenAddressCache.set(tokenAddressString, { estimate, estimateCalculated: new Date() })
			cachedPrices.set(quoteTokenAddressString, quoteTokenAddressCache)
			return estimate
		})).filter((tokenPrice): tokenPrice is TokenPriceEstimate => tokenPrice !== undefined)
	}

	return {
		get cacheAge() { return cacheAge },
		cleanUpCacheIfNeeded,
		estimateEthereumPricesForTokens,
	}
}

export function getTokenAmountsWorth(tokenAmount: bigint, tokenPriceEstimate: TokenPriceEstimate) {
	return (tokenPriceEstimate.price * tokenAmount) / (10n ** (tokenPriceEstimate.quoteToken.decimals))
}
