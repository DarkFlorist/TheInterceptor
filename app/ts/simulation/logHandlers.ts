import { bytes32String, bytesToUnsigned, dataStringWith0xStart } from '../utils/bigint.js'
import { TokenVisualizerResult } from '../utils/visualizer-types.js'
import { MulticallResponseEventLog } from '../utils/JsonRpc-types.js'
import { Interface } from 'ethers'
import { Erc1155ABI } from '../utils/abi.js'
import { parseLogIfPossible } from './services/SimulationModeEthereumClientService.js'

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
	const parsed = parseLogIfPossible(new Interface(Erc1155ABI), { topics: eventLog.topics.map((x) => bytes32String(x)), data: dataStringWith0xStart(eventLog.data) })
	if (parsed === null || parsed.name !== 'TransferBatch') throw new Error('Malformed ERC1155 TransferBatch Event')
	return [...Array(parsed.args._ids.length)].map((_, index) => ({
		type: 'ERC1155' as const,
		operator: eventLog.topics[1],
		from: eventLog.topics[2],
		to: eventLog.topics[3],
		tokenAddress: eventLog.loggersAddress,
		isApproval: false as const,
		tokenId: BigInt(parsed.args._ids[index]),
		amount: BigInt(parsed.args._values[index]),
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
