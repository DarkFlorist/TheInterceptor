import { useState, useEffect } from 'preact/hooks'
import { ActiveAddress, BigAddress, WebsiteOriginText } from '../subcomponents/address.js'
import { AddNewAddress } from './AddNewAddress.js'
import { AddressInfoEntry, AddressBookEntry, AddingNewAddressType, RenameAddressCallBack } from '../../utils/user-interface-types.js'
import { ExternalPopupMessage, PendingAccessRequest, PendingAccessRequestArray } from '../../utils/interceptor-messages.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import Hint from '../subcomponents/Hint.js'
import { convertNumberToCharacterRepresentationIfSmallEnough, tryFocusingTab } from '../ui-utils.js'
import { ChangeActiveAddress } from './ChangeActiveAddress.js'
import { DinoSays, DinoSaysNotification } from '../subcomponents/DinoSays.js'
import { getPrettySignerName } from '../subcomponents/signers.js'

const HALF_HEADER_HEIGHT = 48 / 2

type AccessRequestHeaderParams = {
	pendingAccessRequest: PendingAccessRequest
}

function Title({ icon, title} : {icon: string | undefined, title: string}) {
	return <p style = 'font-weight: 700; line-height: 48px'>
		{ icon === undefined
			? <></>
			: <img src = { icon } style = 'width: 48px; height: 48px; vertical-align: bottom; margin-right: 10px;'/>
		}
		{ title }
	</p>
}

function AccessRequestHeader(param: AccessRequestHeaderParams) {
	return <header class = 'card-header'>
		<div class = 'card-header-icon unset-cursor'>
			{ param.pendingAccessRequest.website.icon === undefined
				? <></>
				: <img src = { param.pendingAccessRequest.website.icon } style = 'width: 48px; height: 48px; vertical-align: bottom; margin-right: 10px;'/>
			}
		</div>
		<p class = 'card-header-title' style = 'white-space: nowrap;'>
			<WebsiteOriginText { ...param.pendingAccessRequest.website } />
		</p>
	</header>
}

type UnderTransactionsParams = {
	reversedPendingAccessRequestArray: PendingAccessRequestArray
}

//todo, maybe make generic component out if this (shares code with same in confirm transaction)
function UnderAccesses(param: UnderTransactionsParams) {
	const nTx = param.reversedPendingAccessRequestArray.length
	return <div style = {`position: relative; top: ${ nTx * -HALF_HEADER_HEIGHT }px;`}>
		{ param.reversedPendingAccessRequestArray.map((pendingAccessRequest, index) => {
			const style = `margin-right: 10px; margin-left: 10px; margin-bottom: 0px; scale: ${ Math.pow(0.95, nTx - index) }; position: relative; top: ${ (nTx - index) * HALF_HEADER_HEIGHT }px;`
			return <div class = 'card' style = { style }>
				<AccessRequestHeader pendingAccessRequest = { pendingAccessRequest } />
				<div style = 'background-color: var(--disabled-card-color); position: absolute; width: 100%; height: 100%; top: 0px'></div>
			</div>
		}) }
	</div>
}

function AssociatedTogether({ associatedAddresses, renameAddressCallBack }: { associatedAddresses: readonly AddressInfoEntry[], renameAddressCallBack: RenameAddressCallBack } ) {
	const [showLogs, setShowLogs] = useState<boolean>(associatedAddresses.length > 1)

	return <>
		<div class = 'card' style = 'margin-top: 10px; margin-bottom: 10px'>
			<header class = 'card-header noselect' style = 'cursor: pointer; height: 30px;' onClick = { () => setShowLogs((prevValue) => !prevValue) }>
				<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em;'>
					{ associatedAddresses.length <= 1
						? 'The website cannot associate any addresses with each other'
						: <> There are&nbsp;
							<p style = 'font-weight: 700'>{ convertNumberToCharacterRepresentationIfSmallEnough(associatedAddresses.length).toUpperCase() } </p>
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
		<div class = 'card' style = { `margin: 10px; margin-top: 0px; top: ${ (param.pendingAccessRequestArray.length - 1) * -HALF_HEADER_HEIGHT }px` }>
			<header class = 'card-header window-header' style = 'height: 40px; border-top-left-radius: 0px; border-top-right-radius: 0px'>
				<div class = 'card-header-icon noselect nopointer' style = 'width: 100%'>
					<WebsiteOriginText { ...firstPendingRequest.website } />
				</div>
			</header>
			<div style = 'overflow-y: auto; padding: 10px'>
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
	const [pendingAccessRequestArray, setAccessRequest] = useState<PendingAccessRequestArray | undefined>(undefined)
	const [addingNewAddress, setAddingNewAddress] = useState<AddingNewAddressType> ({ addingAddress: true, type: 'addressInfo' })
	const [appPage, setAppPage] = useState('Home')
	const [informationUpdatedTimestamp, setInformationUpdatedTimestamp] = useState(0)
	const [, setTimeSinceInformationUpdate] = useState(0)

	useEffect(() => {
		async function popupMessageListener(msg: unknown) {
			const message = ExternalPopupMessage.parse(msg)
			if (message.method === 'popup_addressBookEntriesChanged') return refreshMetadata()
			if (message.method !== 'popup_interceptorAccessDialog') return
			setAccessRequest(message.data)
			if (pendingAccessRequestArray !== undefined) {
				setInformationUpdatedTimestamp(Date.now())
			}
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		sendPopupMessageToBackgroundPage( { method: 'popup_interceptorAccessReadyAndListening' } )
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	async function approve(accessRequest: PendingAccessRequest) {
		if (pendingAccessRequestArray === undefined) return
		const options = {
			userReply: 'Approved' as const,
			websiteOrigin: accessRequest.website.websiteOrigin,
			requestAccessToAddress: accessRequest.requestAccessToAddress?.address,
			originalRequestAccessToAddress: accessRequest.originalRequestAccessToAddress?.address,
			requestId: accessRequest.requestId,
		}
		await tryFocusingTab(accessRequest.dialogId)
		await sendPopupMessageToBackgroundPage({ method: 'popup_interceptorAccess', options })
		globalThis.close()
	}

	async function reject(accessRequest: PendingAccessRequest) {
		if (pendingAccessRequestArray === undefined) return
		const options = {
			userReply: 'Rejected' as const,
			websiteOrigin: accessRequest.website.websiteOrigin,
			requestAccessToAddress: accessRequest.requestAccessToAddress?.address,
			originalRequestAccessToAddress: accessRequest.originalRequestAccessToAddress?.address,
			requestId: accessRequest.requestId,
		}
		await tryFocusingTab(accessRequest.dialogId)
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

	async function refreshMetadata() {
		await sendPopupMessageToBackgroundPage({ method: 'popup_refreshInterceptorAccessMetadata' })
	}

	async function refreshActiveAddress(accessRequest: PendingAccessRequest) {
		if (accessRequest === undefined) throw Error('access request not loaded')
		await sendPopupMessageToBackgroundPage({ method: 'popup_interceptorAccessRefresh', options: {
			socket: accessRequest.socket,
			website: accessRequest.website,
			requestAccessToAddress: accessRequest.requestAccessToAddress?.address,
			requestId: accessRequest.requestId,
		} } )
	}

	async function setActiveAddressAndInformAboutIt(accessRequest: PendingAccessRequest, address: bigint | 'signer') {
		if (accessRequest === undefined) throw Error('access request not loaded')
		await sendPopupMessageToBackgroundPage({ method: 'popup_interceptorAccessChangeAddress', options: {
			socket: accessRequest.socket,
			website: accessRequest.website,
			requestAccessToAddress: accessRequest.requestAccessToAddress?.address,
			newActiveAddress: address,
			requestId: accessRequest.requestId,
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

	if (pendingAccessRequestArray === undefined) return <main></main>

	return <main>
		<Hint>
			<div class = { `modal ${ appPage !== 'Home' ? 'is-active' : ''}` }>
				{ appPage === 'AddNewAddress' || appPage === 'ModifyAddress'
					? <AddNewAddress
						setActiveAddressAndInformAboutIt = { setActiveAddressAndInformAboutIt }
						addingNewAddress = { appPage === 'AddNewAddress' ? { addingAddress: true, type: 'addressInfo' } : addingNewAddress }
						close = { () => setAppPage('Home') }
						activeAddress = { accessRequest.requestAccessToAddress?.address }
					/>
					: <></>
				}

				{ appPage === 'ChangeActiveAddress'
					? <ChangeActiveAddress
						setActiveAddressAndInformAboutIt = { setActiveAddressAndInformAboutIt }
						signerAccounts = { accessRequest.signerAccounts }
						setAndSaveAppPage = { setAppPage }
						addressInfos = { accessRequest.addressInfos }
						signerName = { accessRequest.signerName }
						renameAddressCallBack = { renameAddressCallBack }
					/>
					: <></>
				}
			</div>

			<div class = 'block popup-block'>
				<div style = 'overflow-y: auto'>
					{ pendingTransactionAddedNotification === true
						? <DinoSaysNotification
							text = { `Hey! A new transaction request was queued. Accept or Reject the previous transaction${ pendingTransactions.length > 1 ? 's' : '' } to see the new one.` }
							close = { () => setPendingTransactionAddedNotification(false)}
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
