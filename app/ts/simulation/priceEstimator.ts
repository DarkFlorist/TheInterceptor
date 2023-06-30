import { CHAINS, MOCK_ADDRESS, MULTICALL3  } from '../utils/constants.js'
import { EthereumClientService } from './services/EthereumClientService.js'
import { TokenPriceEstimate } from '../utils/visualizer-types.js'
import { UniswapV2PairABI, UniswapV3PairABI, calculateUniswapPools } from '../utils/uniswap.js'
import { isSupportedChain } from '../utils/constants.js'
import { getUniswapSpotCalls } from '../utils/uniswap.js'
import { Interface } from 'ethers'
import { stringToUint8Array } from '../utils/bigint.js'

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
		const chainString = chainId.toString()
		if (!isSupportedChain(chainString)) return []
		// Support only mainnet for now
		// TODO: fix this
		if (chainId !== 1n) return []

		const quoteToken = quote ?? {
			address: BigInt(CHAINS[chainString].weth),
			decimals: 18n
		}

		const tokenPrices: TokenPriceEstimate[] = []

		const IUniswapV2Pool = new Interface(UniswapV2PairABI)
		const IUniswapV3Pool = new Interface(UniswapV3PairABI)
		const IMulticall3 = new Interface(Multicall3ABI)

		for (const token of tokens) {
			if (token.address === quoteToken.address) {
				tokenPrices.push({
					token,
					quoteToken,
					price: 10n ** 18n
				})
				continue
			}
			const poolAddresses = calculateUniswapPools(token.address, CHAINS[chainString].weth)
			const uniswapSpotCalls = getUniswapSpotCalls(poolAddresses)

			const callData = stringToUint8Array(IMulticall3.encodeFunctionData('aggregate3', [uniswapSpotCalls]))
			const callTransaction = {
				type: '1559',
				from: MOCK_ADDRESS,
				to: MULTICALL3,
				value: 0n,
				input: callData,
				maxFeePerGas: 0n,
				maxPriorityFeePerGas: 0n,
				gasLimit: 15_000_000n,
			}
			const returnData: { success: boolean, returnData: string }[] = IMulticall3.decodeFunctionResult('aggregate3', await this.ethereum.call(callTransaction, 'latest'))[0]



			const prices = returnData.filter(({ success }) => success === true).map(({ returnData }, index) => {
				if (index === 0) {
				const { reserve0, reserve1 } = IUniswapV2Pool.decodeFunctionResult('getReserves', returnData)

				return poolAddresses.token0IsQuote
					? (reserve1 * (10n ** BigInt(token.decimals))) / reserve0
					: (reserve0 * (10n ** BigInt(token.decimals))) / reserve1
				} else {
					const { sqrtPriceX96 } = IUniswapV3Pool.decodeFunctionResult('slot0', returnData)

					return poolAddresses.token0IsQuote
						? ((sqrtPriceX96 * (10n ** BigInt(token.decimals)) / (2n ** 96n)) ** 2n) / (10n ** BigInt(token.decimals))
						: (10n ** (18n)) / ((sqrtPriceX96 / (2n ** 96n)) ** 2n)
					}
			})

			const price = prices.reduce((sum, p) => sum + p, 0n) / BigInt(prices.length)

			if (price) tokenPrices.push({
				token,
				quoteToken,
				price
			})
		}
		return tokenPrices
	}
}

export function getTokenAmountsWorth(tokenAmount: bigint, tokenPriceEstimate: TokenPriceEstimate) {
	return (tokenPriceEstimate.price * tokenAmount) / (10n ** tokenPriceEstimate.token.decimals)
}
