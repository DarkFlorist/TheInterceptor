import { AMBIRE_LOGO, BRAVE_LOGO, COINBASEWALLET_LOGO, METAMASK_LOGO, RABBY_LOGO } from './constants.js'
import type { SignerName } from '../types/signerTypes.js'

const signerLogos: Readonly<Partial<Record<SignerName, string>>> = {
	MetaMask: METAMASK_LOGO,
	Ambire: AMBIRE_LOGO,
	Brave: BRAVE_LOGO,
	CoinbaseWallet: COINBASEWALLET_LOGO,
	Rabby: RABBY_LOGO,
}

export function isSignerMissing(signerName: SignerName) {
	return signerName === 'NoSigner' || signerName === 'NoSignerDetected'
}

export function getPrettySignerName(signerName: SignerName) {
	if (signerName === 'EIP6963') return 'Selected wallet'
	if (signerName === 'NoSigner' || signerName === 'NotRecognizedSigner' || signerName === 'NoSignerDetected') return 'Unknown signer'
	if (signerName === 'Ambire' || signerName === 'Rabby') return `${ signerName } Wallet`
	return signerName
}

export function getSignerLogo(signerName: SignerName) {
	return signerLogos[signerName]
}
