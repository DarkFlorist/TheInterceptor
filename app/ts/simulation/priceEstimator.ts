import { Interface } from 'ethers'
import { MULTICALL3 } from '../utils/constants.js'
import { EthereumClientService } from './services/EthereumClientService.js'
import { TokenPriceEstimate } from '../utils/visualizer-types.js'
import { calculatePricesFromUniswapLikeReturnData, calculateUniswapLikePools, constructUniswapLikeSpotCalls } from '../utils/uniswap.js'
import { stringToUint8Array } from '../utils/bigint.js'
import { networkPriceSources } from '../background/settings.js'

interface TokenDecimals {
	address: bigint,
	decimals: bigint,
}

const Multicall3ABI = [
	'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)'
]

export class PriceEstimator {
	private readonly ethereum
	public constructor(ethereum: EthereumClientService) {
		this.ethereum = ethereum
	}

	public async estimateEthereumPricesForTokens(tokens: TokenDecimals[], quote?: TokenDecimals) : Promise<TokenPriceEstimate[]> {
		if (tokens.length == 0) return []

		const chainId = this.ethereum.getChainId()
		const chainIdString = chainId.toString()
		if (!(chainIdString in networkPriceSources)) return []
		const network = networkPriceSources[chainIdString]

		const quoteToken = quote ?? network.quoteToken
		const tokenPrices: TokenPriceEstimate[] = []

		const IMulticall3 = new Interface(Multicall3ABI)

		for (const token of tokens) {
			if (token.address === quoteToken.address) {
				tokenPrices.push({
					token,
					quoteToken,
					price: 10n ** quoteToken.decimals
				})
				continue
			}

			const poolAddresses = calculateUniswapLikePools(token.address, quoteToken.address, chainId)
			if (!poolAddresses) continue

			const uniswapSpotCalls = constructUniswapLikeSpotCalls(token.address, quoteToken.address, poolAddresses)

			const callData = stringToUint8Array(IMulticall3.encodeFunctionData('aggregate3', [uniswapSpotCalls]))
			const callTransaction = {
				type: '1559',
				to: MULTICALL3,
				value: 0n,
				input: callData,
			}

			const multicallReturnData: { success: boolean, returnData: string }[] = IMulticall3.decodeFunctionResult('aggregate3', await this.ethereum.call(callTransaction, 'latest'))[0]
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
}

export function getTokenAmountsWorth(tokenAmount: bigint, tokenPriceEstimate: TokenPriceEstimate) {
	return (tokenPriceEstimate.price * tokenAmount) / (10n ** (tokenPriceEstimate.quoteToken.decimals))
}
