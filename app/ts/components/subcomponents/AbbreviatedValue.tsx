export const AbbreviatedValue = ({ floatValue }: { floatValue: number }) => {
	const prefixes = [
		{ value: 1e9, symbol: 'G' },
		{ value: 1e6, symbol: 'M' },
		{ value: 1e3, symbol: 'k' },
	];

	// Check if the value is negative
	const isNegative = floatValue < 0;
	// Convert the value to positive for abbreviation logic
	const valueForAbbreviation = isNegative ? -floatValue : floatValue;

	for (const prefix of prefixes) {
		if (valueForAbbreviation >= prefix.value) {
			// Apply the abbreviation and add a negative sign if the original value was negative
			return <>{isNegative ? '-' : ''}{toFixedLengthDigits(valueForAbbreviation / prefix.value) + prefix.symbol}</>
		}
	}

	// if value is a fraction of 1
	if (valueForAbbreviation && valueForAbbreviation % 1 === valueForAbbreviation) {
		const [coefficient, exponent] = valueForAbbreviation.toExponential().split('e')
		const leadingZerosCount = Math.abs(Number.parseInt(exponent)) - 1
		const significantDigits = coefficient.replace('.', '')
		return <>{isNegative ? '-' : ''}0.<small>{'0'.repeat(leadingZerosCount)}</small>{significantDigits}</>
	}

	// Return the original value with a negative sign if it was negative
	return <>{isNegative ? '-' : ''}{toFixedLengthDigits(valueForAbbreviation)}</>
}

function toFixedLengthDigits(num: number, max = 5) {
	const formatter = new Intl.NumberFormat('en-US', { maximumSignificantDigits: max, useGrouping: false })
	return formatter.format(num)
}
