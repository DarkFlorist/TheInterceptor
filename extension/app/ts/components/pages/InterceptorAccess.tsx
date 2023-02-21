import { useState, useEffect } from 'preact/hooks'
import { ActiveAddress, BigAddress, Website } from '../subcomponents/address.js'
import { AddNewAddress } from './AddNewAddress.js'
import { AddressInfoEntry, AddressBookEntry, AddingNewAddressType, RenameAddressCallBack, Page, AddressInfo } from '../../utils/user-interface-types.js'
import { MessageToPopup, SignerName } from '../../utils/interceptor-messages.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import Hint from '../subcomponents/Hint.js'
import { convertNumberToCharacterRepresentationIfSmallEnough, upperCaseFirstCharacter } from '../ui-utils.js'
import { ChangeActiveAddress } from './ChangeActiveAddress.js'
import { DinoSays } from '../subcomponents/DinoSays.js'

function BigWebsite({ icon, origin }: { icon: string | undefined, origin: string }) {
	return <div class = 'media' style = 'margin: 2px; border-radius: 40px 40px 40px 40px; display: flex; padding: 4px 10px 4px 10px; overflow: hidden; background-color: var(--alpha-015);'>
		{ icon === undefined ? <></> :
			<figure class = 'media-left' style = 'margin: auto; display: block; padding: 10px'>
				<img src = { icon } style = 'width: 48px; height: 48px;'/>
			</figure>
		}
		<div class = 'media-content' style = 'margin: auto;'>
			<div style = 'overflow: hidden;'>
				<p class = 'title is-5 address-text is-spaced'>
					{ 'website title is here' }
				</p>
				<p class = 'subtitle is-7 is-spaced' style = 'overflow: visible; white-space: normal;'>
					{ origin }
				</p>
			</div>
		</div>
	</div>
}

function AssociatedTogether({ associatedAddresses, renameAddressCallBack }: { associatedAddresses: readonly AddressInfoEntry[], renameAddressCallBack: RenameAddressCallBack } ) {
	const [showLogs, setShowLogs] = useState<boolean>(associatedAddresses.length > 1)

	return <>
		<div class = 'card' style = 'margin-top: 10px; margin-bottom: 10px'>
			<header class = 'card-header noselect' style = 'cursor: pointer; height: 30px;' onClick = { () => setShowLogs((prevValue) => !prevValue) }>
				<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em;'>
					{ associatedAddresses.length <=1 ? 'The website cannot associate any addresses with each other' : `There are ${ upperCaseFirstCharacter(convertNumberToCharacterRepresentationIfSmallEnough(associatedAddresses.length)) } addresses that the website can associate together with` }
				</p>
				<div class = 'card-header-icon'>
					<span class = 'icon' style = 'color: var(--text-color); font-weight: unset; font-size: 0.8em;'> V </span>
				</div>
			</header>
			{ !showLogs ? <></> : <>
				<div class = 'card-content' style = 'border-bottom-left-radius: 0.25rem; border-bottom-right-radius: 0.25rem; border-left: 2px solid var(--card-bg-color); border-right: 2px solid var(--card-bg-color); border-bottom: 2px solid var(--card-bg-color);'>
					{ associatedAddresses.length <= 1 ? <DinoSays text = { 'Given its size, a tiny dinosaur wouldn\'t be expected to know any...' } /> :
						<ul>
							{ associatedAddresses.map( (info, index) => (
								<li style = { `margin: 0px; margin-bottom: ${ index < associatedAddresses.length - 1  ? '10px;' : '0px' }` } >
									<BigAddress
										addressBookEntry = { info }
										renameAddressCallBack = { renameAddressCallBack }
									/>
								</li>
							)) }
						</ul>
					}
				</div>
			</> }
		</div>
	</>
}

export function AccessRequest({ renameAddressCallBack, accessRequest, changeActiveAddress }: { renameAddressCallBack: RenameAddressCallBack, accessRequest: InterceptorAccessRequest, changeActiveAddress: () => void  }) {
	return <>
		{ accessRequest.requestAccessToAddress === undefined ? <div class = 'card-content'>
			<BigWebsite { ...accessRequest } />
			<p className = 'title is-4' style = 'text-align: center; margin-top: 20px; margin-bottom: 20px;'>
				would like to connect to The Interceptor
			</p>
		</div> :
			<>
				<div class = 'notification' style = 'background-color: var(--importance-box-color); color: var(--text-color)'>
					<BigWebsite { ...accessRequest } />
					<p className = 'title is-4' style = 'text-align: center; margin-top: 20px; margin-bottom: 20px;'>
						would like to connect to your account
					</p>
					<div class = 'notification' style = 'padding: 10px; background-color: var(--alpha-015); justify-content: center; '>
						<ActiveAddress
							addressBookEntry = { accessRequest.requestAccessToAddress }
							renameAddressCallBack = { renameAddressCallBack }
							changeActiveAddress = { changeActiveAddress }
							simulationMode = { true }
						/>
					</div>
				</div>

				<AssociatedTogether
					associatedAddresses = { accessRequest.associatedAddresses }
					renameAddressCallBack = { renameAddressCallBack }
				/>
			</>
		}
	</>
}

interface InterceptorAccessRequest {
	origin: string
	icon: string | undefined
	requestAccessToAddress: AddressInfoEntry | undefined
	associatedAddresses: readonly AddressInfoEntry[]
	addressInfos: readonly AddressInfo[]
	signerAccounts: readonly bigint[]
	signerName: SignerName | undefined
}

export function InterceptorAccess() {
	const [accessRequest, setAccessRequest] = useState<InterceptorAccessRequest | undefined>(undefined)
	const [addingNewAddress, setAddingNewAddress] = useState<AddingNewAddressType> ({ addingAddress: true, type: 'addressInfo' as const })
	const [appPage, setAppPage] = useState(Page.Home)

	useEffect( () => {
		async function popupMessageListener(msg: unknown) {
			const message = MessageToPopup.parse(msg)
			if (message.method !== 'popup_interceptorAccessDialog') return
			setAccessRequest(message.data)
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		sendPopupMessageToBackgroundPage( { method: 'popup_interceptorAccessReadyAndListening' } )
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	}, [])

	function approve() {
		if (accessRequest === undefined) return
		const options = {
			type: 'approval' as const,
			approval: 'Approved' as const,
			origin: accessRequest.origin,
			requestAccessToAddress: accessRequest.requestAccessToAddress?.address,
		}
		sendPopupMessageToBackgroundPage({ method: 'popup_interceptorAccess', options })
	}

	function reject() {
		if (accessRequest === undefined) return
		const options = {
			type: 'approval' as const,
			approval: 'Rejected' as const,
			origin: accessRequest.origin,
			requestAccessToAddress: accessRequest.requestAccessToAddress?.address,
		}
		sendPopupMessageToBackgroundPage({ method: 'popup_interceptorAccess', options })
	}

	function renameAddressCallBack(entry: AddressBookEntry) {
		setAppPage(Page.ModifyAddress)
		setAddingNewAddress({ addingAddress: false, entry: entry })
	}

	function changeActiveAddress() {
		setAppPage(Page.ChangeActiveAddress)
	}

	function setActiveAddressAndInformAboutIt(address: bigint | 'signer') {
		if (accessRequest === undefined) throw Error('access request not loaded')
		sendPopupMessageToBackgroundPage({ method: 'popup_interceptorAccess', options: {
			type: 'addressChange',
			origin: accessRequest.origin,
			requestAccessToAddress: accessRequest.requestAccessToAddress?.address,
			newActiveAddress: address,
		} } )
	}

	if (accessRequest === undefined) return <main></main>

	return <main>
		<Hint>
			<div class = { `modal ${ appPage !== Page.Home ? 'is-active' : ''}` }>
				{ appPage === Page.AddNewAddress || appPage === Page.ModifyAddress ?
					<AddNewAddress
						setActiveAddressAndInformAboutIt = { setActiveAddressAndInformAboutIt }
						addingNewAddress = { appPage === Page.AddNewAddress ? { addingAddress: true, type: 'addressInfo' } : addingNewAddress }
						close = { () => setAppPage(Page.Home) }
						activeAddress = { accessRequest.requestAccessToAddress?.address }
					/>
					: <></> }

				{ appPage === Page.ChangeActiveAddress ?
					<ChangeActiveAddress
						setActiveAddressAndInformAboutIt = { setActiveAddressAndInformAboutIt }
						signerAccounts = { accessRequest.signerAccounts }
						setAndSaveAppPage = { setAppPage }
						addressInfos = { accessRequest.addressInfos }
						signerName = { accessRequest.signerName }
						renameAddressCallBack = { renameAddressCallBack }
					/>
				: <></> }
			</div>

			<div className = 'block' style = 'margin-bottom: 0px; display: flex; justify-content: space-between; flex-direction: column; height: 100%; position: fixed; width: 100%'>
				<header class = 'card-header window-header' style = 'height: 40px; border-top-left-radius: 0px; border-top-right-radius: 0px'>
					<div class = 'card-header-icon noselect nopointer' style = 'overflow: hidden; padding: 0px;'>
						<Website websiteOrigin = { accessRequest.origin } websiteIcon = { accessRequest.icon } />
					</div>
				</header>
				<div style = 'overflow-y: auto; padding: 20px'>
					<AccessRequest
						renameAddressCallBack = { renameAddressCallBack }
						accessRequest = { accessRequest }
						changeActiveAddress = { changeActiveAddress }
					/>
				</div>
				<nav class = 'window-header' style = 'display: flex; justify-content: space-around; width: 100%; flex-direction: column; padding-bottom: 10px; padding-top: 10px;'>
					<div style = 'display: flex; flex-direction: row;'>
					<button className = 'button is-primary' style = 'flex-grow: 1; margin-left: 5px; margin-right: 5px;' onClick = { approve } >
							Grant Access
						</button>
						<button className = 'button is-primary is-danger' style = 'flex-grow: 1; margin-left: 5px; margin-right: 5px;' onClick = { reject } >
							Deny Access
						</button>
					</div>
				</nav>
			</div>
		</Hint>
	</main>
}
