import { decodeParameters, encodeMethod } from '@zoltu/ethereum-abi-encoder'
import { keccak256 } from '@zoltu/ethereum-crypto'
import { CHAINS, isSupportedChain, UNISWAP_V2_ROUTER_ADDRESS } from '../utils/constants'
import { EthereumClientService } from './services/EthereumClientService'
import { TokenPriceEstimate } from '../utils/visualizer-types'
import { addressString } from '../utils/bigint'

interface TokenDecimals {
	token: bigint,
	decimals: bigint,
}

export class PriceEstimator {
	private readonly ethereum
	public constructor(ethereum: EthereumClientService) {
		this.ethereum = ethereum
	}

	public async estimateEthereumPricesForTokens(tokens: TokenDecimals[]) : Promise<TokenPriceEstimate[]> {
		if (tokens.length == 0) return []

		const chainId = await this.ethereum.getChainId()
		const chainString = chainId.toString()
		if (!isSupportedChain(chainString)) return []

		const amountOutMin = 0n
		const sender = CHAINS[chainString].eth_donator
		const block = await this.ethereum.getBlock()
		const deadline = BigInt( block.timestamp.getTime() + 1000 * 1000)

		const transactionCount = await this.ethereum.getTransactionCount(sender)
		let inOutResults: TokenPriceEstimate[] = []
		const outputAbi = [{ 'internalType': 'uint256[]', 'name': 'amounts', 'type': 'uint256[]' }]
		for ( const token of tokens) {
			if ( token.token === CHAINS[chainString].weth ) {
				inOutResults.push({
					token: addressString(CHAINS[chainString].weth),
					inOutAmount: [10n ** 18n, 10n ** 18n] as const,
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
					input: await encodeMethod(keccak256.hash, 'swapExactETHForTokens(uint256,address[],address,uint256)', [amountOutMin, [CHAINS[chainString].weth, token.token], sender, deadline] ),
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
					input: await encodeMethod(keccak256.hash, 'approve(address,uint256)', [UNISWAP_V2_ROUTER_ADDRESS, 2n ** 127n] ),
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
					input: await encodeMethod(keccak256.hash, 'swapTokensForExactETH(uint256,uint256,address[],address,uint256)', [10n ** 18n / 2n, 2n ** 127n, [token.token, CHAINS[chainString].weth], sender, deadline] ),
					accessList: [],
				},
			]
			const results = await this.ethereum.multicall(swapTransactions, block.number + 1n)
			if (results.length !== 3) throw ('invalid multicall result')
			if ( results[2].statusCode === 'success' ) {
				const inOut = decodeParameters(outputAbi, results[2].returnValue) as { amounts: bigint[] }
				if (inOut.amounts.length != 2) return []
				if(inOut.amounts[0] <= 0n || inOut.amounts[1] <= 0n || token.decimals <= 0n) return []
				inOutResults.push( {
					token: addressString(token.token ),
					inOutAmount: [inOut.amounts[1], inOut.amounts[0]] as const,
					decimals: token.decimals
				} )
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
