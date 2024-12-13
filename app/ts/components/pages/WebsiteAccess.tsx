import { useContext, useEffect, useRef } from 'preact/hooks'
import { Signal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { ComponentChildren, createContext, JSX } from 'preact'
import { Website, WebsiteAccess, WebsiteAccessArray, WebsiteAddressAccess } from '../../types/websiteAccessTypes.js'
import { Modal } from '../subcomponents/Modal.js'
import { Collapsible } from '../subcomponents/Collapsible.js'
import { Switch } from '../subcomponents/Switch.js'
import { MessageToPopup, RetrieveWebsiteAccessFilter } from '../../types/interceptor-messages.js'
import { AddressBookEntries, AddressBookEntry } from '../../types/addressBookTypes.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { InterceptorDisabledIcon, RequestBlockedIcon, SearchIcon, TrashIcon } from '../subcomponents/icons.js'
import { BigAddress, SmallAddress } from '../subcomponents/address.js'
import { createPortal } from 'preact/compat'
import { useOptionalComputed } from '../../utils/OptionalSignal.js'

const URL_HASH_KEY = 'origin'
const URL_HASH_PREFIX = `#${ URL_HASH_KEY }:`

type WebsiteAccessContext = {
	searchQuery: Signal<string>
	websiteAccessList: Signal<WebsiteAccessArray>
	addressAccessMetadata: Signal<AddressBookEntries>
	selectedDomain: Signal<string | undefined>
}

const WebsiteAccessContext = createContext<WebsiteAccessContext | undefined>(undefined)

const WebsiteAccessProvider = ({ children }: { children: ComponentChildren }) => {
	const websiteAccessList = useSignal<WebsiteAccessArray>([])
	const searchQuery = useSignal<string>('')
	const addressAccessMetadata = useSignal<AddressBookEntries>([])
	const selectedDomain = useSignal<string | undefined>(undefined)

	const retrieveWebsiteAccess = (filter?: RetrieveWebsiteAccessFilter) => {
		const data = filter ? filter : { query: '' }
		sendPopupMessageToBackgroundPage({ method: 'popup_retrieveWebsiteAccess', data })
	}

	const updateListOnSearch = () => {
		selectedDomain.value = undefined
		retrieveWebsiteAccess({ query: searchQuery.value })
	}

  const listenForPopupMessages = () => {
		const popupMessageListener = (msg: unknown) => {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return // not a message we are interested in
			const parsed = maybeParsed.value
			switch (parsed.method) {
				case 'popup_setDisableInterceptorReply':
				case 'popup_websiteAccess_changed':
					retrieveWebsiteAccess({ query: selectedDomain.value || '' })
					break
				case 'popup_retrieveWebsiteAccessReply':
					websiteAccessList.value = parsed.data.websiteAccess
					addressAccessMetadata.value = parsed.data.addressAccessMetadata
					break
			}
		}

		browser.runtime.onMessage.addListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	}

	const listenForWindowHashChanges = () => {
		const handleHashChange = () => {
			const hash = window.location.hash
			const domainInHash = hash.slice(URL_HASH_PREFIX.length)
			selectedDomain.value = domainInHash || undefined
		}

		// initially set selectedDomain when the page loads/reloads
		handleHashChange()
		window.addEventListener('hashchange', handleHashChange)
		return () => window.removeEventListener('hashchange', handleHashChange)
	}

	useSignalEffect(updateListOnSearch)
	useEffect(listenForPopupMessages, [])
	useEffect(listenForWindowHashChanges, [])
	useEffect(retrieveWebsiteAccess, [])

	return <WebsiteAccessContext.Provider value = { { searchQuery, websiteAccessList, addressAccessMetadata, selectedDomain } }>{ children }</WebsiteAccessContext.Provider>
}

export function useWebsiteAccess() {
	const context = useContext(WebsiteAccessContext)
	if (!context) throw new Error('useWebsiteAccess can only be used within children components of WebsiteAccessProvider')
	return context
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
	const { websiteAccessList } = useWebsiteAccess()

	return (
		<section style = { { paddingBlock: '1rem' } }>
			<h4 style = { { color: 'var(--disabled-text-color)' , fontSize: '0.875rem', display: 'grid', gridTemplateColumns: '1fr max-content' } }>Websites</h4>
			{ websiteAccessList.value.length < 1 ? <EmptyAccessList /> : <>
				<ul role = 'listbox'>{ websiteAccessList.value.map((access, index) => <WebsiteAccessOverview websiteAccess = { access } checked = { index === 0 } />) }</ul>
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
		window.location.href = `${ window.location.pathname }${ URL_HASH_PREFIX }${ websiteAccess.website.websiteOrigin }`
	}

	const getWebsiteStatus = () => {
		if (!websiteAccess.access) return
		if (websiteAccess.interceptorDisabled) return 'disabled'
		if (websiteAccess.declarativeNetRequestBlockMode === 'block-all') return 'blocked'
		return
	}

	return (
		<li role = 'option'>
			<input id = { websiteAccess.website.websiteOrigin } type = 'radio' name = { URL_HASH_KEY } value = { websiteAccess.website.websiteOrigin } defaultChecked = { checked } />
			<label htmlFor = { websiteAccess.website.websiteOrigin } style = { { cursor: 'pointer' } } onClick = { handleChange }>
				<div style = { { display: 'grid', gridTemplateColumns: 'min-content 1fr', alignItems: 'center', columnGap: '1rem', paddingBlock: '0.5rem' } }>
					<img role = 'img' src = { websiteAccess.website.icon } style = { { width: '1.5rem', aspectRatio: 1, maxWidth: 'none' } } title = 'Website Icon' />
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
			return <></>
	}
}

const FullFrameWindow = ({ children }: { children: ComponentChildren }) => {
	return createPortal(<div class = 'access-details'>{children}</div>, document.body)
}

const WebsiteSettingsDetail = () => {
	const { websiteAccessList, selectedDomain } = useWebsiteAccess()
	const selectedWebsiteAccess = useOptionalComputed(() => websiteAccessList.value.find(access => access.website.websiteOrigin === selectedDomain.value))

	const closeDetails = () => { window.location.hash = '' }

	if (selectedWebsiteAccess.value === undefined) return <></>

	return (
		<FullFrameWindow>
			<form method = 'dialog' class = 'layout' onSubmit = { closeDetails }>
				<header style = { { paddingBlock: '1rem' } }>
					<button type = 'submit' class = 'btn btn--ghost' style = { { fontSize: '0.875rem', paddingInline: '0.5rem', paddingBlock: '0.125rem' } } autoFocus>&larr; Show website access list</button>
          <DetailsHeader websiteAccess = { selectedWebsiteAccess.value } />
				</header>
				<article>
					<NoAccessPrompt websiteAccess = { selectedWebsiteAccess.value } />
					<AddressAccessList websiteAccess = { selectedWebsiteAccess.value } />
					<AdvancedSettings websiteAccess = { selectedWebsiteAccess.value } />
				</article>
			</form>
		</FullFrameWindow>
	)
}

const DetailsHeader = ({ websiteAccess }: { websiteAccess: Signal<WebsiteAccess> }) => {
	return (
		<div class = 'flexy flexy-sm' style = { { '--gap-x': '1rem', flex: 1 } }>
			<figure><img width = '34' height = '34' src = { websiteAccess.value.website.icon } /></figure>
			<div style = { { flex: 1 } }>
				<h2 class = 'truncate' style = { { contain: 'inline-size', fontSize: 'clamp(1.25rem,2vw,2rem)', fontWeight: 600, color: 'var(--text-color)' } }>{ websiteAccess.value.website.title }</h2>
				<p><span class = 'truncate' style = { { flex: 1, lineHeight: 1, color: 'var(--disabled-text-color)', direction: 'rtl', textAlign: 'left' } }>&lrm;{ websiteAccess.value.website.websiteOrigin }</span></p>
			</div>
		</div>
	)
}

const NoAccessPrompt = ({ websiteAccess }: { websiteAccess: Signal<WebsiteAccess> }) => {
	const { selectedDomain } = useWebsiteAccess()
	const website = useComputed(() => websiteAccess.value.website)

	// If the website has been granted access, don't show this message
	if (websiteAccess.value.access === true) return <></>

	const confirmOrRejectRemoval = async (returnValue: string) => {
		if (returnValue !== 'confirm' || !websiteAccess.value) return
		await sendPopupMessageToBackgroundPage({ method: 'popup_removeWebsiteAccess',  data: { websiteOrigin: websiteAccess.value.website.websiteOrigin } })
		selectedDomain.value = undefined
	}

	return (
		<div style = { { color: 'var(--disabled-text-color)', border: '1px dashed', padding: '2rem', maxWidth: '50ch', textAlign: 'center', margin: '1rem auto' } }>
				<h4 style = { { fontWeight: 600, color: 'var(--text-color)', lineHeight: '1.25', marginBottom: '0.5rem' } }>This website was denied access to The Interceptor.</h4>
				<p style = { { fontSize: '0.875rem', lineHeight: 1.25, marginBottom: '1rem' } }>Interceptor will automatically deny further requests from <WebsiteCard website = { website } /> for access while this preference is set.</p>
				<Modal>
					<Modal.Open class = 'btn btn--outline' style = { { display: 'inline-block' } }>Stop automatically denying access requests</Modal.Open>
					<Modal.Dialog class = 'dialog' style = { { textAlign: 'center', color: 'var(--disabled-text-color)' } } onModalClose = { confirmOrRejectRemoval }>
						<h2 style = { { fontWeight: 600, fontSize: '1.125rem', color: 'var(--text-color)', marginBlock: '1rem' } }>Stop automatically denying access requests</h2>
						<p></p>
						<p style = { { marginBlock: '0.5rem', lineHeight: 1.5 } }>After confirming this action, The Interceptor will stop automatically denying access requests from <WebsiteCard website = { website } /> and will prompt you for permission the next time you try to connect.</p>
						<div style = { { display: 'flex', flexWrap: 'wrap', columnGap: '1rem', justifyContent: 'center', marginBlock: '1rem' } }>
							<Modal.Close class = 'btn btn--outline' value = 'reject'>Cancel</Modal.Close>
							<Modal.Close class = 'btn btn--destructive' value = 'confirm'>Confirm</Modal.Close>
						</div>
					</Modal.Dialog>
				</Modal>
			</div>
	)
}

const AddressAccessList = ({ websiteAccess }: { websiteAccess: Signal<WebsiteAccess> }) => {
	const access = websiteAccess.value
	const website = useComputed(() => websiteAccess.value.website)

	if (!access || access.addressAccess === undefined || access.addressAccess.length < 1 || website === undefined) return <></>

	return (
		<Collapsible summary = 'Address Access' defaultOpen>
			<p style = { { fontSize: '0.875rem', color: 'var(--text-color)', marginTop: '0.5rem' } }>Configure website access to these address(es). <button type = 'button' class = 'btn btn--ghost' style = { { fontSize: '0.875rem', border: '1px solid', width: '1rem', height: '1rem', padding: 0, borderRadius: '100%', display: 'inline-flex' } }>?</button></p>
				<div style = { { display: 'grid', rowGap: '0.5rem', padding: '0.5rem 0' } }>
				{ access.addressAccess.map(addressAcces => <AddressAccessCard website = { website } addressAccess = { addressAcces } />) }
			</div>
		</Collapsible>
	)
}

const AddressAccessCard = ({ website, addressAccess }: { website: Signal<Website>, addressAccess: WebsiteAddressAccess }) => {
	const { addressAccessMetadata } = useWebsiteAccess()

	const setAddressAccess = (event: Event) => {
		if (!(event.target instanceof HTMLInputElement)) return
		sendPopupMessageToBackgroundPage({ method: 'popup_allowOrPreventAddressAccessForWebsite', data: { website: website.value, address: addressAccess.address, allowAccess: event.target.checked } })
	}

	const renameAddressCallBack = (newAddress: AddressBookEntry) => {
		console.log('new address', newAddress)
		// TODO: Implement address editing https://github.com/DarkFlorist/TheInterceptor/issues/1131
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

const RemoveAddressConfirmation = ({ website, addressBookEntry }: { addressBookEntry: AddressBookEntry, website: Signal<Website> }) => {
	const removeAddressAccessForWebsite = async () => {
		if (!addressBookEntry) return
		sendPopupMessageToBackgroundPage({ method: 'popup_removeWebsiteAddressAccess', data: { websiteOrigin: website.value.websiteOrigin, address: addressBookEntry.address } })
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
				<div style = { { marginBlock: '0.5rem' } }>This will prevent <WebsiteCard website = { website } /> from accessing or using <SmallAddress addressBookEntry = { addressBookEntry } renameAddressCallBack = { () => {} } />
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

const AdvancedSettings = ({ websiteAccess }: { websiteAccess: Signal<WebsiteAccess> }) => {
	return (
		<Collapsible summary = 'Advanced Settings' defaultOpen>
			<BlockRequestSetting websiteAccess = { websiteAccess } />
			<DisableProtectionSetting websiteAccess = { websiteAccess } />
			<RemoveWebsiteSetting websiteAccess = { websiteAccess } />
		</Collapsible>
	)
}

const BlockRequestSetting = ({ websiteAccess }: { websiteAccess: Signal<WebsiteAccess> }) => {
	const setWebsiteExternalRequestBlocking = async (shouldBlock: boolean) => {
		if (!websiteAccess.value) return
		sendPopupMessageToBackgroundPage({ method: 'popup_blockOrAllowExternalRequests', data: { website: websiteAccess.value.website, shouldBlock } })
	}

	const requestBlockMode = useComputed(() => websiteAccess.value.declarativeNetRequestBlockMode)
	const website = useComputed(() => websiteAccess.value.website)

	const confirmOrRejectRequestBlocking = (response: 'confirm' | 'reject') => {
		if (response !== 'confirm') return
		setWebsiteExternalRequestBlocking(true)
	}

	return (
		<article class = 'flexy flexy-lg'>
			<figure><i class = 'status-lg status-warn'><RequestBlockedIcon /></i></figure>
			<section class = 'flexy' style = { { flex: 1, '--pad-y': 0 } }>
				<div style = { { contain: 'inline-size', flex: '1 20ch', marginBottom: '0.5rem' } }>
					<h1 style = { { color: 'var(--text-color)', whiteSpace: 'nowrap' } }>Block External Request</h1>
					<p style = { { color: 'var(--disabled-text-color)', fontSize: '0.875rem' } }>The Interceptor can block network requests from this domain, effectively preventing the website from connecting to external domains and services.</p>
				</div>
				<aside>
					{ requestBlockMode.value === 'block-all' ? (
						<button type='button' class = 'btn btn--primary' onClick = { () => setWebsiteExternalRequestBlocking(false) }><span style = { { whiteSpace: 'nowrap' } }>Unblock Requests</span></button>
					) : (
						<Modal>
							<Modal.Open class = 'btn btn--destructive'><span style = { { whiteSpace: 'nowrap' } }>Block Requests</span></Modal.Open>
							<Modal.Dialog class = 'dialog' style = { { textAlign: 'center', color: 'var(--disabled-text-color)' } } onModalClose = { confirmOrRejectRequestBlocking }>
								<h2 style = { { fontWeight: 600, fontSize: '1.125rem', color: 'var(--text-color)', marginBlock: '1rem' } }>Confirm Blocking External Requests</h2>
								<p></p>
								<p style = { { marginBlock: '0.5rem' } }>This will prevent <WebsiteCard website = { website } /> from requesting resources outside its domain, which can lead to erratic behavior or even cause it to stop functioning entirely.</p>
								<p style = { { marginBlock: '1rem' } }>Are you sure you want to block external requests from this website?</p>
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

const DisableProtectionSetting = ({ websiteAccess }: { websiteAccess: Signal<WebsiteAccess> }) => {

	const disableWebsiteProtection = async (shouldDisable = true) => {
		if (!websiteAccess.value) return
		sendPopupMessageToBackgroundPage({ method: 'popup_setDisableInterceptor',  data: { website: websiteAccess.value.website, interceptorDisabled: shouldDisable } })
	}

	const confirmOrRejectDialog = (response: 'confirm' | 'reject') => {
		if (response === 'reject') return
		disableWebsiteProtection()
	}

	const isInterceptorDisabled = useComputed(() => Boolean(websiteAccess.value.interceptorDisabled))
	const website = useComputed(() => websiteAccess.value.website)

	return (
		<article class = 'flexy flexy-lg'>
			<figure><i class = 'status-lg status-danger'><InterceptorDisabledIcon /></i></figure>
			<section class = 'flexy' style = { { flex: 1, '--pad-y': 0 } }>
				<div style = { { contain: 'inline-size', flex: '1 20ch', marginBottom: '0.5rem' } }>
					<h1 style = { { color: 'var(--text-color)', whiteSpace: 'nowrap' } }>Disable Protection</h1>
					<p style = { { color: 'var(--disabled-text-color)', fontSize: '0.875rem' } }>Turn protection and simulation off for this website and forward all requests directly to default wallet.</p>
				</div>
				<aside>
					{ isInterceptorDisabled.value ? (
						<button type='button' class = 'btn btn--primary' onClick = { () => disableWebsiteProtection(false) }><span style = { { whiteSpace: 'nowrap' } }>Enable Protection</span></button>
					) : (
						<Modal>
							<Modal.Open class = 'btn btn--destructive'><span style = { { whiteSpace: 'nowrap' } }>Disable Protection</span></Modal.Open>
							<Modal.Dialog class = 'dialog' style = { { textAlign: 'center', color: 'var(--disabled-text-color)' } } onModalClose = { confirmOrRejectDialog }>
								<h2 style = { { fontWeight: 600, fontSize: '1.125rem', color: 'var(--text-color)', marginBlock: '1rem' } }>Disable Interceptor Protection</h2>
								<p></p>
								<p style = { { marginBlock: '0.5rem' } }>Interceptor will no longer be able to simulate transactions from <WebsiteCard website = { website } />, which could potentially lead to loss of assets. Please exercise caution.</p>
								<p style = { { marginBlock: '1rem' } }>Are you sure you want to disable protection for this website?</p>
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

const RemoveWebsiteSetting = ({ websiteAccess }: { websiteAccess: Signal<WebsiteAccess> }) => {
	const { selectedDomain } = useWebsiteAccess()
	const website = useComputed(() => websiteAccess.value.website)

	const confirmOrRejectUpdate = async (response: 'confirm' | 'reject') => {
		if (response !== 'confirm' || !websiteAccess.value) return
		await sendPopupMessageToBackgroundPage({ method: 'popup_removeWebsiteAccess', data: { websiteOrigin: websiteAccess.value.website.websiteOrigin } })
		selectedDomain.value = undefined
	}

	return (
		<article class = 'flexy flexy-lg'>
			<figure><i class = 'status-lg status-outline' style = { { '--fg-color': '#FF7272', '--outline': '1px solid' } }><TrashIcon /></i></figure>
			<section class = 'flexy' style = { { flex: 1, '--pad-y': 0 } }>
				<div style = { { contain: 'inline-size', flex: '1 20ch', marginBottom: '0.5rem' } }>
					<h1 style = { { color: 'var(--text-color)', whiteSpace: 'nowrap' } }>Remove Website Access</h1>
					<p style = { { color: 'var(--disabled-text-color)', fontSize: '0.875rem' } }>Revoke all permissions granted to this website including configured access to wallet addresses and network request blocking.</p>
				</div>
				<aside>
					<Modal>
						<Modal.Open class = 'btn btn--destructive'><span style = { { whiteSpace: 'nowrap' } }>Remove Website</span></Modal.Open>
						<Modal.Dialog class = 'dialog' style = { { textAlign: 'center', color: 'var(--disabled-text-color)' } } onModalClose = { confirmOrRejectUpdate }>
							<h2 style = { { fontWeight: 600, fontSize: '1.125rem', color: 'var(--text-color)', marginBlock: '1rem' } }>Confirm Website Removal</h2>
							<p></p>
							<p style = { { marginBlock: '0.5rem' } }>You are about to remove <WebsiteCard website = { website } /> from the list of allowed sites. By doing so, the website will no longer have access to your wallet addresses.</p>
							<p style = { { marginBlock: '1rem' } }>Are you sure you want to remove this website?</p>
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

const WebsiteCard = ({ website }: { website: Signal<Website> }) => {
	return (
		<div style = { { display: 'inline-flex', alignItems: 'center', gap: '0.5rem', padding: '0.125rem 0.25rem', borderRadius: '2px', backgroundColor: 'var(--card-bg-color)', verticalAlign: 'bottom' } }>
			<img style = { { inlineSize: '1rem' } } src = { website.value.icon } />
			<div style = { { fontSize: '0.875rem', color: 'var(--text-color)' } }>{ website.value.websiteOrigin }</div>
		</div>
	)
}
