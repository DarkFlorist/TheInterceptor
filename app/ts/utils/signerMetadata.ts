import { BRAVE_LOGO, COINBASEWALLET_LOGO, METAMASK_LOGO } from './constants.js'
import type { SignerName } from '../types/signerTypes.js'

const signerLogos = {
	MetaMask: METAMASK_LOGO,
	Brave: BRAVE_LOGO,
	CoinbaseWallet: COINBASEWALLET_LOGO,
} as const

export function isSignerMissing(signerName: SignerName) {
	return signerName === 'NoSigner' || signerName === 'NoSignerDetected'
}

export function getPrettySignerName(signerName: SignerName) {
	if (signerName === 'NoSigner' || signerName === 'NotRecognizedSigner' || signerName === 'NoSignerDetected') return 'Unknown signer'
	return signerName
}

export function getSignerLogo(signerName: SignerName) {
	if (signerName === 'NoSigner' || signerName === 'NotRecognizedSigner' || signerName === 'NoSignerDetected') return undefined
	return signerLogos[signerName]
}
