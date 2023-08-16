import { Interface } from 'ethers'
import { Erc20ABI, Erc721ABI, MulticallABI } from './abi.js'
import { EthereumAddress } from './wire-types.js'
import { Erc20Definition } from './visualizer-types.js'
import { IEthereumClientService } from '../simulation/services/EthereumClientService.js'
import { UniswapV3Multicall2 } from './constants.js'
import { addressString, stringToUint8Array } from './bigint.js'

type EOA = {
	type: 'EOA'
	address: EthereumAddress
}

type UnknownContract = {
	type: 'contract'
	address: EthereumAddress
}

type identifiedErc721 = {
	type: 'ERC721'
	address: EthereumAddress
	name: string
	symbol: string
}

type identifiedErc1155 = { type: 'ERC1155', address: EthereumAddress }

type IdentifiedAddress = (EOA | Erc20Definition | identifiedErc721 | identifiedErc1155 | UnknownContract)

async function tryAggregateMulticall(ethereumClientService: IEthereumClientService, calls: { target: string, callData: string }[]): Promise<{ success: boolean, returnData: string }[]> {
	const multicallInterface = new Interface(MulticallABI)
	const tryAggregate = multicallInterface.getFunction('tryAggregate')
	if (tryAggregate === null) throw new Error('tryAggregate misssing from ABI')
	const returnData = await ethereumClientService.call({ to: UniswapV3Multicall2, input: stringToUint8Array(multicallInterface.encodeFunctionData(tryAggregate, [false, calls])) })
	return multicallInterface.decodeFunctionResult(tryAggregate, returnData)[0]
}

export async function itentifyAddressViaOnChainInformation(ethereumClientService: IEthereumClientService, address: EthereumAddress): Promise<IdentifiedAddress> {
	const contractCode = await ethereumClientService.getCode(address)
	if (contractCode.length === 0) return { type: 'EOA', address }

	const nftInterface = new Interface(Erc721ABI)
	const erc20Interface = new Interface(Erc20ABI)
	const target = addressString(address)

	const calls = [
		{ target, callData: nftInterface.encodeFunctionData('supportsInterface', ['0x80ac58cd']) }, // Is Erc721Definition
		{ target, callData: nftInterface.encodeFunctionData('supportsInterface', ['0x5b5e139f']) }, // Is Erc721Metadata
		{ target, callData: nftInterface.encodeFunctionData('supportsInterface', ['0xd9b67a26']) }, // Is Erc1155Definition
		{ target, callData: erc20Interface.encodeFunctionData('name', []) },
		{ target, callData: erc20Interface.encodeFunctionData('symbol', []) },
		{ target, callData: erc20Interface.encodeFunctionData('decimals', []) },
		{ target, callData: erc20Interface.encodeFunctionData('totalSupply', []) }
	]

	try {
		const [isErc721, hasMetadata, isErc1155, name, symbol, decimals, totalSupply] = await tryAggregateMulticall(ethereumClientService, calls)
		if (isErc721.success && nftInterface.decodeFunctionResult('supportsInterface', isErc721.returnData)[0] === true) {
			return {
				type: 'ERC721',
				address,
				name: hasMetadata.success ? nftInterface.decodeFunctionResult('name', name.returnData)[0] : undefined,
				symbol: hasMetadata.success ? nftInterface.decodeFunctionResult('symbol', symbol.returnData)[0] : undefined,
			}
		}
		if (isErc1155.success && nftInterface.decodeFunctionResult('supportsInterface', isErc1155.returnData)[0] === true) {
			return { type: 'ERC1155', address }
		}
		if (name.success && decimals.success && symbol.success && totalSupply.success) {
			return {
				type: 'ERC20',
				address,
				name: erc20Interface.decodeFunctionResult('name', name.returnData)[0],
				symbol: erc20Interface.decodeFunctionResult('name', symbol.returnData)[0],
				decimals: BigInt(erc20Interface.decodeFunctionResult('decimals', decimals.returnData)[0]),
			}
		}
	} catch (error) {
		// For any reason decoding txing fails catch and return as unknown contract
		console.error(error)
		return { type: 'contract', address }
	}

	// If doesn't pass checks being an ERC20, ERC721 or ERC1155, then we only know its a contract
	return { type: 'contract', address }
}
