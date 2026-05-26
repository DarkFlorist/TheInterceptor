import type { SignerName } from '../../types/signerTypes.js'
import { resolveSignal, type SignalOrValue } from '../../utils/signals.js'
import { getPrettySignerName, getSignerLogo } from '../../utils/signerMetadata.js'

export { getPrettySignerName, getSignerLogo } from '../../utils/signerMetadata.js'

export function SignerLogoText(param: { signerName: SignalOrValue<SignerName>, text: SignalOrValue<string> }) {
	const signerLogo = getSignerLogo(resolveSignal(param.signerName))
	return <p style = 'line-height: 24px; display: inline-block;'>
		{ signerLogo ? <img style = 'width: 24px; height: 24px; vertical-align: text-top;' width = '24' height = '24' src = { signerLogo }/> : <></> }
		{ resolveSignal(param.text) }
	</p>
}

export function SignersLogoName(param: { signerName: SignalOrValue<SignerName> }) {
	const signerName = resolveSignal(param.signerName)
	return <SignerLogoText signerName = { param.signerName } text = { getPrettySignerName(signerName) }/>
}
