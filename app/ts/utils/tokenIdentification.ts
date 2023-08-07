import { Contract, Provider, Interface, ZeroAddress, BytesLike } from "ethers"
import { Erc1155ABI, Erc20ABI, Erc721ABI, MulticallABI } from './abi.js'
import { EthereumAddress } from "./wire-types.js"

type EOA = {
	type: 'EOA'
	address: string
}

type UnknownContract = {
	type: 'contract'
	address: string
}

type Erc20 = {
	type: 'Erc20'
	address: string
	name: string
	symbol: string
	decimals: bigint
	totalSupply: bigint
}

export type Erc721 = {
	type: 'Erc721'
	address: string
	owner: string
	id: bigint
	name?: string
	symbol?: string
	tokenURI?: string
}

export type Erc1155 = {
	type: 'Erc1155'
	address: string
	tokenURI?: string
	balance: bigint
	id: bigint
}

export type IdentifiedAddress = (EOA | Erc20 | Erc721 | Erc1155 | UnknownContract) & { inputId: bigint }

export async function itentifyAddress(address: string, id: bigint, provider: Provider, user: EthereumAddress): Promise<IdentifiedAddress> {
	const contractCode = await provider.getCode(address)
	if (contractCode === '0x') return { type: 'EOA', address, inputId: id }

	const multicall = new Contract('0x5ba1e12693dc8f9c48aad8770482f4739beed696', MulticallABI, provider)
	const nftInterface = new Interface(Erc721ABI)
	const erc20Interface = new Interface(Erc20ABI)
	const erc1155Interface = new Interface(Erc1155ABI)

	const calls = [
		{
			target: address,
			callData: nftInterface.encodeFunctionData('supportsInterface', ['0x80ac58cd']) // Is Erc721
		},
		{
			target: address,
			callData: nftInterface.encodeFunctionData('supportsInterface', ['0x5b5e139f']) // Is Erc721Metadata
		},
		{
			target: address,
			callData: nftInterface.encodeFunctionData('supportsInterface', ['0xd9b67a26']) // Is Erc1155
		},
		{
			target: address,
			callData: nftInterface.encodeFunctionData('supportsInterface', ['0x0e89341c']) // Is Erc1155Metadata
		},
		{
			target: address,
			callData: nftInterface.encodeFunctionData('ownerOf', [id])
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
		},
		{
			target: address,
			callData: nftInterface.encodeFunctionData('tokenURI', [id])
		},
		{
			target: address,
			callData: erc1155Interface.encodeFunctionData('uri', [id])
		}
	]

	const [isErc721, hasMetadata, isErc1155, isErc1155Metadata, owner, name, symbol, decimals, totalSupply, tokenURI, erc1155Uri]: { success: boolean, returnData: BytesLike }[] = await multicall.tryAggregate.staticCall(false, calls)

	try {

		if (isErc721.success && nftInterface.decodeFunctionResult('supportsInterface', isErc721.returnData)[0] === true) {
			if (owner.success === false || nftInterface.decodeFunctionResult('ownerOf', owner.returnData)[0] === ZeroAddress) throw new Error('No Erc721 found at address')
			return {
				type: 'Erc721',
				inputId: id,
				address,
				id,
				owner: nftInterface.decodeFunctionResult('ownerOf', owner.returnData)[0],
				name: hasMetadata.success ? nftInterface.decodeFunctionResult('name', name.returnData)[0] : undefined,
				tokenURI: hasMetadata.success ? nftInterface.decodeFunctionResult('tokenURI', tokenURI.returnData)[0] : undefined,
			}
		}

		if (isErc1155.success && nftInterface.decodeFunctionResult('supportsInterface', isErc1155.returnData)[0] === true) {
			const tokenContract = new Contract(address, Erc1155ABI, provider)
			const userAddress = EthereumAddress.serialize(user)
			const balance = await tokenContract.balanceOf(userAddress, id)
			const uri: string | undefined = erc1155Uri.success && isErc1155Metadata.success && erc1155Interface.decodeFunctionResult('supportsInterface', isErc1155Metadata.returnData)[0] === true ? erc1155Interface.decodeFunctionResult('uri', erc1155Uri.returnData)[0] : undefined
			return {
				type: 'Erc1155',
				inputId: id,
				id,
				address,
				balance,
				tokenURI: uri ? uri.replaceAll(`{id}`, id.toString(10)) : undefined,
			}
		}

		if (name.success && decimals.success && symbol.success && totalSupply.success) {
			return {
				type: 'Erc20',
				inputId: id,
				address,
				name: erc20Interface.decodeFunctionResult('name', name.returnData)[0],
				symbol: erc20Interface.decodeFunctionResult('name', symbol.returnData)[0],
				decimals: BigInt(erc20Interface.decodeFunctionResult('decimals', decimals.returnData)[0]),
				totalSupply: erc20Interface.decodeFunctionResult('totalSupply', totalSupply.returnData)[0]
			}
		}

	} catch (error) {
		// For any reason decoding txing fails catch and return as unknown contract
		console.error(error)
		return { type: 'contract', address, inputId: id }
	}

	// If doesn't pass checks being an Erc20 or Erc721, then we only know its a contract
	return { type: 'contract', address, inputId: id }
}