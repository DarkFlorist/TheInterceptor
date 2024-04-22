import { bigintToRoundedPrettyDecimalString } from '../../utils/bigint.js'

export const AbbreviatedValue = ({ amount, decimals = 18n }: { amount: bigint, decimals?: bigint }) => {
	const decimalString = bigintToRoundedPrettyDecimalString(amount, decimals)
	const [beforeDecimal, afterDecimal] = decimalString.split('.')

	// Apply special formatting for decimal values that have long leading zeros
	if (afterDecimal && Number.parseFloat(decimalString) % 1 === 0) {
		const firstNonZeroIndex = afterDecimal.search(/[^0]/)
		if (firstNonZeroIndex !== -1) {
			return (
				<>{ `${ beforeDecimal }.` }<small>{ afterDecimal.slice(0, firstNonZeroIndex) }</small>{ afterDecimal.slice(firstNonZeroIndex) }</>
			)
		}
	}

	// If no special formatting is needed, return the original decimalString
	return <>{ decimalString }</>
}
