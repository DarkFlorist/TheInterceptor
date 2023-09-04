
import { ChangeActiveAddressParam } from '../../types/user-interface-types.js'
import { BigAddress } from '../subcomponents/address.js'
import { getSignerLogo, getPrettySignerName, SignerLogoText } from '../subcomponents/signers.js'

export function ChangeActiveAddress(param: ChangeActiveAddressParam) {
	function ChangeAndStoreActiveAddress(activeAddress: bigint | 'signer') {
		param.setAndSaveAppPage('Home')
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

	function goHome() {
		param.setAndSaveAppPage('Home')
	}

	function changePageToAddAddress() {
		param.addNewAddress()
	}

	const signerAddressName = param.activeAddresses.find( (x) => x.address === getSignerAccount() )?.name

	return ( <>
		<div class = 'modal-background'> </div>
		<div class = 'modal-card' style = 'height: 100%;'>
			<header class = 'modal-card-head card-header interceptor-modal-head window-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'icon'>
						<img src = '../img/address-book.svg'/>
					</span>
				</div>
				<div class = 'card-header-title'>
					<p className = 'paragraph'>
					Change Active Address
					</p>
				</div>
				<button class = 'card-header-icon' aria-label = 'close' onClick = { goHome }>
					<span class = 'icon' style = 'color: var(--text-color);'> X </span>
				</button>
			</header>
			<section class = 'modal-card-body'>
				<ul>
					<li>
						<div class = 'card hoverable' onClick = { () => { ChangeAndStoreActiveAddress('signer') } }>
							<div class = 'card-content hoverable' style = 'cursor: pointer;'>
								<div class = 'media'>
									<div class = 'media-left'>
										<figure class = 'image'>
											{ getSignerLogo(param.signerName) === undefined ?
												<div style = 'border: 1px solid white; width: 40px; height: 40px;'>
													<p class = 'title' style = 'text-align: center'> S </p>
												</div>
												: <img src = { getSignerLogo(param.signerName) } style = 'max-width: 40px; max-height: 40px'/>
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
					</li>

					{ param.activeAddresses === undefined
						? <></>
						: param.activeAddresses.map((activeAddress) => (
							<li>
								<div class = 'card hoverable' onClick = { () => { ChangeAndStoreActiveAddress(activeAddress.address) } }>
									<div class = 'card-content hoverable ' style = 'cursor: pointer;'>
										<BigAddress
											addressBookEntry = { { ...activeAddress, type: 'activeAddress', entrySource: 'User' } }
											noCopying = { true }
											renameAddressCallBack = { param.renameAddressCallBack }
										/>
										{ isSignerConnected(activeAddress.address) ?
											<div class = 'content' style = 'color: var(--text-color)'>
												<SignerLogoText signerName = { param.signerName } text = { ` ${ getPrettySignerName(param.signerName) } connected` }/>
											</div> : <></>
										}
									</div>
								</div>
							</li>
						) )
					}

				</ul>
			</section>
			<footer class = 'modal-card-foot window-footer' style = 'border-bottom-left-radius: unset; border-bottom-right-radius: unset; border-top: unset; padding: 10px;'>
				<button class = 'button is-primary is-success' onClick = { goHome }> Close </button>
				<button class = 'button is-primary' onClick = { changePageToAddAddress }> Add New Address </button>
			</footer>
		</div>
	</> )

}
