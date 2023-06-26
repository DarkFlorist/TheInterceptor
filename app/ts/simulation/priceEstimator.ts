import { UNISWAP_V2_ROUTER_ADDRESS } from '../utils/constants.js'
import { EthereumClientService } from './services/EthereumClientService.js'
import { TokenPriceEstimate } from '../utils/visualizer-types.js'
import { addressString, stringToUint8Array } from '../utils/bigint.js'
import { ethers } from 'ethers'
import { getEthDonator, getPrimaryRPCForChain } from '../background/storageVariables.js'

interface TokenDecimals {
	token: bigint,
	decimals: bigint,
}

const ABI = [
	'function swapExactETHForTokens(uint256,address[],address,uint256) returns (uint[] memory amounts)',
	'function approve(address,uint256)',
	'function swapTokensForExactETH(uint256,uint256,address[],address,uint256) returns (uint[] memory amounts)',
]

export class PriceEstimator {
	private readonly ethereum
	public constructor(ethereum: EthereumClientService) {
		this.ethereum = ethereum
	}

	public async estimateEthereumPricesForTokens(tokens: TokenDecimals[]) : Promise<TokenPriceEstimate[]> {
		if (tokens.length == 0) return []

		const chainId = this.ethereum.getChainId()
		const donator = getEthDonator(chainId)
		const weth = (await getPrimaryRPCForChain(chainId))?.weth

		if (donator === undefined || weth === undefined) return []

		const amountOutMin = 0n
		const sender = donator
		const block = await this.ethereum.getBlock()
		const deadline = BigInt( block.timestamp.getTime() + 1000 * 1000)

		const transactionCount = await this.ethereum.getTransactionCount(sender)
		let inOutResults: TokenPriceEstimate[] = []
		const swapInterface = new ethers.Interface(ABI)
		for (const token of tokens) {
			if (token.token === weth) {
				inOutResults.push({
					token: addressString(weth),
					inOutAmount: [10n ** 18n, 10n ** 18n],
					decimals: 18n,
				})
				continue
			}
			const swapTransactions = [
				{
					type: '1559' as const,
					from: sender,
					chainId: chainId,
					nonce: transactionCount,
					maxFeePerGas: 0n,
					maxPriorityFeePerGas: 0n,
					gas: 15000000n,
					to: UNISWAP_V2_ROUTER_ADDRESS,
					value: 10n ** 18n,
					input: stringToUint8Array(swapInterface.encodeFunctionData(
						'swapExactETHForTokens',
						[amountOutMin, [addressString(weth), addressString(token.token)], addressString(sender), deadline]
					)),
					accessList: [],
				},
				{
					type: '1559' as const,
					from: sender,
					chainId: chainId,
					nonce: transactionCount + 1n,
					maxFeePerGas: 0n,
					maxPriorityFeePerGas: 0n,
					gas: 15000000n,
					to: token.token,
					value: 0n,
					input: stringToUint8Array(swapInterface.encodeFunctionData('approve', [addressString(UNISWAP_V2_ROUTER_ADDRESS), 2n ** 127n] )),
					accessList: [],
				},
				{
					type: '1559' as const,
					from: sender,
					chainId: chainId,
					nonce: transactionCount + 2n,
					maxFeePerGas: 0n,
					maxPriorityFeePerGas: 0n,
					gas: 15000000n,
					to: UNISWAP_V2_ROUTER_ADDRESS,
					value: 0n,
					input: stringToUint8Array(swapInterface.encodeFunctionData(
						'swapTokensForExactETH',
						[10n ** 18n / 2n, 2n ** 127n, [addressString(token.token), addressString(weth)], addressString(sender), deadline]
					)),
					accessList: [],
				},
			]
			const results = await this.ethereum.multicall(swapTransactions, block.number + 1n)
			if (results.length !== 3) throw ('invalid multicall result')
			if (results[2].statusCode === 'success') {
				const parsed = swapInterface.decodeFunctionResult('swapTokensForExactETH', results[2].returnValue)
				const inOut = parsed.toObject() as { amounts: bigint[] } // TODO, change to funtype
				if (inOut.amounts.length != 2) return []
				if(inOut.amounts[0] <= 0n || inOut.amounts[1] <= 0n || token.decimals <= 0n) return []
				inOutResults.push( {
					token: addressString(token.token ),
					inOutAmount: [inOut.amounts[1], inOut.amounts[0]],
					decimals: token.decimals
				})
			}
		}
		return inOutResults
	}
}

export function getTokenPrice(ethInOutAmounts: readonly bigint[], tokenDecimals: bigint, precision: number) {
	return Number(ethInOutAmounts[1] * 10n ** BigInt(precision) / ethInOutAmounts[0]) / Number(10n ** BigInt(precision)* 10n ** tokenDecimals / 10n ** 18n)
}

export function getTokenAmountsWorth(tokenAmount: bigint, tokenPriceEstimate: TokenPriceEstimate) {
	return (tokenPriceEstimate.inOutAmount[0] * tokenAmount / tokenPriceEstimate.inOutAmount[1])
}
