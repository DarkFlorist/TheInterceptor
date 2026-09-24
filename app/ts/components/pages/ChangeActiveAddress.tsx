import { SigningWalletSummary, openSigningWalletSetup } from '../subcomponents/SigningWalletSummary.js'
import { useState } from 'preact/hooks'

import type { ChangeActiveAddressParam } from '../../types/user-interface-types.js'
import { BigAddress } from '../subcomponents/address.js'
import { XMarkIcon } from '../subcomponents/icons.js'
import { getSignerLogo, getPrettySignerName, SignerLogoText } from '../subcomponents/signers.js'

export function ChangeActiveAddress(param: ChangeActiveAddressParam) {
	const [error, setError] = useState<string>()
	function changeAndStoreActiveAddress(activeAddress: bigint | 'signer') {
		param.close()
		param.setActiveAddressAndInformAboutIt(activeAddress)
	}

	function getSignerAccount() {
		if (param.signerAccounts !== undefined && param.signerAccounts.length > 0) {
			return param.signerAccounts[0]
		}
		return undefined
	}

	function isSignerConnected(address: bigint) {
		return address !== undefined && getSignerAccount() === address
	}


	const activeAddresses = param.activeAddresses.value
	const signerAddressName = activeAddresses.find((x) => x.address === getSignerAccount() )?.name

	return ( <>
		<div class = 'modal-background'> </div>
		<div class = 'modal-card signing-address-selector' style = 'height: 100%;'>
			<header class = 'modal-card-head card-header interceptor-modal-head window-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'icon'>
						<img src = '../img/address-book.svg' width = '24' height = '24'/>
					</span>
				</div>
				<div class = 'card-header-title'>
					<p class = 'paragraph'>
					Choose address
					</p>
				</div>
				<button class = 'card-header-icon' aria-label = 'close' onClick = { param.close }>
					<XMarkIcon />
				</button>
			</header>
			<section class = 'modal-card-body'>
				<p class = 'signing-muted'>Select an address to use in your current mode.</p>
				<ul>
					{ getSignerAccount() === undefined ? <></> : <li>
						<div class = 'card hoverable' onClick = { () => { changeAndStoreActiveAddress('signer') } }>
							<div class = 'card-content hoverable' style = 'cursor: pointer;'>
								<div class = 'media'>
									<div class = 'media-left'>
										<figure class = 'image'>
											{ getSignerLogo(param.signerName) === undefined ?
												<div style = 'border: 1px solid white; width: 40px; height: 40px;'>
													<p class = 'title' style = 'text-align: center'> S </p>
												</div>
												: <img src = { getSignerLogo(param.signerName) } width = '40' height = '40' style = 'max-width: 40px; max-height: 40px'/>
											}
										</figure>
									</div>

									<div class = 'media-content' style = 'overflow-y: hidden;'>
										<p class = 'title is-5 is-spaced'>{ `Use address from ${ getPrettySignerName(param.signerName) }` }</p>
										<p class = 'subtitle is-7'> { signerAddressName === undefined ? '' : signerAddressName }</p>
									</div>
								</div>
							</div>
						</div>
					</li> }

					{ activeAddresses.map((activeAddress) => (
						<li key = { activeAddress.address.toString() }>
							<div class = 'card hoverable' onClick = { () => { changeAndStoreActiveAddress(activeAddress.address) } }>
								<div class = 'card-content hoverable ' style = 'cursor: pointer;'>
									<BigAddress
										addressBookEntry = { activeAddress }
										noCopying = { true }
										noEditAddress = { true }
										renameAddressCallBack = { param.renameAddressCallBack }
									/>
									{ activeAddress.type === 'safe' ? undefined : <SigningWalletSummary address = { activeAddress.address } showSimulationShortcut = { false }/> }
									{ isSignerConnected(activeAddress.address) ?
										<div class = 'content' style = 'color: var(--text-color)'>
											<SignerLogoText signerName = { param.signerName } text = { ` ${ getPrettySignerName(param.signerName) } connected` }/>
										</div> : <></>
									}
								</div>
							</div>
						</li>
					) ) }

				</ul>
			</section>
			<footer class = 'modal-card-foot window-footer' style = 'border-bottom-left-radius: unset; border-bottom-right-radius: unset; border-top: unset; padding: 10px;'>
				<button class = 'button signing-secondary' onClick = { param.close }> Close </button>
				<button class = 'button is-primary' onClick = { () => { void openSigningWalletSetup().catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Could not open wallet setup')) } }>Add address</button>
				{ error === undefined ? undefined : <p role = 'alert'>{ error }</p> }
			</footer>
		</div>
	</> )

}
