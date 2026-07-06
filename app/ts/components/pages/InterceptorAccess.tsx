import { useEffect } from 'preact/hooks'
import { ActiveAddressComponent, BigAddress, WebsiteOriginText } from '../subcomponents/address.js'
import { AddNewAddress } from './AddNewAddress.js'
import type { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import Hint from '../subcomponents/Hint.js'
import { addressEditEntry, convertNumberToCharacterRepresentationIfSmallEnough, tryFocusingTabOrWindow } from '../ui-utils.js'
import { ChangeActiveAddress } from './ChangeActiveAddress.js'
import { DinoSays } from '../subcomponents/DinoSays.js'
import { getPrettySignerName } from '../subcomponents/signers.js'
import type { AddressBookEntries, AddressBookEntry } from '../../types/addressBookTypes.js'
import type { Website } from '../../types/websiteAccessTypes.js'
import type { PendingAccessRequest, PendingAccessRequests } from '../../types/accessRequest.js'
import { type ReadonlySignal, Signal, useComputed, useSignal } from '@preact/signals'
import type { RpcEntries } from '../../types/rpc.js'
import type { ModifyAddressWindowState } from '../../types/visualizer-types.js'
import { ChevronIcon } from '../subcomponents/icons.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'
import { sendPopupReadyAndListening } from '../../background/backgroundUtils.js'
import { sanitizeStoredWebsiteIcon } from '../../utils/websiteIcons.js'
import { AsyncActionButton } from '../subcomponents/AsyncAction.js'
import { useAsyncState } from '../../utils/preact-utilities.js'

function Title({ icon, title} : {icon: string | undefined, title: string}) {
	const websiteIcon = sanitizeStoredWebsiteIcon(icon)
	return <span style = 'font-weight: 900; line-height: 48px'>
		{ websiteIcon === undefined
			? <></>
			: <img src = { websiteIcon } width = '48' height = '48' style = 'width: 48px; height: 48px; vertical-align: bottom; margin-right: 10px;'/>
		}
		{ title }
	</span>
}

function AccessRequestHeader(website: Website) {
	return <header class = 'card-header' style = 'height: 40px'>
		<div class = 'card-header-icon noselect nopointer' style = 'width: 100%;'>
			<WebsiteOriginText website = { website } />
		</div>
	</header>
}

function AssociatedTogether({ associatedAddresses, renameAddressCallBack }: { associatedAddresses: AddressBookEntries, renameAddressCallBack: RenameAddressCallBack } ) {
	const showLogs = useSignal<boolean>(associatedAddresses.length > 1)

	return <>
		<div class = 'card' style = 'margin-top: 10px; margin-bottom: 10px;'>
			<header class = 'card-header noselect' style = 'cursor: pointer; height: 30px;' onClick = { () => { showLogs.value = !showLogs.value } }>
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
					<span class = 'icon'><ChevronIcon /></span>
				</div>
			</header>
			{ !showLogs.value
				? <></>
				: <div class = 'card-content' style = 'border-bottom-left-radius: 0.25rem; border-bottom-right-radius: 0.25rem; border-left: 2px solid var(--card-bg-color); border-right: 2px solid var(--card-bg-color); border-bottom: 2px solid var(--card-bg-color);'>
					{ associatedAddresses.length <= 1
						? <DinoSays text = { 'Given its size, a tiny dinosaur wouldn\'t be expected to know any...' } />
						: <ul>
							{ associatedAddresses.map( (info, index) => (
								<li key = { info.address.toString() } style = { `margin: 0px; margin-bottom: ${ index < associatedAddresses.length - 1  ? '10px;' : '0px' }` } >
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

function AccessRequest({ renameAddressCallBack, accessRequest, changeActiveAddress, refreshActiveAddress }: { renameAddressCallBack: (entry: AddressBookEntry) => void, accessRequest: PendingAccessRequest, changeActiveAddress: () => void, refreshActiveAddress: () => Promise<void> }) {
	return <>
		{ accessRequest.requestAccessToAddress === undefined ?
		<div style = 'margin: 10px'>
			<p class = 'title is-4' style = 'text-align: center; margin-top: 40px; margin-bottom: 40px;'>
				<Title icon = { accessRequest.website.icon } title = { accessRequest.website.title === undefined ? accessRequest.website.websiteOrigin : accessRequest.website.title }/>
				<br/>
				would like to connect to The Interceptor
			</p>
		</div> :
			<>
				<div class = 'notification' style = 'background-color: var(--importance-box-color); color: var(--text-color)'>
					<p class = 'title is-3' style = 'text-align: center; margin-bottom: 10px;'>
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
	renameAddressCallBack: (accessRequestId: string, entry: AddressBookEntry) => void
	pendingAccessRequests: PendingAccessRequests
	changeActiveAddress: (accessRequestId: string) => void
	refreshActiveAddress: (accessRequestId: string) => Promise<void>
	approve: (accessRequestId: string) => void
	reject: (accessRequestId: string) => void
	informationChangedRecently: ReadonlySignal<boolean>
}

function AccessRequests(param: AccessRequestParam) {

	const AccessRequestActions = ({ accessRequest, reject, approve, informationChangedRecently }: {
		accessRequest: PendingAccessRequest
		reject: (accessRequestId: string) => void
		approve: (accessRequestId: string) => void
		informationChangedRecently: ReadonlySignal<boolean>
	}) => {
		const { value: rejectState, waitFor: waitForReject } = useAsyncState<void>()
		const { value: approveState, waitFor: waitForApprove } = useAsyncState<void>()
		const disabled = informationChangedRecently.value
		const onReject = () => {
			void waitForReject(async () => {
				reject(accessRequest.accessRequestId)
			})
		}
		const onApprove = () => {
			void waitForApprove(async () => {
				approve(accessRequest.accessRequestId)
			})
		}

		return <nav class = 'popup-button-row'>
			<div style = 'display: flex; flex-direction: row;'>
		<AsyncActionButton
				class = 'button is-primary is-danger'
				state = { rejectState.value.state }
					text = 'Deny Access'
					pendingText = 'Denying access...'
					onClick = { onReject }
					disabled = { disabled }
				/>
			<AsyncActionButton
				class = 'button is-primary'
				state = { approveState.value.state }
					text = 'Grant Access'
					pendingText = 'Granting access...'
					onClick = { onApprove }
					disabled = { disabled }
				/>
			</div>
			</nav>
	}

	return <> { param.pendingAccessRequests.map((pendingRequest) => <>
		<div class = 'card' style = 'margin-bottom: 10px;'>
			<AccessRequestHeader { ...pendingRequest.website } />
			<div class = 'card-content' style = 'padding-bottom: 5px;'>
				<AccessRequest
						renameAddressCallBack =  { (entry: AddressBookEntry) => param.renameAddressCallBack(pendingRequest.accessRequestId, entry) }
						accessRequest = { pendingRequest }
					changeActiveAddress = { () => param.changeActiveAddress(pendingRequest.accessRequestId) }
						refreshActiveAddress = { () => param.refreshActiveAddress(pendingRequest.accessRequestId) }
					/>
				</div>
				<AccessRequestActions accessRequest = { pendingRequest } reject = { param.reject } approve = { param.approve } informationChangedRecently = { param.informationChangedRecently } />
			</div>
		</>) } </>
}

const DISABLED_DELAY_MS = 500

type Page = { page: 'Home', accessRequestId: string }
	| { page: 'ModifyAddress' | 'AddNewAddress', state: Signal<ModifyAddressWindowState>, accessRequestId: string }
	| { page: 'ChangeActiveAddress', accessRequestId: string }

export function getSelectedPendingAccessRequest(pendingAccessRequests: PendingAccessRequests, accessRequestId: string | undefined) {
	if (accessRequestId === undefined) return pendingAccessRequests[0]
	return pendingAccessRequests.find((request) => request.accessRequestId === accessRequestId)
}

export function InterceptorAccess() {
	const pendingAccessRequests = useSignal<PendingAccessRequests>([])
	const activeAddresses = useSignal<AddressBookEntries>([])
	const appPage = useSignal<Page>({ page: 'Home', accessRequestId: '' })
	const informationUpdatedTimestamp = useSignal<number>(0)
	const timeTicker = useSignal<number>(0)
	const rpcEntries = useSignal<RpcEntries>([])

	useEffect(() => {
		function popupMessageListener(msg: unknown): false {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return false // not a message we are interested in
			const parsed = maybeParsed.value
			if (parsed.method === 'popup_settingsUpdated') {
				sendPopupMessageToBackgroundPage({ method: 'popup_requestSettings' })
				return false
			}
			if (parsed.method === 'popup_requestSettingsReply') {
				rpcEntries.value = parsed.data.rpcEntries
				return false
			}
			if (parsed.method === 'popup_addressBookEntriesChanged') {
				refreshMetadata()
				return false
			}
			if (parsed.method === 'popup_websiteAccess_changed') {
				refreshMetadata()
				return false
			}
			if (parsed.method === 'popup_interceptorAccessDialog' || parsed.method === 'popup_interceptor_access_dialog_pending_changed') {
				if (parsed.method === 'popup_interceptor_access_dialog_pending_changed') {
					if (pendingAccessRequests.value.length > 0) informationUpdatedTimestamp.value = Date.now()
				}
				pendingAccessRequests.value = parsed.data.pendingAccessRequests
				activeAddresses.value = parsed.data.activeAddresses
				return false
			}
			return false
		}
		noReplyExpectingBrowserRuntimeOnMessageListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	}, [])

	useEffect(() => {
		void sendPopupReadyAndListening('interceptorAccess')
		sendPopupMessageToBackgroundPage({ method: 'popup_requestSettings' })
	}, [])

	async function approve(accessRequestId: string) {
		const accessRequest = pendingAccessRequests.value.find((request) => request.accessRequestId === accessRequestId)
		if (accessRequest === undefined) throw Error('accessRequest is undefined')
		const data = {
			userReply: 'Approved' as const,
			websiteOrigin: accessRequest.website.websiteOrigin,
			requestAccessToAddress: accessRequest.requestAccessToAddress?.address,
			originalRequestAccessToAddress: accessRequest.originalRequestAccessToAddress?.address,
			accessRequestId: accessRequest.accessRequestId,
		}
		informationUpdatedTimestamp.value = Date.now()
		if (pendingAccessRequests.value.length === 1) await tryFocusingTabOrWindow({ type: 'tab', id: accessRequest.socket.tabId })
		await sendPopupMessageToBackgroundPage({ method: 'popup_interceptorAccess', data })
	}

	async function reject(accessRequestId: string) {
		const accessRequest = pendingAccessRequests.value.find((request) => request.accessRequestId === accessRequestId)
		if (accessRequest === undefined) throw Error('accessRequest is undefined')
		const data = {
			userReply: 'Rejected' as const,
			websiteOrigin: accessRequest.website.websiteOrigin,
			requestAccessToAddress: accessRequest.requestAccessToAddress?.address,
			originalRequestAccessToAddress: accessRequest.originalRequestAccessToAddress?.address,
			accessRequestId: accessRequest.accessRequestId,
		}
		informationUpdatedTimestamp.value = Date.now()
		if (pendingAccessRequests.value.length === 1) await tryFocusingTabOrWindow({ type: 'tab', id: accessRequest.socket.tabId })
		await sendPopupMessageToBackgroundPage({ method: 'popup_interceptorAccess', data })
	}

	function renameAddressCallBack(accessRequestId: string, entry: AddressBookEntry) {
		appPage.value = { page: 'ModifyAddress', state: new Signal(addressEditEntry(entry)), accessRequestId }
	}

	const changeActiveAddress = (accessRequestId: string) => { appPage.value = { accessRequestId, page: 'ChangeActiveAddress' } }

	async function refreshMetadata() {
		await sendPopupMessageToBackgroundPage({ method: 'popup_refreshInterceptorAccessMetadata' })
	}

	async function refreshActiveAddress(accessRequestId: string) {
		const accessRequest = pendingAccessRequests.value.find((request) => request.accessRequestId === accessRequestId)
		if (accessRequest === undefined) throw Error('accessRequest is undefined')
		await sendPopupMessageToBackgroundPage({ method: 'popup_interceptorAccessRefresh', data: {
			socket: accessRequest.socket,
			website: accessRequest.website,
			requestAccessToAddress: accessRequest.requestAccessToAddress?.address,
			accessRequestId: accessRequest.accessRequestId,
		} } )
	}

	async function setActiveAddressAndInformAboutIt(accessRequestId: string, address: bigint | 'signer') {
		const accessRequest = pendingAccessRequests.value.find((request) => request.accessRequestId === accessRequestId)
		if (accessRequest === undefined) throw Error('accessRequest is undefined')
		await sendPopupMessageToBackgroundPage({ method: 'popup_interceptorAccessChangeAddress', data: {
			socket: accessRequest.socket,
			website: accessRequest.website,
			requestAccessToAddress: accessRequest.requestAccessToAddress?.address,
			newActiveAddress: address,
			accessRequestId: accessRequest.accessRequestId,
		} } )
	}

	const informationChangedRecently = useComputed(() => {
		timeTicker.value
		return Date.now()< informationUpdatedTimestamp.value + DISABLED_DELAY_MS
	})

	useEffect(() => {
		const id = setInterval(() => { timeTicker.value++ }, 1000)
		return () => clearInterval(id)
	}, [])

	function addNewAddress(accessRequestId: string) {
		appPage.value = { accessRequestId, page: 'AddNewAddress', state: new Signal({
			windowStateId: 'AddNewAddressAccess',
			errorState: undefined,
			incompleteAddressBookEntry: {
				name: undefined,
				addingAddress: false,
				askForAddressAccess: true,
				symbol: undefined,
				decimals: undefined,
				logoUri: undefined,
				type: 'contact',
				useAsActiveAddress: true,
				entrySource: 'FilledIn',
				address: undefined,
				abi: undefined,
				declarativeNetRequestBlockMode: undefined,
				chainId: 1n,
			}
		}) }
	}

	if (pendingAccessRequests.value.length === 0) return <main></main>
	const selectedPendingAccessRequest = getSelectedPendingAccessRequest(
		pendingAccessRequests.value,
		appPage.value.page === 'Home' ? undefined : appPage.value.accessRequestId,
	)
	const isModalActive = appPage.value.page !== 'Home' && selectedPendingAccessRequest !== undefined

	return <main>
		<Hint>
			<div class = { `modal ${ isModalActive ? 'is-active' : ''}` }>
				{ (appPage.value.page === 'AddNewAddress' || appPage.value.page === 'ModifyAddress') && selectedPendingAccessRequest !== undefined
					? <AddNewAddress
						setActiveAddressAndInformAboutIt = { (address: bigint | 'signer') => setActiveAddressAndInformAboutIt(appPage.value.accessRequestId, address) }
						modifyAddressWindowState = { appPage.value.state }
						close = { () => { appPage.value = { page: 'Home', accessRequestId: '' } } }
						activeAddress = { selectedPendingAccessRequest.requestAccessToAddress?.address }
						rpcEntries = { rpcEntries }
					/>
					: <></>
				}

				{ appPage.value.page === 'ChangeActiveAddress' && selectedPendingAccessRequest !== undefined
					? <ChangeActiveAddress
						setActiveAddressAndInformAboutIt = { (address: bigint | 'signer') => setActiveAddressAndInformAboutIt(appPage.value.accessRequestId, address) }
						signerAccounts = { selectedPendingAccessRequest.signerAccounts }
						close = { () => { appPage.value = { page: 'Home', accessRequestId: '' } } }
						activeAddresses = { activeAddresses }
						signerName = { selectedPendingAccessRequest.signerName }
						renameAddressCallBack = { (entry: AddressBookEntry) => renameAddressCallBack(appPage.value.accessRequestId, entry) }
						addNewAddress = { () => addNewAddress(appPage.value.accessRequestId) }
					/>
					: <></>
				}
			</div>

			<div class = 'block popup-block'>
				<div class = 'popup-block-scroll'>
					<AccessRequests
						changeActiveAddress = { changeActiveAddress }
						renameAddressCallBack = { renameAddressCallBack }
						pendingAccessRequests = { pendingAccessRequests.value }
						refreshActiveAddress = { refreshActiveAddress }
						approve = { approve }
						reject = { reject }
						informationChangedRecently = { informationChangedRecently }
					/>
				</div>
			</div>
		</Hint>
	</main>
}
