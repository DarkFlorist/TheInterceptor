import { expect, test } from 'bun:test'
import { createAirGapUrDecoder, createAirGapUrEncoder } from '../../app/ts/signing/airgapUr.js'
import { decodeAirGapBytewords, encodeAirGapBytewords } from '../../app/ts/signing/airgapBytewords.js'
import { decodeAirGapCbor, encodeAirGapCbor } from '../../app/ts/signing/airgapCbor.js'
import { urReferenceParts } from './data/urReference.js'

test('matches all twenty official bc-ur encoder vectors, including mixed fountain parts', () => {
	const decoder = createAirGapUrDecoder('bytes')
	let payload: Uint8Array | undefined
	for (const part of urReferenceParts.slice(0, 9)) payload = decoder.receive(part).payload
	if (payload === undefined) throw new Error('Reference fragments did not complete')
	const encoder = createAirGapUrEncoder('bytes', payload, 30)
	for (const [index, part] of urReferenceParts.entries()) expect(encoder.part(index + 1)).toBe(part)
	expect(() => decoder.receive(encoder.part(1))).toThrow('closed')
})

test('decodes reference fragments reordered, duplicated and with missing pure fragments', () => {
	const decoder = createAirGapUrDecoder('bytes')
	let payload: Uint8Array | undefined
	for (const index of [19, 19, 17, 15, 13, 11, 9, 7, 5, 3, 1, 0, 2, 4, 6, 8]) {
		const part = urReferenceParts[index]
		if (part === undefined) throw new Error('Missing fixture')
		payload = decoder.receive(part).payload
		if (payload !== undefined) break
	}
	if (payload === undefined) throw new Error('Mixed parts did not complete')
	expect(createAirGapUrEncoder('bytes', payload, 30).part(1)).toBe(urReferenceParts[0])
})

test('recovers large payloads using only mixed fountain parts', () => {
	const payload = Uint8Array.from({ length: 32767 }, (_, index) => index % 251)
	const encoder = createAirGapUrEncoder('eth-sign-request', payload, 256)
	const decoder = createAirGapUrDecoder('eth-sign-request')
	let decoded: Uint8Array | undefined
	for (let sequence = encoder.count + 1; sequence < encoder.count + 1000; sequence += 1) {
		decoded = decoder.receive(encoder.part(sequence)).payload
		if (decoded !== undefined) break
	}
	expect(decoded).toEqual(payload)
})

test('rejects oversized input, mismatched metadata, malformed fragments and wrong registry types', () => {
	for (const input of ['x'.repeat(140000), 'ur:bytes/0-2/aaaa', 'ur:crypto-hdkey/aaaa', 'ur:bytes/1-2/aaaa', 'ur:bytes/ſſſſ']) expect(() => createAirGapUrDecoder('bytes').receive(input)).toThrow()
	const first = urReferenceParts[0]
	if (first === undefined) throw new Error('Missing fixture')
	const decoder = createAirGapUrDecoder('bytes')
	decoder.receive(first)
	expect(() => decoder.receive(createAirGapUrEncoder('bytes', new Uint8Array(300), 30).part(2))).toThrow('different payload')
	const data = first.split('/')[2]
	if (data === undefined) throw new Error('Missing fixture body')
	const fields = decodeAirGapCbor(decodeAirGapBytewords(data))
	if (!Array.isArray(fields)) throw new Error('Invalid fixture')
	const bad = encodeAirGapBytewords(encodeAirGapCbor([fields[0], 513n, fields[2], fields[3], fields[4]]))
	expect(() => createAirGapUrDecoder('bytes').receive(`ur:bytes/1-513/${ bad }`)).toThrow('limits')
})

test('supports single-part uppercase QR text', () => {
	const bytes = encodeAirGapCbor(new Map([[1n, 42n]]))
	const encoder = createAirGapUrEncoder('eth-signature', bytes)
	expect(createAirGapUrDecoder('eth-signature').receive(encoder.part(1).toUpperCase()).payload).toEqual(bytes)
})
