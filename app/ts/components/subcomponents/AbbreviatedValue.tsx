export const AbbreviatedValue = ({ floatValue }: { floatValue: number }) => {
	const prefixes = [
		{ value: 1e9, symbol: 'G' },
		{ value: 1e6, symbol: 'M' },
		{ value: 1e3, symbol: 'k' },
	]

	for (const prefix of prefixes) {
		if (floatValue >= prefix.value) {
			return <>{toFixedLengthDigits(floatValue / prefix.value) + prefix.symbol}</>
		}
	}

	// if value is a fraction of 1
	if (floatValue && floatValue % 1 === floatValue) {
		const [coefficient, exponent] = floatValue.toExponential().split('e')
		const leadingZerosCount = Math.abs(Number.parseInt(exponent)) - 1
		const significantDigits = coefficient.replace('.', '')
		return (
			<>
				0.
				<small>{'0'.repeat(leadingZerosCount)}</small>
				{significantDigits}
			</>
		)
	}

	return <>{toFixedLengthDigits(floatValue)}</>
}

function toFixedLengthDigits(num: number, max = 5) {
	const formatter = new Intl.NumberFormat('en-US', { maximumSignificantDigits: max, useGrouping: false })
	return formatter.format(num)
}
