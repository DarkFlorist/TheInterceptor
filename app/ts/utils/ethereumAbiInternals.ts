export const INTEGER_REGEX = /^(u?)int([0-9]*)$/u
export const FIXED_BYTES_REGEX = /^bytes([1-9]|[12][0-9]|3[0-2])$/u

const HEX_INTEGER_STRING_REGEX = /^0x[0-9a-fA-F]+$/u
const DECIMAL_INTEGER_STRING_REGEX = /^-?[0-9]+$/u

export const canonicalAbiType = (type: string): string => {
	if (type.startsWith('uint[') || type === 'uint') return type.replace(/^uint/u, 'uint256')
	if (type.startsWith('int[') || type === 'int') return type.replace(/^int/u, 'int256')
	return type
}

export const parseIntegerString = (value: string): bigint | undefined => {
	if (DECIMAL_INTEGER_STRING_REGEX.test(value) || HEX_INTEGER_STRING_REGEX.test(value)) return BigInt(value)
	return undefined
}
