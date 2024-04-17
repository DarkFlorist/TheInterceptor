import { bigintToDecimalString } from '../../utils/bigint.js'

export const AbbreviatedValue = ({ amount, decimals = 18n }: { amount: bigint, decimals?: bigint }) => {
	const decimalString = bigintToDecimalString(amount, decimals)
	const [integer, fraction] = decimalString.split('.')

	if (fraction) {
		const normalizedFraction = `${Number(fraction)}` // zero padding removed
		const zeroPad = fraction.replace(normalizedFraction, '')
		return <>{integer}<small>{zeroPad}</small>normalizedFraction</>
	}

	return <>{decimalString}</>
}

export function toFixedLengthDigits(num: number, max = 5) {
	const formatter = new Intl.NumberFormat('en-US', { maximumSignificantDigits: max, useGrouping: false })
	return formatter.format(num)
}
