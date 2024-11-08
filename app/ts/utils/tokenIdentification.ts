import { Interface } from 'ethers'
import { Erc20ABI, Erc721ABI } from './abi.js'
import { EthereumAddress } from '../types/wire-types.js'
import { IEthereumClientService } from '../simulation/services/EthereumClientService.js'
import { checksummedAddress, stringToUint8Array } from './bigint.js'
import { Erc1155Entry, Erc20TokenEntry, Erc721Entry } from '../types/addressBookTypes.js'

type EOA = {
	type: 'EOA'
	address: EthereumAddress
}

type UnknownContract = {
	type: 'contract'
	address: EthereumAddress
}

export type IdentifiedAddress = (EOA | Erc20TokenEntry | Erc721Entry | Erc1155Entry | UnknownContract)

async function tryAggregateMulticall(ethereumClientService: IEthereumClientService, requestAbortController: AbortController | undefined, calls: { targetAddress: EthereumAddress, callData: Uint8Array }[]): Promise<{ success: boolean, returnData: Uint8Array }[]> {
	const results = await ethereumClientService.ethSimulateV1([{ calls: calls.map((call) => ({
		type: '1559' as const,
		to: call.targetAddress,
		input: call.callData
	}))}], 'latest', requestAbortController)
	const blockResult = results[0]
	if (blockResult === undefined) throw new Error('Failed eth_simulateV1 call: did not get a block')
	if (blockResult.calls.length !== calls.length) throw new Error('Failed eth_simulateV1 call: call length mismatch')
	return blockResult.calls.map((call) => ({
		success: call.status === 'success',
		returnData: call.returnData
	}))
}

export async function itentifyAddressViaOnChainInformation(ethereumClientService: IEthereumClientService, requestAbortController: AbortController | undefined, address: EthereumAddress): Promise<IdentifiedAddress> {
	const contractCode = await ethereumClientService.getCode(address, 'latest', requestAbortController)
	if (contractCode.length === 0) return { type: 'EOA', address }

	const nftInterface = new Interface(Erc721ABI)
	const erc20Interface = new Interface(Erc20ABI)
	const targetAddress = address
	const calls = [
		{ targetAddress, callData: stringToUint8Array(nftInterface.encodeFunctionData('supportsInterface', ['0x80ac58cd'])) }, // Is Erc721Definition
		{ targetAddress, callData: stringToUint8Array(nftInterface.encodeFunctionData('supportsInterface', ['0x5b5e139f'])) }, // Is Erc721Metadata
		{ targetAddress, callData: stringToUint8Array(nftInterface.encodeFunctionData('supportsInterface', ['0xd9b67a26'])) }, // Is Erc1155Definition
		{ targetAddress, callData: stringToUint8Array(erc20Interface.encodeFunctionData('name', [])) },
		{ targetAddress, callData: stringToUint8Array(erc20Interface.encodeFunctionData('symbol', [])) },
		{ targetAddress, callData: stringToUint8Array(erc20Interface.encodeFunctionData('decimals', [])) },
		{ targetAddress, callData: stringToUint8Array(erc20Interface.encodeFunctionData('totalSupply', [])) }
	]

	try {
		const [isErc721, hasMetadata, isErc1155, name, symbol, decimals, totalSupply] = await tryAggregateMulticall(ethereumClientService, requestAbortController, calls)
		if (isErc721 === undefined || hasMetadata === undefined || isErc1155 === undefined || name === undefined || symbol === undefined || decimals === undefined || totalSupply === undefined) throw new Error('Multicall result is too short')
		if (isErc721.success && nftInterface.decodeFunctionResult('supportsInterface', isErc721.returnData)[0] === true) {
			return {
				type: 'ERC721',
				address,
				name: hasMetadata.success && nftInterface.decodeFunctionResult('supportsInterface', hasMetadata.returnData)[0] ? nftInterface.decodeFunctionResult('name', name.returnData)[0] : checksummedAddress(address),
				symbol: hasMetadata.success && nftInterface.decodeFunctionResult('supportsInterface', hasMetadata.returnData)[0] ? nftInterface.decodeFunctionResult('symbol', symbol.returnData)[0] : '???',
				entrySource: 'OnChain'
			}
		}
		if (isErc1155.success && nftInterface.decodeFunctionResult('supportsInterface', isErc1155.returnData)[0] === true) {
			return {
				type: 'ERC1155',
				address,
				entrySource: 'OnChain',
				name: checksummedAddress(address),
				symbol: '???',
				decimals: undefined
			}
		}
		if (name.success && decimals.success && symbol.success && totalSupply.success) {
			return {
				type: 'ERC20',
				address,
				name: erc20Interface.decodeFunctionResult('name', name.returnData)[0],
				symbol: erc20Interface.decodeFunctionResult('symbol', symbol.returnData)[0],
				decimals: BigInt(erc20Interface.decodeFunctionResult('decimals', decimals.returnData)[0]),
				entrySource: 'OnChain'
			}
		}
	} catch (error) {
		// For any reason decoding txing fails catch and return as unknown contract
		console.warn(error)
		return { type: 'contract', address }
	}

	// If doesn't pass checks being an ERC20, ERC721 or ERC1155, then we only know its a contract
	return { type: 'contract', address }
}
