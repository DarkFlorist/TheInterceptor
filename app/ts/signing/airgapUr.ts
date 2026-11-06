// UR fountain selection adapted from Blockchain Commons bc-ur, Copyright 2020 Blockchain Commons, LLC. BSD-2-Clause-Patent; full notice in app/licenses/bc-ur.txt. xoshiro256** is public domain.
import { sha256 } from '@noble/hashes/sha256'
import { decodeAirGapCbor, encodeAirGapCbor, MAX_AIRGAP_CBOR_BYTES } from './airgapCbor.js'
import { airGapCrc32, decodeAirGapBytewords, encodeAirGapBytewords } from './airgapBytewords.js'

const MAX_FRAGMENTS = 512
const MAX_FRAGMENT_BYTES = 1024
const MAX_INPUT_FRAMES = 4096
const MAX_XOR_BYTES = 64 * 1024 * 1024

/** The UR reference uses SHA-256 seeded xoshiro256**, not a cryptographic random generator. */
function fountainRandom(sequence: number, checksum: number) {
	const seed = new Uint8Array(8)
	const view = new DataView(seed.buffer)
	view.setUint32(0, sequence)
	view.setUint32(4, checksum)
	const digest = sha256(seed)
	const words = new DataView(digest.buffer, digest.byteOffset, digest.byteLength)
	let a = words.getBigUint64(0)
	let b = words.getBigUint64(8)
	let c = words.getBigUint64(16)
	let d = words.getBigUint64(24)
	const mask = (1n << 64n) - 1n
	const rotate = (value: bigint, shift: bigint) => ((value << shift) | (value >> (64n - shift))) & mask
	return () => {
		const result = (rotate((b * 5n) & mask, 7n) * 9n) & mask
		const temporary = (b << 17n) & mask
		c ^= a
		d ^= b
		b ^= c
		a ^= d
		c ^= temporary
		d = rotate(d, 45n)
		return Number(result) / 18446744073709551616
	}
}

/** Protocol-compatible Walker/Vose sampling, including the reference's reverse index ordering. */
export function chooseAirGapFragments(sequence: number, count: number, checksum: number): readonly number[] {
	if (!Number.isInteger(sequence) || sequence < 1 || sequence > 0xffffffff || !Number.isInteger(count) || count < 1 || count > MAX_FRAGMENTS || !Number.isInteger(checksum) || checksum < 0 || checksum > 0xffffffff) throw new Error('Invalid UR fountain parameters')
	if (sequence <= count) return [sequence - 1]
	const rng = fountainRandom(sequence, checksum)
	const weights = Array.from({ length: count }, (_, index) => 1 / (index + 1))
	const sum = weights.reduce((total, weight) => total + weight, 0)
	const scaled = weights.map((weight) => weight * count / sum)
	const probabilities = new Float64Array(count)
	const aliases = new Uint16Array(count)
	const small: number[] = []
	const large: number[] = []
	for (let index = count - 1; index >= 0; index -= 1) ((scaled[index] ?? 0) < 1 ? small : large).push(index)
	while (small.length > 0 && large.length > 0) {
		const low = small.pop()
		const high = large.pop()
		if (low === undefined || high === undefined) throw new Error('Invalid UR sampler state')
		probabilities[low] = scaled[low] ?? 0
		aliases[low] = high
		const next = (scaled[high] ?? 0) + ((scaled[low] ?? 0) - 1)
		scaled[high] = next
		if (next < 1) small.push(high)
		else large.push(high)
	}
	for (const index of [...small, ...large]) probabilities[index] = 1
	const column = Math.floor(count * rng())
	const chosen = rng() < (probabilities[column] ?? 0) ? column : aliases[column]
	if (chosen === undefined || chosen >= count) throw new Error('Invalid UR sampler output')
	const degree = chosen + 1
	const remaining = Array.from({ length: count }, (_, index) => index)
	const result: number[] = []
	while (result.length < degree) {
		const index = Math.floor(rng() * remaining.length)
		const item = remaining.splice(index, 1)[0]
		if (item === undefined) throw new Error('Invalid UR shuffle output')
		result.push(item)
	}
	return result
}

function validateType(type: string) {
	if (!/^[a-z0-9-]{1,40}$/u.test(type)) throw new Error('Invalid UR registry type')
}

export function createAirGapUrEncoder(type: string, payload: Uint8Array, maximumFragmentBytes = 200) {
	validateType(type)
	if (payload.length === 0 || payload.length > MAX_AIRGAP_CBOR_BYTES) throw new Error('UR payload size exceeds limit')
	if (!Number.isInteger(maximumFragmentBytes) || maximumFragmentBytes < 10 || maximumFragmentBytes > MAX_FRAGMENT_BYTES) throw new Error('Invalid UR fragment size')
	const data = payload.slice()
	const count = Math.ceil(data.length / maximumFragmentBytes)
	if (count > MAX_FRAGMENTS) throw new Error('UR fragment count exceeds limit')
	const fragmentLength = Math.ceil(data.length / count)
	const checksum = airGapCrc32(data)
	return {
		count,
		part: (sequence: number) => {
			const indices = chooseAirGapFragments(sequence, count, checksum)
			if (count === 1) return `ur:${ type }/${ encodeAirGapBytewords(data) }`
			const fragment = new Uint8Array(fragmentLength)
			for (const index of indices) for (let byte = 0; byte < fragmentLength; byte += 1) fragment[byte] = (fragment[byte] ?? 0) ^ (data[index * fragmentLength + byte] ?? 0)
			const encoded = encodeAirGapCbor([BigInt(sequence), BigInt(count), BigInt(data.length), BigInt(checksum), fragment])
			return `ur:${ type }/${ sequence }-${ count }/${ encodeAirGapBytewords(encoded) }`
		},
	}
}

export function createAirGapUrDecoder(expectedType: string) {
	validateType(expectedType)
	let metadata: { count: number, length: number, checksum: number, fragmentLength: number } | undefined
	const rows = new Map<number, { mask: bigint, data: Uint8Array }>()
	let frames = 0
	let xorBytes = 0
	let closed = false
	const xor = (left: Uint8Array, right: Uint8Array) => {
		xorBytes += left.length
		if (xorBytes > MAX_XOR_BYTES) throw new Error('UR decoding work limit exceeded')
		for (let index = 0; index < left.length; index += 1) left[index] = (left[index] ?? 0) ^ (right[index] ?? 0)
	}
	const receive = (input: string): { received: number, total: number, payload: Uint8Array | undefined } => {
		if (closed) throw new Error('UR decoder is closed; start a new scan')
		if (++frames > MAX_INPUT_FRAMES || input.length > (MAX_AIRGAP_CBOR_BYTES + 4) * 2 + 80) throw new Error('UR input exceeds limits')
		if (!/^[a-zA-Z0-9:/-]+$/u.test(input)) throw new Error('Invalid UR characters')
		const parts = input.toLowerCase().split('/')
		if (parts[0] !== `ur:${ expectedType }`) throw new Error('Unexpected UR registry type')
		if (parts.length === 2 && parts[1] !== undefined) {
			if (metadata !== undefined) throw new Error('Cannot mix single and multipart UR payloads')
			const payload = decodeAirGapBytewords(parts[1])
			closed = true
			return { received: 1, total: 1, payload }
		}
		if (parts.length !== 3 || parts[1] === undefined || parts[2] === undefined || parts[2].length > 2 * (MAX_FRAGMENT_BYTES + 40)) throw new Error('Invalid UR multipart envelope')
		const sequenceText = /^([1-9][0-9]{0,9})-([1-9][0-9]{0,2})$/u.exec(parts[1])
		if (!sequenceText) throw new Error('Invalid UR sequence')
		const decoded = decodeAirGapCbor(decodeAirGapBytewords(parts[2]))
		if (!Array.isArray(decoded) || decoded.length !== 5) throw new Error('Invalid UR fountain part')
		const [sequence, count, length, checksum, data] = decoded
		if (typeof sequence !== 'bigint' || typeof count !== 'bigint' || typeof length !== 'bigint' || typeof checksum !== 'bigint' || !(data instanceof Uint8Array)) throw new Error('Invalid UR fountain fields')
		if (sequence !== BigInt(sequenceText[1] ?? '') || count !== BigInt(sequenceText[2] ?? '') || sequence < 1n || sequence > 0xffffffffn || count < 2n || count > BigInt(MAX_FRAGMENTS) || length < 1n || length > BigInt(MAX_AIRGAP_CBOR_BYTES) || checksum < 0n || checksum > 0xffffffffn || data.length === 0 || data.length > MAX_FRAGMENT_BYTES) throw new Error('UR fountain fields exceed limits or disagree with envelope')
		if (length <= (count - 1n) * BigInt(data.length) || length > count * BigInt(data.length)) throw new Error('Invalid UR fragment geometry')
		const next = { count: Number(count), length: Number(length), checksum: Number(checksum), fragmentLength: data.length }
		if (metadata !== undefined && (metadata.count !== next.count || metadata.length !== next.length || metadata.checksum !== next.checksum || metadata.fragmentLength !== next.fragmentLength)) throw new Error('UR fragment belongs to a different payload')
		metadata = next
		let mask = chooseAirGapFragments(Number(sequence), next.count, next.checksum).reduce((bits, index) => bits | (1n << BigInt(index)), 0n)
		for (let pivot = 0; pivot < next.count && mask !== 0n; pivot += 1) {
			if ((mask & (1n << BigInt(pivot))) === 0n) continue
			const row = rows.get(pivot)
			if (row === undefined) {
				rows.set(pivot, { mask, data })
				mask = 0n
				break
			}
			mask ^= row.mask
			xor(data, row.data)
			if (mask === 0n && data.some((byte) => byte !== 0)) throw new Error('Conflicting UR fountain fragment')
		}
		if (rows.size !== next.count) return { received: rows.size, total: next.count, payload: undefined }
		const output = new Uint8Array(next.count * next.fragmentLength)
		for (let pivot = next.count - 1; pivot >= 0; pivot -= 1) {
			const row = rows.get(pivot)
			if (row === undefined) throw new Error('Missing UR decoding row')
			for (let index = pivot + 1; index < next.count; index += 1) if ((row.mask & (1n << BigInt(index))) !== 0n) xor(row.data, output.subarray(index * next.fragmentLength, (index + 1) * next.fragmentLength))
			output.set(row.data, pivot * next.fragmentLength)
		}
		const payload = output.slice(0, next.length)
		if (airGapCrc32(payload) !== next.checksum) throw new Error('UR payload checksum mismatch')
		closed = true
		rows.clear()
		return { received: next.count, total: next.count, payload }
	}
	return {
		receive: (input: string) => {
			try { return receive(input) }
			catch (error) {
				closed = true
				rows.clear()
				throw error
			}
		},
	}
}
