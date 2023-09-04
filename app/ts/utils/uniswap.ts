import { AbiCoder, getCreate2Address, keccak256, solidityPacked, Interface } from "ethers"
import { EthereumAddress } from "../types/wire-types.js"
import { addressString } from "./bigint.js"
import { networkPriceSources } from "../background/settings.js"

interface UniswapPools {
	token0IsQuote: boolean
	v2Pools: EthereumAddress[],
	v3Pools: EthereumAddress[]
}

interface Multicall3Call {
	target: string
	allowFailure: boolean
	callData: string
}

const isSuccessfulCall = ({ returnData, success }: { returnData: string, success: boolean }) => success && returnData !== '0x'

export function calculateUniswapLikePools(token: EthereumAddress, quoteToken: EthereumAddress, chainId: bigint): UniswapPools | undefined {
	const chainIdString = chainId.toString()
	if (!(chainIdString in networkPriceSources)) return undefined
	const network = networkPriceSources[chainIdString]


	const [token0, token1] = token < quoteToken ? [addressString(token), addressString(quoteToken)] : [addressString(quoteToken), addressString(token)]
	const abi = new AbiCoder()

	const v2Pools = network.priceSources.uniswapV2Like.map(({ factory, initCodeHash }) => EthereumAddress.parse(getCreate2Address(addressString(factory), keccak256(solidityPacked(['address', 'address'], [token0, token1])), initCodeHash)))

	const v3Pools = network.priceSources.uniswapV3Like.map(({ factory, initCodeHash }) => [
		getCreate2Address(addressString(factory), keccak256(abi.encode(['address', 'address', 'uint24'], [token0, token1, 100])), initCodeHash),
		getCreate2Address(addressString(factory), keccak256(abi.encode(['address', 'address', 'uint24'], [token0, token1, 500])), initCodeHash),
		getCreate2Address(addressString(factory), keccak256(abi.encode(['address', 'address', 'uint24'], [token0, token1, 3000])), initCodeHash),
		getCreate2Address(addressString(factory), keccak256(abi.encode(['address', 'address', 'uint24'], [token0, token1, 10000])), initCodeHash)
	]).flat().map(addr => EthereumAddress.parse(addr))

	if (v2Pools.length === 0 && v3Pools.length === 0) return undefined

	return {
		token0IsQuote: BigInt(token0) === quoteToken,
		v2Pools,
		v3Pools
	}
}

export const UniswapV2PairABI = ['function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)']
export const UniswapV3PairABI = ['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)']

export function constructUniswapLikeSpotCalls(tokenA: EthereumAddress, tokenB: EthereumAddress, poolAddresses: UniswapPools): Multicall3Call[] {
	const IUniswapV2Pool = new Interface(UniswapV2PairABI)
	const IUniswapV3Pool = new Interface(UniswapV3PairABI)
	const IErc20Bal = new Interface(['function balanceOf(address) external view returns (uint256)'])

	return [
		// Pool calls
		...poolAddresses.v2Pools.map(poolAddress => ({
			target: addressString(poolAddress),
			allowFailure: true,
			callData: IUniswapV2Pool.encodeFunctionData('getReserves')
		})),
		...poolAddresses.v3Pools.map(poolAddress => ({
			target: addressString(poolAddress),
			allowFailure: true,
			callData: IUniswapV3Pool.encodeFunctionData('slot0')
		})),

		// Balance calls for v3 pool TVL
		...poolAddresses.v3Pools.map(poolAddress => [
			{
				target: addressString(tokenA),
				allowFailure: true,
				callData: IErc20Bal.encodeFunctionData('balanceOf', [addressString(poolAddress)])
			},
			{
				target: addressString(tokenB),
				allowFailure: true,
				callData: IErc20Bal.encodeFunctionData('balanceOf', [addressString(poolAddress)])
			}
		]).flat(),
	]
}

interface PriceWithLiquidity {
	price: bigint
	liquidity: bigint
}

export function calculatePricesFromUniswapLikeReturnData(multicallData: { success: boolean, returnData: string }[], poolAddresses: UniswapPools): PriceWithLiquidity[] {
	const IUniswapV2Pool = new Interface(UniswapV2PairABI)
	const IUniswapV3Pool = new Interface(UniswapV3PairABI)
	const multicallReturnData = [...multicallData] // Make mutable to be able to splice

	const v2Prices = multicallReturnData.splice(0, poolAddresses.v2Pools.length).map(({ success, returnData }) => {
		if (!isSuccessfulCall({ returnData, success })) return undefined
		const { reserve0, reserve1 } = IUniswapV2Pool.decodeFunctionResult('getReserves', returnData)
		if (reserve0 === 0n || reserve1 === 0n) return undefined

		const price = poolAddresses.token0IsQuote
			? (reserve0 * (10n ** 18n)) / reserve1
			: (reserve1 * (10n ** 18n)) / reserve0

		return { price, liquidity: BigInt(reserve0 * reserve1) }
	})

	const v3Prices = multicallReturnData.map(({ success, returnData }, index) => {
		if (index >= poolAddresses.v3Pools.length) return undefined // Dont directly map over balanceOf calls
		if (!isSuccessfulCall({ success, returnData }) || !isSuccessfulCall(multicallReturnData[(index * 2) + poolAddresses.v3Pools.length]) || !isSuccessfulCall(multicallReturnData[(index * 2) + 1 + poolAddresses.v3Pools.length])) return undefined

		// Current
		const { sqrtPriceX96 } = IUniswapV3Pool.decodeFunctionResult('slot0', returnData)
		const reserve0 = BigInt(multicallReturnData[(index * 2) + poolAddresses.v3Pools.length].returnData)
		const reserve1 = BigInt(multicallReturnData[(index * 2) + 1 + poolAddresses.v3Pools.length].returnData)

		if (reserve0 === 0n || reserve1 === 0n || sqrtPriceX96 === 0n) return undefined

		const price = poolAddresses.token0IsQuote
			? (10n ** 36n) / ((((sqrtPriceX96 * 10n ** 18n) / (2n ** 96n)) ** 2n) / (10n ** 18n))
			: (((sqrtPriceX96 * 10n ** 18n) / (2n ** 96n)) ** 2n) / (10n ** 18n)

		return { price, liquidity: reserve0 * reserve1 }
	})

	return [...v2Prices, ...v3Prices].filter((x): x is { price: bigint, liquidity: bigint } => typeof x !== 'undefined')
}
