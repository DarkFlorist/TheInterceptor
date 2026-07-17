import { AMBIRE_LOGO, BRAVE_LOGO, COINBASEWALLET_LOGO, METAMASK_LOGO, RABBY_LOGO } from './constants.js'
import type { SignerName } from '../types/signerTypes.js'

const signerLogos = {
	MetaMask: METAMASK_LOGO,
	Ambire: AMBIRE_LOGO,
	Brave: BRAVE_LOGO,
	CoinbaseWallet: COINBASEWALLET_LOGO,
	Rabby: RABBY_LOGO,
} as const

export function getPrettySignerName(signerName: SignerName) {
	if (signerName === 'NoSigner' || signerName === 'NotRecognizedSigner' || signerName === 'NoSignerDetected') return 'Unknown signer'
	if (signerName === 'Ambire' || signerName === 'Rabby') return `${ signerName } Wallet`
	return signerName
}

export function getSignerLogo(signerName: SignerName) {
	if (signerName === 'NoSigner' || signerName === 'NotRecognizedSigner' || signerName === 'NoSignerDetected') return undefined
	return signerLogos[signerName]
}
