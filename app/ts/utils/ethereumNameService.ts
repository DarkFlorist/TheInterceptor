import { ethers } from 'ethers'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { bytes32String, stringToUint8Array } from './bigint.js'
import { MOCK_ADDRESS } from './constants.js'

// parses ens string, eg vitalik.eth from the wrapped ens names() return value
function encodeEthereumNameServiceString(data: string): string | undefined {
	const encodedData: string[] = []
	let currentIndex = 2
	while (currentIndex < data.length - 2) {
		const byteCount = parseInt(data.slice(currentIndex, currentIndex + 2), 16)
		currentIndex += 2
		if (currentIndex + byteCount * 2 <= data.length) {
			const encodedChunk = data.slice(currentIndex, currentIndex + byteCount * 2)
			encodedData.push(encodedChunk)
			currentIndex += byteCount * 2
		} else {
			console.error("Invalid ENS data format.")
			return undefined
		}
	}
	if (encodedData.length === 0) return undefined
	return encodedData.map((part) => new TextDecoder().decode(stringToUint8Array(`0x${ part }`))).join('.')
}

export const EthereumNameServiceTokenWrapper = 0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401n //mainnet only
export const getEthereumNameServiceNameFromTokenId = async (ethereumMainnet: EthereumClientService, tokenId: bigint) : Promise<string | undefined> => {
	if (ethereumMainnet.getChainId() !== 1n) return undefined
	const wrappedEthereumNameService1155TokenInterface = new ethers.Interface(['function names(bytes32) public view returns (bytes)'])
	const tx = {
		type: '1559' as const,
		from: MOCK_ADDRESS,
		to: EthereumNameServiceTokenWrapper,
		value: 0n,
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n,
		accessList: [],
		gas: 42000n,
		chainId: 0n,
		nonce: 0n,
		input: stringToUint8Array(wrappedEthereumNameService1155TokenInterface.encodeFunctionData('names', [bytes32String(tokenId)])),
	}
	const nameString: string = wrappedEthereumNameService1155TokenInterface.decodeFunctionResult('names', stringToUint8Array(await ethereumMainnet.call(tx)))[0]
	return encodeEthereumNameServiceString(nameString)
}
