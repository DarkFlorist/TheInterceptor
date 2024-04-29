import { Interface } from 'ethers'
import { MULTICALL3, Multicall3ABI } from '../utils/constants.js'
import { EthereumClientService } from './services/EthereumClientService.js'
import { TokenPriceEstimate } from '../types/visualizer-types.js'
import { calculatePricesFromUniswapLikeReturnData, calculateUniswapLikePools, constructUniswapLikeSpotCalls } from '../utils/uniswap.js'
import { stringToUint8Array } from '../utils/bigint.js'
import { identifyAddress } from '../background/metadataUtils.js'

interface TokenDecimals {
	address: bigint,
	decimals: bigint,
}

export const estimateEthereumPricesForTokens = async (ethereum: EthereumClientService, requestAbortController: AbortController | undefined, quoteTokenAddress: bigint | undefined, tokens: TokenDecimals[]) : Promise<TokenPriceEstimate[]> => {
	if (quoteTokenAddress === undefined) return []
	const quoteToken = await identifyAddress(ethereum, requestAbortController, quoteTokenAddress)
	if (quoteToken.type !== 'ERC20') return []
	if (tokens.length === 0) return []
	const tokenPrices: TokenPriceEstimate[] = []
	const IMulticall3 = new Interface(Multicall3ABI)
	for (const token of tokens) {
		if (token.address === quoteToken.address) {
			tokenPrices.push({ token, quoteToken, price: 10n ** quoteToken.decimals })
			continue
		}

		const poolAddresses = calculateUniswapLikePools(token.address, quoteToken.address)
		if (!poolAddresses) continue

		const uniswapSpotCalls = constructUniswapLikeSpotCalls(token.address, quoteToken.address, poolAddresses)

		const callData = stringToUint8Array(IMulticall3.encodeFunctionData('aggregate3', [uniswapSpotCalls]))
		const callTransaction = { type: '1559', to: MULTICALL3, value: 0n, input: callData, }
		const multicallReturnData: { success: boolean, returnData: string }[] = IMulticall3.decodeFunctionResult('aggregate3', await ethereum.call(callTransaction, 'latest', requestAbortController))[0]
		const prices = calculatePricesFromUniswapLikeReturnData(multicallReturnData, poolAddresses)
		if (prices.length > 0) tokenPrices.push({
			token,
			quoteToken,
			// Use pool with most TVL
			price: prices.reduce((highestLiq, p) => p.liquidity > highestLiq.liquidity ? p : highestLiq).price
		})
	}
	return tokenPrices
}

export function getTokenAmountsWorth(tokenAmount: bigint, tokenPriceEstimate: TokenPriceEstimate) {
	return (tokenPriceEstimate.price * tokenAmount) / (10n ** (tokenPriceEstimate.quoteToken.decimals))
}
