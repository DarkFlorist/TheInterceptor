import { ComponentChild } from 'preact'
import { bigintToNumberFormatParts } from '../../utils/bigint.js'

export const AbbreviatedValue = ({ amount, decimals = 18n }: { amount: bigint, decimals?: bigint }) => {
	const numberParts = bigintToNumberFormatParts(amount, decimals)
	const domElement: ComponentChild[] = []

	for (const [type, value] of numberParts) {
		if (type === 'fraction') {
			const significantDigits = `${ Number(value) }`
			const zeroPad = value.replace(significantDigits, '')
			if (zeroPad.length) {
				domElement.push(<><small>{ zeroPad }</small>{ significantDigits }</>)
				continue
			}
		}
		domElement.push([value])
	}

	return <>{ domElement }</>
}
