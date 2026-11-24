import { concatBytes } from '@noble/hashes/utils'
import { bytesFromHex, ensureHex } from '../utils/ethereumBytes.js'
import { isRecord } from '../utils/runtimeTypeGuards.js'
import { parseDirectSigningTypedData } from './exactPayload.js'
import { encodeLedgerDerivationPath } from './ledgerFraming.js'

export type LedgerCommand = Readonly<{ instruction: number, p1: number, p2: number, data: Uint8Array }>

function identifier(value: string) {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) || value.length > 255) throw new Error('Unsupported Ledger typed-data identifier')
	return new TextEncoder().encode(value)
}

function sized(value: Uint8Array) {
	if (value.length > 255) throw new Error('Ledger field exceeds one-byte length')
	return concatBytes(Uint8Array.of(value.length), value)
}

function describeType(type: string, customTypes: ReadonlySet<string>) {
	const base = type.split('[')[0]
	if (base === undefined) throw new Error('Missing Ledger field type')
	const arrays = [...type.matchAll(/\[([0-9]*)\]/gu)].map((match) => match[1] === '' ? undefined : Number(match[1]))
	if (arrays.length > 16 || arrays.some((length) => length !== undefined && (!Number.isInteger(length) || length < 1 || length > 255))) throw new Error('Ledger supports array dimensions of at most 255 items')
	const integer = /^(u?int)([0-9]+)$/u.exec(base)
	const fixedBytes = /^bytes([0-9]+)$/u.exec(base)
	let kind: number
	let size: number | undefined
	if (customTypes.has(base)) kind = 0
	else if (integer) {
		kind = integer[1] === 'int' ? 1 : 2
		size = Number(integer[2]) / 8
		if (!Number.isInteger(size) || size < 1 || size > 32) throw new Error('Invalid Ledger integer width')
	} else if (fixedBytes) {
		kind = 6
		size = Number(fixedBytes[1])
		if (!Number.isInteger(size) || size < 1 || size > 32) throw new Error('Invalid Ledger bytes width')
	} else {
		switch (base) {
			case 'address': kind = 3; break
			case 'bool': kind = 4; break
			case 'string': kind = 5; break
			case 'bytes': kind = 7; break
			default: throw new Error(`Unsupported Ledger typed-data type ${ base }`)
		}
	}
	const descriptor = concatBytes(
		Uint8Array.of(kind | (size === undefined ? 0 : 0x40) | (arrays.length === 0 ? 0 : 0x80)),
		kind === 0 ? sized(identifier(base)) : new Uint8Array(),
		size === undefined ? new Uint8Array() : Uint8Array.of(size),
		arrays.length === 0 ? new Uint8Array() : Uint8Array.from([arrays.length, ...arrays.flatMap((length) => length === undefined ? [0] : [1, length])]),
	)
	return { base, arrays, kind, size, descriptor }
}

/** Compile the entire stream before contacting a device; never fall back to the hash-only protocol. */
export function compileLedgerTypedData(json: string, derivationPath: string): readonly LedgerCommand[] {
	const parsed = parseDirectSigningTypedData(json)
	const types = new Set(Object.keys(parsed.types))
	const commands: LedgerCommand[] = []
	let bytes = 0
	const add = (instruction: number, p1: number, p2: number, data: Uint8Array) => {
		bytes += data.length
		if (data.length > 255 || bytes > 131072 || commands.length >= 4096) throw new Error('Ledger typed-data stream exceeds limits')
		commands.push({ instruction, p1, p2, data })
	}
	for (const [name, fields] of Object.entries(parsed.types)) {
		if (fields === undefined) throw new Error('Missing Ledger type definition')
		add(0x1a, 0, 0, identifier(name))
		for (const field of fields) add(0x1a, 0, 0xff, concatBytes(describeType(field.type, types).descriptor, sized(identifier(field.name))))
	}
	const sendValue = (value: Uint8Array) => {
		if (value.length > 65535) throw new Error('Ledger typed-data value exceeds limit')
		const length = new Uint8Array(2)
		new DataView(length.buffer).setUint16(0, value.length)
		const encoded = concatBytes(length, value)
		for (let offset = 0; offset < encoded.length; offset += 255) add(0x1c, offset + 255 < encoded.length ? 1 : 0, 0xff, encoded.slice(offset, offset + 255))
	}
	const visit = (type: string, value: unknown, depth: number): void => {
		if (depth > 16) throw new Error('Ledger typed-data nesting exceeds limit')
		const array = /^(.*)\[([0-9]*)\]$/u.exec(type)
		if (array) {
			const inner = array[1]
			if (inner === undefined || !Array.isArray(value) || value.length > 255) throw new Error('Unsupported Ledger array value')
			if (array[2] !== '' && value.length !== Number(array[2])) throw new Error('Ledger fixed array size mismatch')
			add(0x1c, 0, 0x0f, Uint8Array.of(value.length))
			for (const item of value) visit(inner, item, depth + 1)
			return
		}
		const description = describeType(type, types)
		if (description.kind === 0) {
			if (!isRecord(value)) throw new Error('Invalid Ledger struct value')
			const fields = parsed.types[type]
			if (fields === undefined) throw new Error('Unknown Ledger struct')
			for (const field of fields) visit(field.type, value[field.name], depth + 1)
			return
		}
		if (description.kind === 4) {
			if (typeof value !== 'boolean') throw new Error('Invalid Ledger boolean')
			return sendValue(Uint8Array.of(value ? 1 : 0))
		}
		if (description.kind === 1 || description.kind === 2) {
			if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isSafeInteger(value))) throw new Error('Invalid Ledger integer')
			const integer = BigInt(value)
			const width = (description.size ?? 32) * 8
			const signed = description.kind === 1
			const lower = signed ? -(1n << BigInt(width - 1)) : 0n
			const upper = 1n << BigInt(signed ? width - 1 : width)
			if (integer < lower || integer >= upper) throw new Error('Ledger integer out of range')
			let hex = (integer < 0n ? (1n << BigInt(width)) + integer : integer).toString(16)
			if (hex.length % 2 !== 0) hex = `0${ hex }`
			return sendValue(bytesFromHex(ensureHex(`0x${ hex }`)))
		}
		if (typeof value !== 'string') throw new Error('Invalid Ledger byte or string value')
		if (description.kind === 5) return sendValue(new TextEncoder().encode(value))
		const raw = bytesFromHex(ensureHex(value))
		if ((description.kind === 3 && raw.length !== 20) || (description.kind === 6 && raw.length !== description.size)) throw new Error('Invalid Ledger fixed byte length')
		sendValue(raw)
	}
	add(0x1c, 0, 0, identifier('EIP712Domain'))
	visit('EIP712Domain', parsed.domain, 0)
	add(0x1c, 0, 0, identifier(parsed.primaryType))
	visit(parsed.primaryType, parsed.message, 0)
	add(0x0c, 0, 1, encodeLedgerDerivationPath(derivationPath))
	return commands
}
