import { useContext, useEffect, useRef } from 'preact/hooks'
import { Signal, type ReadonlySignal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { type ComponentChildren, createContext, type JSX } from 'preact'
import type { Website, WebsiteAccess, WebsiteAccessArray, WebsiteAddressAccess } from '../../types/websiteAccessTypes.js'
import { Modal } from '../subcomponents/Modal.js'
import { Collapsible } from '../subcomponents/Collapsible.js'
import { Switch } from '../subcomponents/Switch.js'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import type { AddressBookEntries, AddressBookEntry } from '../../types/addressBookTypes.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { InterceptorDisabledIcon, RequestBlockedIcon, SearchIcon, TrashIcon } from '../subcomponents/icons.js'
import { BigAddress, SmallAddress } from '../subcomponents/address.js'
import { createPortal } from 'preact/compat'
import { useOptionalComputed } from '../../utils/OptionalSignal.js'
import type { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { AddNewAddress } from './AddNewAddress.js'
import type { ModifyAddressWindowState } from '../../types/visualizer-types.js'
import type { RpcEntries } from '../../types/rpc.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'
import { addressEditEntry } from '../ui-utils.js'
import type { OptionalSignal } from '../../utils/OptionalSignal.js'
import { sanitizeStoredWebsiteIcon } from '../../utils/websiteIcons.js'
import { getHostnameForWebsiteOrigin } from '../../utils/websiteOrigins.js'
import { searchWebsiteAccess } from '../../background/websiteAccessSearch.js'

const URL_HASH_KEY = 'origin'
const URL_HASH_PREFIX = `#${ URL_HASH_KEY }:`

function getSelectedDomainFromHash(hash: string) {
	const domainInHash = hash.slice(URL_HASH_PREFIX.length)
	return domainInHash || undefined
}

type WebsiteAccessContext = {
	searchQuery: Signal<string>
	allWebsiteAccess: Signal<WebsiteAccessArray>
	viewState: ReadonlySignal<WebsiteAccessViewState>
	addressAccessMetadata: Signal<AddressBookEntries>
	selectedDomain: Signal<string | undefined>
}

type HostScopeDetails = {
	readonly hostname: string
	readonly selectedOrigin: string
	readonly affectedOrigins: readonly string[]
}

type WebsiteAccessViewState = {
	readonly websiteAccessList: WebsiteAccessArray
	readonly selectedWebsiteAccess: WebsiteAccess | undefined
	readonly hostScopeDetails: HostScopeDetails | undefined
}

const WebsiteAccessContext = createContext<WebsiteAccessContext | undefined>(undefined)

const WebsiteAccessProvider = ({ children }: { children: ComponentChildren }) => {
	const allWebsiteAccess = useSignal<WebsiteAccessArray>([])
	const searchQuery = useSignal<string>('')
	const addressAccessMetadata = useSignal<AddressBookEntries>([])
	const hasLoadedWebsiteAccess = useSignal(false)
	const selectedDomain = useSignal<string | undefined>(getSelectedDomainFromHash(window.location.hash))
	const viewState = useComputed(() => deriveWebsiteAccessViewState(allWebsiteAccess.value, searchQuery.value, selectedDomain.value))

	const retrieveWebsiteAccess = () => {
		sendPopupMessageToBackgroundPage({ method: 'popup_retrieveWebsiteAccess', data: { query: '' } })
	}

	const clearSelectionWhenRemoved = () => {
		if (!hasLoadedWebsiteAccess.value || selectedDomain.value === undefined) return
		const selectedStillExists = allWebsiteAccess.value.some((access) => access.website.websiteOrigin === selectedDomain.value)
		if (!selectedStillExists) window.location.hash = ''
	}

	const updateWebsiteAccessState = (websiteAccess: WebsiteAccessArray, metadata: AddressBookEntries) => {
		allWebsiteAccess.value = websiteAccess
		addressAccessMetadata.value = metadata
		hasLoadedWebsiteAccess.value = true
	}

  const listenForPopupMessages = () => {
		const popupMessageListener = (msg: unknown): false => {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return false// not a message we are interested in
			const parsed = maybeParsed.value
				switch (parsed.method) {
					case 'popup_setDisableInterceptorReply':
					case 'popup_addressBookEntriesChanged':
						retrieveWebsiteAccess()
						break
					case 'popup_websiteAccess_changed':
					case 'popup_retrieveWebsiteAccessReply':
						updateWebsiteAccessState(parsed.data.websiteAccess, parsed.data.addressAccessMetadata)
						break
				}
			return false
		}

		noReplyExpectingBrowserRuntimeOnMessageListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	}

	const listenForWindowHashChanges = () => {
		const handleHashChange = () => {
			selectedDomain.value = getSelectedDomainFromHash(window.location.hash)
		}

		// initially set selectedDomain when the page loads/reloads
		handleHashChange()
		window.addEventListener('hashchange', handleHashChange)
		return () => window.removeEventListener('hashchange', handleHashChange)
	}

	useSignalEffect(clearSelectionWhenRemoved)
	useEffect(listenForPopupMessages, [])
	useEffect(listenForWindowHashChanges, [])
	useEffect(retrieveWebsiteAccess, [])

	return <WebsiteAccessContext.Provider value = { { searchQuery, allWebsiteAccess, viewState, addressAccessMetadata, selectedDomain } }>{ children }</WebsiteAccessContext.Provider>
}

export function useWebsiteAccess() {
	const context = useContext(WebsiteAccessContext)
	if (!context) throw new Error('useWebsiteAccess can only be used within children components of WebsiteAccessProvider')
	return context
}

export function getHostScopeDetails(websiteAccessList: WebsiteAccessArray, websiteOrigin: string): HostScopeDetails {
	const hostname = getHostnameForWebsiteOrigin(websiteOrigin)
	const affectedOrigins = Array.from(new Set(
		websiteAccessList
			.map((access) => access.website.websiteOrigin)
			.filter((origin) => getHostnameForWebsiteOrigin(origin) === hostname)
	))
	return { hostname, selectedOrigin: websiteOrigin, affectedOrigins }
}

export function findWebsiteAccessByOrigin(websiteAccessList: WebsiteAccessArray, websiteOrigin: string | undefined) {
	if (websiteOrigin === undefined) return undefined
	return websiteAccessList.find((access) => access.website.websiteOrigin === websiteOrigin)
}

export function deriveWebsiteAccessViewState(allWebsiteAccess: WebsiteAccessArray, searchQuery: string, selectedDomain: string | undefined): WebsiteAccessViewState {
	const websiteAccessList = searchWebsiteAccess(searchQuery, allWebsiteAccess)
	const selectedWebsiteAccess = findWebsiteAccessByOrigin(allWebsiteAccess, selectedDomain)
	const hostScopeDetails = selectedWebsiteAccess === undefined ? undefined : getHostScopeDetails(allWebsiteAccess, selectedWebsiteAccess.website.websiteOrigin)
	return { websiteAccessList, selectedWebsiteAccess, hostScopeDetails }
}

const HostScopeSummary = ({ hostScopeDetails }: { hostScopeDetails: HostScopeDetails | undefined }) => {
	if (hostScopeDetails === undefined) return <></>
	const siblingOrigins = hostScopeDetails.affectedOrigins.filter((origin) => origin !== hostScopeDetails.selectedOrigin)
	return (
		<div style = { { marginTop: '0.75rem', padding: '0.75rem', border: '1px solid var(--line-color)', borderRadius: '0.5rem', backgroundColor: 'var(--card-bg-color)' } }>
			<p style = { { fontSize: '0.875rem', color: 'var(--text-color)', lineHeight: 1.35 } }>
				These settings apply to all sites on <b>{ hostScopeDetails.hostname }</b>.
			</p>
			<p style = { { fontSize: '0.875rem', color: 'var(--disabled-text-color)', lineHeight: 1.35, marginTop: '0.375rem' } }>
				Affected site{ hostScopeDetails.affectedOrigins.length === 1 ? '' : 's' }: { hostScopeDetails.affectedOrigins.join(', ') }
			</p>
			{ siblingOrigins.length > 0 ? <p style = { { fontSize: '0.875rem', color: 'var(--disabled-text-color)', lineHeight: 1.35, marginTop: '0.375rem' } }>
				This includes sibling origin{ siblingOrigins.length === 1 ? '' : 's' } on other port{ siblingOrigins.length === 1 ? '' : 's' } or scheme variants.
			</p> : <></> }
		</div>
	)
}

export const WebsiteAccessView = () => {
	return (
		<WebsiteAccessProvider>
			<main>
				<div class = 'layout'>
					<header>
						<h1>Manage Websites</h1>
						<SearchForm id = 'site_search' name = 'search' placeholder = 'Search website name, url or Ethereum address' />
					</header>
					<article>
						<WebsiteSettingsList />
						<WebsiteSettingsDetail />
					</article>
				</div>
			</main>
		</WebsiteAccessProvider>
	)
}

type SearchFormProps = {
	id: string
	name: string
	placeholder?: string
	defaultValue?: string
}

const SearchForm = (props: SearchFormProps) => {
	const inputRef = useRef<HTMLInputElement>(null)
	const { searchQuery } = useWebsiteAccess()

	const updateSearchParameters = (event: JSX.TargetedInputEvent<HTMLFormElement>) => {
		const formData = new FormData(event.currentTarget)
		const q = formData.get('search')
		searchQuery.value = q?.toString() || ''
	}

	const commitSelectionOrReset = (event: Event) => {
		event.preventDefault()
		if (!(event instanceof SubmitEvent) || !(event.currentTarget instanceof HTMLFormElement) || !inputRef.current) return

		if (event.submitter instanceof HTMLButtonElement && event.submitter.value === 'clear') {
			event.currentTarget.reset()

			const formData = new FormData(event.currentTarget)
			const inputValue = formData.get(props.name)?.toString()
			searchQuery.value = inputValue || ''
			inputRef.current.focus()
			return
		}
	}

	const updateSelection = (event: KeyboardEvent) => {
		if (event.key !== 'ArrowDown') return
		event.preventDefault()
		inputRef.current?.blur()
	}

	return (
		<form role = 'search' onInput = { updateSearchParameters } onSubmit = { commitSelectionOrReset } onKeyDown = { updateSelection }>
			<fieldset>
				<label for = { props.id }><SearchIcon /></label>
				<input { ...props } name = { props.name } ref = { inputRef } type = 'search' value = { searchQuery.value } autoFocus autoComplete = 'off' />
				<input type = 'submit' style = { { display: 'none' } } />
				<button type = 'submit' value = 'clear'>
					<svg width = '1em' height = '1em' viewBox = '0 0 16 16' fill = 'none' xmlns = 'http://www.w3.org/2000/svg'>
						<path d = 'M1 1L15 15M15 1L1 15' stroke = 'currentColor' stroke-width = '2' />
					</svg>
				</button>
			</fieldset>
		</form>
	)
}

const WebsiteSettingsList = () => {
	const { viewState, selectedDomain } = useWebsiteAccess()
	const websiteAccessList = viewState.value.websiteAccessList

	return (
		<section style = { { paddingBlock: '1rem' } }>
			<h4 style = { { color: 'var(--disabled-text-color)' , fontSize: '0.875rem', display: 'grid', gridTemplateColumns: '1fr max-content' } }>Websites</h4>
			{ websiteAccessList.length < 1 ? <EmptyAccessList /> : <>
				<ul role = 'listbox'>{ websiteAccessList.map((access) => <WebsiteAccessOverview key = { access.website.websiteOrigin } websiteAccess = { access } checked = { selectedDomain.value === access.website.websiteOrigin } />) }</ul>
					<input type = 'submit' style = { { display: 'none' } } />
				</> }
		</section>
	)
}

const EmptyAccessList = () => {
	const { searchQuery } = useWebsiteAccess()
	const clearSearch = () => { searchQuery.value = '' }
	return (
		<div style = { { display: 'flex', flexDirection: 'column', rowGap: '0.5rem', border: '1px dashed var(--line-color)', padding: '2rem 1rem', textAlign: 'center', margin: '1rem 0', alignItems: 'center' } }>
			<p style = { { color: 'var(--disabled-text-color)', fontSize: '0.9rem', lineHeight: 1.2 } }>Did not find anything that matched your search query</p>
			<button onClick = { clearSearch } type = 'button' class = 'btn btn--outline btn--sm' style = { { fontSize: '0.9rem' } }>Clear Search</button>
		</div>
	)
}

type WebsiteAccessOverviewProps = {
	websiteAccess: WebsiteAccess
	checked: boolean
}

const WebsiteAccessOverview = ({ websiteAccess, checked }: WebsiteAccessOverviewProps) => {
	const handleChange = () => {
		window.location.hash = `${ URL_HASH_KEY }:${ websiteAccess.website.websiteOrigin }`
	}

	const getWebsiteStatus = () => {
		if (!websiteAccess.access) return
		if (websiteAccess.interceptorDisabled) return 'disabled'
		if (websiteAccess.declarativeNetRequestBlockMode === 'block-all') return 'blocked'
		return
	}
	const websiteIcon = sanitizeStoredWebsiteIcon(websiteAccess.website.icon)

	return (
		<li role = 'option'>
			<input id = { websiteAccess.website.websiteOrigin } type = 'radio' name = { URL_HASH_KEY } value = { websiteAccess.website.websiteOrigin } checked = { checked } onChange = { handleChange } />
			<label for = { websiteAccess.website.websiteOrigin } style = { { cursor: 'pointer' } }>
				<div style = { { display: 'grid', gridTemplateColumns: 'min-content 1fr', alignItems: 'center', columnGap: '1rem', paddingBlock: '0.5rem' } }>
					{ websiteIcon === undefined ? <span style = { { width: '1.5rem', aspectRatio: 1, display: 'block' } } /> : <img role = 'img' src = { websiteIcon } width = '24' height = '24' style = { { width: '1.5rem', aspectRatio: 1, maxWidth: 'none' } } title = 'Website Icon' /> }
					<div class = 'flexy' style = { { textAlign: 'left', flex: '1', '--pad-y': 0 } }>
						<div style = { { flex: 1 } }>
							<h4 class = 'truncate' style = { { contain: 'inline-size',  color: 'var(--heading-color)', fontWeight: 'var(--heading-weight)' } }>{ websiteAccess.website.title }</h4>
							<p class = 'truncate' style = { { contain: 'inline-size', fontSize: '0.875rem', lineHeight: 1.25, direction: 'rtl', color: 'var(--subheading-color)' } }>&lrm;{ websiteAccess.website.websiteOrigin }</p>
						</div>
						<SiteStatusIndicator status = { getWebsiteStatus() } />
					</div>
				</div>
			</label>
		</li>
	)
}

const SiteStatusIndicator = ({ status }: { status?: 'disabled' | 'blocked' }) => {
	switch (status) {
		case 'blocked':
			return <span class = 'status-warn' role = 'img' title = 'External Request Blocked' aria-label = 'External Request Blocked'><RequestBlockedIcon /></span>
		case 'disabled':
			return <span class = 'status-danger' role = 'img' title = 'Protection Disabled' aria-label = 'Protection Disabled'><InterceptorDisabledIcon /></span>
		case undefined:
			return null
		default:
			return null
	}
}

const FullFrameWindow = ({ children }: { children: ComponentChildren }) => {
	return createPortal(<div class = 'access-details'>{children}</div>, document.body)
}

type Modals = { page: 'noModal' } | { page: 'ModifyAddress', state: Signal<ModifyAddressWindowState> }

const WebsiteSettingsDetail = () => {
	const { viewState } = useWebsiteAccess()
	const selectedWebsiteAccess = useOptionalComputed(() => viewState.value.selectedWebsiteAccess)
	const hostScopeDetails = useComputed(() => viewState.value.hostScopeDetails)
	const modalState = useSignal<Modals>({ page: 'noModal' })
	const rpcEntries = useSignal<RpcEntries>([])
	const closeDetails = () => { window.location.hash = '' }

	function renameAddressCallBack(entry: AddressBookEntry) {
		modalState.value = { page: 'ModifyAddress', state: new Signal(addressEditEntry(entry)) }
	}

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
			return false
		}
		noReplyExpectingBrowserRuntimeOnMessageListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	useEffect(() => { sendPopupMessageToBackgroundPage({ method: 'popup_requestSettings' }) }, [])

	if (selectedWebsiteAccess.value === undefined) return <></>

		return (
			<div class = { `modal ${ modalState.value.page !== 'noModal' ? 'is-active' : ''}` }>
				<FullFrameWindow>
					<form method = 'dialog' class = 'layout' onSubmit = { closeDetails }>
						<header style = { { paddingBlock: '1rem' } }>
							<button type = 'submit' class = 'btn btn--ghost' style = { { fontSize: '0.875rem', paddingInline: '0.5rem', paddingBlock: '0.125rem' } } autoFocus>&larr; Show website access list</button>
							<DetailsHeader websiteAccess = { selectedWebsiteAccess } hostScopeDetails = { hostScopeDetails } />
						</header>
						<article>
							<NoAccessPrompt websiteAccess = { selectedWebsiteAccess } hostScopeDetails = { hostScopeDetails } />
							<AddressAccessList websiteAccess = { selectedWebsiteAccess } renameAddressCallBack = { renameAddressCallBack }/>
							<AdvancedSettings websiteAccess = { selectedWebsiteAccess } hostScopeDetails = { hostScopeDetails } />
						</article>
					</form>
				</FullFrameWindow>
			{ modalState.value.page === 'ModifyAddress' ?
				<AddNewAddress
					setActiveAddressAndInformAboutIt = { undefined }
					modifyAddressWindowState = { modalState.value.state }
					close = { () => { modalState.value = { page: 'noModal' } } }
					activeAddress = { undefined }
					rpcEntries = { rpcEntries }
				/>
			: <></> }
		</div>
	)
}

const DetailsHeader = ({ websiteAccess, hostScopeDetails }: { websiteAccess: OptionalSignal<WebsiteAccess>, hostScopeDetails: ReadonlySignal<HostScopeDetails | undefined> }) => {
	if (websiteAccess.deepValue === undefined) return <></>
	const websiteIcon = sanitizeStoredWebsiteIcon(websiteAccess.deepValue.website.icon)
	return (
		<div class = 'flexy flexy-sm' style = { { '--gap-x': '1rem', flex: 1 } }>
			{ websiteIcon === undefined ? <></> : <figure><img width = '34' height = '34' src = { websiteIcon } /></figure> }
			<div style = { { flex: 1 } }>
				<h2 class = 'truncate' style = { { contain: 'inline-size', fontSize: 'clamp(1.25rem,2vw,2rem)', fontWeight: 600, color: 'var(--text-color)' } }>{ websiteAccess.deepValue.website.title }</h2>
				<p><span class = 'truncate' style = { { flex: 1, lineHeight: 1, color: 'var(--disabled-text-color)', direction: 'rtl', textAlign: 'left' } }>&lrm;{ websiteAccess.deepValue.website.websiteOrigin }</span></p>
				<HostScopeSummary hostScopeDetails = { hostScopeDetails.value } />
			</div>
		</div>
	)
}

const NoAccessPrompt = ({ websiteAccess, hostScopeDetails }: { websiteAccess: OptionalSignal<WebsiteAccess>, hostScopeDetails: ReadonlySignal<HostScopeDetails | undefined> }) => {
	const { selectedDomain } = useWebsiteAccess()
	const website = useComputed(() => websiteAccess.deepValue?.website)

	// If the website has been granted access, don't show this message
	if (websiteAccess.deepValue === undefined || websiteAccess.deepValue.access === true) return <></>

	const confirmOrRejectRemoval = async (returnValue: string) => {
		if (returnValue !== 'confirm' || !websiteAccess.deepValue) return
		await sendPopupMessageToBackgroundPage({ method: 'popup_removeWebsiteAccess',  data: { websiteOrigin: websiteAccess.deepValue.website.websiteOrigin } })
		selectedDomain.value = undefined
	}

		return (
			<div style = { { color: 'var(--disabled-text-color)', border: '1px dashed', padding: '2rem', maxWidth: '50ch', textAlign: 'center', margin: '1rem auto' } }>
				<h4 style = { { fontWeight: 600, color: 'var(--text-color)', lineHeight: '1.25', marginBottom: '0.5rem' } }>This host was denied access to The Interceptor.</h4>
					<p style = { { fontSize: '0.875rem', lineHeight: 1.25, marginBottom: '1rem' } }>Interceptor will automatically deny further requests from <WebsiteCard website = { website.value } /> and any other affected site on <b>{ hostScopeDetails.value?.hostname }</b> while this preference is set.</p>
				<Modal>
					<Modal.Open class = 'btn btn--outline' style = { { display: 'inline-block' } }>Stop automatically denying access for host</Modal.Open>
					<Modal.Dialog class = 'dialog' style = { { textAlign: 'center', color: 'var(--disabled-text-color)' } } onModalClose = { confirmOrRejectRemoval }>
						<h2 style = { { fontWeight: 600, fontSize: '1.125rem', color: 'var(--text-color)', marginBlock: '1rem' } }>Stop automatically denying access for host</h2>
						<p></p>
							<p style = { { marginBlock: '0.5rem', lineHeight: 1.5 } }>After confirming this action, The Interceptor will stop automatically denying access requests from <WebsiteCard website = { website.value } /> and every affected site on <b>{ hostScopeDetails.value?.hostname }</b>. You will be prompted again the next time one of them tries to connect.</p>
						<div style = { { display: 'flex', flexWrap: 'wrap', columnGap: '1rem', justifyContent: 'center', marginBlock: '1rem' } }>
							<Modal.Close class = 'btn btn--outline' value = 'reject'>Cancel</Modal.Close>
							<Modal.Close class = 'btn btn--destructive' value = 'confirm'>Confirm</Modal.Close>
					</div>
				</Modal.Dialog>
			</Modal>
		</div>
	)
}

const AddressAccessList = ({ websiteAccess, renameAddressCallBack }: { websiteAccess: OptionalSignal<WebsiteAccess>, renameAddressCallBack: RenameAddressCallBack }) => {
	const access = websiteAccess.deepValue
	const website = useComputed(() => websiteAccess.deepValue?.website)

	if (!access || access.addressAccess === undefined || access.addressAccess.length < 1 || website.value === undefined) return <></>

	return (
		<Collapsible summary = 'Address Access' defaultOpen>
			<p style = { { fontSize: '0.875rem', color: 'var(--text-color)', marginTop: '0.5rem' } }>Configure website access to these address(es). <button type = 'button' class = 'btn btn--ghost' style = { { fontSize: '0.875rem', border: '1px solid', width: '1rem', height: '1rem', padding: 0, borderRadius: '100%', display: 'inline-flex' } }>?</button></p>
				<div style = { { display: 'grid', rowGap: '0.5rem', padding: '0.5rem 0' } }>
		{ access.addressAccess.map((addressAcces) => <AddressAccessCard key = { addressAcces.address.toString() } website = { website } addressAccess = { addressAcces } renameAddressCallBack = { renameAddressCallBack }/>) }
			</div>
		</Collapsible>
	)
}

const AddressAccessCard = ({ website, addressAccess, renameAddressCallBack }: { website: ReadonlySignal<Website | undefined>, addressAccess: WebsiteAddressAccess, renameAddressCallBack: RenameAddressCallBack }) => {
	const { addressAccessMetadata } = useWebsiteAccess()

	const setAddressAccess = (event: Event) => {
		if (!(event.target instanceof HTMLInputElement)) return
		const currentWebsite = website.value
		if (currentWebsite === undefined) return
		sendPopupMessageToBackgroundPage({ method: 'popup_allowOrPreventAddressAccessForWebsite', data: { website: currentWebsite, address: addressAccess.address, allowAccess: event.target.checked } })
	}

	const addressBookEntry = useOptionalComputed(() => addressAccessMetadata.value.find(entry => entry.address === addressAccess.address))

	if (addressBookEntry.deepValue === undefined) return <></>
	return (
		<div style = { { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) min-content min-content', columnGap: '1rem', alignItems: 'center' } }>
			<BigAddress addressBookEntry = { addressBookEntry.deepValue } noEditAddress = { true } renameAddressCallBack = { renameAddressCallBack } />
			<RemoveAddressConfirmation website = { website } addressBookEntry = { addressBookEntry.deepValue } />
			<Switch checked = { addressAccess.access } onChange = { setAddressAccess } />
		</div>
	)
}

const RemoveAddressConfirmation = ({ website, addressBookEntry }: { addressBookEntry: AddressBookEntry, website: ReadonlySignal<Website | undefined> }) => {
	const removeAddressAccessForWebsite = async () => {
		if (!addressBookEntry) return
		const currentWebsite = website.value
		if (currentWebsite === undefined) return
		sendPopupMessageToBackgroundPage({ method: 'popup_removeWebsiteAddressAccess', data: { websiteOrigin: currentWebsite.websiteOrigin, address: addressBookEntry.address } })
	}

	const confirmOrRejectRemoval = (returnValue: 'confirm' | 'reject') => {
		if (returnValue !== 'confirm') return
		removeAddressAccessForWebsite()
	}

	return (
		<Modal>
			<Modal.Open class = 'btn btn--ghost'><TrashIcon /></Modal.Open>
			<Modal.Dialog class = 'dialog' style = { { textAlign: 'center', color: 'var(--disabled-text-color)' } } onModalClose = { confirmOrRejectRemoval }>
				<h2 style = { { fontWeight: 600, fontSize: '1.125rem', color: 'var(--text-color)', marginBlock: '1rem' } }>Removing Address</h2>
				<div style = { { marginBlock: '0.5rem' } }>This will prevent <WebsiteCard website = { website.value } /> from accessing or using <SmallAddress addressBookEntry = { addressBookEntry } renameAddressCallBack = { () => undefined } />
				</div>
				<p style = { { marginBlock: '1rem' } }>Remove the website's access to this address anyway?</p>
				<div style = { { display: 'flex', flexWrap: 'wrap', columnGap: '1rem', justifyContent: 'center', marginBlock: '1rem' } }>
					<Modal.Close class = 'btn btn--outline' value = 'reject'>Cancel</Modal.Close>
					<Modal.Close class = 'btn btn--destructive' value = 'confirm'>Confirm</Modal.Close>
				</div>
			</Modal.Dialog>
		</Modal>
	)
}

const AdvancedSettings = ({ websiteAccess, hostScopeDetails }: { websiteAccess: OptionalSignal<WebsiteAccess>, hostScopeDetails: ReadonlySignal<HostScopeDetails | undefined> }) => {
	if (websiteAccess.deepValue === undefined) return <></>
	return (
		<Collapsible summary = 'Advanced Settings' defaultOpen>
			<BlockRequestSetting websiteAccess = { websiteAccess } hostScopeDetails = { hostScopeDetails } />
			<DisableProtectionSetting websiteAccess = { websiteAccess } hostScopeDetails = { hostScopeDetails } />
			<RemoveWebsiteSetting websiteAccess = { websiteAccess } hostScopeDetails = { hostScopeDetails } />
		</Collapsible>
	)
}

const BlockRequestSetting = ({ websiteAccess, hostScopeDetails }: { websiteAccess: OptionalSignal<WebsiteAccess>, hostScopeDetails: ReadonlySignal<HostScopeDetails | undefined> }) => {
	const setWebsiteExternalRequestBlocking = async (shouldBlock: boolean) => {
		if (!websiteAccess.deepValue) return
		sendPopupMessageToBackgroundPage({ method: 'popup_blockOrAllowExternalRequests', data: { website: websiteAccess.deepValue.website, shouldBlock } })
	}

	const requestBlockMode = useComputed(() => websiteAccess.deepValue?.declarativeNetRequestBlockMode)
	const website = useComputed(() => websiteAccess.deepValue?.website)

	const confirmOrRejectRequestBlocking = (response: 'confirm' | 'reject') => {
		if (response !== 'confirm') return
		setWebsiteExternalRequestBlocking(true)
	}

	return (
		<article class = 'flexy flexy-lg'>
			<figure><i class = 'status-lg status-warn'><RequestBlockedIcon /></i></figure>
			<section class = 'flexy' style = { { flex: 1, '--pad-y': 0 } }>
				<div style = { { contain: 'inline-size', flex: '1 20ch', marginBottom: '0.5rem' } }>
					<h1 style = { { color: 'var(--text-color)', whiteSpace: 'nowrap' } }>Block External Requests For Host</h1>
					<p style = { { color: 'var(--disabled-text-color)', fontSize: '0.875rem' } }>The Interceptor can block network requests from every affected site on <b>{ hostScopeDetails.value?.hostname }</b>, preventing that host from connecting to external domains and services.</p>
				</div>
				<aside>
					{ requestBlockMode.value === 'block-all' ? (
						<button type='button' class = 'btn btn--primary' onClick = { () => setWebsiteExternalRequestBlocking(false) }><span style = { { whiteSpace: 'nowrap' } }>Unblock Host Requests</span></button>
					) : (
						<Modal>
							<Modal.Open class = 'btn btn--destructive'><span style = { { whiteSpace: 'nowrap' } }>Block Host Requests</span></Modal.Open>
								<Modal.Dialog class = 'dialog' style = { { textAlign: 'center', color: 'var(--disabled-text-color)' } } onModalClose = { confirmOrRejectRequestBlocking }>
									<h2 style = { { fontWeight: 600, fontSize: '1.125rem', color: 'var(--text-color)', marginBlock: '1rem' } }>Confirm Blocking External Requests For Host</h2>
									<p></p>
									<p style = { { marginBlock: '0.5rem' } }>This will prevent <WebsiteCard website = { website.value } /> and every affected site on <b>{ hostScopeDetails.value?.hostname }</b> from requesting resources outside that host, which can lead to erratic behavior or stop those sites from functioning entirely.</p>
									<p style = { { marginBlock: '1rem' } }>Are you sure you want to block external requests for this host?</p>
								<div style = { { display: 'flex', flexWrap: 'wrap', columnGap: '1rem', justifyContent: 'center', marginBlock: '1rem' } }>
									<Modal.Close class = 'btn btn--outline' value = 'reject'>Cancel</Modal.Close>
									<Modal.Close class = 'btn btn--destructive' value = 'confirm'>Confirm</Modal.Close>
								</div>

							</Modal.Dialog>
						</Modal>
					) }
				</aside>
			</section>
		</article>
	)
}

const DisableProtectionSetting = ({ websiteAccess, hostScopeDetails }: { websiteAccess: OptionalSignal<WebsiteAccess>, hostScopeDetails: ReadonlySignal<HostScopeDetails | undefined> }) => {

	const disableWebsiteProtection = async (shouldDisable = true) => {
		if (!websiteAccess.deepValue) return
		sendPopupMessageToBackgroundPage({ method: 'popup_setDisableInterceptor',  data: { website: websiteAccess.deepValue.website, interceptorDisabled: shouldDisable } })
	}

	const confirmOrRejectDialog = (response: 'confirm' | 'reject') => {
		if (response === 'reject') return
		disableWebsiteProtection()
	}

	const isInterceptorDisabled = useComputed(() => Boolean(websiteAccess.deepValue?.interceptorDisabled))
	const website = useComputed(() => websiteAccess.deepValue?.website)

	return (
		<article class = 'flexy flexy-lg'>
			<figure><i class = 'status-lg status-danger'><InterceptorDisabledIcon /></i></figure>
			<section class = 'flexy' style = { { flex: 1, '--pad-y': 0 } }>
				<div style = { { contain: 'inline-size', flex: '1 20ch', marginBottom: '0.5rem' } }>
					<h1 style = { { color: 'var(--text-color)', whiteSpace: 'nowrap' } }>Disable Protection For Host</h1>
					<p style = { { color: 'var(--disabled-text-color)', fontSize: '0.875rem' } }>Turn protection and simulation off for every affected site on <b>{ hostScopeDetails.value?.hostname }</b> and forward all requests directly to the default wallet.</p>
				</div>
				<aside>
					{ isInterceptorDisabled.value ? (
						<button type='button' class = 'btn btn--primary' onClick = { () => disableWebsiteProtection(false) }><span style = { { whiteSpace: 'nowrap' } }>Enable Host Protection</span></button>
					) : (
						<Modal>
							<Modal.Open class = 'btn btn--destructive'><span style = { { whiteSpace: 'nowrap' } }>Disable Host Protection</span></Modal.Open>
								<Modal.Dialog class = 'dialog' style = { { textAlign: 'center', color: 'var(--disabled-text-color)' } } onModalClose = { confirmOrRejectDialog }>
									<h2 style = { { fontWeight: 600, fontSize: '1.125rem', color: 'var(--text-color)', marginBlock: '1rem' } }>Disable Interceptor Protection For Host</h2>
									<p></p>
								<p style = { { marginBlock: '0.5rem' } }>Interceptor will no longer be able to simulate transactions from <WebsiteCard website = { website.value } /> or any other affected site on <b>{ hostScopeDetails.value?.hostname }</b>, which could potentially lead to loss of assets. Please exercise caution.</p>
									<p style = { { marginBlock: '1rem' } }>Are you sure you want to disable protection for this host?</p>
								<div style = { { display: 'flex', flexWrap: 'wrap', columnGap: '1rem', justifyContent: 'center', marginBlock: '1rem' } }>
									<Modal.Close class = 'btn btn--outline' value = 'reject'>Cancel</Modal.Close>
									<Modal.Close class = 'btn btn--destructive' value = 'confirm'>Confirm</Modal.Close>
								</div>
							</Modal.Dialog>
						</Modal>
					) }
				</aside>
			</section>
		</article>
	)
}

const RemoveWebsiteSetting = ({ websiteAccess, hostScopeDetails }: { websiteAccess: OptionalSignal<WebsiteAccess>, hostScopeDetails: ReadonlySignal<HostScopeDetails | undefined> }) => {
	const { selectedDomain } = useWebsiteAccess()
	const website = useComputed(() => websiteAccess.deepValue?.website)

	const confirmOrRejectUpdate = async (response: 'confirm' | 'reject') => {
		if (response !== 'confirm' || !websiteAccess.deepValue) return
		await sendPopupMessageToBackgroundPage({ method: 'popup_removeWebsiteAccess', data: { websiteOrigin: websiteAccess.deepValue.website.websiteOrigin } })
		selectedDomain.value = undefined
	}

	return (
		<article class = 'flexy flexy-lg'>
			<figure><i class = 'status-lg status-outline' style = { { '--fg-color': 'var(--status-danger-outline-color)', '--outline': '1px solid var(--status-danger-outline-color)' } }><TrashIcon /></i></figure>
			<section class = 'flexy' style = { { flex: 1, '--pad-y': 0 } }>
				<div style = { { contain: 'inline-size', flex: '1 20ch', marginBottom: '0.5rem' } }>
					<h1 style = { { color: 'var(--text-color)', whiteSpace: 'nowrap' } }>Remove Host Access</h1>
					<p style = { { color: 'var(--disabled-text-color)', fontSize: '0.875rem' } }>Revoke all permissions granted to every affected site on <b>{ hostScopeDetails.value?.hostname }</b>, including wallet access and network request blocking.</p>
				</div>
				<aside>
					<Modal>
						<Modal.Open class = 'btn btn--destructive'><span style = { { whiteSpace: 'nowrap' } }>Remove Host</span></Modal.Open>
							<Modal.Dialog class = 'dialog' style = { { textAlign: 'center', color: 'var(--disabled-text-color)' } } onModalClose = { confirmOrRejectUpdate }>
								<h2 style = { { fontWeight: 600, fontSize: '1.125rem', color: 'var(--text-color)', marginBlock: '1rem' } }>Confirm Host Removal</h2>
								<p></p>
								<p style = { { marginBlock: '0.5rem' } }>You are about to remove <WebsiteCard website = { website.value } /> and every affected site on <b>{ hostScopeDetails.value?.hostname }</b> from the access list. Those sites will no longer have access to your wallet addresses.</p>
								<p style = { { marginBlock: '1rem' } }>Are you sure you want to remove access for this host?</p>
							<div style = { { display: 'flex', flexWrap: 'wrap', columnGap: '1rem', justifyContent: 'center', marginBlock: '1rem' } }>
								<Modal.Close class = 'btn btn--outline' value = 'reject'>Cancel</Modal.Close>
								<Modal.Close class = 'btn btn--destructive' value = 'confirm'>Confirm</Modal.Close>
							</div>
						</Modal.Dialog>
					</Modal>
				</aside>
			</section>
		</article>
	)
}

const WebsiteCard = ({ website }: { website: Website | undefined }) => {
	if (website === undefined) return <></>
	const websiteIcon = sanitizeStoredWebsiteIcon(website.icon)
	return (
		<div style = { { display: 'inline-flex', alignItems: 'center', gap: '0.5rem', padding: '0.125rem 0.25rem', borderRadius: '2px', backgroundColor: 'var(--card-bg-color)', verticalAlign: 'bottom' } }>
			{ websiteIcon === undefined ? <></> : <img style = { { inlineSize: '1rem' } } width = '16' height = '16' src = { websiteIcon } /> }
			<div style = { { fontSize: '0.875rem', color: 'var(--text-color)' } }>{ website.websiteOrigin }</div>
		</div>
	)
}
