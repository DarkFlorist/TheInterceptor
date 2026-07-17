import { BRAVE_LOGO, COINBASEWALLET_LOGO, METAMASK_LOGO } from './constants.js'
import type { SignerName } from '../types/signerTypes.js'

const signerLogos = {
	MetaMask: METAMASK_LOGO,
	Brave: BRAVE_LOGO,
	CoinbaseWallet: COINBASEWALLET_LOGO,
} as const

export function getPrettySignerName(signerName: SignerName) {
	if (signerName === 'NoSigner' || signerName === 'NotRecognizedSigner' || signerName === 'NoSignerDetected') return 'Unknown signer'
	return signerName
}

export function getSignerLogo(signerName: SignerName) {
	switch (signerName) {
		case 'MetaMask': return signerLogos.MetaMask
		case 'Brave': return signerLogos.Brave
		case 'CoinbaseWallet': return signerLogos.CoinbaseWallet
		default: return undefined
	}
}
