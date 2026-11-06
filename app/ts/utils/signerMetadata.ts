import { isWalletSignerName, signerIdentities, type WalletSignerName } from './signerIdentity.js'
import { AMBIRE_LOGO, BRAVE_LOGO, COINBASEWALLET_LOGO, METAMASK_LOGO, RABBY_LOGO } from './constants.js'
import type { SignerName } from '../types/signerTypes.js'

const signerLogos: Readonly<Record<WalletSignerName, string>> = {
	MetaMask: METAMASK_LOGO,
	Ambire: AMBIRE_LOGO,
	Brave: BRAVE_LOGO,
	CoinbaseWallet: COINBASEWALLET_LOGO,
	Rabby: RABBY_LOGO,
}

export function isSignerMissing(signerName: SignerName) {
	return signerIdentities[signerName].missing
}

export function getPrettySignerName(signerName: SignerName) {
	return signerIdentities[signerName].displayName
}

export function getSignerLogo(signerName: SignerName) {
	return isWalletSignerName(signerName) ? signerLogos[signerName] : undefined
}
