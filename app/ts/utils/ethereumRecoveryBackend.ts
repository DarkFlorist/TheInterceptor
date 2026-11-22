import { initSig } from 'micro-eth-signer/utils.js'
import { getRecordProperty, isRecord } from './runtimeTypeGuards.js'

export type PublicKeyRecoveryResult = { readonly success: true, readonly publicKey: Uint8Array } | { readonly success: false, readonly error: Error }

// Environment-neutral shared boundary: build tooling imports this module; do not add browser, extension or application-service dependencies. This adapter alone translates the version-pinned dependency patch into an application result; callers never inspect Noble metadata. The build/test guard probes this exact boundary.
const isInvalidRecoveryPoint = (error: unknown) => {
	if (!isRecord(error)) return false
	const tagged = getRecordProperty(error, 'cause') ?? error
	return isRecord(tagged) && getRecordProperty(tagged, 'code') === 'ERR_SECP256K1_INVALID_POINT'
}

const recoverPublicKeyUnchecked = (digest: Uint8Array, signature: { readonly r: bigint, readonly s: bigint, readonly yParity: number }): PublicKeyRecoveryResult => {
	const recoveredSignature = initSig(signature, signature.yParity)
	let publicKey
	try {
		publicKey = recoveredSignature.recoverPublicKey(digest)
	} catch (error: unknown) {
		if (!(error instanceof Error) || !isInvalidRecoveryPoint(error)) throw error
		return { success: false, error }
	}
	return { success: true, publicKey: publicKey.toBytes(false) }
}

// Keep unrelated primitive imports usable. Verify the replaceable dependency contract once on first recovery, or explicitly during build preflight; failures never become successful initialization.
let dependencyVerified = false
export const assertRecoveryDependencyContract = () => {
	if (dependencyVerified) return
	const digest = new Uint8Array(32)
	digest[31] = 1
	for (const r of [5n, 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n]) {
		if (recoverPublicKeyUnchecked(digest, { r, s: 1n, yParity: 0 }).success) throw new Error('Recovery dependency contract failed: invalid point recovered a key')
	}
	dependencyVerified = true
}

export const recoverEthereumPublicKey = (digest: Uint8Array, signature: { readonly r: bigint, readonly s: bigint, readonly yParity: number }): PublicKeyRecoveryResult => {
	assertRecoveryDependencyContract()
	return recoverPublicKeyUnchecked(digest, signature)
}
