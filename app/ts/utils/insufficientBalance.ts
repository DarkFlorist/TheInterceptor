import { bigintToDecimalString } from './bigint.js'
import { parseTransactionIfPossible } from './calldata.js'

type TransactionForBalanceDiagnosis = {
	from: bigint
	to: bigint | null
	value: bigint
	input?: Uint8Array
}

export type AssetBalance = {
	balance: bigint
	symbol: string
	decimals: bigint
}

export type Erc20AssetBalance = AssetBalance & {
	token: bigint
}

const formatInsufficientBalanceMessage = (
	symbol: string,
	decimals: bigint,
	available: bigint,
	attempted: bigint,
) => (
	`Insufficient ${ symbol } balance. Available: ${ bigintToDecimalString(available, decimals) } ${ symbol }. Attempting to send: ${ bigintToDecimalString(attempted, decimals) } ${ symbol }.`
)

const getDirectErc20Transfer = (transaction: TransactionForBalanceDiagnosis) => {
	if (transaction.to === null) return undefined
	const parsedTransaction = parseTransactionIfPossible(transaction)
	if (parsedTransaction?.name !== 'transfer') return undefined
	return {
		token: transaction.to,
		owner: transaction.from,
		amount: parsedTransaction.arguments.value,
	}
}

export const getInsufficientBalanceMessage = (
	transaction: TransactionForBalanceDiagnosis,
	nativeBalance: AssetBalance | undefined,
	erc20Balance: Erc20AssetBalance | undefined,
) => {
	if (nativeBalance !== undefined && transaction.value > nativeBalance.balance) {
		return formatInsufficientBalanceMessage(nativeBalance.symbol, nativeBalance.decimals, nativeBalance.balance, transaction.value)
	}
	const attemptedTransfer = getDirectErc20Transfer(transaction)
	if (attemptedTransfer === undefined || erc20Balance === undefined || erc20Balance.token !== attemptedTransfer.token) return undefined
	if (attemptedTransfer.amount <= erc20Balance.balance) return undefined
	return formatInsufficientBalanceMessage(erc20Balance.symbol, erc20Balance.decimals, erc20Balance.balance, attemptedTransfer.amount)
}

export const resolveInsufficientBalanceMessage = async (
	transaction: TransactionForBalanceDiagnosis,
	nativeBalance: AssetBalance,
	resolveErc20Balance: (token: bigint, owner: bigint) => Promise<Erc20AssetBalance | undefined>,
) => {
	const nativeBalanceMessage = getInsufficientBalanceMessage(transaction, nativeBalance, undefined)
	if (nativeBalanceMessage !== undefined) return nativeBalanceMessage
	const attemptedTransfer = getDirectErc20Transfer(transaction)
	if (attemptedTransfer === undefined) return undefined
	const erc20Balance = await resolveErc20Balance(attemptedTransfer.token, attemptedTransfer.owner)
	return getInsufficientBalanceMessage(transaction, nativeBalance, erc20Balance)
}
