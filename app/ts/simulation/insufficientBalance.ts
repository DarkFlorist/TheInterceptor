import type { MaybeSimulatedTransaction } from '../types/visualizer-types.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS } from '../utils/constants.js'
import { getInsufficientBalanceMessage } from '../utils/insufficientBalance.js'

type FailedSimulatedTransaction = Extract<MaybeSimulatedTransaction, { transactionStatus: 'Transaction Failed' }>

export const getSimulatedTransactionInsufficientBalanceMessage = (transaction: FailedSimulatedTransaction) => {
	const sender = transaction.transaction.from.address
	const nativeBalanceAfter = transaction.tokenBalancesAfter.find((balance) => (
		balance.token === ETHEREUM_LOGS_LOGGER_ADDRESS && balance.owner === sender
	))?.balance
	const token = transaction.transaction.to
	const tokenBalance = token?.type === 'ERC20'
		? transaction.tokenBalancesAfter.find((balance) => balance.token === token.address && balance.owner === sender)?.balance
		: undefined

	return getInsufficientBalanceMessage(
		{
			from: sender,
			to: token?.address ?? null,
			value: transaction.transaction.value,
			input: transaction.transaction.input,
		},
		nativeBalanceAfter === undefined
			? undefined
			: {
				balance: nativeBalanceAfter + transaction.gasSpent * transaction.realizedGasPrice,
				symbol: transaction.transaction.rpcNetwork.currencyTicker,
				decimals: 18n,
			},
		token?.type !== 'ERC20' || tokenBalance === undefined
			? undefined
			: { token: token.address, balance: tokenBalance, symbol: token.symbol, decimals: token.decimals },
	)
}
