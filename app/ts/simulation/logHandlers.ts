import { bytesToUnsigned } from '../utils/bigint.js'
import { TokenVisualizerResult } from '../utils/visualizer-types.js'
import { MulticallResponseEventLog } from '../utils/JsonRpc-types.js'

export function handleERC20TransferLog(eventLog: MulticallResponseEventLog): TokenVisualizerResult[] {
	const is721 = eventLog.topics.length === 4
	return [{
		from: eventLog.topics[1],
		to: eventLog.topics[2],
		tokenAddress: eventLog.loggersAddress,
		isApproval: false,
		...(is721 ? { tokenId: eventLog.topics[3], type: 'ERC721' } : { amount: bytesToUnsigned(eventLog.data), type: 'ERC20' }),
	}]
}

export function handleApprovalLog(eventLog: MulticallResponseEventLog): TokenVisualizerResult[] {
	const is721 = eventLog.topics.length === 4
	return [{
		from: eventLog.topics[1],
		to: eventLog.topics[2],
		tokenAddress: eventLog.loggersAddress,
		...(is721 ? { tokenId: eventLog.topics[3], type: 'ERC721' } : { amount: bytesToUnsigned(eventLog.data), type: 'ERC20' }),
		isApproval: true,
	}]
}

export function handleErc721ApprovalForAllLog(eventLog: MulticallResponseEventLog): TokenVisualizerResult[] {
	return [{
		from: eventLog.topics[1],
		to: eventLog.topics[2],
		tokenAddress: eventLog.loggersAddress,
		type: 'NFT All approval',
		isApproval: true,
		allApprovalAdded: eventLog.topics[3] != 0n,
	}]
}

export function handleDepositLog(eventLog: MulticallResponseEventLog): TokenVisualizerResult[] {
	return [{
		from: eventLog.loggersAddress,
		to: eventLog.topics[1],
		tokenAddress: eventLog.loggersAddress,
		isApproval: false,
		amount: bytesToUnsigned(eventLog.data),
		type: 'ERC20'
	}]
}

export function handleWithdrawalLog(eventLog: MulticallResponseEventLog): TokenVisualizerResult[] {
	return [{
		from: eventLog.topics[1],
		to: eventLog.loggersAddress,
		tokenAddress: eventLog.loggersAddress,
		isApproval: false,
		amount: bytesToUnsigned(eventLog.data),
		type: 'ERC20'
	}]
}

export function handleERC1155TransferBatch(eventLog: MulticallResponseEventLog): TokenVisualizerResult[] {
	if (eventLog.topics.length !== 4) throw new Error('Malformed ERC1155 TransferBatch Event')
	console.log('handleERC1155TransferBatch')
	console.log(eventLog)
	const nEvents = Math.floor(eventLog.data.length / 64)
	console.log(nEvents)
	return Array(nEvents).map((index) => ({
		type: 'ERC1155',
		operator: eventLog.topics[1],
		from: eventLog.topics[2],
		to: eventLog.topics[3],
		tokenAddress: eventLog.loggersAddress,
		isApproval: false,
		tokenId: bytesToUnsigned(eventLog.data.slice(index * 32 + 0, index * 32 + 32)),// TODO FIXME, this is wrong
		amount: bytesToUnsigned(eventLog.data.slice(nEvents * 32 + index * 32 + 32, nEvents * 32 + index * 32 + 64)), // TODO FIXME, this is wrong
	}))
}
//operator, from, to, id, value)
export function handleERC1155TransferSingle(eventLog: MulticallResponseEventLog): TokenVisualizerResult[] {
	if (eventLog.topics.length != 4) throw new Error('Malformed ERC1155 TransferSingle Event')
	return [{
		type: 'ERC1155',
		operator: eventLog.topics[1],
		from: eventLog.topics[2],
		to: eventLog.topics[3],
		tokenAddress: eventLog.loggersAddress,
		isApproval: false,
		tokenId: bytesToUnsigned(eventLog.data.slice(0, 32)),
		amount: bytesToUnsigned(eventLog.data.slice(32, 64)),
	}]
}
