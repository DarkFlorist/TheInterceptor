import { addr } from 'micro-eth-signer'
import type { SigningWallet } from '../types/signingWallet.js'
import { bytesFromHex, ensureHex, getAddress } from '../utils/ethereumBytes.js'
import { signingOperationError } from './signingOperationError.js'

/** Cryptographic identity belongs at wallet admission and device boundaries, not in persisted codecs. */
export function publicKeyAddress(publicKey: string) {
	return getAddress(addr.fromPublicKey(bytesFromHex(ensureHex(publicKey))))
}

export function assertPublicKeyAddress(publicKey: string, address: bigint) {
	if (BigInt(publicKeyAddress(publicKey)) !== address) throw signingOperationError('Signing wallet address does not match its public key')
}

export function assertSigningWalletIdentity(wallet: SigningWallet) {
	if (wallet.type !== 'browser') assertPublicKeyAddress(wallet.publicKey, wallet.address)
}
