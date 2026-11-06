export const generateUuidV4 = () => {
	const bytes = new Uint8Array(16)
	globalThis.crypto.getRandomValues(bytes)
	const versionByte = bytes[6]
	const variantByte = bytes[8]
	if (versionByte === undefined || variantByte === undefined) throw new Error('UUID entropy is incomplete')
	bytes[6] = (versionByte & 0x0f) | 0x40
	bytes[8] = (variantByte & 0x3f) | 0x80
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
	return `${ hex.slice(0, 8) }-${ hex.slice(8, 12) }-${ hex.slice(12, 16) }-${ hex.slice(16, 20) }-${ hex.slice(20) }`
}

// Use primitive operations: RegExp matches publish private inputs through legacy page-readable statics.
export const isUuid = (value: unknown): value is string => {
	if (typeof value !== 'string' || value.length !== 36) return false
	for (let index = 0; index < value.length; index++) {
		const character = value[index]
		if (index === 8 || index === 13 || index === 18 || index === 23) {
			if (character !== '-') return false
		} else if (character === undefined || !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F'))) return false
	}
	const version = value[14]
	const variant = value[19]
	return version !== undefined && version >= '1' && version <= '5'
		&& (variant === '8' || variant === '9' || variant === 'a' || variant === 'b' || variant === 'A' || variant === 'B')
}

