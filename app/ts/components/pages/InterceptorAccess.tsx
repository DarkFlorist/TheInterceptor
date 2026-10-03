import { Fragment } from 'preact'
import { useEffect } from 'preact/hooks'
import { ActiveAddressComponent, BigAddress, WebsiteOriginText } from '../subcomponents/address.js'
import { AddNewAddress } from './AddNewAddress.js'
import type { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import Hint from '../subcomponents/Hint.js'
import { addressEditEntry, convertNumberToCharacterRepresentationIfSmallEnough, getInterceptorModeClass } from '../ui-utils.js'
import { ChangeActiveAddress } from './ChangeActiveAddress.js'
import { DinoSays } from '../subcomponents/DinoSays.js'
import { getPrettySignerName } from '../subcomponents/signers.js'
import type { AddressBookEntries, AddressBookEntry } from '../../types/addressBookTypes.js'
import type { Website } from '../../types/websiteAccessTypes.js'
import type { PendingAccessRequest, PendingAccessRequests } from '../../types/accessRequest.js'
import { type ReadonlySignal, Signal, useComputed, useSignal } from '@preact/signals'
import type { RpcEntries } from '../../types/rpc.js'
import type { ModifyAddressWindowState } from '../../types/visualizer-types.js'
import { CheckMarkIcon, ChevronIcon, XMarkIcon } from '../subcomponents/icons.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'
import { sendPopupReadyAndListening } from '../../background/backgroundUtils.js'
import { sanitizeStoredWebsiteIcon } from '../../utils/websiteIcons.js'
import { AsyncActionButton } from '../subcomponents/AsyncAction.js'
import { useAsyncState } from '../../utils/preact-utilities.js'
import { respondToAccessRequest } from './interceptorAccessResponse.js'
import { getSelectableActiveAddresses, includePersistedAddressBookEntry, isActiveAddressSelectionAllowed } from '../../utils/activeAddressSelection.js'

function AccessRequestHero({ website, request }: { website: Website, request: string }) {
	const websiteIcon = sanitizeStoredWebsiteIcon(website.icon)
	return <div class = 'access-request-hero'>
		{ websiteIcon === undefined ? <></> : <img class = 'access-request-site-icon' src = { websiteIcon } alt = '' width = '56' height = '56'/> }
		<p class = 'access-request-site'>{ website.title === undefined ? website.websiteOrigin : website.title }</p>
		<p class = 'access-request-ask'>{ request }</p>
	</div>
}

// Spells out what granting access does and does not allow, so the privacy model is visible at the moment of the decision.
function AccessCapabilities() {
	return <div class = 'access-capabilities'>
		<p class = 'access-capabilities-heading'>This site will be able to</p>
		<ul class = 'transaction-checks access-capabilities-list'>
			<li class = 'transaction-check transaction-check--positive'><span class = 'transaction-check-icon'><CheckMarkIcon/></span><span class = 'transaction-check-text'>See this address and its public balances and activity</span></li>
			<li class = 'transaction-check transaction-check--positive'><span class = 'transaction-check-icon'><CheckMarkIcon/></span><span class = 'transaction-check-text'>Ask you to review transactions and signatures</span></li>
		</ul>
		<p class = 'access-capabilities-heading'>It will not be able to</p>
		<ul class = 'transaction-checks access-capabilities-list'>
			<li class = 'transaction-check transaction-check--negative'><span class = 'transaction-check-icon'><XMarkIcon/></span><span class = 'transaction-check-text'>Send transactions or sign anything without your confirmation</span></li>
			<li class = 'transaction-check transaction-check--negative'><span class = 'transaction-check-icon'><XMarkIcon/></span><span class = 'transaction-check-text'>See your other addresses unless you grant access to them</span></li>
		</ul>
	</div>
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
			<header class = 'card-header noselect' style = 'cursor: pointer; min-height: 30px;' onClick = { () => { showLogs.value = !showLogs.value } }>
				<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em;'>
					{ associatedAddresses.length <= 1
						? 'The website cannot associate any addresses with each other'
						: <span>There are <b>{ convertNumberToCharacterRepresentationIfSmallEnough(associatedAddresses.length).toUpperCase() }</b> addresses that the website can associate together with</span>
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
			<AccessRequestHero website = { accessRequest.website } request = 'would like to connect to The Interceptor'/>
		:
			<>
				<AccessRequestHero website = { accessRequest.website } request = 'would like to connect to your account'/>
				<div class = 'access-request-account'>
					<div>
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
								<p style = 'color: var(--subtitle-text-color); white-space: normal; margin-top: 6px;' class = 'subtitle is-7'>
									{ `You can change active address by changing it directly from ${ getPrettySignerName(accessRequest.signerName) } and clicking refresh here afterwards` }
								</p>
							</>
						}
					</div>
				</div>

				<AccessCapabilities/>
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
	approve: (accessRequestId: string) => Promise<void>
	reject: (accessRequestId: string) => Promise<void>
	informationChangedRecently: ReadonlySignal<boolean>
}

type AccessRequestActionsProps = {
	accessRequest: PendingAccessRequest
	reject: (accessRequestId: string) => Promise<void>
	approve: (accessRequestId: string) => Promise<void>
	informationChangedRecently: ReadonlySignal<boolean>
}

export function AccessRequestActions({ accessRequest, reject, approve, informationChangedRecently }: AccessRequestActionsProps) {
	const { value: rejectState, waitFor: waitForReject } = useAsyncState<void>()
	const { value: approveState, waitFor: waitForApprove } = useAsyncState<void>()
	const disabled = informationChangedRecently.value
	const rejectPending = rejectState.value.state === 'pending'
	const approvePending = approveState.value.state === 'pending'
	const onReject = () => {
		void waitForReject(() => reject(accessRequest.accessRequestId))
	}
	const onApprove = () => {
		void waitForApprove(() => approve(accessRequest.accessRequestId))
	}

	return <nav class = 'popup-button-row'>
		<div style = 'display: flex; flex-direction: row;'>
		<AsyncActionButton
			class = 'button button--secondary button-overflow dialog-action-button'
			state = { rejectState.value.state }
			text = 'Deny Access'
			pendingText = 'Denying access...'
			onClick = { onReject }
		disabled = { disabled || approvePending }
		/>
		<AsyncActionButton
			class = 'button is-primary button-overflow dialog-action-button dialog-action-button--confirm'
			state = { approveState.value.state }
			text = 'Grant Access'
			pendingText = 'Granting access...'
			onClick = { onApprove }
		disabled = { disabled || rejectPending }
		/>
		</div>
	</nav>
}

export function AccessRequests(param: AccessRequestParam) {

	return <> { param.pendingAccessRequests.map((pendingRequest) => <Fragment key = { pendingRequest.accessRequestId }>
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
		</Fragment>) } </>
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
	const activeRpcChainId = useSignal<bigint | undefined>(undefined)
	const selectedPendingAccessRequest = useComputed(() => getSelectedPendingAccessRequest(
		pendingAccessRequests.value,
		appPage.value.page === 'Home' ? undefined : appPage.value.accessRequestId,
	))
	const selectableActiveAddresses = useComputed(() => {
		const accessRequest = selectedPendingAccessRequest.value
		if (accessRequest === undefined) return []
		return getSelectableActiveAddresses(activeAddresses.value, accessRequest.simulationMode, activeRpcChainId.value, accessRequest.signerAccounts)
	})

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
				activeRpcChainId.value = parsed.data.activeRpcNetwork.chainId
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
		informationUpdatedTimestamp.value = Date.now()
		await respondToAccessRequest(accessRequest, 'Approved', pendingAccessRequests.value.length)
	}

	async function reject(accessRequestId: string) {
		const accessRequest = pendingAccessRequests.value.find((request) => request.accessRequestId === accessRequestId)
		if (accessRequest === undefined) throw Error('accessRequest is undefined')
		informationUpdatedTimestamp.value = Date.now()
		await respondToAccessRequest(accessRequest, 'Rejected', pendingAccessRequests.value.length)
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

	async function setActiveAddressAndInformAboutIt(accessRequestId: string, address: bigint | 'signer', persistedEntry?: AddressBookEntry) {
		const accessRequest = pendingAccessRequests.value.find((request) => request.accessRequestId === accessRequestId)
		if (accessRequest === undefined) throw Error('accessRequest is undefined')
		const selectableAddresses = includePersistedAddressBookEntry(activeAddresses.value, persistedEntry)
		if (!isActiveAddressSelectionAllowed(address, selectableAddresses, accessRequest.simulationMode, activeRpcChainId.value, accessRequest.signerAccounts)) return
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
	const selectedAccessRequest = selectedPendingAccessRequest.value
	const isModalActive = appPage.value.page !== 'Home' && selectedAccessRequest !== undefined

	return <main class = { selectedAccessRequest === undefined ? undefined : getInterceptorModeClass(selectedAccessRequest.simulationMode) }>
		<Hint>
			<div class = { `modal ${ isModalActive ? 'is-active' : ''}` }>
				{ (appPage.value.page === 'AddNewAddress' || appPage.value.page === 'ModifyAddress') && selectedAccessRequest !== undefined
					? <AddNewAddress
						setActiveAddressAndInformAboutIt = { selectedAccessRequest.simulationMode ? (address: bigint | 'signer', persistedEntry?: AddressBookEntry) => setActiveAddressAndInformAboutIt(selectedAccessRequest.accessRequestId, address, persistedEntry) : undefined }
						modifyAddressWindowState = { appPage.value.state }
						close = { () => { appPage.value = { page: 'Home', accessRequestId: '' } } }
						activeAddress = { selectedAccessRequest.requestAccessToAddress?.address }
						rpcEntries = { rpcEntries }
					/>
					: <></>
				}

				{ appPage.value.page === 'ChangeActiveAddress' && selectedAccessRequest !== undefined
					? <ChangeActiveAddress
						setActiveAddressAndInformAboutIt = { (address: bigint | 'signer') => setActiveAddressAndInformAboutIt(selectedAccessRequest.accessRequestId, address) }
						signerAccounts = { selectedAccessRequest.signerAccounts }
						close = { () => { appPage.value = { page: 'Home', accessRequestId: '' } } }
						activeAddresses = { selectableActiveAddresses }
						signerName = { selectedAccessRequest.signerName }
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
