import { expect, test } from 'bun:test'
import encodeQR from 'qr'
import decodeQR from 'qr/decode.js'
import { createAirGapUrEncoder, createAirGapUrDecoder } from '../../app/ts/signing/airgapUr.js'

function scanGeneratedFrame(text: string) {
	const matrix = encodeQR(text, 'raw', { border: 4, ecc: 'medium' })
	const scale = 3
	const size = matrix.length * scale
	const data = new Uint8ClampedArray(size * size * 4)
	for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
		const value = matrix[Math.floor(y / scale)]?.[Math.floor(x / scale)] ? 0 : 255
		const offset = (y * size + x) * 4
		data[offset] = value; data[offset + 1] = value; data[offset + 2] = value; data[offset + 3] = 255
	}
	return decodeQR({ width: size, height: size, data })
}

test('animated UR survives actual QR generation and pixel decoding in reverse order', () => {
	const payload = Uint8Array.from({ length: 1800 }, (_, index) => index % 251)
	const encoder = createAirGapUrEncoder('eth-sign-request', payload, 200)
	const decoder = createAirGapUrDecoder('eth-sign-request')
	let result: Uint8Array | undefined
	for (let sequence = encoder.count; sequence > 0; sequence -= 1) result = decoder.receive(scanGeneratedFrame(encoder.part(sequence).toUpperCase())).payload
	expect(result).toEqual(payload)
})

test('single-frame public account and signature URs remain scanner-compatible', () => {
	for (const type of ['crypto-account', 'crypto-hdkey', 'eth-signature']) {
		const payload = Uint8Array.from({ length: 100 }, (_, index) => index)
		const encoder = createAirGapUrEncoder(type, payload)
		expect(createAirGapUrDecoder(type).receive(scanGeneratedFrame(encoder.part(1).toUpperCase())).payload).toEqual(payload)
	}
})
