import { bigintToDecimalString } from './bigint.js'

export const formatInsufficientBalanceMessage = (
	symbol: string,
	decimals: bigint,
	available: bigint,
	attempted: bigint,
) => (
	`Insufficient ${ symbol } balance. Available: ${ bigintToDecimalString(available, decimals) } ${ symbol }. Attempting to send: ${ bigintToDecimalString(attempted, decimals) } ${ symbol }.`
)
