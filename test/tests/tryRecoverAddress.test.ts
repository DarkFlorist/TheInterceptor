import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { initSig } from 'micro-eth-signer/utils.js'
import { bytes32String } from '../../app/ts/utils/bigint.js'
import { bytesToHex, hashMessage, privateKeyToAccount, recoverAddress, tryRecoverAddress, type Hex } from '../../app/ts/utils/ethereumPrimitives.js'

const CURVE_ORDER = secp256k1.Point.Fn.ORDER

const account = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
const messageHash = hashMessage('hello')

const toSignatureHex = (r: bigint, s: bigint, yParity: number): Hex => `${ bytes32String(r) }${ bytes32String(s).slice(2) }${ (27 + yParity).toString(16) }`

// With s = 1 and R = hashScalar * G, recovery computes r^-1 * (s * R - hashScalar * G), which is the point at infinity.
const getSignatureRecoveringToInfinity = (hashScalar: bigint, flipParity = false) => {
	const compressedR = secp256k1.Point.BASE.multiply(hashScalar).toBytes(true)
	const r = BigInt(bytesToHex(compressedR.slice(1)))
	assert.ok(r < CURVE_ORDER)
	const yParity = compressedR[0] === 3 ? 1 : 0
	return toSignatureHex(r, 1n, flipParity ? 1 - yParity : yParity)
}

describe('tryRecoverAddress', () => {
	test('shares one secp256k1 implementation with the micro-eth-signer recovery', () => {
		assert.ok(initSig({ r: 1n, s: 1n }, 0) instanceof secp256k1.Signature)
	})

	test('recovers the signer of a valid signature', async () => {
		const signature = await account.signMessage({ message: 'hello' })
		assert.deepEqual(await tryRecoverAddress({ hash: messageHash, signature }), { type: 'recovered', address: account.address })
	})

	test('recovers the same signer from the high-s form of a valid signature', async () => {
		const signature = await account.signMessage({ message: 'hello' })
		const r = BigInt(signature.slice(0, 66))
		const s = BigInt(`0x${ signature.slice(66, 130) }`)
		const yParity = signature.endsWith('1b') ? 0 : 1
		const highS = CURVE_ORDER - s
		assert.ok(highS > CURVE_ORDER / 2n)
		assert.deepEqual(await tryRecoverAddress({ hash: messageHash, signature: toSignatureHex(r, highS, 1 - yParity) }), { type: 'recovered', address: account.address })
	})

	// Each case covers one unrecoverable input.
	test('reports signatures that recover to no address as unrecoverable', async () => {
		const validSignature = await account.signMessage({ message: 'hello' })
		const validR = BigInt(validSignature.slice(0, 66))
		const validS = BigInt(`0x${ validSignature.slice(66, 130) }`)
		const unrecoverableSignatures = {
			'r is zero': toSignatureHex(0n, validS, 0),
			's is zero': toSignatureHex(validR, 0n, 0),
			'r is the curve order': toSignatureHex(CURVE_ORDER, validS, 0),
			's is the curve order': toSignatureHex(validR, CURVE_ORDER, 0),
			'r is not a curve x-coordinate': toSignatureHex(5n, validS, 0),
			'recovery lands on the point at infinity': getSignatureRecoveringToInfinity(BigInt(messageHash) % CURVE_ORDER),
		}
		for (const [name, signature] of Object.entries(unrecoverableSignatures)) {
			assert.deepEqual(await tryRecoverAddress({ hash: messageHash, signature }), { type: 'unrecoverable' }, name)
		}
	})

	test('classifies the point at infinity the way the library computes the digest scalar', async () => {
		const digestsRecoveringToScalarOne = {
			'digest shorter than 32 bytes': '0x01',
			'digest above the curve order': bytes32String(CURVE_ORDER + 1n),
			'digest longer than 32 bytes': `${ bytes32String(1n) }ff`,
		} as const
		const signature = getSignatureRecoveringToInfinity(1n)
		for (const [name, hash] of Object.entries(digestsRecoveringToScalarOne)) {
			await assert.rejects(recoverAddress({ hash, signature }), undefined, name)
			assert.deepEqual(await tryRecoverAddress({ hash, signature }), { type: 'unrecoverable' }, name)
		}
	})

	test('recovers the opposite-parity nonce point of a signature that lands on the point at infinity', async () => {
		const signature = getSignatureRecoveringToInfinity(BigInt(messageHash) % CURVE_ORDER, true)
		assert.deepEqual(await tryRecoverAddress({ hash: messageHash, signature }), { type: 'recovered', address: await recoverAddress({ hash: messageHash, signature }) })
	})

	test('recovers from a digest that reduces to zero', async () => {
		const signature = await account.signMessage({ message: 'hello' })
		const hash = bytes32String(CURVE_ORDER)
		assert.deepEqual(await tryRecoverAddress({ hash, signature }), { type: 'recovered', address: await recoverAddress({ hash, signature }) })
	})

	test('rethrows failures that are not about the signature recovering', async () => {
		await assert.rejects(tryRecoverAddress({ hash: messageHash, signature: '0xzz' }), /signature must be a 0x-prefixed hex string/u)
	})

	test('rethrows library errors from recovering a well-formed signature instead of reporting it unrecoverable', async () => {
		const signature = await account.signMessage({ message: 'hello' })
		const digestOverLibraryLimit = new Uint8Array(8193)
		await assert.rejects(tryRecoverAddress({ hash: digestOverLibraryLimit, signature }), /input is too large/u)
	})

	test('rethrows the library digest rejection when the digest and signature also land on the point at infinity', async () => {
		const digestOverLibraryLimit = new Uint8Array(8193)
		digestOverLibraryLimit[31] = 1
		const signature = { r: secp256k1.Point.CURVE().Gx, s: 1n, yParity: 0 }
		await assert.rejects(tryRecoverAddress({ hash: digestOverLibraryLimit, signature }), /input is too large/u)
	})

	test('reports invalid scalars as unrecoverable before the library sees the digest', async () => {
		const digestOverLibraryLimit = new Uint8Array(8193)
		assert.deepEqual(await tryRecoverAddress({ hash: digestOverLibraryLimit, signature: { r: 0n, s: 1n, yParity: 0 } }), { type: 'unrecoverable' })
	})
})
