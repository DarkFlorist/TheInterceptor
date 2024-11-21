import { ethers, isValidName, namehash } from 'ethers'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { addressStringWithout0x, bytes32String, stringToUint8Array } from './bigint.js'
import { CANNOT_APPROVE, CANNOT_BURN_FUSES, CANNOT_CREATE_SUBDOMAIN, CANNOT_SET_RESOLVER, CANNOT_SET_TTL, CANNOT_TRANSFER, CANNOT_UNWRAP, CAN_DO_EVERYTHING, CAN_EXTEND_EXPIRY, ENS_TOKEN_WRAPPER, IS_DOT_ETH, MOCK_ADDRESS, PARENT_CANNOT_CONTROL } from './constants.js'
import { EthereumAddress } from '../types/wire-types.js'

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
			console.error('Invalid ENS data format.')
			return undefined
		}
	}
	if (encodedData.length === 0) return undefined
	return encodedData.map((part) => new TextDecoder().decode(stringToUint8Array(`0x${ part }`))).join('.')
}

export const getEthereumNameServiceNameFromTokenId = async (ethereumMainnet: EthereumClientService, requestAbortController: AbortController | undefined, tokenId: bigint) : Promise<string | undefined> => {
	if (ethereumMainnet.getChainId() !== 1n) return undefined
	const wrappedEthereumNameService1155TokenInterface = new ethers.Interface(['function names(bytes32) public view returns (bytes)'])
	const tx = {
		type: '1559' as const,
		from: MOCK_ADDRESS,
		to: ENS_TOKEN_WRAPPER,
		value: 0n,
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n,
		accessList: [],
		gas: 42000n,
		chainId: ethereumMainnet.getChainId(),
		nonce: 0n,
		input: stringToUint8Array(wrappedEthereumNameService1155TokenInterface.encodeFunctionData('names', [bytes32String(tokenId)])),
	}
	const nameString: string = wrappedEthereumNameService1155TokenInterface.decodeFunctionResult('names', stringToUint8Array(await ethereumMainnet.call(tx, 'latest', requestAbortController)))[0]
	const name = encodeEthereumNameServiceString(nameString)
	if (name === undefined) return undefined
	if (!isValidName(name)) return name
	if (tokenId !== BigInt(namehash(name))) {
		console.error(`Querying RPC ${ ethereumMainnet.getRpcEntry().httpsRpc } returned invalid name for hash: ${ tokenId }.`)
		return undefined
	}
	return name
}

type EnsFuseName =
  | 'Cannot Unwrap Name'
  | 'Cannot Burn Fuses'
  | 'Cannot Transfer'
  | 'Cannot Set Resolver'
  | 'Cannot Set Time To Live'
  | 'Cannot Create Subdomain'
  | 'Parent Domain Cannot Control'
  | 'Cannot Approve'
  | 'Is .eth domain'
  | 'Can Extend Expiry'
  | 'Can Do Everything'

type EnsFuseFlag = {
	name: EnsFuseName
	value: bigint
}

const flags: EnsFuseFlag[] = [
	{ name: 'Cannot Unwrap Name', value: CANNOT_UNWRAP },
	{ name: 'Cannot Burn Fuses', value: CANNOT_BURN_FUSES },
	{ name: 'Cannot Transfer', value: CANNOT_TRANSFER },
	{ name: 'Cannot Set Resolver', value: CANNOT_SET_RESOLVER },
	{ name: 'Cannot Set Time To Live', value: CANNOT_SET_TTL },
	{ name: 'Cannot Create Subdomain', value: CANNOT_CREATE_SUBDOMAIN },
	{ name: 'Cannot Approve', value: CANNOT_APPROVE },
	{ name: 'Parent Domain Cannot Control', value: PARENT_CANNOT_CONTROL },
	{ name: 'Is .eth domain', value: IS_DOT_ETH },
	{ name: 'Can Extend Expiry', value: CAN_EXTEND_EXPIRY },
	{ name: 'Can Do Everything', value: CAN_DO_EVERYTHING },
]

export const extractENSFuses = (uint: bigint): readonly EnsFuseName[] => {
	if (uint === CAN_DO_EVERYTHING) return ['Can Do Everything']
	const result: EnsFuseName[] = []
	for (const flag of flags) {
		if ((uint & flag.value) === flag.value && flag.value !== CAN_DO_EVERYTHING) {
			result.push(flag.name)
		}
	}
	return result
}

export const getEnsReverseNodeHash = (address: EthereumAddress) => {
	const name = `${ addressStringWithout0x(address) }.addr.reverse`
	return { nameHash: BigInt(namehash(name)), name }
}
