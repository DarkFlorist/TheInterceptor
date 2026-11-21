/** Bounded CBOR subset for ERC-4527 registries, not a general CBOR parser. */
export type AirGapCbor = bigint | boolean | string | Uint8Array | readonly AirGapCbor[] | ReadonlyMap<bigint, AirGapCbor> | { readonly tag: bigint, readonly value: AirGapCbor }
export const MAX_AIRGAP_CBOR_BYTES = 65536
const MAX_NODES = 4096
const MAX_DEPTH = 16
const MAX_UINT64 = (1n << 64n) - 1n

export function decodeAirGapCbor(bytes: Uint8Array): AirGapCbor {
	if (bytes.length === 0 || bytes.length > MAX_AIRGAP_CBOR_BYTES) throw new Error('AirGap CBOR payload size is out of bounds')
	let offset = 0
	let nodes = 0
	const take = (length: number) => {
		if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - offset) throw new Error('Truncated AirGap CBOR')
		const result = bytes.subarray(offset, offset + length)
		offset += length
		return result
	}
	const read = (depth: number): AirGapCbor => {
		if (depth > MAX_DEPTH || ++nodes > MAX_NODES) throw new Error('AirGap CBOR complexity limit exceeded')
		const initial = take(1)[0]
		if (initial === undefined) throw new Error('Missing AirGap CBOR header')
		const major = initial >>> 5
		const additional = initial & 31
		if (major === 7) {
			if (additional === 20) return false
			if (additional === 21) return true
			throw new Error('Unsupported AirGap CBOR simple value')
		}
		let argument: bigint
		if (additional < 24) argument = BigInt(additional)
		else {
			if (additional > 27) throw new Error('Indefinite or reserved AirGap CBOR length')
			const length = 2 ** (additional - 24)
			argument = 0n
			for (const byte of take(length)) argument = (argument << 8n) | BigInt(byte)
		}
		if (major === 0) return argument
		if (major === 1) return -1n - argument
		if (major === 6) return { tag: argument, value: read(depth + 1) }
		if (argument > BigInt(MAX_AIRGAP_CBOR_BYTES)) throw new Error('AirGap CBOR length exceeds limit')
		const length = Number(argument)
		if (major === 2) return take(length).slice()
		if (major === 3) return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(take(length))
		if (major === 4) {
			if (length > MAX_NODES - nodes) throw new Error('AirGap CBOR array exceeds limit')
			return Array.from({ length }, () => read(depth + 1))
		}
		if (major === 5) {
			if (length > (MAX_NODES - nodes) / 2) throw new Error('AirGap CBOR map exceeds limit')
			const result = new Map<bigint, AirGapCbor>()
			for (let index = 0; index < length; index += 1) {
				const key = read(depth + 1)
				if (typeof key !== 'bigint' || key < 0n) throw new Error('AirGap registry map keys must be unsigned integers')
				if (result.has(key)) throw new Error('Duplicate AirGap CBOR map key')
				result.set(key, read(depth + 1))
			}
			return result
		}
		throw new Error('Unsupported AirGap CBOR type')
	}
	const result = read(0)
	if (offset !== bytes.length) throw new Error('Trailing AirGap CBOR data')
	return result
}

export function encodeAirGapCbor(value: AirGapCbor): Uint8Array {
	const chunks: Uint8Array[] = []
	let length = 0
	let nodes = 0
	const append = (chunk: Uint8Array) => {
		length += chunk.length
		if (length > MAX_AIRGAP_CBOR_BYTES) throw new Error('AirGap CBOR payload size is out of bounds')
		chunks.push(chunk)
	}
	const header = (major: number, argument: bigint) => {
		if (argument < 0n || argument > MAX_UINT64) throw new Error('AirGap CBOR integer is out of range')
		if (argument < 24n) return append(Uint8Array.of((major << 5) | Number(argument)))
		const size = argument <= 255n ? 1 : argument <= 65535n ? 2 : argument <= 0xffffffffn ? 4 : 8
		const result = new Uint8Array(1 + size)
		result[0] = (major << 5) | (size === 1 ? 24 : size === 2 ? 25 : size === 4 ? 26 : 27)
		for (let index = size; index > 0; index -= 1) {
			result[index] = Number(argument & 255n)
			argument >>= 8n
		}
		append(result)
	}
	const write = (item: AirGapCbor, depth: number): void => {
		if (depth > MAX_DEPTH || ++nodes > MAX_NODES) throw new Error('AirGap CBOR complexity limit exceeded')
		if (typeof item === 'bigint') return header(item < 0n ? 1 : 0, item < 0n ? -1n - item : item)
		if (typeof item === 'boolean') return append(Uint8Array.of(item ? 0xf5 : 0xf4))
		if (typeof item === 'string') {
			if (item.length > MAX_AIRGAP_CBOR_BYTES) throw new Error('AirGap CBOR text exceeds limit')
			const encoded = new TextEncoder().encode(item)
			if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(encoded) !== item) throw new Error('AirGap CBOR text contains an unpaired surrogate')
			header(3, BigInt(encoded.length))
			return append(encoded)
		}
		if (item instanceof Uint8Array) {
			header(2, BigInt(item.length))
			return append(item)
		}
		if ('tag' in item) {
			header(6, item.tag)
			return write(item.value, depth + 1)
		}
		if ('get' in item) {
			if (item.size > (MAX_NODES - nodes) / 2) throw new Error('AirGap CBOR map exceeds limit')
			header(5, BigInt(item.size))
			for (const [key, entry] of [...item].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
				if (key < 0n) throw new Error('AirGap registry map keys must be unsigned integers')
				write(key, depth + 1)
				write(entry, depth + 1)
			}
			return
		}
		if (item.length > MAX_NODES - nodes) throw new Error('AirGap CBOR array exceeds limit')
		header(4, BigInt(item.length))
		for (const entry of item) write(entry, depth + 1)
	}
	write(value, 0)
	const result = new Uint8Array(length)
	let offset = 0
	for (const chunk of chunks) {
		result.set(chunk, offset)
		offset += chunk.length
	}
	return result
}
