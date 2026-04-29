import type { Abi } from 'viem'
import { encodePacked, getCreate2Address, keccak256 } from 'viem/utils'
import { EthereumAddress } from '../types/wire-types.js'
import { addressString } from './bigint.js'
import { networkPriceSources } from '../background/settings.js'
import { decodeFunctionOutput, encodeAbiValues, encodeFunctionCall } from './abiRuntime.js'

interface UniswapPools {
	token0IsQuote: boolean
	v2Pools: EthereumAddress[],
	v3Pools: EthereumAddress[]
}

interface Multicall3Call {
	target: `0x${ string }`
	allowFailure: boolean
	callData: `0x${ string }`
}

const isSuccessfulCall = ({ returnData, success }: { returnData: string, success: boolean }) => success && returnData !== '0x'

const UniswapV2PairABI = [
	{
		type: 'function',
		name: 'getReserves',
		stateMutability: 'view',
		inputs: [],
		outputs: [
			{ name: 'reserve0', type: 'uint112' },
			{ name: 'reserve1', type: 'uint112' },
			{ name: 'blockTimestampLast', type: 'uint32' },
		],
	},
] as const satisfies Abi

const UniswapV3PairABI = [
	{
		type: 'function',
		name: 'slot0',
		stateMutability: 'view',
		inputs: [],
		outputs: [
			{ name: 'sqrtPriceX96', type: 'uint160' },
			{ name: 'tick', type: 'int24' },
			{ name: 'observationIndex', type: 'uint16' },
			{ name: 'observationCardinality', type: 'uint16' },
			{ name: 'observationCardinalityNext', type: 'uint16' },
			{ name: 'feeProtocol', type: 'uint8' },
			{ name: 'unlocked', type: 'bool' },
		],
	},
] as const satisfies Abi

const Erc20BalanceAbi = [
	{
		type: 'function',
		name: 'balanceOf',
		stateMutability: 'view',
		inputs: [{ name: 'account', type: 'address' }],
		outputs: [{ name: 'balance', type: 'uint256' }],
	},
] as const satisfies Abi

export function calculateUniswapLikePools(token: EthereumAddress, quoteToken: EthereumAddress): UniswapPools | undefined {
	const [token0, token1] = token < quoteToken ? [addressString(token), addressString(quoteToken)] : [addressString(quoteToken), addressString(token)]
	const v2Pools = networkPriceSources.uniswapV2Like.map(({ factory, initCodeHash }) => EthereumAddress.parse(getCreate2Address({
		from: addressString(factory),
		salt: keccak256(encodePacked(['address', 'address'], [token0, token1])),
		bytecodeHash: initCodeHash,
	})))
	const v3Pools = networkPriceSources.uniswapV3Like.flatMap(({ factory, initCodeHash }) => [
		getCreate2Address({ from: addressString(factory), salt: keccak256(encodeAbiValues(['address', 'address', 'uint24'], [token0, token1, 100])), bytecodeHash: initCodeHash }),
		getCreate2Address({ from: addressString(factory), salt: keccak256(encodeAbiValues(['address', 'address', 'uint24'], [token0, token1, 500])), bytecodeHash: initCodeHash }),
		getCreate2Address({ from: addressString(factory), salt: keccak256(encodeAbiValues(['address', 'address', 'uint24'], [token0, token1, 3000])), bytecodeHash: initCodeHash }),
		getCreate2Address({ from: addressString(factory), salt: keccak256(encodeAbiValues(['address', 'address', 'uint24'], [token0, token1, 10000])), bytecodeHash: initCodeHash }),
	]).map((addr) => EthereumAddress.parse(addr))

	if (v2Pools.length === 0 && v3Pools.length === 0) return undefined

	return {
		token0IsQuote: BigInt(token0) === quoteToken,
		v2Pools,
		v3Pools
	}
}

export function constructUniswapLikeSpotCalls(tokenA: EthereumAddress, tokenB: EthereumAddress, poolAddresses: UniswapPools): Multicall3Call[] {
	return [
		// Pool calls
		...poolAddresses.v2Pools.map((poolAddress) => ({
			target: addressString(poolAddress),
			allowFailure: true,
			callData: encodeFunctionCall(UniswapV2PairABI, 'getReserves', [])
		})),
		...poolAddresses.v3Pools.map((poolAddress) => ({
			target: addressString(poolAddress),
			allowFailure: true,
			callData: encodeFunctionCall(UniswapV3PairABI, 'slot0', [])
		})),

		// Balance calls for v3 pool TVL
		...poolAddresses.v3Pools.flatMap((poolAddress) => [
			{
				target: addressString(tokenA),
				allowFailure: true,
				callData: encodeFunctionCall(Erc20BalanceAbi, 'balanceOf', [addressString(poolAddress)])
			},
			{
				target: addressString(tokenB),
				allowFailure: true,
				callData: encodeFunctionCall(Erc20BalanceAbi, 'balanceOf', [addressString(poolAddress)])
			}
		]),
	]
}

interface PriceWithLiquidity {
	price: bigint
	liquidity: bigint
}

export function calculatePricesFromUniswapLikeReturnData(multicallData: readonly { success: boolean, returnData: `0x${ string }` }[], poolAddresses: UniswapPools): PriceWithLiquidity[] {
	const multicallReturnData = [...multicallData] // Make mutable to be able to splice

	const v2Prices = multicallReturnData.splice(0, poolAddresses.v2Pools.length).map(({ success, returnData }) => {
		if (!isSuccessfulCall({ returnData, success })) return undefined
		const [reserve0, reserve1] = decodeFunctionOutput(UniswapV2PairABI, 'getReserves', returnData)
		if (reserve0 === 0n || reserve1 === 0n) return undefined

		const price = poolAddresses.token0IsQuote
			? (reserve0 * (10n ** 18n)) / reserve1
			: (reserve1 * (10n ** 18n)) / reserve0

		return { price, liquidity: reserve0 * reserve1 }
	})

	const v3Prices = multicallReturnData.map(({ success, returnData }, index) => {
		if (index >= poolAddresses.v3Pools.length) return undefined // Dont directly map over balanceOf calls
		const multicallReturn1 = multicallReturnData[(index * 2) + poolAddresses.v3Pools.length]
		const multicallReturn2 = multicallReturnData[(index * 2) + 1 + poolAddresses.v3Pools.length]
		if (multicallReturn1 === undefined || multicallReturn2 === undefined) return undefined
		if (!isSuccessfulCall({ success, returnData }) || !isSuccessfulCall(multicallReturn1) || !isSuccessfulCall(multicallReturn2)) return undefined

		const [sqrtPriceX96] = decodeFunctionOutput(UniswapV3PairABI, 'slot0', returnData)
		const reserve0 = BigInt(multicallReturn1.returnData)
		const reserve1 = BigInt(multicallReturn2.returnData)

		if (reserve0 === 0n || reserve1 === 0n || sqrtPriceX96 === 0n) return undefined
		if (sqrtPriceX96 <= 2n ** 96n / 10n ** 9n) return undefined

		const price = poolAddresses.token0IsQuote
			? (10n ** 36n) / ((((sqrtPriceX96 * 10n ** 18n) / (2n ** 96n)) ** 2n) / (10n ** 18n))
			: (((sqrtPriceX96 * 10n ** 18n) / (2n ** 96n)) ** 2n) / (10n ** 18n)

		return { price, liquidity: reserve0 * reserve1 }
	})

	return [...v2Prices, ...v3Prices].filter((x): x is { price: bigint, liquidity: bigint } => typeof x !== 'undefined')
}
