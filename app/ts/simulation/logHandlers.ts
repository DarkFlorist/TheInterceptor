import { bytesToUnsigned } from '../utils/bigint.js'
import { ParsedEvent, TokenVisualizerResult } from '../types/visualizer-types.js'
import { Interface } from 'ethers'
import { Erc1155ABI } from '../utils/abi.js'
import { parseEventIfPossible } from './services/SimulationModeEthereumClientService.js'

export function handleERC20TransferLog(eventLog: ParsedEvent): TokenVisualizerResult[] {
	if (eventLog.topics[1] === undefined || eventLog.topics[2] === undefined) throw new Error('unknown log')
	const data = {
		from: eventLog.topics[1],
		to: eventLog.topics[2],
		tokenAddress: eventLog.loggersAddressBookEntry.address,
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

export function handleApprovalLog(eventLog: ParsedEvent): TokenVisualizerResult[] {
	if (eventLog.topics[1] === undefined || eventLog.topics[2] === undefined) throw new Error('unknown log')
	const data = {
		from: eventLog.topics[1],
		to: eventLog.topics[2],
		tokenAddress: eventLog.loggersAddressBookEntry.address,
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

export function handleErc721ApprovalForAllLog(eventLog: ParsedEvent): TokenVisualizerResult[] {
	if (eventLog.topics[1] === undefined || eventLog.topics[2] === undefined) throw new Error('unknown log')
	return [{
		from: eventLog.topics[1],
		to: eventLog.topics[2],
		tokenAddress: eventLog.loggersAddressBookEntry.address,
		type: 'NFT All approval',
		isApproval: true,
		allApprovalAdded: eventLog.topics[3] != 0n,
	}]
}

export function handleDepositLog(eventLog: ParsedEvent): TokenVisualizerResult[] {
	if (eventLog.topics[1] === undefined) throw new Error('unknown log')
	return [{
		from: eventLog.loggersAddressBookEntry.address,
		to: eventLog.topics[1],
		tokenAddress: eventLog.loggersAddressBookEntry.address,
		isApproval: false,
		amount: bytesToUnsigned(eventLog.data),
		type: 'ERC20',
	}]
}

export function handleWithdrawalLog(eventLog: ParsedEvent): TokenVisualizerResult[] {
	if (eventLog.topics[1] === undefined) throw new Error('unknown log')
	return [{
		from: eventLog.topics[1],
		to: eventLog.loggersAddressBookEntry.address,
		tokenAddress: eventLog.loggersAddressBookEntry.address,
		isApproval: false,
		amount: bytesToUnsigned(eventLog.data),
		type: 'ERC20',
	}]
}

export function handleERC1155TransferBatch(eventLog: ParsedEvent): TokenVisualizerResult[] {
	if (eventLog.topics.length !== 4) throw new Error('Malformed ERC1155 TransferBatch Event')
	return eventLog.args.map((_, index) => {
		return {
			type: 'ERC1155' as const,
			operator: eventLog.topics[1],
			from: eventLog.topics[2],
			to: eventLog.topics[3],
			tokenAddress: eventLog.loggersAddressBookEntry.address,
			isApproval: false as const,
			tokenId: BigInt(parsed.args._ids[index]),
			amount: BigInt(parsed.args._values[index]),
			originalLogObject: eventLog,
		}
	})
}
//operator, from, to, id, value)
export function handleERC1155TransferSingle(eventLog: ParsedEvent): TokenVisualizerResult[] {
	if (eventLog.topics.length !== 4 || eventLog.topics[1] === undefined || eventLog.topics[2] === undefined || eventLog.topics[3] === undefined) throw new Error('Malformed ERC1155 TransferSingle Event')
	return [{
		type: 'ERC1155',
		operator: eventLog.topics[1],
		from: eventLog.topics[2],
		to: eventLog.topics[3],
		tokenAddress: eventLog.loggersAddressBookEntry.address,
		isApproval: false,
		tokenId: bytesToUnsigned(eventLog.data.slice(0, 32)),
		amount: bytesToUnsigned(eventLog.data.slice(32, 64)),
	}]
}
