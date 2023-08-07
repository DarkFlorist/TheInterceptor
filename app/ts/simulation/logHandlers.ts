import { bytesToUnsigned } from '../utils/bigint.js'
import { TokenVisualizerResult } from '../utils/visualizer-types.js'
import { MulticallResponseEventLog } from '../utils/JsonRpc-types.js'

export function handleERC20TransferLog(eventLog: MulticallResponseEventLog): TokenVisualizerResult {
	const is721 = eventLog.topics.length === 4
	return {
		from: eventLog.topics[1],
		to: eventLog.topics[2],
		tokenAddress: eventLog.loggersAddress,
		isApproval: false,
		...(is721 ? { tokenId: eventLog.topics[3], type: 'ERC721' } : { amount: bytesToUnsigned(eventLog.data), type: 'ERC20' }),
	}
}

export function handleApprovalLog(eventLog: MulticallResponseEventLog): TokenVisualizerResult {
	const is721 = eventLog.topics.length === 4
	return {
		from: eventLog.topics[1],
		to: eventLog.topics[2],
		tokenAddress: eventLog.loggersAddress,
		...(is721 ? { tokenId: eventLog.topics[3], type: 'ERC721' } : { amount: bytesToUnsigned(eventLog.data), type: 'ERC20' }),
		isApproval: true,
	}
}

export function handleErc721ApprovalForAllLog(eventLog: MulticallResponseEventLog): TokenVisualizerResult {
	return {
		from: eventLog.topics[1],
		to: eventLog.topics[2],
		tokenAddress: eventLog.loggersAddress,
		type: 'NFT All approval',
		isApproval: true,
		allApprovalAdded: eventLog.topics[3] != 0n,
	}
}

export function handleDepositLog(eventLog: MulticallResponseEventLog): TokenVisualizerResult {
	return {
		from: eventLog.loggersAddress,
		to: eventLog.topics[1],
		tokenAddress: eventLog.loggersAddress,
		isApproval: false,
		amount: bytesToUnsigned(eventLog.data),
		type: 'ERC20'
	}
}

export function handleWithdrawalLog(eventLog: MulticallResponseEventLog): TokenVisualizerResult {
	return {
		from: eventLog.topics[1],
		to: eventLog.loggersAddress,
		tokenAddress: eventLog.loggersAddress,
		isApproval: false,
		amount: bytesToUnsigned(eventLog.data),
		type: 'ERC20'
	}
}

export function handleERC1155TransferBatch(eventLog: MulticallResponseEventLog): TokenVisualizerResult {
	return {
		type: 'ERC1155 Transfer Batch',
		operator: eventLog.topics[0],
		from: eventLog.topics[1],
		to: eventLog.topics[2],
		tokenAddress: eventLog.loggersAddress,
		isApproval: false,
		ids: [],//eventLog.topics[3],//TODO FIXME
		amounts: [], //eventLog.topics[4],//TODO FIXME
	}
}

export function handleERC1155TransferSingle(eventLog: MulticallResponseEventLog): TokenVisualizerResult {
	return {
		type: 'ERC1155 Transfer Single',
		operator: eventLog.topics[0],
		from: eventLog.topics[1],
		to: eventLog.topics[2],
		tokenAddress: eventLog.loggersAddress,
		isApproval: false,
		id: eventLog.topics[3],
		amount: eventLog.topics[4],
	}
}
