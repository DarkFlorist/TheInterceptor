import { expect, test } from 'bun:test'
import { secp256k1 } from '@noble/curves/secp256k1'
import { bytesFromHex, bytesToHex, type Hex } from '../../app/ts/utils/ethereumBytes.js'
import { privateKeyToAccount } from '../../app/ts/utils/ethereumSigning.js'
import { decodeAirGapCbor, encodeAirGapCbor, type AirGapCbor } from '../../app/ts/signing/airgapCbor.js'
import { encodeAirGapSigningRequest, importAirGapAccounts, verifyAirGapSigningResponse } from '../../app/ts/signing/airgapEthereum.js'
import { preparePersonalSigningPayload, prepareTypedDataSigningPayload } from '../../app/ts/signing/exactPayload.js'
import { eip712Example } from './data/eip712Data.js'

const privateKey: Hex = '0x0000000000000000000000000000000000000000000000000000000000000001'
const signer = privateKeyToAccount(privateKey)
const key = secp256k1.getPublicKey(bytesFromHex(privateKey), true)
const uuid = '12345678-1234-4234-8234-123456789012'
const uuidBytes = bytesFromHex('0x12345678123442348234123456789012')
const origin = new Map<bigint, AirGapCbor>([[1n, [44n, true, 60n, true, 0n, true, 0n, false, 0n, false]], [2n, 0x11223344n]])
const hdkey = new Map<bigint, AirGapCbor>([[3n, key], [6n, { tag: 304n, value: origin }]])

function imported() {
	const account = importAirGapAccounts('crypto-hdkey', encodeAirGapCbor(hdkey))[0]
	if (account === undefined) throw new Error('Missing imported account')
	return account
}

test('imports concrete public accounts from crypto-hdkey and crypto-account without claiming signing authority', () => {
	const account = imported()
	expect(account.address).toBe(signer.address)
	expect(account.derivationPath).toBe('m/44\'/60\'/0\'/0/0')
	expect(account.sourceFingerprint).toBe(0x11223344)
	const exported = new Map<bigint, AirGapCbor>([[1n, 0x11223344n], [2n, [{ tag: 303n, value: hdkey }]]])
	expect(importAirGapAccounts('crypto-account', encodeAirGapCbor(exported))).toEqual([account])
})

test('rejects private keys, master keys, wrong curves, wrong coin paths and inconsistent fingerprints', () => {
	for (const [field, value] of [[1n, true], [2n, true], [3n, new Uint8Array(33)], [7n, { tag: 304n, value: new Map() }]] satisfies readonly (readonly [bigint, AirGapCbor])[]) {
		const invalid = new Map(hdkey)
		invalid.set(field, value)
		expect(() => importAirGapAccounts('crypto-hdkey', encodeAirGapCbor(invalid))).toThrow()
	}
	const wrongPath = new Map(hdkey)
	wrongPath.set(6n, { tag: 304n, value: new Map<bigint, AirGapCbor>([[1n, [44n, true, 0n, true, 0n, true]], [2n, 0x11223344n]]) })
	expect(() => importAirGapAccounts('crypto-hdkey', encodeAirGapCbor(wrongPath))).toThrow('Ethereum')
	expect(() => importAirGapAccounts('crypto-account', encodeAirGapCbor(new Map<bigint, AirGapCbor>([[1n, 1n], [2n, [{ tag: 303n, value: hdkey }]]])))).toThrow('fingerprint')
})

test('encodes the ERC-4527 personal-message registry field numbers, UUID and derivation tag exactly', () => {
	const payload = preparePersonalSigningPayload('0x010203', signer.address)
	const encoded = encodeAirGapSigningRequest(imported(), payload, 1n, uuid)
	expect(bytesToHex(encoded)).toBe(`0xa701d825501234567812344234823412345678901202430102030303040105d90130a2018a182cf5183cf500f500f400f4021a112233440654${ signer.address.slice(2).toLowerCase() }076b496e746572636570746f72`)
})

test('encodes full typed-data JSON and verifies returned signatures independently', async () => {
	const payload = prepareTypedDataSigningPayload(eip712Example, signer.address, 1n)
	const fields = decodeAirGapCbor(encodeAirGapSigningRequest(imported(), payload, 1n, uuid))
	if (!(fields instanceof Map)) throw new Error('Expected request map')
	expect(fields.get(3n)).toBe(2n)
	expect(fields.get(2n)).toEqual(new TextEncoder().encode(eip712Example))
	const signed = await signer.signTypedData(JSON.parse(eip712Example))
	const response = encodeAirGapCbor(new Map<bigint, AirGapCbor>([[1n, { tag: 37n, value: uuidBytes }], [2n, bytesFromHex(signed)]]))
	expect(await verifyAirGapSigningResponse(response, uuid, payload)).toBe(signed)
	await expect(verifyAirGapSigningResponse(response, '12345678-1234-4234-8234-123456789013', payload)).rejects.toThrow('another request')
	const changed = prepareTypedDataSigningPayload(eip712Example.replace('Hello, Bob!', 'Changed message'), signer.address, 1n)
	await expect(verifyAirGapSigningResponse(response, uuid, changed)).rejects.toThrow('expected account')
})

test('rejects request-account mismatches and tampered payloads before producing QR data', () => {
	const payload = preparePersonalSigningPayload('0x00ff', signer.address)
	expect(() => encodeAirGapSigningRequest({ ...imported(), address: '0x0000000000000000000000000000000000000002' }, payload, 1n, uuid)).toThrow('account')
	expect(() => encodeAirGapSigningRequest(imported(), { ...payload, message: '0x00fe' }, 1n, uuid)).toThrow('changed')
	expect(() => encodeAirGapSigningRequest(imported(), payload, 1n, 'not-a-uuid')).toThrow('UUID')
})
