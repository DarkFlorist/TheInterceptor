import { Interface, BytesLike } from 'ethers'
import { Erc20ABI, Erc721ABI, MulticallABI } from './abi.js'
import { EthereumAddress } from './wire-types.js'
import { Erc20Definition } from './visualizer-types.js'
import { IEthereumClientService } from '../simulation/services/EthereumClientService.js'
import { UniswapV3Multicall2 } from './constants.js'
import { stringToUint8Array } from './bigint.js'

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

/*
async function erc1155balanceOf(ethereumClientService: IEthereumClientService, contractAddress: EthereumAddress, userAddress: EthereumAddress, id: bigint): Promise<bigint> {
	const erc1155Interface = new Interface(Erc1155ABI)
	const returnData = await ethereumClientService.call({ to: contractAddress, input: stringToUint8Array(erc1155Interface.encodeFunctionData('balanceOf', [userAddress, id])) })
	const balance: bigint = erc1155Interface.decodeFunctionResult('balanceOf', returnData)[0]
	return balance
}*/

async function tryAggregateMulticall(ethereumClientService: IEthereumClientService, calls: { target: bigint, callData: string }[]): Promise<{ success: boolean, returnData: string }[]> {
	const multicallInterface = new Interface(MulticallABI)
	const returnData = await ethereumClientService.call({ to: UniswapV3Multicall2, input: stringToUint8Array(multicallInterface.encodeFunctionData('tryAggregate', [false, calls])) })
	return multicallInterface.decodeFunctionResult('tryAggregate', returnData)
}

export async function itentifyAddressViaOnChainInformation(ethereumClientService: IEthereumClientService, address: EthereumAddress): Promise<IdentifiedAddress> {
	const contractCode = await ethereumClientService.getCode(address)
	if (contractCode.length === 0) return { type: 'EOA', address }

	const nftInterface = new Interface(Erc721ABI)
	const erc20Interface = new Interface(Erc20ABI)
	//const erc1155Interface = new Interface(Erc1155ABI)

	const calls = [
		{
			target: address,
			callData: nftInterface.encodeFunctionData('supportsInterface', ['0x80ac58cd']) // Is Erc721Definition
		},
		{
			target: address,
			callData: nftInterface.encodeFunctionData('supportsInterface', ['0x5b5e139f']) // Is Erc721Metadata
		},
		{
			target: address,
			callData: nftInterface.encodeFunctionData('supportsInterface', ['0xd9b67a26']) // Is Erc1155Definition
		},
		{
			target: address,
			callData: erc20Interface.encodeFunctionData('name', [])
		},
		{
			target: address,
			callData: erc20Interface.encodeFunctionData('symbol', [])
		},
		{
			target: address,
			callData: erc20Interface.encodeFunctionData('decimals', [])
		},
		{
			target: address,
			callData: erc20Interface.encodeFunctionData('totalSupply', [])
		}
	]

	const [isErc721, hasMetadata, isErc1155, name, symbol, decimals, totalSupply]: { success: boolean, returnData: BytesLike }[] = await tryAggregateMulticall(ethereumClientService, calls)

	try {
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

	// If doesn't pass checks being an Erc20Definition or Erc721Definition, then we only know its a contract
	return { type: 'contract', address }
}