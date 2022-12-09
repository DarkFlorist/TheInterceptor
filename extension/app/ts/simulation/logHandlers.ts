import { bytesToUnsigned } from '../utils/bigint.js'
import { TokenVisualizerResult } from '../utils/visualizer-types.js'
import { MulticallResponseEventLog } from '../utils/wire-types.js'

export function handleTransferLog(eventLog: MulticallResponseEventLog): TokenVisualizerResult {
	const is721 = eventLog.topics.length === 4
	return {
		from: eventLog.topics[1],
		to: eventLog.topics[2],
		tokenAddress: eventLog.loggersAddress,
		isApproval: false,
		...(is721 ? { tokenId: eventLog.topics[3], is721: true } : { amount: bytesToUnsigned(eventLog.data), is721: false }),
	}
}

export function handleApprovalLog(eventLog: MulticallResponseEventLog): TokenVisualizerResult {
	const is721 = eventLog.topics.length === 4
	return {
		from: eventLog.topics[1],
		to: eventLog.topics[2],
		tokenAddress: eventLog.loggersAddress,
		...(is721 ? { tokenId: eventLog.topics[3], is721: true } : { amount: bytesToUnsigned(eventLog.data), is721: false }),
		isApproval: true,
	}
}

export function handleERC721ApprovalForAllLog(eventLog: MulticallResponseEventLog): TokenVisualizerResult {
	return {
		from: eventLog.topics[1],
		to: eventLog.topics[2],
		tokenAddress: eventLog.loggersAddress,
		is721: true,
		isApproval: true,
		isAllApproval: true,
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
		is721: false
	}
}

export function handleWithdrawalLog(eventLog: MulticallResponseEventLog): TokenVisualizerResult {
	return {
		from: eventLog.topics[1],
		to: eventLog.loggersAddress,
		tokenAddress: eventLog.loggersAddress,
		isApproval: false,
		amount: bytesToUnsigned(eventLog.data),
		is721: false
	}
}
