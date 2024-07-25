import { BRAVE_LOGO, COINBASEWALLET_LOGO, METAMASK_LOGO, OKX_WALLET_LOGO } from '../../utils/constants.js'
import { SignerName } from '../../types/signerTypes.js'

const signerLogos = {
	MetaMask: METAMASK_LOGO,
	Brave: BRAVE_LOGO,
	CoinbaseWallet: COINBASEWALLET_LOGO,
	'OKX Wallet': OKX_WALLET_LOGO
}

export const getSignerNameAndLogo = (signerName: SignerName) => {
	if (signerName === 'NoSigner' || signerName === 'NotRecognizedSigner' || signerName === 'NoSignerDetected') return { name: 'Unknown signer', logo: undefined }
	return {
		name: signerName,
		logo: signerLogos[signerName]
	}
}

export function SignerLogoText(param: { signerName: SignerName, text: string }) {
	const signer = getSignerNameAndLogo(param.signerName)
	return <p style = 'line-height: 24px; display: inline-block;'>
		{ signer.logo ? <img style = 'width: 24px; height: 24px; vertical-align: text-top;' src = { signer.logo }/> : <></> }
		{ param.text }
	</p>
}

export function SignersLogoName(param: { signerName: SignerName }) {
	const signer = getSignerNameAndLogo(param.signerName)
	return <SignerLogoText signerName = { param.signerName } text = { signer.name }/>
}