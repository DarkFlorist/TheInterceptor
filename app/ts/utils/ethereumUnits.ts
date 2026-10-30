export const formatUnits = (amount: bigint, decimals: number): string => {
	if (!Number.isInteger(decimals) || decimals < 0) throw new Error('decimals must be a non-negative integer')
	const negative = amount < 0n
	const absolute = negative ? -amount : amount
	const base = 10n ** BigInt(decimals)
	const integer = absolute / base
	const fraction = absolute % base
	if (decimals === 0 || fraction === 0n) return `${ negative ? '-' : '' }${ integer }`
	const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/u, '')
	return `${ negative ? '-' : '' }${ integer }.${ fractionText }`
}

export const parseUnits = (value: string, decimals: number): bigint | undefined => {
	if (!Number.isInteger(decimals) || decimals < 0) return undefined
	const match = value.trim().match(/^([0-9]+)(?:\.([0-9]*))?$/u)
	const integerText = match?.[1]
	const fractionText = match?.[2] ?? ''
	if (integerText === undefined || fractionText.length > decimals) return undefined
	return BigInt(integerText) * 10n ** BigInt(decimals) + BigInt(fractionText.padEnd(decimals, '0') || '0')
}
