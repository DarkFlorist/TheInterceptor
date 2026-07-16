import type { SignerName } from '../../types/signerTypes.js'
import { resolveSignal, type SignalOrValue } from '../../utils/signals.js'
import { getPrettySignerName, getSignerLogo } from '../../utils/signerMetadata.js'

export { getPrettySignerName, getSignerLogo } from '../../utils/signerMetadata.js'

const SignerLogoPlaceholder = () => <svg class = 'signer-logo-placeholder' viewBox = '0 0 24 24' aria-hidden = 'true'>
	<rect x = '3' y = '5' width = '18' height = '14' rx = '3' fill = 'none' stroke = 'currentColor' stroke-width = '1.75'/>
	<path d = 'M16 10h5v4h-5a2 2 0 0 1 0-4Z' fill = 'none' stroke = 'currentColor' stroke-width = '1.75'/>
	<circle cx = '17' cy = '12' r = '0.75' fill = 'currentColor'/>
</svg>

export function SignerLogoText(param: { signerName: SignalOrValue<SignerName>, text: SignalOrValue<string>, reserveLogoSpace?: boolean }) {
	const signerLogo = getSignerLogo(resolveSignal(param.signerName))
	const showLogoSlot = signerLogo !== undefined || param.reserveLogoSpace === true
	return <p class = 'signer-logo-text'>
		{ showLogoSlot ? <span class = 'signer-logo-slot' aria-hidden = 'true'>
			{ signerLogo === undefined ? <SignerLogoPlaceholder /> : <img width = '24' height = '24' src = { signerLogo }/> }
		</span> : <></> }
		<span>{ resolveSignal(param.text) }</span>
	</p>
}

export function SignersLogoName(param: { signerName: SignalOrValue<SignerName> }) {
	const signerName = resolveSignal(param.signerName)
	return <SignerLogoText signerName = { param.signerName } text = { getPrettySignerName(signerName) }/>
}
