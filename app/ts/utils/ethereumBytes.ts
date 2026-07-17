import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex as nobleBytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { addr } from 'micro-eth-signer'

export type Hex = `0x${ string }`

const HEX_REGEX = /^0x[0-9a-fA-F]*$/u

export const ensureHex = (value: string, name = 'hex'): Hex => {
	if (!HEX_REGEX.test(value)) throw new Error(`${ name } must be a 0x-prefixed hex string`)
	if (value.length % 2 !== 0) throw new Error(`${ name } must have an even number of hex digits`)
	return value as Hex
}

export const stripHexPrefix = (value: Hex) => value.slice(2)

export const bytesFromHex = (value: Hex) => hexToBytes(stripHexPrefix(value))

export const bytesFromHexOrBytes = (value: Hex | Uint8Array): Uint8Array => value instanceof Uint8Array ? value : bytesFromHex(ensureHex(value))

const isHex = (value: Hex | Uint8Array): value is Hex => typeof value === 'string'

export function concat(values: readonly Hex[]): Hex
export function concat(values: readonly (Hex | Uint8Array)[]): Hex | Uint8Array
export function concat(values: readonly (Hex | Uint8Array)[]): Hex | Uint8Array {
	if (values.every(isHex)) {
		return `0x${ values.map((value) => stripHexPrefix(ensureHex(value))).join('') }`
	}
	if (values.some(isHex)) throw new Error('Cannot concat hex strings and byte arrays')
	return concatBytes(...values.map((value) => bytesFromHexOrBytes(value)))
}

export const bytesToHex = (bytes: Uint8Array): Hex => `0x${ nobleBytesToHex(bytes) }`

export const stringToBytes = (value: string): Uint8Array => utf8ToBytes(value)

export const keccak256 = (value: Hex | Uint8Array): Hex => bytesToHex(keccak_256(bytesFromHexOrBytes(value)))

export const getAddress = (address: string): Hex => {
	if (!addr.isValid(address)) throw new Error(`Address "${ address }" is invalid`)
	return ensureHex(addr.addChecksum(address), 'checksummed address')
}

export const isAddress = (address: string): boolean => addr.isValid(address)
