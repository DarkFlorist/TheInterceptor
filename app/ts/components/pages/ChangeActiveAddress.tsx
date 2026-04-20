
import { ChangeActiveAddressParam } from '../../types/user-interface-types.js'
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

	const signerAddressName = param.activeAddresses.value.find((x) => x.address === getSignerAccount() )?.name

	return ( <>
		<div class = 'dialog-backdrop'> </div>
		<div class = 'dialog-panel' style = 'height: 100%;'>
			<header class = 'dialog-panel__header panel-card__header interceptor-modal-head window-header'>
				<div class = 'panel-card__icon unset-cursor'>
					<span class = 'ui-icon'>
						<img src = '../img/address-book.svg'/>
					</span>
				</div>
				<div class = 'panel-card__title'>
					<p className = 'paragraph'>
					Change Active Address
					</p>
				</div>
				<button class = 'panel-card__icon' aria-label = 'close' onClick = { param.close }>
					<XMarkIcon />
				</button>
			</header>
			<section class = 'dialog-panel__body'>
				<ul>
					<li>
						<div class = 'panel-card hoverable' onClick = { () => { changeAndStoreActiveAddress('signer') } }>
							<div class = 'panel-card__content hoverable' style = 'cursor: pointer;'>
								<div class = 'media-layout'>
									<div class = 'media-layout__aside'>
										<figure class = 'media-figure'>
											{ getSignerLogo(param.signerName) === undefined ?
												<div style = 'border: 1px solid white; width: 40px; height: 40px;'>
													<p class = 'heading-text' style = 'text-align: center'> S </p>
												</div>
												: <img src = { getSignerLogo(param.signerName) } style = 'max-width: 40px; max-height: 40px'/>
											}
										</figure>
									</div>

									<div class = 'media-layout__content' style = 'overflow-y: hidden;'>
										<p class = 'heading-text heading-text--md flow-spacing-sm'>{ `Use address from ${ getPrettySignerName(param.signerName) }` }</p>
										<p class = 'subheading-text subheading-text--sm'> { signerAddressName === undefined ? '' : signerAddressName }</p>
									</div>
								</div>
							</div>
						</div>
					</li>

					{ param.activeAddresses === undefined
						? <></>
						: param.activeAddresses.value.map((activeAddress) => (
							<li>
								<div class = 'panel-card hoverable' onClick = { () => { changeAndStoreActiveAddress(activeAddress.address) } }>
									<div class = 'panel-card__content hoverable ' style = 'cursor: pointer;'>
										<BigAddress
											addressBookEntry = { activeAddress }
											noCopying = { true }
											noEditAddress = { true }
											renameAddressCallBack = { param.renameAddressCallBack }
										/>
										{ isSignerConnected(activeAddress.address) ?
											<div class = 'rich-content' style = 'color: var(--text-color)'>
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
			<footer class = 'dialog-panel__footer window-footer' style = 'border-bottom-left-radius: unset; border-bottom-right-radius: unset; border-top: unset; padding: 10px;'>
				<button class = 'btn btn--success' onClick = { param.close }> Close </button>
				<button class = 'btn btn--primary' onClick = { changePageToAddAddress }> Add New Address </button>
			</footer>
		</div>
	</> )

}
