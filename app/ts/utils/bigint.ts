import { ethers } from 'ethers'

export function bigintToDecimalString(value: bigint, power: bigint): string {
	if (value >= 0n) {
		const integerPart = value / 10n**power
		const fractionalPart = value % 10n**power
		if (fractionalPart === 0n) return integerPart.toString(10)
		return `${ integerPart.toString(10) }.${ fractionalPart.toString(10).padStart(Number(power), '0').replace(/0+$/, '') }`
	}
	const integerPart = -value / 10n**power
	const fractionalPart = -value % 10n**power
	if (fractionalPart === 0n) return `-${ integerPart.toString(10) }`
	return `-${ integerPart.toString(10) }.${ fractionalPart.toString(10).padStart(Number(power), '0').replace(/0+$/, '') }`
}

export const bigintToNumberFormatParts = (amount: bigint, decimals = 18n, maximumSignificantDigits = 4) => {
	const floatValue = Number(ethers.formatUnits(amount, decimals))

	let formatterOptions: Intl.NumberFormatOptions = { useGrouping: false, maximumFractionDigits: 3 }

	// maintain accuracy if value is a fraction of 1 ex 0.00001
	if (floatValue % 1 === floatValue) formatterOptions.maximumSignificantDigits = maximumSignificantDigits

	// apply only compacting with prefixes for values >= 10k or values <= -10k
	if (Math.abs(floatValue) >= 1e4) {
		formatterOptions = { minimumFractionDigits: 0, notation: 'compact' }
	}

	const formatter = new Intl.NumberFormat('en-US', formatterOptions)
	const parts = formatter.formatToParts(floatValue)
	const partsMap = new Map<Intl.NumberFormatPartTypes, string>()

	for (const part of parts) {
		if (part.type === 'compact') {
			// replace American format with Metric prefixes https://www.ibiblio.org/units/prefixes.html
			const prefix = part.value.replace('K', 'k').replace('B', 'G')
			partsMap.set(part.type, prefix)
			continue
		}
		partsMap.set(part.type, part.value)
	}

	return partsMap
}

export const bigintToRoundedPrettyDecimalString = (amount: bigint, decimals?: bigint, maximumSignificantDigits = 4) => {
	const numberParts = bigintToNumberFormatParts(amount, decimals, maximumSignificantDigits)
	let numberString = ''
	for (const [_type, value] of numberParts) numberString += value
	return numberString
}

export const nanoString = (value: bigint) => bigintToDecimalString(value, 9n)
export const addressString = (address: bigint) => `0x${ address.toString(16).padStart(40, '0') }`
export const addressStringWithout0x = (address: bigint) => address.toString(16).padStart(40, '0')
export const checksummedAddress = (address: bigint) => ethers.getAddress(addressString(address))

export function stringToAddress(addressString: string | undefined) {
	if (addressString === undefined) return undefined
	const trimmedAddress = addressString.trim()
	if (!ethers.isAddress(trimmedAddress)) return undefined
	return BigInt(trimmedAddress)
}

export const bytes32String = (bytes32: bigint) => `0x${ bytes32.toString(16).padStart(64, '0') }`

export function stringToUint8Array(data: string) {
	const dataLength = (data.length - 2) / 2
	if (dataLength === 0) return new Uint8Array()
	return bigintToUint8Array(BigInt(data), dataLength)
}

export function dataString(data: Uint8Array | null) {
	if (data === null) return ''
	return Array.from(data).map(x => x.toString(16).padStart(2, '0')).join('')
}

export function dataStringWith0xStart(data: Uint8Array | null): `0x${ string }` {
	return `0x${ dataString(data) }`
}

export function bigintToUint8Array(value: bigint, numberOfBytes: number) {
	if (typeof value === 'number') value = BigInt(value)
	if (value >= 2n ** BigInt(numberOfBytes * 8) || value < 0n) throw new Error(`Cannot fit ${ value } into a ${ numberOfBytes }-byte unsigned integer.`)
	const result = new Uint8Array(numberOfBytes)
	for (let i = 0; i < result.length; ++i) {
		result[i] = Number((value >> BigInt(numberOfBytes - i - 1) * 8n) & 0xffn)
	}
	return result
}

// biome-ignore lint/suspicious/noExplicitAny: matches JSON.stringify signature
export function stringifyJSONWithBigInts(value: any, space?: string | number | undefined): string {
	return JSON.stringify(value, (_key, value) => {
		if (typeof value === 'bigint') return `0x${ value.toString(16) }`
		if (value instanceof Uint8Array) return '0x' + Array.from(value).map(b => b.toString(16).padStart(2, '0')).join('')
		return value
	}, space)
}

export function bytesToUnsigned(bytes: Uint8Array): bigint {
	let value = 0n
	for (const byte of bytes) {
		value = (value << 8n) + BigInt(byte)
	}
	return value
}

export const min = (left: bigint, right: bigint) => left < right ? left : right
export const max = (left: bigint, right: bigint) => left > right ? left : right
export const abs = (x: bigint) => (x < 0n) ? -1n * x : x

export function isHexEncodedNumber(input: string): boolean {
	const hexNumberRegex = /^(0x)?[0-9a-fA-F]+$/
	return hexNumberRegex.test(input)
}

export function calculateWeightedPercentile(data: readonly { dataPoint: bigint, weight: bigint }[], percentile: bigint): bigint {
	if (data.length === 0) return 0n
	if (percentile < 0 || percentile > 100 || data.map((point) => point.weight).some((weight) => weight < 0)) throw new Error('Invalid input')
	const sortedData = [...data].sort((a, b) => a.dataPoint < b.dataPoint ? -1 : a.dataPoint > b.dataPoint ? 1 : 0)
	const cumulativeWeights = sortedData.map((point) => point.weight).reduce((acc, w, i) => [...acc, (acc[i] ?? 0n) + w], [0n])
	const totalWeight = cumulativeWeights[cumulativeWeights.length - 1]
	if (totalWeight === undefined) throw new Error('Invalid input')

	const targetIndex = percentile * totalWeight / 100n

	const index = cumulativeWeights.findIndex(w => w >= targetIndex)

	if (index === -1) throw new Error('Invalid input')

	const lowerIndex = index === 0 ? 0 : index - 1
	const upperIndex = index

	const lowerValue = sortedData[lowerIndex]
	const upperValue = sortedData[upperIndex]
	const lowerWeight = cumulativeWeights[lowerIndex]
	const upperWeight = cumulativeWeights[upperIndex]

	if (lowerWeight === undefined || upperWeight === undefined || lowerValue === undefined || upperValue === undefined) throw new Error('weights were undefined')
	if (lowerIndex === upperIndex) return lowerValue.dataPoint

	const interpolation = (targetIndex - lowerWeight) / (upperWeight - lowerWeight)
	return lowerValue.dataPoint + (upperValue.dataPoint - lowerValue.dataPoint) * interpolation
}

export const bigintSecondsToDate = (seconds: bigint) => {
	if (seconds > 8640000000000n) throw new Error(`Too big seconds value: ${ seconds }`)
	if (seconds < 0) throw new Error(`Got negative seconds: ${ seconds }`)
	return new Date(Number(seconds) * 1000)
}

export const dateToBigintSeconds = (date: Date) => BigInt(date.getTime()) / 1000n

export function generate256BitRandomBigInt(): bigint {
	const cryptoInterface = globalThis.crypto
	if (cryptoInterface === undefined || cryptoInterface.getRandomValues === undefined) {
		throw new Error("Secure random number generator is not available in this environment")
	}
	const randomBytes = new Uint8Array(32)
	cryptoInterface.getRandomValues(randomBytes)
	return bytesToUnsigned(randomBytes)
}
