import { StateOverrides } from '../types/ethSimulate-types.js'
import { GetSimulationStackReplyV1, GetSimulationStackReplyV2 } from '../types/simulationStackTypes.js'
import { SimulatedTransaction, SimulationState } from '../types/visualizer-types.js'
import { EthereumAddress } from '../types/wire-types.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS, MAKE_YOU_RICH_TRANSACTION } from '../utils/constants.js'
import { handleERC20TransferLog } from './logHandlers.js'

const mergeSimulationOverrides = (stateOverridesArray: StateOverrides[]): StateOverrides => {
	return stateOverridesArray.reduce((accumulator, next) => ({ ...accumulator, ...next }), {})
}

const getETHBalanceChanges = (baseFeePerGas: bigint, transaction: SimulatedTransaction) => {
	if (transaction.ethSimulateV1CallResult.status === 'failure') return []
	const ethLogs = transaction.ethSimulateV1CallResult.logs.filter((log) => log.address === ETHEREUM_LOGS_LOGGER_ADDRESS)
	const ethBalanceAfter = transaction.tokenBalancesAfter.filter((x) => x.token === ETHEREUM_LOGS_LOGGER_ADDRESS)
	return ethBalanceAfter.map((balanceAfter) => {
		const balanceAfterBalance = baseFeePerGas * transaction.ethSimulateV1CallResult.gasUsed
		const gasFees = balanceAfter.owner === transaction.preSimulationTransaction.signedTransaction.from ? transaction.realizedGasPrice * transaction.ethSimulateV1CallResult.gasUsed : 0n
		return {
			address: balanceAfter.owner,
			before: ethLogs.reduce((total, event) => {
				const parsed = handleERC20TransferLog(event)[0]
				if (parsed === undefined || parsed.type !== 'ERC20') throw new Error('eth log was not erc20 transfer event')
				if (parsed.from === balanceAfter.owner && parsed.to !== balanceAfter.owner) return total + parsed.amount
				if (parsed.from !== balanceAfter.owner && parsed.to === balanceAfter.owner) return total - parsed.amount
				return total
			}, balanceAfterBalance ?? 0n) + gasFees,
			after: balanceAfterBalance ?? 0n,
		}
	})
}

export const getSimulatedStackV2 = (simulationState: SimulationState | undefined): GetSimulationStackReplyV2 => {
	if (simulationState === undefined) return { stateOverrides: {}, transactions: [] }
	return {
		stateOverrides: mergeSimulationOverrides(simulationState.simulatedBlocks.map((simulatedBlock) => simulatedBlock.stateOverrides)),
		transactions: simulationState.simulatedBlocks.flatMap((simulatedBlock) => simulatedBlock.simulatedTransactions).map((simulatedTransaction) => ({ ethBalanceChanges: getETHBalanceChanges(simulationState.baseFeePerGas, simulatedTransaction), simulatedTransaction }))
	}
}

export const getSimulatedStackV1 = (simulationState: SimulationState | undefined, addressToMakeRich: EthereumAddress | undefined, version: '1.0.0' | '1.0.1'): GetSimulationStackReplyV1 => {
	if (simulationState === undefined) return []
	const simulatedTransactions = simulationState.simulatedBlocks.flatMap((simulatedBlock) => simulatedBlock.simulatedTransactions).map((transaction) => {
		const ethLogs = transaction.ethSimulateV1CallResult.status === 'failure' ? [] : transaction.ethSimulateV1CallResult.logs.filter((log) => log.address === ETHEREUM_LOGS_LOGGER_ADDRESS)
		const ethBalanceAfter = transaction.tokenBalancesAfter.filter((x) => x.token === ETHEREUM_LOGS_LOGGER_ADDRESS)
		const maxPriorityFeePerGas = transaction.preSimulationTransaction.signedTransaction.type === '1559' ? transaction.preSimulationTransaction.signedTransaction.maxPriorityFeePerGas : 0n
		return {
			...transaction.preSimulationTransaction.signedTransaction,
			...transaction.ethSimulateV1CallResult,
			... ( transaction.ethSimulateV1CallResult.status === 'failure' ? {
				statusCode: transaction.ethSimulateV1CallResult.status,
				error: transaction.ethSimulateV1CallResult.error.message } : {
					statusCode: transaction.ethSimulateV1CallResult.status,
					events: transaction.ethSimulateV1CallResult.logs.map((x) => ({ loggersAddress: x.address, data: x.data, topics: x.topics }))
				}
			),
			returnValue: transaction.ethSimulateV1CallResult.returnData,
			maxPriorityFeePerGas,
			balanceChanges: ethBalanceAfter.map((balanceAfter) => {
				// in the version 1.0.0 , gas price was wrongly calculated with 'maxPriorityFeePerGas', this code keeps this for 1.0.0 but fixes it for other versions
				const balanceAfterBalance = version === '1.0.0' || balanceAfter.owner !== transaction.preSimulationTransaction.signedTransaction.from ? balanceAfter.balance : (balanceAfter.balance ?? 0n) - simulationState.baseFeePerGas * transaction.ethSimulateV1CallResult.gasUsed
				const gasFees = balanceAfter.owner === transaction.preSimulationTransaction.signedTransaction.from ? transaction.realizedGasPrice * transaction.ethSimulateV1CallResult.gasUsed : 0n
				return {
					address: balanceAfter.owner,
					before: ethLogs.reduce((total, event) => {
						const parsed = handleERC20TransferLog(event)[0]
						if (parsed === undefined || parsed.type !== 'ERC20') throw new Error('eth log was not erc20 transfer event')
						if (parsed.from === balanceAfter.owner && parsed.to !== balanceAfter.owner) return total + parsed.amount
						if (parsed.from !== balanceAfter.owner && parsed.to === balanceAfter.owner) return total - parsed.amount
						return total
					}, balanceAfterBalance ?? 0n) + gasFees,
					after: balanceAfterBalance ?? 0n,
				}
			}),
			realizedGasPrice: transaction.realizedGasPrice,
			gasLimit: transaction.preSimulationTransaction.signedTransaction.gas,
			gasSpent: transaction.ethSimulateV1CallResult.gasUsed,
		}
	})
	if (addressToMakeRich === undefined) return simulatedTransactions
	return [
		{
			from: 0x0n,
			chainId: simulationState.rpcNetwork.chainId,
			nonce: 0n,
			to: addressToMakeRich,
			...MAKE_YOU_RICH_TRANSACTION.transaction,
			statusCode: 'success' as const,
			gasSpent: MAKE_YOU_RICH_TRANSACTION.transaction.gas,
			realizedGasPrice: 0n,
			gasLimit: MAKE_YOU_RICH_TRANSACTION.transaction.gas,
			returnValue: new Uint8Array(),
			events: [],
			balanceChanges: [{ address: addressToMakeRich, before: 0n, after: MAKE_YOU_RICH_TRANSACTION.transaction.value }]
		}, ...simulatedTransactions
	]
}
