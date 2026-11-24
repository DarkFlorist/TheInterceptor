import { describe, expect, test } from 'bun:test'
import { sign } from 'micro-eth-signer/utils.js'
import { decodeAirGapCbor, encodeAirGapCbor, type AirGapCbor } from '../../app/ts/signing/airgapCbor.js'
import { airGapCrc32, decodeAirGapBytewords, encodeAirGapBytewords } from '../../app/ts/signing/airgapBytewords.js'
import { createLedgerResponseDecoder, encodeLedgerDerivationPath, frameLedgerApdu } from '../../app/ts/signing/ledgerFraming.js'
import { assembleSignedTransaction, preparePersonalSigningPayload, prepareTransactionSigningPayload, verifyPersonalSigningResponse, verifySignedTransaction } from '../../app/ts/signing/exactPayload.js'
import { bytesFromHex, bytesToHex, ensureHex, type Hex } from '../../app/ts/utils/ethereumBytes.js'
import { hashMessage, privateKeyToAccount } from '../../app/ts/utils/ethereumSigning.js'
import { serializeTransaction } from '../../app/ts/utils/ethereumTransactions.js'

describe('Ledger HID framing', () => {
	test('matches the Ledger channel, tag, sequence and length wire layout', () => {
		const packets = frameLedgerApdu(0x1234, bytesFromHex('0xe006000000'))
		expect(bytesToHex(packets[0]?.subarray(0, 12) ?? new Uint8Array())).toBe('0x12340500000005e006000000')
	})
	for (const size of [2, 57, 58, 116, 117, 65535]) {
		test(`reassembles ${ size } bytes with bounded padding`, () => {
			const data = Uint8Array.from({ length: size }, (_, index) => index % 256)
			const decode = createLedgerResponseDecoder(1)
			let result: Uint8Array | undefined
			for (const packet of frameLedgerApdu(1, data)) result = decode(packet)
			expect(result).toEqual(data)
			expect(() => decode(new Uint8Array(64))).toThrow('closed')
		})
	}
	for (const offset of [0, 2, 3, 5]) {
		test(`rejects malformed header at ${ offset } and invalidates the decoder`, () => {
			const packet = frameLedgerApdu(1, new Uint8Array(2))[0]
			if (packet === undefined) throw new Error('Missing test packet')
			packet[offset] = 255
			const decode = createLedgerResponseDecoder(1, 100)
			expect(() => decode(packet)).toThrow()
			expect(() => decode(packet)).toThrow('closed')
		})
	}
	test('rejects duplicate, reordered and truncated packets', () => {
		const packets = frameLedgerApdu(1, new Uint8Array(200))
		const first = packets[0]
		const second = packets[1]
		if (first === undefined || second === undefined) throw new Error('Missing test packets')
		const decode = createLedgerResponseDecoder(1)
		decode(first)
		expect(() => decode(first)).toThrow('sequence')
		expect(() => createLedgerResponseDecoder(1)(second)).toThrow('sequence')
		expect(() => createLedgerResponseDecoder(1)(first.subarray(1))).toThrow('length')
		const container = new Uint8Array(70)
		container.set(first, 3)
		expect(createLedgerResponseDecoder(1)(container.subarray(3, 67))).toBeUndefined()
	})
	test('encodes exact BIP-32 paths and rejects ambiguous or oversized paths', () => {
		expect(bytesToHex(encodeLedgerDerivationPath('m/44\'/60\'/0\'/0/0'))).toBe('0x058000002c8000003c800000000000000000000000')
		for (const path of ['m', 'm/01', 'm/-1', 'm/2147483648', 'm/1h', 'm/*', 'm/1/2/3/4/5/6/7/8/9/10/11']) expect(() => encodeLedgerDerivationPath(path)).toThrow()
		expect(() => frameLedgerApdu(-1, new Uint8Array(2))).toThrow()
		expect(() => frameLedgerApdu(1, new Uint8Array(65536))).toThrow()
	})
})

describe('AirGap binary primitives', () => {
	const referenceBytes = bytesFromHex('0xd99d6ca20150c7098580125e2ab0981253468b2dbc5202c11947da')
	const referenceWords = 'tantjzoeadgdstaslplabghydrpfmkbggufgludprfgmaosecffltnsoaawkbd'
	test('matches the published BCR-2020-012 Bytewords and CRC32 vector', () => {
		expect(airGapCrc32(referenceBytes)).toBe(0xc904f40b)
		expect(encodeAirGapBytewords(referenceBytes)).toBe(referenceWords)
		expect(decodeAirGapBytewords(referenceWords.toUpperCase())).toEqual(referenceBytes)
		expect(encodeAirGapCbor(decodeAirGapCbor(referenceBytes))).toEqual(referenceBytes)
	})
	test('all alphabet values roundtrip and checksum corruption is rejected', () => {
		const bytes = Uint8Array.from({ length: 256 }, (_, index) => index)
		expect(decodeAirGapBytewords(encodeAirGapBytewords(bytes))).toEqual(bytes)
		for (const input of [referenceWords.slice(2), `ae${ referenceWords.slice(2) }`, `${ referenceWords }a`, 'zzzzzzzzzz', 'a'.repeat(140000)]) expect(() => decodeAirGapBytewords(input)).toThrow()
	})
		test('roundtrips the supported registry CBOR subset', () => {
		const value = new Map<bigint, AirGapCbor>([
			[1n, { tag: 37n, value: new Uint8Array(16) }],
			[2n, [0n, 23n, 24n, 255n, 256n, 65535n, 65536n, 0xffffffffn, 1n << 63n, -1n, true, false, 'Ethereum']]
		])
		expect(decodeAirGapCbor(encodeAirGapCbor(value))).toEqual(value)
		expect(decodeAirGapCbor(encodeAirGapCbor('\ufeffEthereum'))).toBe('\ufeffEthereum')
		expect(() => encodeAirGapCbor('\ud800')).toThrow('surrogate')
	})
	test('rejects duplicate keys, unsupported types, excessive work and trailing bytes', () => {
		for (const hex of ['0xa201000101', '0x9f00ff', '0xf6', '0xf93c00', '0x61ff', '0x0000', '0x5affffffff', '0x9a00010000', '0xa1616100', '0x81']) expect(() => decodeAirGapCbor(bytesFromHex(ensureHex(hex)))).toThrow()
		expect(() => decodeAirGapCbor(new Uint8Array(65537))).toThrow()
		expect(() => decodeAirGapCbor(Uint8Array.from([...new Uint8Array(20).fill(0x81), 0]))).toThrow('complexity')
		expect(() => encodeAirGapCbor(1n << 64n)).toThrow()
		expect(() => encodeAirGapCbor(new Uint8Array(65536))).toThrow()
		expect(() => encodeAirGapCbor(Array.from({ length: 4096 }, () => 0n))).toThrow()
	})
})

describe('independent exact-payload signature verification', () => {
	const privateKey: Hex = '0x0000000000000000000000000000000000000000000000000000000000000001'
	const account = privateKeyToAccount(privateKey)
	const other = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000002')
	const transaction = { chainId: 1n, nonce: 3n, gas: 100000n, maxFeePerGas: 20n, maxPriorityFeePerGas: 1n, to: other.address, value: 42n }
	const signHash = (digest: Hex): Hex => {
		const signature = sign(bytesFromHex(digest), bytesFromHex(privateKey), false)
		return ensureHex(`0x${ signature.toHex('compact') }${ signature.recovery === 0 ? '1b' : '1c' }`)
	}
	test('verifies exact personal-sign bytes including non-UTF8 and zero bytes', async () => {
		const payload = preparePersonalSigningPayload('0x00ff80c3a9', account.address)
		const signature = await account.signMessage({ message: { raw: payload.message } })
		expect(await verifyPersonalSigningResponse(payload, signature)).toBe(signature)
		expect(payload.digest).not.toBe(hashMessage('0x00ff80c3a9'))
		await expect(verifyPersonalSigningResponse(preparePersonalSigningPayload('0x00ff80c3a900', account.address), signature)).rejects.toThrow()
		await expect(verifyPersonalSigningResponse(preparePersonalSigningPayload(payload.message, other.address), signature)).rejects.toThrow()
		await expect(verifyPersonalSigningResponse(payload, `${ signature.slice(0, -2) }02`)).rejects.toThrow('recovery')
		expect(Object.isFrozen(payload)).toBe(true)
	})
	test('assembles signed transactions and checks every unsigned field', async () => {
		const payload = prepareTransactionSigningPayload(serializeTransaction(transaction), account.address, 1n)
		const signed = await assembleSignedTransaction(payload, signHash(payload.digest))
		expect(verifySignedTransaction(payload, signed)).toBe(signed)
		for (const change of [{ nonce: 4n }, { gas: 110000n }, { chainId: 2n }, { value: 43n }, { to: account.address }, { maxFeePerGas: 21n }, { maxPriorityFeePerGas: 2n }, { data: ensureHex('0x00') }, { accessList: [{ address: account.address, storageKeys: [] }] }]) {
			const changed = { ...transaction, ...change }
			const next = prepareTransactionSigningPayload(serializeTransaction(changed), account.address, changed.chainId)
			expect(() => verifySignedTransaction(next, signed)).toThrow('fields differ')
		}
		await expect(assembleSignedTransaction({ ...payload, expectedAddress: other.address }, signHash(payload.digest))).rejects.toThrow('expected account')
		expect(() => prepareTransactionSigningPayload(signed, account.address, 1n)).toThrow('unsigned')
		expect(() => prepareTransactionSigningPayload(payload.unsignedTransaction, account.address, 2n)).toThrow('chain')
	})
	test('rejects a tampered stored digest and malformed signature', async () => {
		const payload = preparePersonalSigningPayload('0x', account.address)
		await expect(verifyPersonalSigningResponse({ ...payload, digest: hashMessage('different') }, signHash(payload.digest))).rejects.toThrow('digest')
		await expect(verifyPersonalSigningResponse(payload, '0x')).rejects.toThrow('65-byte')
		await expect(verifyPersonalSigningResponse(payload, `0x${ '00'.repeat(64) }1b`)).rejects.toThrow('noncanonical')
	})
})
