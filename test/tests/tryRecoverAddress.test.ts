import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { secp256k1 } from '@noble/curves/secp256k1'
import { bytes32String } from '../../app/ts/utils/bigint.js'
import { bytesToHex, hashMessage, privateKeyToAccount, recoverAddress, tryRecoverAddress, type Hex } from '../../app/ts/utils/ethereumPrimitives.js'

const account = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
const messageHash = hashMessage('hello')

const toSignatureHex = (r: bigint, s: bigint, yParity: number): Hex => `${ bytes32String(r) }${ bytes32String(s).slice(2) }${ (27 + yParity).toString(16) }`

// With s = 1 and R = hashScalar * G, recovery computes r^-1 * (s * R - hashScalar * G), which is the point at infinity.
const getSignatureRecoveringToInfinity = (hashScalar: bigint, flipParity = false) => {
	const compressedR = secp256k1.getPublicKey(hashScalar, true)
	const r = BigInt(bytesToHex(compressedR.slice(1)))
	assert.ok(r < secp256k1.CURVE.n)
	const yParity = compressedR[0] === 3 ? 1 : 0
	return toSignatureHex(r, 1n, flipParity ? 1 - yParity : yParity)
}

describe('tryRecoverAddress', () => {
	test('recovers the signer of a valid signature', async () => {
		const signature = await account.signMessage({ message: 'hello' })
		assert.deepEqual(await tryRecoverAddress({ hash: messageHash, signature }), { type: 'recovered', address: account.address })
	})

	test('recovers the same signer from the high-s form of a valid signature', async () => {
		const signature = await account.signMessage({ message: 'hello' })
		const r = BigInt(signature.slice(0, 66))
		const s = BigInt(`0x${ signature.slice(66, 130) }`)
		const yParity = signature.endsWith('1b') ? 0 : 1
		const highS = secp256k1.CURVE.n - s
		assert.ok(highS > secp256k1.CURVE.n / 2n)
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
			'r is the curve order': toSignatureHex(secp256k1.CURVE.n, validS, 0),
			's is the curve order': toSignatureHex(validR, secp256k1.CURVE.n, 0),
			'r is not a curve x-coordinate': toSignatureHex(5n, validS, 0),
			'recovery lands on the point at infinity': getSignatureRecoveringToInfinity(BigInt(messageHash) % secp256k1.CURVE.n),
		}
		for (const [name, signature] of Object.entries(unrecoverableSignatures)) {
			assert.deepEqual(await tryRecoverAddress({ hash: messageHash, signature }), { type: 'unrecoverable' }, name)
		}
	})

	test('classifies the point at infinity the way the library computes the digest scalar', async () => {
		const digestsRecoveringToScalarOne = {
			'digest shorter than 32 bytes': '0x01',
			'digest above the curve order': bytes32String(secp256k1.CURVE.n + 1n),
			'digest longer than 32 bytes': `${ bytes32String(1n) }ff`,
		} as const
		const signature = getSignatureRecoveringToInfinity(1n)
		for (const [name, hash] of Object.entries(digestsRecoveringToScalarOne)) {
			await assert.rejects(recoverAddress({ hash, signature }), undefined, name)
			assert.deepEqual(await tryRecoverAddress({ hash, signature }), { type: 'unrecoverable' }, name)
		}
	})

	test('recovers the opposite-parity nonce point of a signature that lands on the point at infinity', async () => {
		const signature = getSignatureRecoveringToInfinity(BigInt(messageHash) % secp256k1.CURVE.n, true)
		assert.deepEqual(await tryRecoverAddress({ hash: messageHash, signature }), { type: 'recovered', address: await recoverAddress({ hash: messageHash, signature }) })
	})

	test('recovers from a digest that reduces to zero', async () => {
		const signature = await account.signMessage({ message: 'hello' })
		const hash = bytes32String(secp256k1.CURVE.n)
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
})
