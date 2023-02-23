import { BRAVE_LOGO, METAMASK_LOGO } from '../../utils/constants.js'
import { SignerName } from '../../utils/interceptor-messages.js'

const signerLogos = {
	'MetaMask': METAMASK_LOGO,
	'Brave': BRAVE_LOGO
}

export function getSignerName(signerName: SignerName | undefined ) {
	if (signerName === 'NoSigner' || signerName === 'NotRecognizedSigner' || signerName === undefined) return 'Unknown signer'
	return signerName
}

export function getSignerLogo(signerName: SignerName | undefined ) {
	if (signerName === 'NoSigner' || signerName === 'NotRecognizedSigner' || signerName === undefined) return undefined
	return signerLogos[signerName]
}

export function SignerLogoText(param: { signerName: SignerName | undefined, text: string }) {
	const signerLogo = getSignerLogo(param.signerName)

	return <p style = 'line-height: 24px'>
		{ signerLogo ? <img style = 'width: 24px; height: 24px; vertical-align: bottom; margin-right: 5px' src = { signerLogo }/> : <></>}
		{ param.text }
	</p>
}

export function SignersLogoName(param: { signerName: SignerName | undefined}) {
	const signerLogo = getSignerLogo(param.signerName)

	return <span class = 'vertical-center'>
		{ signerLogo ? <img class = 'vertical-center' style = 'width: 24px;' src = { signerLogo }/> : <></> }
		<p class = 'vertical-center'> { getSignerName(param.signerName) } </p>
	</span>
}
