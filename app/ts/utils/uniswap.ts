import { AbiCoder, getCreate2Address, keccak256, solidityPacked } from "ethers"
import { EthereumAddress } from "./wire-types.js"
import { Interface } from "ethers"
import { UNISWAP_V2_FACTORY_ADDRESS, UNISWAP_V3_FACTORY_ADDRESS } from "./constants.js"
import { addressString } from "./bigint.js"

interface UniswapPools {
	token0IsQuote: boolean
	v2: EthereumAddress
	v3: {
		'100': EthereumAddress
		'500': EthereumAddress
		'3000': EthereumAddress
		'10000': EthereumAddress
	}
}

interface Multicall3Call {
	target: string
	allowFailure: boolean
	callData: string
}

export function calculateUniswapPools(tokenA: EthereumAddress, tokenB: EthereumAddress): UniswapPools {
	const [token0, token1] = tokenA < tokenB ? [addressString(tokenA), addressString(tokenB)] : [addressString(tokenB), addressString(tokenA)]
	const abi = new AbiCoder()

	const v2 = getCreate2Address(
		addressString(UNISWAP_V2_FACTORY_ADDRESS),
		keccak256(solidityPacked(['address', 'address'], [token0, token1])),
		'0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f'
	)

	const v3 = {
		'100': getCreate2Address(
			addressString(UNISWAP_V3_FACTORY_ADDRESS),
			keccak256(
				abi.encode(['address', 'address', 'uint24'], [token0, token1, 100])
			),
			'0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54'
		),
		'500': getCreate2Address(
			addressString(UNISWAP_V3_FACTORY_ADDRESS),
			keccak256(
				abi.encode(['address', 'address', 'uint24'], [token0, token1, 500])
			),
			'0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54'
		),
		'3000': getCreate2Address(
			addressString(UNISWAP_V3_FACTORY_ADDRESS),
			keccak256(
				abi.encode(['address', 'address', 'uint24'], [token0, token1, 3000])
			),
			'0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54'
		),
		'10000': getCreate2Address(
			addressString(UNISWAP_V3_FACTORY_ADDRESS),
			keccak256(
				abi.encode(['address', 'address', 'uint24'], [token0, token1, 10000])
			),
			'0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54'
		)
	}

	return {
		token0IsQuote: BigInt(token0) === tokenA,
		v2: EthereumAddress.parse(v2),
		v3: {
		'100': EthereumAddress.parse(v3[100]),
		'500': EthereumAddress.parse(v3[500]),
		'3000': EthereumAddress.parse(v3[3000]),
		'10000': EthereumAddress.parse(v3[10000]),
		}
	}
}

export const UniswapV2PairABI = [
	'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
]

export const UniswapV3PairABI = [
	'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'
]

export function getUniswapSpotCalls(poolAddresses: UniswapPools): Multicall3Call[] {
	const IUniswapV2Pool = new Interface(UniswapV2PairABI)
	const IUniswapV3Pool = new Interface(UniswapV3PairABI)

	return [
		{
			target: addressString(poolAddresses.v2),
			allowFailure: true,
			callData: IUniswapV2Pool.encodeFunctionData('getReserves')
		},
		{
			target: addressString(poolAddresses.v3[100]),
			allowFailure: true,
			callData: IUniswapV3Pool.encodeFunctionData('slot0')
		},
		{
			target: addressString(poolAddresses.v3[500]),
			allowFailure: true,
			callData: IUniswapV3Pool.encodeFunctionData('slot0')
		},
		{
			target: addressString(poolAddresses.v3[3000]),
			allowFailure: true,
			callData: IUniswapV3Pool.encodeFunctionData('slot0')
		},
		{
			target: addressString(poolAddresses.v3[10000]),
			allowFailure: true,
			callData: IUniswapV3Pool.encodeFunctionData('slot0')
		}
	]
}
