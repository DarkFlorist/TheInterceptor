import type { EthSimulateV1CallResult, EthereumEvent } from '../../types/ethSimulate-types.js'
import { EthereumAddress, type EthereumData, type EthereumQuantity, type EthereumSendableSignedTransaction } from '../../types/wire-types.js'
import { handleERC1155TransferBatch, handleERC1155TransferSingle } from '../logHandlers.js'
import { Erc1155ABI, Erc20ABI } from '../../utils/abi.js'
import { decodeCallDataLoose, decodeEventLoose, type AbiLike } from '../../utils/abiRuntime.js'
import { bytes32String, dataStringWith0xStart } from '../../utils/bigint.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS } from '../../utils/constants.js'
import { parseTransactionIfPossible } from '../../utils/calldata.js'

export type BalanceQuery = {
	readonly type: 'ERC20'
	readonly token: bigint
	readonly owner: bigint
} | {
	readonly type: 'ERC1155'
	readonly token: bigint
	readonly owner: bigint
	readonly tokenId: bigint
}

export const parseEventIfPossible = (abi: AbiLike, log: EthereumEvent) => {
	try {
		return decodeEventLoose(abi, { topics: log.topics.map((topic) => bytes32String(topic)), data: dataStringWith0xStart(log.data) })
	} catch {
		return undefined
	}
}

export const parseTransactionInputIfPossible = (abi: AbiLike, data: EthereumData, value: EthereumQuantity) => {
	try {
		return decodeCallDataLoose(abi, dataStringWith0xStart(data), value)
	} catch {
		return undefined
	}
}

const getErc20BalanceQueries = (events: readonly EthereumEvent[]): BalanceQuery[] => {
	const queries: BalanceQuery[] = []
	for (const log of events) {
		const parsed = parseEventIfPossible(Erc20ABI, log)
		if (parsed === undefined) continue
		const addOwner = (owner: unknown) => queries.push({ type: 'ERC20', token: log.address, owner: EthereumAddress.parse(owner) })
		switch (parsed.name) {
			case 'Withdrawal':
			case 'Deposit':
				addOwner(parsed.args[0])
				break
			case 'Approval':
			case 'Transfer':
				addOwner(parsed.args[0])
				addOwner(parsed.args[1])
				break
			default: throw new Error(`wrong name: ${ parsed.name }`)
		}
	}
	return queries
}

const getErc1155BalanceQueries = (events: readonly EthereumEvent[]): BalanceQuery[] => {
	const queries: BalanceQuery[] = []
	for (const log of events) {
		const parsed = parseEventIfPossible(Erc1155ABI, log)
		if (parsed === undefined) continue
		const addTransfer = (transfer: ReturnType<typeof handleERC1155TransferSingle>[number] | undefined) => {
			if (transfer === undefined || transfer.type !== 'ERC1155') return
			queries.push({ type: 'ERC1155', token: log.address, owner: transfer.from, tokenId: transfer.tokenId })
			queries.push({ type: 'ERC1155', token: log.address, owner: transfer.to, tokenId: transfer.tokenId })
		}
		switch (parsed.name) {
			case 'TransferSingle':
				addTransfer(handleERC1155TransferSingle(log)[0])
				break
			case 'TransferBatch':
				for (const transfer of handleERC1155TransferBatch(log)) addTransfer(transfer)
				break
			default: throw new Error(`wrong name: ${ parsed.name }`)
		}
	}
	return queries
}

export const getTokenBalanceQueriesForTransaction = (callResult: EthSimulateV1CallResult, transaction: EthereumSendableSignedTransaction): BalanceQuery[] => {
	const events = callResult.status === 'success' ? callResult.logs : []
	const attemptedTransfer = parseTransactionIfPossible(transaction)
	const attemptedTransferQueries: BalanceQuery[] = attemptedTransfer?.name === 'transfer' && transaction.to !== null
		? [{ type: 'ERC20', token: transaction.to, owner: transaction.from }]
		: []
	return [
		{ type: 'ERC20', token: ETHEREUM_LOGS_LOGGER_ADDRESS, owner: transaction.from },
		...attemptedTransferQueries,
		...getErc20BalanceQueries(events),
		...getErc1155BalanceQueries(events),
	]
}
