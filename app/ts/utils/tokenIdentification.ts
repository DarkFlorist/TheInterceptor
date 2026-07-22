import type { Abi } from './ethereumPrimitives.js'
import { Erc20ABI, Erc721ABI } from './abi.js'
import type { EthereumAddress } from '../types/wire-types.js'
import type { IEthereumClientService } from '../simulation/services/EthereumClientService.js'
import { checksummedAddress, stringToUint8Array } from './bigint.js'
import type { Erc1155Entry, Erc20TokenEntry, Erc721Entry } from '../types/addressBookTypes.js'
import { decodeFunctionOutputSafely, encodeFunctionCall } from './abiRuntime.js'
import { isBigint, isBoolean, isNumberOrBigint, isString } from './typescript.js'

type EOA = {
	type: 'EOA'
	address: EthereumAddress
}

type UnknownContract = {
	type: 'contract'
	address: EthereumAddress
}

export type IdentifiedAddress = (EOA | Erc20TokenEntry | Erc721Entry | Erc1155Entry | UnknownContract)

const TOKEN_METADATA_PROBE_GAS_LIMIT = 500_000n

async function tryAggregateMulticall(ethereumClientService: IEthereumClientService, requestAbortController: AbortController | undefined, calls: { targetAddress: EthereumAddress, callData: Uint8Array }[]): Promise<{ success: boolean, returnData: Uint8Array }[]> {
	const results = await ethereumClientService.ethSimulateV1([{ calls: calls.map((call) => ({
		type: '1559' as const,
		to: call.targetAddress,
		input: call.callData,
		gas: TOKEN_METADATA_PROBE_GAS_LIMIT,
	}))}], 'latest', requestAbortController)
	const blockResult = results[0]
	if (blockResult === undefined) throw new Error('Failed eth_simulateV1 call: did not get a block')
	if (blockResult.calls.length !== calls.length) throw new Error('Failed eth_simulateV1 call: call length mismatch')
	return blockResult.calls.map((call) => ({
		success: call.status === 'success',
		returnData: call.returnData
	}))
}

type MulticallResult = {
	success: boolean
	returnData: Uint8Array
}

const decodeMulticallFunctionOutputSafely = <T>(abi: Abi, functionName: string, result: MulticallResult, isExpectedType: (value: unknown) => value is T): T | undefined => {
	if (!result.success || result.returnData.length === 0) return undefined
	return decodeFunctionOutputSafely(abi, functionName, result.returnData, isExpectedType)
}

export async function itentifyAddressViaOnChainInformation(ethereumClientService: IEthereumClientService, requestAbortController: AbortController | undefined, address: EthereumAddress): Promise<IdentifiedAddress> {
	const contractCode = await ethereumClientService.getCode(address, 'latest', requestAbortController)
	if (contractCode.length === 0) return { type: 'EOA', address }

	const targetAddress = address
	const calls = [
		{ targetAddress, callData: stringToUint8Array(encodeFunctionCall(Erc721ABI, 'supportsInterface', ['0x80ac58cd'])) }, // Is Erc721Definition
		{ targetAddress, callData: stringToUint8Array(encodeFunctionCall(Erc721ABI, 'supportsInterface', ['0x5b5e139f'])) }, // Is Erc721Metadata
		{ targetAddress, callData: stringToUint8Array(encodeFunctionCall(Erc721ABI, 'supportsInterface', ['0xd9b67a26'])) }, // Is Erc1155Definition
		{ targetAddress, callData: stringToUint8Array(encodeFunctionCall(Erc20ABI, 'name', [])) },
		{ targetAddress, callData: stringToUint8Array(encodeFunctionCall(Erc20ABI, 'symbol', [])) },
		{ targetAddress, callData: stringToUint8Array(encodeFunctionCall(Erc20ABI, 'decimals', [])) },
		{ targetAddress, callData: stringToUint8Array(encodeFunctionCall(Erc20ABI, 'totalSupply', [])) }
	]

	const [isErc721, hasMetadata, isErc1155, name, symbol, decimals, totalSupply] = await tryAggregateMulticall(ethereumClientService, requestAbortController, calls)
	if (isErc721 === undefined || hasMetadata === undefined || isErc1155 === undefined || name === undefined || symbol === undefined || decimals === undefined || totalSupply === undefined) throw new Error('Multicall result is too short')
	const supportsErc721 = decodeMulticallFunctionOutputSafely(Erc721ABI, 'supportsInterface', isErc721, isBoolean)
	const supportsMetadata = decodeMulticallFunctionOutputSafely(Erc721ABI, 'supportsInterface', hasMetadata, isBoolean)
	const supportsErc1155 = decodeMulticallFunctionOutputSafely(Erc721ABI, 'supportsInterface', isErc1155, isBoolean)
	const tokenName = decodeMulticallFunctionOutputSafely(Erc20ABI, 'name', name, isString)
	const tokenSymbol = decodeMulticallFunctionOutputSafely(Erc20ABI, 'symbol', symbol, isString)
	const tokenDecimals = decodeMulticallFunctionOutputSafely(Erc20ABI, 'decimals', decimals, isNumberOrBigint)
	const tokenSupply = decodeMulticallFunctionOutputSafely(Erc20ABI, 'totalSupply', totalSupply, isBigint)

	if (supportsErc721 === true) {
		return {
			type: 'ERC721',
			address,
			name: supportsMetadata === true ? decodeMulticallFunctionOutputSafely(Erc721ABI, 'name', name, isString) ?? checksummedAddress(address) : checksummedAddress(address),
			symbol: supportsMetadata === true ? decodeMulticallFunctionOutputSafely(Erc721ABI, 'symbol', symbol, isString) ?? '???' : '???',
			entrySource: 'OnChain'
		}
	}
	if (supportsErc1155 === true) {
		return {
			type: 'ERC1155',
			address,
			entrySource: 'OnChain',
			name: checksummedAddress(address),
			symbol: '???',
			decimals: undefined
		}
	}
	if (tokenName !== undefined && tokenSymbol !== undefined && tokenDecimals !== undefined && tokenSupply !== undefined) {
		return {
			type: 'ERC20',
			address,
			name: tokenName,
			symbol: tokenSymbol,
			decimals: BigInt(tokenDecimals),
			entrySource: 'OnChain'
		}
	}

	// If doesn't pass checks being an ERC20, ERC721 or ERC1155, then we only know its a contract
	return { type: 'contract', address }
}
