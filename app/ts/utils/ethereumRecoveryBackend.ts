import { initSig } from 'micro-eth-signer/utils.js'
import { getRecordProperty, isRecord } from './runtimeTypeGuards.js'

export type PublicKeyRecoveryResult = { readonly success: true, readonly publicKey: Uint8Array } | { readonly success: false, readonly error: Error }

// This adapter alone translates the version-pinned dependency patch into an application result; callers never inspect Noble metadata. The build/test guard probes this exact boundary.
const isInvalidRecoveryPoint = (error: unknown) => {
	if (!isRecord(error)) return false
	const tagged = getRecordProperty(error, 'cause') ?? error
	return isRecord(tagged) && getRecordProperty(tagged, 'code') === 'ERR_SECP256K1_INVALID_POINT'
}

export const recoverEthereumPublicKey = (digest: Uint8Array, signature: { readonly r: bigint, readonly s: bigint, readonly yParity: number }): PublicKeyRecoveryResult => {
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
