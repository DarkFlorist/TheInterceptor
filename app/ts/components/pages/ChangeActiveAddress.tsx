
import type { ChangeActiveAddressParam } from '../../types/user-interface-types.js'
import { BigAddress } from '../subcomponents/address.js'
import { XMarkIcon } from '../subcomponents/icons.js'
import { getSignerLogo, getPrettySignerName, SignerLogoText } from '../subcomponents/signers.js'

export function ChangeActiveAddress(param: ChangeActiveAddressParam) {
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

	function changePageToAddAddress() {
		param.addNewAddress()
	}

	const activeAddresses = param.activeAddresses.value
	const signerAddressName = activeAddresses.find((x) => x.address === getSignerAccount() )?.name

	return ( <>
		<div class = 'modal-background'> </div>
		<div class = 'modal-card change-address-modal-card'>
			<header class = 'modal-card-head card-header interceptor-modal-head window-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'icon'>
						<img src = '../img/address-book.svg' width = '24' height = '24'/>
					</span>
				</div>
				<div class = 'card-header-title'>
					<p class = 'paragraph'>
					Change Active Address
					</p>
				</div>
				<button class = 'card-header-icon' aria-label = 'close' onClick = { param.close }>
					<XMarkIcon />
				</button>
			</header>
			<section class = 'modal-card-body'>
				<ul>
					{ getSignerAccount() === undefined ? <></> : <li>
						<div class = 'card hoverable' onClick = { () => { changeAndStoreActiveAddress('signer') } }>
							<div class = 'card-content hoverable change-address-option'>
								<div class = 'media'>
									<div class = 'media-left'>
										<figure class = 'image'>
											{ getSignerLogo(param.signerName) === undefined ?
												<div class = 'change-address-signer-placeholder'>
													<p class = 'title change-address-signer-initial'> S </p>
												</div>
												: <img src = { getSignerLogo(param.signerName) } width = '40' height = '40' class = 'change-address-signer-logo'/>
											}
										</figure>
									</div>

									<div class = 'media-content change-address-signer-text'>
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
								<div class = 'card-content hoverable change-address-option'>
									<BigAddress
										addressBookEntry = { activeAddress }
										noCopying = { true }
										noEditAddress = { true }
										renameAddressCallBack = { param.renameAddressCallBack }
									/>
									{ isSignerConnected(activeAddress.address) ?
										<div class = 'content change-address-connected-signer'>
											<SignerLogoText signerName = { param.signerName } text = { ` ${ getPrettySignerName(param.signerName) } connected` }/>
										</div> : <></>
									}
								</div>
							</div>
						</li>
					) ) }

				</ul>
			</section>
			<footer class = 'modal-card-foot window-footer'>
				<button class = 'button button--secondary' onClick = { param.close }> Close </button>
				<button class = 'button is-primary' onClick = { changePageToAddAddress }> Add New Address </button>
			</footer>
		</div>
	</> )

}
