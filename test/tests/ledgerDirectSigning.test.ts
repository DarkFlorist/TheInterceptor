import { describe, expect, spyOn, test } from 'bun:test'
import { secp256k1 } from '@noble/curves/secp256k1'
import { sign } from 'micro-eth-signer/utils.js'
import { concatBytes } from '@noble/hashes/utils'
import { bytesFromHex, bytesToHex, ensureHex, type Hex } from '../../app/ts/utils/ethereumBytes.js'
import { privateKeyToAccount } from '../../app/ts/utils/ethereumSigning.js'
import { serializeTransaction } from '../../app/ts/utils/ethereumTransactions.js'
import { parseDirectSigningTypedData, preparePersonalSigningPayload, prepareTransactionSigningPayload, prepareTypedDataSigningPayload, verifyTypedDataSigningResponse } from '../../app/ts/signing/exactPayload.js'
import { compileLedgerTypedData, type LedgerCommand } from '../../app/ts/signing/ledgerTypedData.js'
import { encodeLedgerCommand, runLedgerHidSession, type LedgerHid, type LedgerHidDevice } from '../../app/ts/signing/ledgerHid.js'
import { createLedgerResponseDecoder, frameLedgerApdu } from '../../app/ts/signing/ledgerFraming.js'
import { readLedgerAccount, signWithLedger } from '../../app/ts/signing/ledgerEthereum.js'
import { eip712Example } from './data/eip712Data.js'

const key: Hex = '0x0000000000000000000000000000000000000000000000000000000000000001'
const account = privateKeyToAccount(key)
const path = 'm/44\'/60\'/0\'/0/0'
const publicKey = secp256k1.getPublicKey(bytesFromHex(key), false)
const savedAccount = { address: account.address, publicKey: bytesToHex(publicKey), derivationPath: path }
const publicAccountResponse = concatBytes(Uint8Array.of(65), publicKey, Uint8Array.of(40), new TextEncoder().encode(account.address.slice(2)))
const config: LedgerCommand = { instruction: 6, p1: 0, p2: 0, data: new Uint8Array() }

function signature(digest: Hex) {
	const value = sign(bytesFromHex(digest), bytesFromHex(key), false)
	const v = value.recovery === 0 ? 27 : 28
	return { ledger: concatBytes(Uint8Array.of(v), value.toBytes('compact')), ethereum: bytesToHex(concatBytes(value.toBytes('compact'), Uint8Array.of(v))) }
}

function fakeHid(reply: (apdu: Uint8Array) => Uint8Array | undefined) {
	const decoders = new Map<number, ReturnType<typeof createLedgerResponseDecoder>>()
	let closes = 0
	let opens = 0
	const sentPackets: Uint8Array[] = []
	const device: LedgerHidDevice = Object.assign(new EventTarget(), {
		vendorId: 0x2c97, productId: 1, productName: 'Test Ledger', opened: false, collections: [{ usagePage: 0xffa0 }],
		open: async () => { opens += 1 }, close: async () => { closes += 1 },
		sendReport: async (_reportId: number, data: Uint8Array<ArrayBuffer>) => {
			sentPackets.push(data.slice())
			const channel = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(0)
			const decode = decoders.get(channel) ?? createLedgerResponseDecoder(channel)
			decoders.set(channel, decode)
			const request = decode(data)
			if (request === undefined) return
			decoders.delete(channel)
			const response = reply(request)
			if (response === undefined) return
			for (const packet of frameLedgerApdu(channel, response)) device.dispatchEvent(Object.assign(new Event('inputreport'), { reportId: 0, data: new DataView(packet.slice().buffer) }))
		},
	})
	const hid: LedgerHid = Object.assign(new EventTarget(), { requestDevice: async () => [device], getDevices: async () => [device] })
	return { hid, device, sentPackets, counts: () => ({ opens, closes }), disconnect: () => hid.dispatchEvent(Object.assign(new Event('disconnect'), { device })) }
}

describe('typed-data exact payload', () => {
	test('matches the official EIP-712 Mail digest and verifies signatures', async () => {
		const payload = prepareTypedDataSigningPayload(eip712Example, account.address, 1n)
		expect(payload.digest).toBe('0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2')
		expect(await verifyTypedDataSigningResponse(payload, signature(payload.digest).ethereum)).toBe(signature(payload.digest).ethereum)
		const changed = prepareTypedDataSigningPayload(eip712Example.replace('Hello, Bob!', 'Hello, Alice!'), account.address, 1n)
		await expect(verifyTypedDataSigningResponse(changed, signature(payload.digest).ethereum)).rejects.toThrow('expected account')
		await expect(verifyTypedDataSigningResponse({ ...payload, domainChainId: 2n }, signature(payload.digest).ethereum)).rejects.toThrow('domain')
		expect(() => prepareTypedDataSigningPayload(eip712Example, account.address, 2n)).toThrow('chain')
		expect(Object.isFrozen(payload)).toBe(true)
	})
	test('rejects duplicate keys, oversized and deeply nested input before recursive validation', () => {
		expect(() => parseDirectSigningTypedData(eip712Example.replace('"chainId":1', '"chainId":1,"chainId":1'))).toThrow('Duplicate')
		expect(() => parseDirectSigningTypedData(eip712Example.replace('"chainId":1', '"chainId":1,"chain\\u0049d":1'))).toThrow('Duplicate')
		expect(() => parseDirectSigningTypedData('['.repeat(17) + ']'.repeat(17))).toThrow('nesting')
		expect(() => parseDirectSigningTypedData(' '.repeat(65537))).toThrow('size')
	})
})

describe('Ledger full EIP-712 compiler', () => {
	test('encodes documented type descriptors and finishes with V1, never a hash-only command', () => {
		const commands = compileLedgerTypedData(eip712Example, path)
		expect(commands.some((command) => command.instruction === 0x1a && bytesToHex(command.data) === '0x422007636861696e4964')).toBe(true)
		expect(commands.some((command) => command.instruction === 0x1a && bytesToHex(command.data) === '0x0006506572736f6e0466726f6d')).toBe(true)
		const last = commands[commands.length - 1]
		if (last === undefined) throw new Error('Missing signing command')
		expect(bytesToHex(encodeLedgerCommand(last))).toBe('0xe00c000115058000002c8000003c800000000000000000000000')
		expect(commands.filter((command) => command.instruction === 0x0c)).toHaveLength(1)
	})
	test('streams long fields in protocol-sized chunks with one total-length prefix', () => {
		const text = 'x'.repeat(600)
		const commands = compileLedgerTypedData(eip712Example.replace('Hello, Bob!', text), path)
		const parts = commands.slice(-4, -1)
		expect(parts.map((command) => command.p1)).toEqual([1, 1, 0])
		expect(parts.map((command) => command.data.length)).toEqual([255, 255, 92])
		expect(bytesToHex(concatBytes(...parts.map((command) => command.data)))).toBe(bytesToHex(concatBytes(Uint8Array.of(2, 88), new TextEncoder().encode(text))))
	})
	test('retains numeric suffixes in custom struct names', () => {
		const commands = compileLedgerTypedData(eip712Example.replaceAll('Person', 'Person2'), path)
		expect(commands.some((command) => bytesToHex(command.data) === '0x0007506572736f6e320466726f6d')).toBe(true)
	})
})

describe('Ledger session lifecycle', () => {
	test('handles native-shaped HID events and closes a successful session', async () => {
		const fixture = fakeHid(() => Uint8Array.of(0, 1, 9, 19, 0x90, 0))
		expect(await runLedgerHidSession(fixture.hid, fixture.device, new AbortController().signal, async (exchange) => await exchange(config))).toEqual(Uint8Array.of(0, 1, 9, 19))
		expect(fixture.counts()).toEqual({ opens: 1, closes: 1 })
	})
	test('cancellation closes and prevents reuse until physical disconnection', async () => {
		const fixture = fakeHid(() => undefined)
		const abort = new AbortController()
		await expect(runLedgerHidSession(fixture.hid, fixture.device, abort.signal, async (exchange) => {
			const pending = exchange(config)
			abort.abort(new Error('Cancelled test'))
			return await pending
		})).rejects.toThrow('Cancelled test')
		expect(fixture.counts().closes).toBe(1)
		await expect(runLedgerHidSession(fixture.hid, fixture.device, new AbortController().signal, async () => true)).rejects.toThrow('Disconnect and reconnect')
		fixture.disconnect()
		expect(await runLedgerHidSession(fixture.hid, fixture.device, new AbortController().signal, async () => true)).toBe(true)
	})
	test('timeout and concurrent exchanges fail instead of reusing a pending channel', async () => {
		const fixture = fakeHid(() => undefined)
		await expect(runLedgerHidSession(fixture.hid, fixture.device, new AbortController().signal, async (exchange) => await exchange(config), 10)).rejects.toThrow('timed out')
		const concurrent = fakeHid(() => undefined)
		await expect(runLedgerHidSession(concurrent.hid, concurrent.device, new AbortController().signal, async (exchange) => await Promise.all([exchange(config), exchange(config)]))).rejects.toThrow('serialized')
	})
	test('explicit device rejection permits a new session without changing account or mode', async () => {
		const fixture = fakeHid(() => Uint8Array.of(0x69, 0x85))
		await expect(runLedgerHidSession(fixture.hid, fixture.device, new AbortController().signal, async (exchange) => await exchange(config))).rejects.toThrow('rejected')
		expect(await runLedgerHidSession(fixture.hid, fixture.device, new AbortController().signal, async () => true)).toBe(true)
	})
	test('physical disconnection rejects the pending exchange and permits a new connection', async () => {
		const fixture = fakeHid(() => undefined)
		await expect(runLedgerHidSession(fixture.hid, fixture.device, new AbortController().signal, async (exchange) => {
			const pending = exchange(config)
			fixture.disconnect()
			return await pending
		})).rejects.toThrow('disconnected')
		expect(await runLedgerHidSession(fixture.hid, fixture.device, new AbortController().signal, async () => true)).toBe(true)
	})
	test('unexpected reports invalidate an exchange instead of being accepted as late replies', async () => {
		const fixture = fakeHid(() => undefined)
		await expect(runLedgerHidSession(fixture.hid, fixture.device, new AbortController().signal, async (exchange) => {
			const pending = exchange(config)
			fixture.device.dispatchEvent(Object.assign(new Event('inputreport'), { reportId: 0, data: new DataView(new ArrayBuffer(63)) }))
			return await pending
		})).rejects.toThrow('packet length')
		expect(fixture.counts().closes).toBe(1)
	})
	test('constant random output cannot reuse a channel and a delayed prior response is rejected', async () => {
		const random = spyOn(crypto, 'getRandomValues').mockReturnValue(new Uint16Array([65535]))
		let requests = 0
		const fixture = fakeHid(() => ++requests === 1 ? Uint8Array.of(0x90, 0) : undefined)
		try {
			await expect(runLedgerHidSession(fixture.hid, fixture.device, new AbortController().signal, async (exchange) => {
				await exchange(config)
				const pending = exchange(config)
				for (const packet of frameLedgerApdu(65535, Uint8Array.of(0x90, 0))) fixture.device.dispatchEvent(Object.assign(new Event('inputreport'), { reportId: 0, data: new DataView(packet.slice().buffer) }))
				return await pending
			})).rejects.toThrow('channel')
			expect(fixture.sentPackets.map((packet) => new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint16(0))).toEqual([65535, 0])
		} finally { random.mockRestore() }
	})
})

describe('Ledger Ethereum adapter', () => {
	test('verifies address against public key and expected binding', async () => {
		expect(await readLedgerAccount(async () => publicAccountResponse, path, true, account.address)).toEqual(savedAccount)
		await expect(readLedgerAccount(async () => publicAccountResponse, path, false, '0x0000000000000000000000000000000000000002')).rejects.toThrow('expected account')
	})
	for (const payload of [preparePersonalSigningPayload('0x00ff80', account.address), prepareTypedDataSigningPayload(eip712Example, account.address, 1n), prepareTransactionSigningPayload(serializeTransaction({ chainId: 1n, nonce: 0n, gas: 21000n, maxFeePerGas: 20n, maxPriorityFeePerGas: 1n, to: account.address, value: 1n }), account.address, 1n)]) {
		test(`verifies ${ payload.method } against the final expected payload`, async () => {
			const result = await signWithLedger(async (command) => {
				if (command.instruction === 6) return Uint8Array.of(0, 1, 9, 19)
				if (command.instruction === 2) return publicAccountResponse
				if ([4, 8, 12].includes(command.instruction)) return signature(payload.digest).ledger
				return new Uint8Array()
			}, savedAccount, payload)
			expect(result.startsWith(payload.method === 'eth_sendTransaction' ? '0x02' : '0x')).toBe(true)
		})
	}
	test('invalid payload digest is rejected before any device exchange', async () => {
		let calls = 0
		const payload = preparePersonalSigningPayload('0x', account.address)
		await expect(signWithLedger(async () => { calls += 1; return new Uint8Array() }, savedAccount, { ...payload, digest: ensureHex('0x00') })).rejects.toThrow('changed')
		expect(calls).toBe(0)
	})
})
