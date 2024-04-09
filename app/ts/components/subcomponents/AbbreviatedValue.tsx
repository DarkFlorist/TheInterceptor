import { formatUnits } from 'ethers'

export const AbbreviatedValue = ({ amount, decimals = 18n }: { amount: bigint, decimals?: bigint }) => {
	const prefixes = [
		{ value: 1e9, symbol: 'G' },
		{ value: 1e6, symbol: 'M' },
		{ value: 1e3, symbol: 'k' },
	];

	const floatValue = Number(formatUnits(amount, decimals))
	const sign = floatValue < 0 ? '-' : '';
	const absoluteValue = Math.abs(floatValue)

	// display prefixed values
	for (const prefix of prefixes) {
		if (absoluteValue >= prefix.value) {
			return <>{sign}{toFixedLengthDigits(absoluteValue / prefix.value) + prefix.symbol}</>
		}
	}

	// display for values that are a fraction of 1
	if (absoluteValue && absoluteValue % 1 === absoluteValue) {
		const [coefficient, exponent] = absoluteValue.toExponential().split('e')

		// coefficient and exponent should always return string for absolute values but String.split thinks otherwise
		if (!coefficient || !exponent) return <>{floatValue}</>

		const leadingZerosCount = Math.abs(Number.parseInt(exponent)) - 1
		const significantDigits = coefficient.replace('.', '')
		return <>{sign}0.<small>{'0'.repeat(leadingZerosCount)}</small>{significantDigits}</>
	}

	return <>{sign}{toFixedLengthDigits(absoluteValue)}</>
}

function toFixedLengthDigits(num: number, max = 5) {
	const formatter = new Intl.NumberFormat('en-US', { maximumSignificantDigits: max, useGrouping: false })
	return formatter.format(num)
}
