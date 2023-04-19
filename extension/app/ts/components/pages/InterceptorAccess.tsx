import { useState, useEffect } from 'preact/hooks'
import { ActiveAddress, BigAddress, WebsiteOriginText } from '../subcomponents/address.js'
import { AddNewAddress } from './AddNewAddress.js'
import { AddressInfoEntry, AddressBookEntry, AddingNewAddressType, RenameAddressCallBack, AddressInfo, Website, WebsiteSocket } from '../../utils/user-interface-types.js'
import { ExternalPopupMessage, SignerName } from '../../utils/interceptor-messages.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import Hint from '../subcomponents/Hint.js'
import { convertNumberToCharacterRepresentationIfSmallEnough } from '../ui-utils.js'
import { ChangeActiveAddress } from './ChangeActiveAddress.js'
import { DinoSays } from '../subcomponents/DinoSays.js'
import { getPrettySignerName } from '../subcomponents/signers.js'

function AssociatedTogether({ associatedAddresses, renameAddressCallBack }: { associatedAddresses: readonly AddressInfoEntry[], renameAddressCallBack: RenameAddressCallBack } ) {
	const [showLogs, setShowLogs] = useState<boolean>(associatedAddresses.length > 1)

	return <>
		<div class = 'card' style = 'margin-top: 10px; margin-bottom: 10px'>
			<header class = 'card-header noselect' style = 'cursor: pointer; height: 30px;' onClick = { () => setShowLogs((prevValue) => !prevValue) }>
				<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em;'>
					{ associatedAddresses.length <= 1 ? 'The website cannot associate any addresses with each other' : <>
						There are&nbsp;
						<p style = 'font-weight: 700'>{ convertNumberToCharacterRepresentationIfSmallEnough(associatedAddresses.length).toUpperCase() } </p>
						&nbsp;addresses that the website can associate together with
					</> }
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

function Title({ icon, title} : {icon: string | undefined, title: string}) {
	return <p style = 'font-weight: 700; line-height: 48px'>
		{ icon === undefined ? <></> :
			<img src = { icon } style = 'width: 48px; height: 48px; vertical-align: bottom; margin-right: 10px;'/>
		}
		{ title }
	</p>
}

function AccessRequest({ renameAddressCallBack, accessRequest, changeActiveAddress, refreshActiveAddress }: { renameAddressCallBack: RenameAddressCallBack, accessRequest: InterceptorAccessRequest, changeActiveAddress: () => void, refreshActiveAddress: () => void }) {
	return <>
		{ accessRequest.requestAccessToAddress === undefined ?
		<div style = 'margin: 10px'>
			<p className = 'title is-4' style = 'text-align: center; margin-top: 40px; margin-bottom: 40px;'>
				<Title icon = { accessRequest.website.icon } title = { accessRequest.website.title === undefined ? accessRequest.website.websiteOrigin : accessRequest.website.title }/>
				would like to connect to The Interceptor
			</p>
		</div> :
			<>
				<div class = 'notification' style = 'background-color: var(--importance-box-color); color: var(--text-color)'>
					<p className = 'title is-3' style = 'text-align: center; margin-bottom: 10px;'>
						<Title icon = { accessRequest.website.icon } title = { accessRequest.website.title === undefined ? accessRequest.website.websiteOrigin : accessRequest.website.title }/>
						would like to connect to your account:
					</p>
					<div class = 'notification' style = 'padding: 10px; background-color: var(--alpha-015); justify-content: center; '>
						{ accessRequest.simulationMode ?
							<ActiveAddress
								activeAddress = { accessRequest.requestAccessToAddress }
								renameAddressCallBack = { renameAddressCallBack }
								changeActiveAddress = { changeActiveAddress }
								buttonText = { 'Change' }
								disableButton = { false }
							/> : <>
								<ActiveAddress
									activeAddress = { accessRequest.requestAccessToAddress }
									renameAddressCallBack = { renameAddressCallBack }
									changeActiveAddress = { refreshActiveAddress }
									disableButton = { false }
									buttonText = { 'Refresh' }
								/>
								<p style = 'color: var(--subtitle-text-color); white-space: normal;' class = 'subtitle is-7'>
									{ `You can change active address by changing it directly from ${ getPrettySignerName(accessRequest.signerName) } and clicking refresh here afterwards` }
								</p>
							</>
						}
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
	website: Website,
	requestAccessToAddress: AddressInfoEntry | undefined
	originalRequestAccessToAddress: AddressInfoEntry | undefined
	associatedAddresses: readonly AddressInfoEntry[]
	addressInfos: readonly AddressInfo[]
	signerAccounts: readonly bigint[]
	signerName: SignerName
	simulationMode: boolean
	socket: WebsiteSocket
}

export function InterceptorAccess() {
	const [accessRequest, setAccessRequest] = useState<InterceptorAccessRequest | undefined>(undefined)
	const [addingNewAddress, setAddingNewAddress] = useState<AddingNewAddressType> ({ addingAddress: true, type: 'addressInfo' as const })
	const [appPage, setAppPage] = useState('Home')

	useEffect( () => {
		async function popupMessageListener(msg: unknown) {
			const message = ExternalPopupMessage.parse(msg)
			if (message.method === 'popup_addressBookEntriesChanged') return refreshMetadata()
			if (message.method !== 'popup_interceptorAccessDialog') return
			setAccessRequest(message.data)
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		sendPopupMessageToBackgroundPage( { method: 'popup_interceptorAccessReadyAndListening' } )
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	async function approve() {
		if (accessRequest === undefined) return
		const options = {
			approval: 'Approved' as const,
			websiteOrigin: accessRequest.website.websiteOrigin,
			requestAccessToAddress: accessRequest.requestAccessToAddress?.address,
			originalRequestAccessToAddress: accessRequest.originalRequestAccessToAddress?.address,
		}
		await sendPopupMessageToBackgroundPage({ method: 'popup_interceptorAccess', options })
		globalThis.close()
	}

	async function reject() {
		if (accessRequest === undefined) return
		const options = {
			approval: 'Rejected' as const,
			websiteOrigin: accessRequest.website.websiteOrigin,
			requestAccessToAddress: accessRequest.requestAccessToAddress?.address,
			originalRequestAccessToAddress: accessRequest.originalRequestAccessToAddress?.address,
		}
		await sendPopupMessageToBackgroundPage({ method: 'popup_interceptorAccess', options })
		globalThis.close()
	}

	function renameAddressCallBack(entry: AddressBookEntry) {
		setAppPage('ModifyAddress')
		setAddingNewAddress({ addingAddress: false, entry: entry })
	}

	function changeActiveAddress() {
		setAppPage('ChangeActiveAddress')
	}

	function refreshMetadata() {
		if (accessRequest === undefined || accessRequest.requestAccessToAddress?.address === undefined || accessRequest.originalRequestAccessToAddress?.address === undefined) return
		const options = {
			socket: accessRequest.socket,
			website: accessRequest.website,
			websiteOrigin: accessRequest.website.websiteOrigin,
			requestAccessToAddress: accessRequest.requestAccessToAddress.address,
			originalRequestAccessToAddress: accessRequest.originalRequestAccessToAddress.address,
		}
		sendPopupMessageToBackgroundPage({ method: 'popup_refreshInterceptorAccessMetadata', options })
	}

	function refreshActiveAddress() {
		if (accessRequest === undefined) throw Error('access request not loaded')
		sendPopupMessageToBackgroundPage({ method: 'popup_interceptorAccessRefresh', options: {
			socket: accessRequest.socket,
			website: accessRequest.website,
			requestAccessToAddress: accessRequest.requestAccessToAddress?.address,
		} } )
	}

	function setActiveAddressAndInformAboutIt(address: bigint | 'signer') {
		if (accessRequest === undefined) throw Error('access request not loaded')
		sendPopupMessageToBackgroundPage({ method: 'popup_interceptorAccessChangeAddress', options: {
			socket: accessRequest.socket,
			website: accessRequest.website,
			requestAccessToAddress: accessRequest.requestAccessToAddress?.address,
			newActiveAddress: address,
		} } )
	}

	if (accessRequest === undefined) return <main></main>

	return <main>
		<Hint>
			<div class = { `modal ${ appPage !== 'Home' ? 'is-active' : ''}` }>
				{ appPage === 'AddNewAddress' || appPage === 'ModifyAddress' ?
					<AddNewAddress
						setActiveAddressAndInformAboutIt = { setActiveAddressAndInformAboutIt }
						addingNewAddress = { appPage === 'AddNewAddress' ? { addingAddress: true, type: 'addressInfo' } : addingNewAddress }
						close = { () => setAppPage('Home') }
						activeAddress = { accessRequest.requestAccessToAddress?.address }
					/>
					: <></> }

				{ appPage === 'ChangeActiveAddress' ?
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

			<div className = 'block' style = 'margin-bottom: 0px; display: flex; justify-content: space-between; flex-direction: column; height: 100%; position: fixed; width: 100%; background-color: var(--card-content-bg-color);'>
				<header class = 'card-header window-header' style = 'height: 40px; border-top-left-radius: 0px; border-top-right-radius: 0px'>
					<div class = 'card-header-icon noselect nopointer' style = 'overflow: hidden; padding: 0px;'>
						<WebsiteOriginText { ...accessRequest.website } />
					</div>
				</header>
				<div style = 'overflow-y: auto; padding: 10px'>
					<AccessRequest
						renameAddressCallBack = { renameAddressCallBack }
						accessRequest = { accessRequest }
						changeActiveAddress = { changeActiveAddress }
						refreshActiveAddress = { refreshActiveAddress }
					/>
				</div>
				<nav class = 'window-header' style = 'display: flex; justify-content: space-around; width: 100%; flex-direction: column; padding-bottom: 10px; padding-top: 10px;'>
					<div style = 'display: flex; flex-direction: row;'>
						<button className = 'button is-primary is-danger' style = 'flex-grow: 1; margin-left: 5px; margin-right: 5px;' onClick = { reject } >
							Deny Access
						</button>
						<button className = 'button is-primary' style = 'flex-grow: 1; margin-left: 5px; margin-right: 5px;' onClick = { approve } >
							Grant Access
						</button>
					</div>
				</nav>
			</div>
		</Hint>
	</main>
}
