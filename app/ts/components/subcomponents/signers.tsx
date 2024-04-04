import { BRAVE_LOGO, COINBASEWALLET_LOGO, METAMASK_LOGO } from '../../utils/constants.js'
import { SignerName } from '../../types/signerTypes.js'

const signerLogos = {
	MetaMask: METAMASK_LOGO,
	Brave: BRAVE_LOGO,
	CoinbaseWallet: COINBASEWALLET_LOGO,
}

export function getPrettySignerName(signerName: SignerName) {
	if (signerName === 'NoSigner' || signerName === 'NotRecognizedSigner' || signerName === 'NoSignerDetected') return 'Unknown signer'
	return signerName
}

export function getSignerLogo(signerName: SignerName) {
	if (signerName === 'NoSigner' || signerName === 'NotRecognizedSigner' || signerName === 'NoSignerDetected') return undefined
	return signerLogos[signerName]
}

export function SignerLogoText(param: { signerName: SignerName, text: string }) {
	const signerLogo = getSignerLogo(param.signerName)
	return <p style = 'line-height: 24px; display: inline-block;'>
		{ signerLogo ? <img style = 'width: 24px; height: 24px; vertical-align: text-top;' src = { signerLogo }/> : <></> }
		{ param.text }
	</p>
}

export function SignersLogoName(param: { signerName: SignerName }) {
	return <SignerLogoText signerName = { param.signerName } text = { getPrettySignerName(param.signerName) }/>
}
