import { keccak_256 } from '@noble/hashes/sha3'
import { concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { RLP } from 'micro-eth-signer/core/rlp.js'
import { ens_normalize as normalizeEnsNameWithLocalData } from './ensNormalize.js'
import {
	bytesFromHex,
	bytesToHex,
	ensureHex,
	getAddress,
	keccak256,
	stringToBytes,
	stripHexPrefix,
	type Hex,
} from './ethereumBytes.js'

const INTEGER_REGEX = /^(u?)int([0-9]*)$/u
const FIXED_BYTES_REGEX = /^bytes([1-9]|[12][0-9]|3[0-2])$/u
const PACKED_ARRAY_TYPE_REGEX = /^(.*)\[([0-9]*)\]$/u
const PACKED_ARRAY_ELEMENT_BYTES = 32

const canonicalAbiType = (type: string): string => {
	if (type.startsWith('uint[') || type === 'uint') return type.replace(/^uint/u, 'uint256')
	if (type.startsWith('int[') || type === 'int') return type.replace(/^int/u, 'int256')
	return type
}

export const encodePacked = (types: readonly string[], values: readonly unknown[]): Hex => {
	if (types.length !== values.length) throw new Error(`Packed value count mismatch: expected ${ types.length }, got ${ values.length }`)
	return bytesToHex(concatBytes(...types.map((type, index) => encodePackedValue(canonicalAbiType(type), values[index]))))
}

const splitPackedArrayType = (type: string) => {
	const match = type.match(PACKED_ARRAY_TYPE_REGEX)
	const itemType = match?.[1]
	const lengthText = match?.[2]
	if (itemType === undefined || lengthText === undefined) return undefined
	if (itemType === '') throw new Error(`Invalid packed array type ${ type }`)
	if (lengthText === '') return { itemType }
	const length = Number(lengthText)
	if (!Number.isSafeInteger(length)) throw new Error(`Invalid packed array length for ${ type }`)
	return { itemType, length }
}

const leftPadPackedArrayElement = (bytes: Uint8Array, padByte = 0) => {
	if (bytes.length >= PACKED_ARRAY_ELEMENT_BYTES) return bytes
	const padded = new Uint8Array(PACKED_ARRAY_ELEMENT_BYTES)
	if (padByte !== 0) padded.fill(padByte, 0, PACKED_ARRAY_ELEMENT_BYTES - bytes.length)
	padded.set(bytes, PACKED_ARRAY_ELEMENT_BYTES - bytes.length)
	return padded
}

const rightPadPackedArrayElement = (bytes: Uint8Array) => {
	if (bytes.length >= PACKED_ARRAY_ELEMENT_BYTES) return bytes
	const padded = new Uint8Array(PACKED_ARRAY_ELEMENT_BYTES)
	padded.set(bytes)
	return padded
}

const isNegativePackedSignedInteger = (type: string, value: unknown) => {
	const integerMatch = type.match(INTEGER_REGEX)
	if (integerMatch === null || integerMatch[1] === 'u') return false
	return BigInt(String(value)) < 0n
}

const encodePackedArrayElement = (type: string, value: unknown): Uint8Array => {
	const arrayType = splitPackedArrayType(type)
	if (arrayType !== undefined) return encodePackedArrayValue(arrayType.itemType, arrayType.length, value)
	if (type === 'bytes' || type === 'string') return encodePackedValue(type, value)
	const encoded = encodePackedValue(type, value)
	if (FIXED_BYTES_REGEX.test(type)) return rightPadPackedArrayElement(encoded)
	return leftPadPackedArrayElement(encoded, isNegativePackedSignedInteger(type, value) ? 0xff : 0)
}

const encodePackedArrayValue = (itemType: string, length: number | undefined, value: unknown): Uint8Array => {
	if (!Array.isArray(value)) throw new Error(`Packed array value for ${ itemType } must be an array`)
	if (length !== undefined && value.length !== length) throw new Error(`Packed array value for ${ itemType } must have ${ length } entries`)
	return concatBytes(...value.map((entry) => encodePackedArrayElement(itemType, entry)))
}

const encodePackedValue = (type: string, value: unknown): Uint8Array => {
	const arrayType = splitPackedArrayType(type)
	if (arrayType !== undefined) return encodePackedArrayValue(arrayType.itemType, arrayType.length, value)
	if (type === 'address') return bytesFromHex(ensureHex(getAddress(String(value)), 'address'))
	if (type === 'bool') return value === true ? new Uint8Array([1]) : value === false ? new Uint8Array([0]) : integerToBytes(BigInt(String(value)), 8, false)
	if (type === 'string') return utf8ToBytes(String(value))
	if (type === 'bytes') return bytesFromHex(ensureHex(String(value), 'bytes'))
	const fixedBytesMatch = type.match(FIXED_BYTES_REGEX)
	if (fixedBytesMatch !== null) {
		const size = Number(fixedBytesMatch[1])
		const bytes = bytesFromHex(ensureHex(String(value), type))
		if (bytes.length !== size) throw new Error(`${ type } value must be ${ size } bytes`)
		return bytes
	}
	const integerMatch = type.match(INTEGER_REGEX)
	if (integerMatch !== null) {
		const signed = integerMatch[1] !== 'u'
		const bits = integerMatch[2] === '' ? 256 : Number(integerMatch[2])
		if (!Number.isInteger(bits) || bits <= 0 || bits > 256 || bits % 8 !== 0) throw new Error(`Invalid integer type ${ type }`)
		return integerToBytes(typeof value === 'bigint' ? value : BigInt(String(value)), bits, signed)
	}
	throw new Error(`Packed encoding for ${ type } is not supported`)
}

const integerToBytes = (value: bigint, bits: number, signed: boolean): Uint8Array => {
	const byteLength = bits / 8
	const max = signed ? 2n ** BigInt(bits - 1) - 1n : 2n ** BigInt(bits) - 1n
	const min = signed ? -(2n ** BigInt(bits - 1)) : 0n
	if (value < min || value > max) throw new Error(`Integer value ${ value } is out of range for ${ bits } bits`)
	const encoded = value < 0n ? 2n ** BigInt(bits) + value : value
	const hex = encoded.toString(16).padStart(byteLength * 2, '0')
	return hexToBytes(hex)
}

export const getCreate2Address = ({ from, salt, bytecodeHash }: { readonly from: string, readonly salt: Hex, readonly bytecodeHash: Hex }): Hex => {
	const fromBytes = bytesFromHex(ensureHex(getAddress(from), 'from'))
	const saltBytes = bytesFromHex(ensureHex(salt, 'salt'))
	const bytecodeHashBytes = bytesFromHex(ensureHex(bytecodeHash, 'bytecodeHash'))
	if (saltBytes.length !== 32) throw new Error('CREATE2 salt must be 32 bytes')
	if (bytecodeHashBytes.length !== 32) throw new Error('CREATE2 bytecodeHash must be 32 bytes')
	const hash = keccak256(concatBytes(new Uint8Array([0xff]), fromBytes, saltBytes, bytecodeHashBytes))
	return getAddress(`0x${ stripHexPrefix(hash).slice(24) }`)
}

type ParsedRlpInput = string | ParsedRlpInput[]

const parseRlpInput = (value: unknown): ParsedRlpInput => {
	if (typeof value === 'string') return ensureHex(value, 'RLP value')
	if (Array.isArray(value)) return value.map(parseRlpInput)
	throw new Error('RLP value must be a hex string or array of RLP values')
}

export function toRlp(value: unknown, to?: 'hex'): Hex
export function toRlp(value: unknown, to: 'bytes'): Uint8Array
export function toRlp(value: unknown, to: 'hex' | 'bytes' = 'hex'): Hex | Uint8Array {
	const encoded = RLP.encode(parseRlpInput(value))
	return to === 'bytes' ? encoded : bytesToHex(encoded)
}

export const namehash = (name: string): Hex => {
	let node: Uint8Array<ArrayBufferLike> = new Uint8Array(32)
	if (name === '') return bytesToHex(node)
	for (const label of name.split('.').reverse()) {
		if (label === '') throw new Error('ENS name contains an empty label')
		node = keccak_256(concatBytes(node, keccak_256(stringToBytes(label))))
	}
	return bytesToHex(node)
}

export const ens_normalize = (name: string) => {
	if (name === '') return ''
	try {
		return normalizeEnsNameWithLocalData(name)
	} catch (error) {
		if (error instanceof Error) throw new Error(`Invalid ENS name: ${ error.message }`)
		throw new Error('Invalid ENS name')
	}
}
