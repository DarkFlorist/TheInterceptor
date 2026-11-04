import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { secp256k1 } from '@noble/curves/secp256k1'
import { bytes32String } from '../../app/ts/utils/bigint.js'
import { bytesToHex, hashMessage, privateKeyToAccount, tryRecoverAddress, type Hex } from '../../app/ts/utils/ethereumPrimitives.js'

const account = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
const messageHash = hashMessage('hello')

const toSignatureHex = (r: bigint, s: bigint, yParity: number): Hex => `${ bytes32String(r) }${ bytes32String(s).slice(2) }${ (27 + yParity).toString(16) }`

// With s = 1 and R = hash * G, recovery computes r^-1 * (s * R - hash * G), which is the point at infinity.
const getSignatureRecoveringToInfinity = (hash: Hex) => {
	const hashScalar = BigInt(hash) % secp256k1.CURVE.n
	const compressedR = secp256k1.getPublicKey(hashScalar, true)
	const r = BigInt(bytesToHex(compressedR.slice(1)))
	assert.ok(r < secp256k1.CURVE.n)
	return toSignatureHex(r, 1n, compressedR[0] === 3 ? 1 : 0)
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

	// Each case covers one unrecoverable input; the point-at-infinity case is classified by the library's error text, so a reworded message makes it fail here.
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
			'recovery lands on the point at infinity': getSignatureRecoveringToInfinity(messageHash),
		}
		for (const [name, signature] of Object.entries(unrecoverableSignatures)) {
			assert.deepEqual(await tryRecoverAddress({ hash: messageHash, signature }), { type: 'unrecoverable' }, name)
		}
	})

	test('rethrows failures that are not about the signature recovering', async () => {
		await assert.rejects(tryRecoverAddress({ hash: messageHash, signature: '0xzz' }), /signature must be a 0x-prefixed hex string/u)
	})
})
