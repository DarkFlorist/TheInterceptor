import { bytesToUnsigned, dataStringWith0xStart } from '../utils/bigint.js'
import { ParsedEvent, TokenVisualizerResult } from '../types/visualizer-types.js'
import { parseEventIfPossible } from './services/SimulationModeEthereumClientService.js'
import { Erc1155ABI } from '../utils/abi.js'
import { Interface } from 'ethers'
import { EthereumEvent } from '../types/ethSimulate-types.js'
import { EthereumBytes32 } from '../types/wire-types.js'

export function handleERC20TransferLog(eventLog: EthereumEvent): TokenVisualizerResult[] {
	if (eventLog.topics[1] === undefined || eventLog.topics[2] === undefined) throw new Error('unknown log')
	const data = {
		from: eventLog.topics[1],
		to: eventLog.topics[2],
		tokenAddress: eventLog.address,
		isApproval: false,
		originalLogObject: eventLog,
	}

	const is721 = eventLog.topics.length === 4
	if (is721) {
		if (eventLog.topics[3] === undefined) throw new Error('unknown log')
		return [{ ...data, ...{ tokenId: eventLog.topics[3], type: 'ERC721' } }]
	}
	return [{...data, amount: bytesToUnsigned(eventLog.data), type: 'ERC20' }]
}

export function handleApprovalLog(eventLog: EthereumEvent): TokenVisualizerResult[] {
	if (eventLog.topics[1] === undefined || eventLog.topics[2] === undefined) throw new Error('unknown log')
	const data = {
		from: eventLog.topics[1],
		to: eventLog.topics[2],
		tokenAddress: eventLog.address,
		isApproval: true,
		originalLogObject: eventLog,
	}
	const is721 = eventLog.topics.length === 4
	if (is721) {
		if (eventLog.topics[3] === undefined) throw new Error('unknown log')
		return [{ ...data, ...{ tokenId: eventLog.topics[3], type: 'ERC721' } } ]
	}
	return [{ ...data, ...{ amount: bytesToUnsigned(eventLog.data), type: 'ERC20' } }]
}

export function handleErc721ApprovalForAllLog(eventLog: EthereumEvent): TokenVisualizerResult[] {
	if (eventLog.topics[1] === undefined || eventLog.topics[2] === undefined) throw new Error('unknown log')
	return [{
		from: eventLog.topics[1],
		to: eventLog.topics[2],
		tokenAddress: eventLog.address,
		type: 'NFT All approval',
		isApproval: true,
		allApprovalAdded: eventLog.topics[3] !== 0n,
	}]
}

export function handleDepositLog(eventLog: EthereumEvent): TokenVisualizerResult[] {
	if (eventLog.topics[1] === undefined) throw new Error('unknown log')
	return [{
		from: eventLog.address,
		to: eventLog.topics[1],
		tokenAddress: eventLog.address,
		isApproval: false,
		amount: bytesToUnsigned(eventLog.data),
		type: 'ERC20',
	}]
}

export function handleWithdrawalLog(eventLog: EthereumEvent): TokenVisualizerResult[] {
	if (eventLog.topics[1] === undefined) throw new Error('unknown log')
	return [{
		from: eventLog.topics[1],
		to: eventLog.address,
		tokenAddress: eventLog.address,
		isApproval: false,
		amount: bytesToUnsigned(eventLog.data),
		type: 'ERC20',
	}]
}

export function handleERC1155TransferBatch(eventLog: EthereumEvent): TokenVisualizerResult[] {
	if (eventLog.topics.length !== 4) throw new Error('Malformed ERC1155 TransferBatch Event')
	const parsed = parseEventIfPossible(new Interface(Erc1155ABI), eventLog)
	if (parsed === null || parsed.name !== 'TransferBatch') throw new Error('Malformed ERC1155 TransferBatch Event')
	return [...Array(parsed.args._ids.length)].map((_, index) => {
		if (parsed.args._ids[index] === undefined || parsed.args._values[index] === undefined || eventLog.topics[1] === undefined || eventLog.topics[2] === undefined || eventLog.topics[3] === undefined) throw new Error('Malformed ERC1155 TransferBatch Event')
		return {
			type: 'ERC1155' as const,
			operator: eventLog.topics[1],
			from: eventLog.topics[2],
			to: eventLog.topics[3],
			tokenAddress: eventLog.address,
			isApproval: false as const,
			tokenId: BigInt(parsed.args._ids[index]),
			amount: BigInt(parsed.args._values[index]),
			originalLogObject: eventLog,
		}
	})
}
//operator, from, to, id, value)
export function handleERC1155TransferSingle(eventLog: EthereumEvent): TokenVisualizerResult[] {
	if (eventLog.topics.length !== 4 || eventLog.topics[1] === undefined || eventLog.topics[2] === undefined || eventLog.topics[3] === undefined) throw new Error('Malformed ERC1155 TransferSingle Event')
	return [{
		type: 'ERC1155',
		operator: eventLog.topics[1],
		from: eventLog.topics[2],
		to: eventLog.topics[3],
		tokenAddress: eventLog.address,
		isApproval: false,
		tokenId: bytesToUnsigned(eventLog.data.slice(0, 32)),
		amount: bytesToUnsigned(eventLog.data.slice(32, 64)),
	}]
}

// event AddressChanged(bytes32 indexed node, uint coinType, bytes newAddress)
export function handleEnsAddressChanged(eventLog: ParsedEvent) {
	if (eventLog.args[0]?.typeValue.type !== 'fixedBytes' || eventLog.args[1]?.typeValue.type !== 'unsignedInteger' || eventLog.args[2]?.typeValue.type !== 'bytes') throw new Error('Malformed ENS AddrChanged Event')
	return {
		node: EthereumBytes32.parse(dataStringWith0xStart(eventLog.args[0].typeValue.value)),
		coinType: eventLog.args[1].typeValue.value,
		to: eventLog.args[2].typeValue.value
	}
}

// event AddrChanged(bytes32 indexed node, address a)
export function handleEnsAddrChanged(eventLog: ParsedEvent) {
	if (eventLog.args[0]?.typeValue.type !== 'fixedBytes' || eventLog.args[1]?.typeValue.type !== 'address') throw new Error('Malformed ENS AddrChanged Event')
	return {
		node: EthereumBytes32.parse(dataStringWith0xStart(eventLog.args[0].typeValue.value)),
		to: eventLog.args[1].typeValue.value
	}
}

// event NameRenewed(string name, bytes32 indexed label, uint cost, uint expires)
export function handleEnsRegistrarNameRenewed(eventLog: ParsedEvent) {
	if (eventLog.args[0]?.typeValue.type !== 'string' || eventLog.args[1]?.typeValue.type !== 'fixedBytes' || eventLog.args[2]?.typeValue.type !== 'unsignedInteger' || eventLog.args[3]?.typeValue.type !== 'unsignedInteger') throw new Error('Malformed ENS AddrChanged Event')
	return {
		name: eventLog.args[0].typeValue.value,
		labelHash: bytesToUnsigned(eventLog.args[1].typeValue.value),
		cost: eventLog.args[2].typeValue.value,
		expires: eventLog.args[3].typeValue.value,
	}
}

// event NameRenewed(uint256 indexed hash, uint expires)
export function handleNameRenewed(eventLog: ParsedEvent) {
	if (eventLog.args[0]?.typeValue.type !== 'unsignedInteger' || eventLog.args[1]?.typeValue.type !== 'unsignedInteger') throw new Error('Malformed ENS NameRenewed Event')
	return {
		labelHash: eventLog.args[0].typeValue.value,
		expires: eventLog.args[1].typeValue.value,
	}
}

// event TextChanged(bytes32 indexed node, string indexed indexedKey, string key)
export function handleEnsTextChanged(eventLog: ParsedEvent) {
	if (eventLog.args[0]?.typeValue.type !== 'fixedBytes' || eventLog.args[1]?.typeValue.type !== 'fixedBytes' || eventLog.args[2]?.typeValue.type !== 'string') throw new Error('Malformed ENS TextChanged Event')
	return { node: EthereumBytes32.parse(dataStringWith0xStart(eventLog.args[0].typeValue.value)) }
}

// event Transfer(bytes32 indexed node, address owner)
export function handleEnsTransfer(eventLog: ParsedEvent) {
	if (eventLog.args[0]?.typeValue.type !== 'fixedBytes' || eventLog.args[1]?.typeValue.type !== 'address') throw new Error('Malformed ENS Transfe Event')
	return { node: EthereumBytes32.parse(dataStringWith0xStart(eventLog.args[0].typeValue.value)) }
}
