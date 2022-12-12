
import { Page, ChangeActiveAddressParam } from '../../utils/user-interface-types.js'
import { BigAddress } from '../subcomponents/address.js'
import { getSignerLogo, getSignerName, SignerLogoText } from '../subcomponents/signers.js'

export function ChangeActiveAddress(param: ChangeActiveAddressParam) {
	function ChangeAndStoreActiveAddress(activeAddress: bigint | 'signer') {
		param.setAndSaveAppPage(Page.Home)
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
		param.setAndSaveAppPage(Page.Home)
	}

	function changePageToAddAddress() {
		param.setAndSaveAppPage(Page.AddNewAddress)
	}

	const signerAddressName = param.addressInfos.find( (x) => x.address === getSignerAccount() )?.name

	return ( <>
		<div class = 'modal-background'> </div>
		<div class = 'modal-card' style = 'height: 100%;'>
			<header class = 'modal-card-head card-header interceptor-modal-head window-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'icon'>
						<img src = '../img/address-book.svg'/>
					</span>
				</div>
				<p class = 'card-header-title'>
					<p className = 'paragraph'>
					Change Active Address
					</p>
				</p>
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
										<p class = 'title is-5'>{ `Use address from ${ getSignerName(param.signerName) }` }</p>
										<p class = 'subtitle is-7'> { signerAddressName === undefined ? '' : signerAddressName }</p>
									</div>
								</div>
							</div>
						</div>
					</li>

					{ param.addressInfos === undefined ? <></> : param.addressInfos.map( (addressInfo) => (
						<li>
							<div class = 'card hoverable' onClick = { () => { ChangeAndStoreActiveAddress(addressInfo.address) } }>
								<div class = 'card-content hoverable ' style = 'cursor: pointer;'>
									<div class = 'media'>
										<BigAddress address = { addressInfo.address } title = { addressInfo.name } noCopying = { true }/>
									</div>
									{ isSignerConnected(addressInfo.address) ?
										<div class = 'content' style = 'color: var(--text-color)'>
											<SignerLogoText signerName = { param.signerName } text = { ` ${ getSignerName(param.signerName) } connected` }/>
										</div> : <></>
									}
								</div>
							</div>
						</li>
					) ) }

				</ul>
			</section>
			<footer class = 'modal-card-foot window-footer' style = 'border-bottom-left-radius: unset; border-bottom-right-radius: unset; border-top: unset; padding: 10px;'>
				<button class = 'button is-primary is-success' onClick = { goHome }> Close </button>
				<button class = 'button is-primary' onClick = { changePageToAddAddress }> Add New Address </button>
			</footer>
		</div>
	</> )

}
