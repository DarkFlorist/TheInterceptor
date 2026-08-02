
import type { ChangeActiveAddressParam } from '../../types/user-interface-types.js'
import { BigAddress } from '../subcomponents/address.js'
import { getSignerLogo, getPrettySignerName, SignerLogoText } from '../subcomponents/signers.js'
import { InterceptorDialogBody, InterceptorDialogFooter, InterceptorDialogHeader, InterceptorDialogSurface } from '../subcomponents/InterceptorDialog.js'

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

	return <InterceptorDialogSurface ariaLabel = 'Change active address' onClose = { param.close } size = 'large' fill = { true }>
		<InterceptorDialogHeader close = { param.close } closeLabel = 'Close address selection' icon = '../img/address-book.svg' title = 'Change active address' subtitle = 'Choose which account Interceptor uses for simulation'/>
		<InterceptorDialogBody>
				<ul class = 'interceptor-dialog-list'>
					<li>
						<button type = 'button' class = 'card hoverable interceptor-dialog-choice' onClick = { () => { changeAndStoreActiveAddress('signer') } }>
							<div class = 'card-content'>
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
						</button>
					</li>

					{ activeAddresses.map((activeAddress) => (
						<li key = { activeAddress.address.toString() }>
							<button type = 'button' class = 'card hoverable interceptor-dialog-choice' onClick = { () => { changeAndStoreActiveAddress(activeAddress.address) } }>
								<div class = 'card-content'>
									<BigAddress
										addressBookEntry = { activeAddress }
										noCopying = { true }
										noEditAddress = { true }
										presentationOnly = { true }
										renameAddressCallBack = { param.renameAddressCallBack }
									/>
									{ isSignerConnected(activeAddress.address) ?
										<div class = 'content' style = 'color: var(--text-color)'>
											<SignerLogoText signerName = { param.signerName } text = { ` ${ getPrettySignerName(param.signerName) } connected` }/>
										</div> : <></>
									}
								</div>
							</button>
						</li>
					) ) }

				</ul>
		</InterceptorDialogBody>
		<InterceptorDialogFooter>
			<button type = 'button' class = 'btn btn--ghost' onClick = { param.close }>Close</button>
			<button type = 'button' class = 'btn btn--primary' onClick = { changePageToAddAddress }>Add new address</button>
		</InterceptorDialogFooter>
	</InterceptorDialogSurface>

}
