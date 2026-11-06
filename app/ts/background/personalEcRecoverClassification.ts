// @noble/curves is pinned exactly to the version micro-eth-signer resolves to, so this classification and recoverAddress run on one copy of the library. tryRecoverAddress.test.ts fails if an upgrade splits them into two copies, so a split cannot be silent and an upgrade has to bump both together.
// secp256k1.Point's BASE, Fn and Fp are public @noble/curves API: they are declared on its exported point constructor type and shown in its README.
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToNumberBE } from '@noble/curves/utils.js'
import { concatBytes } from '@noble/hashes/utils'
import type { RecoverableMessageSignature } from '../types/JsonRpc-types.js'
import { bytesFromHexOrBytes } from '../utils/ethereumBytes.js'
import { recoverAddress, type Hex } from '../utils/ethereumPrimitives.js'

const { BASE: GENERATOR_POINT, Fn: SCALAR_FIELD, Fp: COORDINATE_FIELD } = secp256k1.Point

// r is the x-coordinate of the signing nonce point on y^2 = x^3 + 7, so it names a curve point only if x^3 + 7 is a nonzero square mod p (Euler's criterion; secp256k1 has no point with y = 0).
const isCurveXCoordinate = (x: bigint) => COORDINATE_FIELD.pow(COORDINATE_FIELD.create(x ** 3n + 7n), (COORDINATE_FIELD.ORDER - 1n) / 2n) === COORDINATE_FIELD.ONE

// Checked here rather than inferred from library errors: r and s must be in 1..n-1 and r must be a curve x-coordinate for recovery to have a nonce point to start from.
const hasRecoverableRAndS = (signature: RecoverableMessageSignature) => SCALAR_FIELD.isValidNot0(signature.r) && SCALAR_FIELD.isValidNot0(signature.s) && isCurveXCoordinate(signature.r)

// ECDSA signs the integer in the leftmost 256 bits of the digest, reduced mod n.
const digestToScalar = (digest: Uint8Array) => SCALAR_FIELD.create(bytesToNumberBE(digest.subarray(0, SCALAR_FIELD.BYTES)))

// Recovery computes r^-1 * (s * R - hash * G), which is the point at infinity exactly when s * R = hash * G. Call only after hasRecoverableRAndS, which guarantees r names the nonce point R.
const recoversToPointAtInfinity = (digest: Uint8Array, { r, s, yParity }: RecoverableMessageSignature) => {
	const noncePoint = secp256k1.Point.fromBytes(concatBytes(new Uint8Array([2 + yParity]), COORDINATE_FIELD.toBytes(r)))
	return noncePoint.multiplyUnsafe(s).equals(GENERATOR_POINT.multiplyUnsafe(digestToScalar(digest)))
}

// For a signature recoversToPointAtInfinity accepted, s * R = hash * G with both sides nonzero, so the opposite nonce point -R sums to -2 * hash * G and never reaches infinity. Recovering from -R therefore runs all of the library's digest checks, whose errors outrank the 'unrecoverable' result, without hitting its own infinity error.
const assertRecoveryAcceptsDigest = async (digest: Uint8Array, signature: RecoverableMessageSignature) => {
	await recoverAddress({ hash: digest, signature: { ...signature, yParity: 1 - signature.yParity } })
}

type AddressRecovery = { readonly type: 'recovered', readonly address: Hex } | { readonly type: 'unrecoverable' }

// Like recoverAddress, but reports a signature whose r and s recover to no address as 'unrecoverable' instead of throwing. That is decided from the signature and digest alone, so every error the recovery itself throws is unexpected and propagates.
export const tryRecoverAddress = async ({ hash, signature }: { readonly hash: Hex | Uint8Array, readonly signature: RecoverableMessageSignature }): Promise<AddressRecovery> => {
	const digest = bytesFromHexOrBytes(hash)
	if (!hasRecoverableRAndS(signature)) return { type: 'unrecoverable' }
	if (recoversToPointAtInfinity(digest, signature)) {
		await assertRecoveryAcceptsDigest(digest, signature)
		return { type: 'unrecoverable' }
	}
	return { type: 'recovered', address: await recoverAddress({ hash: digest, signature }) }
}
