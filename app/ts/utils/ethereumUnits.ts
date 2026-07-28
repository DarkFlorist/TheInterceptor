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
