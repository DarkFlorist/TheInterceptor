import { useState, useEffect } from 'preact/hooks'
import { ActiveAddressComponent, BigAddress, WebsiteOriginText } from '../subcomponents/address.js'
import { AddNewAddress } from './AddNewAddress.js'
import { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { ExternalPopupMessage } from '../../types/interceptor-messages.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import Hint from '../subcomponents/Hint.js'
import { convertNumberToCharacterRepresentationIfSmallEnough, tryFocusingTabOrWindow } from '../ui-utils.js'
import { ChangeActiveAddress } from './ChangeActiveAddress.js'
import { DinoSays, DinoSaysNotification } from '../subcomponents/DinoSays.js'
import { getPrettySignerName } from '../subcomponents/signers.js'
import { checksummedAddress } from '../../utils/bigint.js'
import { ActiveAddressEntry, AddressBookEntry, IncompleteAddressBookEntry } from '../../types/addressBookTypes.js'
import { Website } from '../../types/websiteAccessTypes.js'
import { PendingAccessRequest, PendingAccessRequestArray } from '../../types/accessRequest.js'

const HALF_HEADER_HEIGHT = 48 / 2

function Title({ icon, title} : {icon: string | undefined, title: string}) {
	return <span style = 'font-weight: 700; line-height: 48px'>
		{ icon === undefined
			? <></>
			: <img src = { icon } style = 'width: 48px; height: 48px; vertical-align: bottom; margin-right: 10px;'/>
		}
		{ title }
	</span>
}

function AccessRequestHeader(website: Website) {
	return <header class = 'card-header' style = 'height: 40px'>
		<div class = 'card-header-icon noselect nopointer' style = 'width: 100%;'>
			<WebsiteOriginText { ...website } />
		</div>
	</header>
}

type UnderTransactionsParams = {
	reversedPendingAccessRequestArray: PendingAccessRequestArray
}

function UnderAccesses(param: UnderTransactionsParams) {
	const nTx = param.reversedPendingAccessRequestArray.length
	return <div style = {`position: relative; top: ${ nTx * -HALF_HEADER_HEIGHT }px;`}>
		{ param.reversedPendingAccessRequestArray.map((pendingAccessRequest, index) => {
			const style = `margin-bottom: 0px; scale: ${ Math.pow(0.95, nTx - index) }; position: relative; top: ${ (nTx - index) * HALF_HEADER_HEIGHT }px;`
			return <div class = 'card' style = { style }>
				<AccessRequestHeader { ...pendingAccessRequest.website } />
				<div style = 'background-color: var(--disabled-card-color); position: absolute; width: 100%; height: 100%; top: 0px'></div>
			</div>
		}) }
	</div>
}

function AssociatedTogether({ associatedAddresses, renameAddressCallBack }: { associatedAddresses: readonly ActiveAddressEntry[], renameAddressCallBack: RenameAddressCallBack } ) {
	const [showLogs, setShowLogs] = useState<boolean>(associatedAddresses.length > 1)

	return <>
		<div class = 'card' style = 'margin-top: 10px; margin-bottom: 10px;'>
			<header class = 'card-header noselect' style = 'cursor: pointer; height: 30px;' onClick = { () => setShowLogs((prevValue) => !prevValue) }>
				<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em;'>
					{ associatedAddresses.length <= 1
						? 'The website cannot associate any addresses with each other'
						: <> There are&nbsp;
							<b>{ convertNumberToCharacterRepresentationIfSmallEnough(associatedAddresses.length).toUpperCase() } </b>
							&nbsp;addresses that the website can associate together with
						</>
					}
				</p>
				<div class = 'card-header-icon'>
					<span class = 'icon' style = 'color: var(--text-color); font-weight: unset; font-size: 0.8em;'> V </span>
				</div>
			</header>
			{ !showLogs
				? <></>
				: <div class = 'card-content' style = 'border-bottom-left-radius: 0.25rem; border-bottom-right-radius: 0.25rem; border-left: 2px solid var(--card-bg-color); border-right: 2px solid var(--card-bg-color); border-bottom: 2px solid var(--card-bg-color);'>
					{ associatedAddresses.length <= 1
						? <DinoSays text = { 'Given its size, a tiny dinosaur wouldn\'t be expected to know any...' } />
						: <ul>
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
			}
		</div>
	</>
}

function AccessRequest({ renameAddressCallBack, accessRequest, changeActiveAddress, refreshActiveAddress }: { renameAddressCallBack: RenameAddressCallBack, accessRequest: PendingAccessRequest, changeActiveAddress: () => void, refreshActiveAddress: () => void }) {
	return <>
		{ accessRequest.requestAccessToAddress === undefined ?
		<div style = 'margin: 10px'>
			<p className = 'title is-4' style = 'text-align: center; margin-top: 40px; margin-bottom: 40px;'>
				<Title icon = { accessRequest.website.icon } title = { accessRequest.website.title === undefined ? accessRequest.website.websiteOrigin : accessRequest.website.title }/>
				&nbsp;would like to connect to The Interceptor
			</p>
		</div> :
			<>
				<div class = 'notification' style = 'background-color: var(--importance-box-color); color: var(--text-color)'>
					<p className = 'title is-3' style = 'text-align: center; margin-bottom: 10px;'>
						<Title icon = { accessRequest.website.icon } title = { accessRequest.website.title === undefined ? accessRequest.website.websiteOrigin : accessRequest.website.title }/>
						&nbsp;would like to connect to your account:
					</p>
					<div class = 'notification' style = 'padding: 10px; background-color: var(--alpha-015); justify-content: center; '>
						{ accessRequest.simulationMode ?
							<ActiveAddressComponent
								activeAddress = { accessRequest.requestAccessToAddress }
								renameAddressCallBack = { renameAddressCallBack }
								changeActiveAddress = { changeActiveAddress }
								buttonText = { 'Change' }
								disableButton = { false }
							/> : <>
								<ActiveAddressComponent
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

type AccessRequestParam = {
	renameAddressCallBack: (entry: AddressBookEntry) => void
	pendingAccessRequestArray: PendingAccessRequestArray
	changeActiveAddress: () => void
	refreshActiveAddress: () => void
}

function AccessRequests(param: AccessRequestParam) {
	const firstPendingRequest = param.pendingAccessRequestArray.at(0)
	if (firstPendingRequest === undefined) return <></>
	return <>
		<UnderAccesses
			reversedPendingAccessRequestArray = { param.pendingAccessRequestArray.slice(1).reverse() }
		/>
		<div class = 'card' style = { `top: ${ (param.pendingAccessRequestArray.length - 1) * -HALF_HEADER_HEIGHT }px` }>
			<AccessRequestHeader { ...firstPendingRequest.website } />
			<div class = 'card-content' style = 'padding-bottom: 5px;'>
				<AccessRequest
					renameAddressCallBack = { param.renameAddressCallBack }
					accessRequest = { firstPendingRequest }
					changeActiveAddress = { param.changeActiveAddress }
					refreshActiveAddress = { param.refreshActiveAddress }
				/>
			</div>
		</div>
	</>
}

const DISABLED_DELAY_MS = 3000

export function InterceptorAccess() {
	const [pendingAccessRequestArray, setAccessRequest] = useState<PendingAccessRequestArray>([])
	const [addingNewAddress, setAddingNewAddress] = useState<IncompleteAddressBookEntry> ({ addingAddress: false, type: 'activeAddress', address: undefined, askForAddressAccess: false, name: undefined, symbol: undefined, decimals: undefined, logoUri: undefined, entrySource: 'FilledIn' })
	const [appPage, setAppPage] = useState('Home')
	const [informationUpdatedTimestamp, setInformationUpdatedTimestamp] = useState(0)
	const [, setTimeSinceInformationUpdate] = useState(0)
	const [pendingRequestAddedNotification, setPendingRequestAddedNotification] = useState<boolean>(false)

	useEffect(() => {
		async function popupMessageListener(msg: unknown) {
			const message = ExternalPopupMessage.parse(msg)
			if (message.method === 'popup_addressBookEntriesChanged') return refreshMetadata()
			if (message.method === 'popup_websiteAccess_changed') return refreshMetadata()
			if (message.method === 'popup_interceptorAccessDialog' || message.method === 'popup_interceptor_access_dialog_pending_changed') {
				if (message.method === 'popup_interceptor_access_dialog_pending_changed') {
					if (pendingAccessRequestArray.length > 0) setInformationUpdatedTimestamp(Date.now())
					setPendingRequestAddedNotification(true)
				}
				setAccessRequest(message.data)
				const currentWindowId = (await browser.windows.getCurrent()).id
				const currentTabId = (await browser.tabs.getCurrent()).id
				if (currentWindowId === undefined) throw new Error('could not get current window Id!')
				if (currentTabId === undefined) throw new Error('could not get current tab Id!')
				return
			}
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	
	useEffect(() => { sendPopupMessageToBackgroundPage({ method: 'popup_interceptorAccessReadyAndListening' }) }, [])

	async function approve() {
		if (pendingAccessRequestArray.length === 0) throw Error('access request not loaded')
		const accessRequest = pendingAccessRequestArray[0]
		const data = {
			userReply: 'Approved' as const,
			websiteOrigin: accessRequest.website.websiteOrigin,
			requestAccessToAddress: accessRequest.requestAccessToAddress?.address,
			originalRequestAccessToAddress: accessRequest.originalRequestAccessToAddress?.address,
			accessRequestId: accessRequest.accessRequestId,
		}
		setPendingRequestAddedNotification(false)
		setInformationUpdatedTimestamp(Date.now())
		if (pendingAccessRequestArray.length === 1) await tryFocusingTabOrWindow({ type: 'tab', id: accessRequest.socket.tabId })
		await sendPopupMessageToBackgroundPage({ method: 'popup_interceptorAccess', data })
	}

	async function reject() {
		if (pendingAccessRequestArray.length === 0) throw Error('access request not loaded')
		const accessRequest = pendingAccessRequestArray[0]
		const data = {
			userReply: 'Rejected' as const,
			websiteOrigin: accessRequest.website.websiteOrigin,
			requestAccessToAddress: accessRequest.requestAccessToAddress?.address,
			originalRequestAccessToAddress: accessRequest.originalRequestAccessToAddress?.address,
			accessRequestId: accessRequest.accessRequestId,
		}
		setPendingRequestAddedNotification(false)
		setInformationUpdatedTimestamp(Date.now())
		if (pendingAccessRequestArray.length === 1) await tryFocusingTabOrWindow({ type: 'tab', id: accessRequest.socket.tabId })
		await sendPopupMessageToBackgroundPage({ method: 'popup_interceptorAccess', data })
	}

	function renameAddressCallBack(entry: AddressBookEntry) {
		setAppPage('ModifyAddress')
		setAddingNewAddress({
			addingAddress: false,
			askForAddressAccess: false,
			symbol: undefined,
			decimals: undefined,
			logoUri: undefined,
			...entry,
			address: checksummedAddress(entry.address)
		})
	}

	function changeActiveAddress() {
		setAppPage('ChangeActiveAddress')
	}

	async function refreshMetadata() {
		await sendPopupMessageToBackgroundPage({ method: 'popup_refreshInterceptorAccessMetadata' })
	}

	async function refreshActiveAddress() {
		if (pendingAccessRequestArray.length === 0) throw Error('access request not loaded')
		const accessRequest = pendingAccessRequestArray[0]
		await sendPopupMessageToBackgroundPage({ method: 'popup_interceptorAccessRefresh', data: {
			socket: accessRequest.socket,
			website: accessRequest.website,
			requestAccessToAddress: accessRequest.requestAccessToAddress?.address,
			accessRequestId: accessRequest.accessRequestId,
		} } )
	}

	async function setActiveAddressAndInformAboutIt(address: bigint | 'signer') {
		if (pendingAccessRequestArray.length === 0) throw Error('access request not loaded')
		const accessRequest = pendingAccessRequestArray[0]
		await sendPopupMessageToBackgroundPage({ method: 'popup_interceptorAccessChangeAddress', data: {
			socket: accessRequest.socket,
			website: accessRequest.website,
			requestAccessToAddress: accessRequest.requestAccessToAddress?.address,
			newActiveAddress: address,
			accessRequestId: accessRequest.accessRequestId,
		} } )
	}

	const informationChangedRecently = () => new Date().getTime() < informationUpdatedTimestamp + DISABLED_DELAY_MS

	useEffect(() => {
		const id = setInterval(() => setTimeSinceInformationUpdate((old) => old + 1), 1000)
		return () => clearInterval(id)
	}, [])

	function Buttons() {
		return <div style = 'display: flex; flex-direction: row;'>
			<button className = 'button is-primary is-danger' style = 'flex-grow: 1; margin-left: 5px; margin-right: 5px;' onClick = { reject } disabled = { informationChangedRecently() }>
				Deny Access
			</button>
			<button className = 'button is-primary' style = 'flex-grow: 1; margin-left: 5px; margin-right: 5px;' onClick = { approve } disabled = { informationChangedRecently() }>
				Grant Access
			</button>
		</div>
	}	
	function addNewAddress() {
		setAppPage('AddNewAddress')
		setAddingNewAddress({
			addingAddress: true,
			symbol: undefined,
			decimals: undefined,
			logoUri: undefined,
			type: 'activeAddress',
			name: undefined,
			address: undefined,
			askForAddressAccess: true,
			entrySource: 'FilledIn',
		} )
	}

	if (pendingAccessRequestArray.length === 0) return <main></main>

	return <main>
		<Hint>
			<div class = { `modal ${ appPage !== 'Home' ? 'is-active' : ''}` }>
				{ appPage === 'AddNewAddress' || appPage === 'ModifyAddress'
					? <AddNewAddress
						setActiveAddressAndInformAboutIt = { setActiveAddressAndInformAboutIt }
						incompleteAddressBookEntry = { addingNewAddress }
						close = { () => setAppPage('Home') }
						activeAddress = { pendingAccessRequestArray[0].requestAccessToAddress?.address }
					/>
					: <></>
				}

				{ appPage === 'ChangeActiveAddress'
					? <ChangeActiveAddress
						setActiveAddressAndInformAboutIt = { setActiveAddressAndInformAboutIt }
						signerAccounts = { pendingAccessRequestArray[0].signerAccounts }
						setAndSaveAppPage = { setAppPage }
						activeAddresses = { pendingAccessRequestArray[0].activeAddresses }
						signerName = { pendingAccessRequestArray[0].signerName }
						renameAddressCallBack = { renameAddressCallBack }
						addNewAddress = { addNewAddress }
					/>
					: <></>
				}
			</div>

			<div class = 'block popup-block'>
				<div class = 'popup-block-scroll'>
					{ pendingRequestAddedNotification === true
						? <DinoSaysNotification
							text = { `Hey! A new request was queued. Accept or Reject the previous request${ pendingAccessRequestArray.length > 1 ? 's' : '' } to see the new one.` }
							close = { () => setPendingRequestAddedNotification(false)}
						/>
						: <></>
					}
					<AccessRequests
						changeActiveAddress = { changeActiveAddress }
						renameAddressCallBack = { renameAddressCallBack }
						pendingAccessRequestArray = { pendingAccessRequestArray }
						refreshActiveAddress = { refreshActiveAddress }
					/>
				</div>
				<nav class = 'window-header popup-button-row'>
					<Buttons/>
				</nav>
			</div>
		</Hint>
	</main>
}
