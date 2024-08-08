import { useContext, useEffect, useRef } from 'preact/hooks'
import { Signal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { ComponentChildren, createContext, JSX } from 'preact'
import { Blockie } from '../subcomponents/SVGBlockie.js'
import { WebsiteAccess, WebsiteAccessArray, WebsiteAddressAccess } from '../../types/websiteAccessTypes.js'
import { Modal } from '../subcomponents/Modal.js'
import { EthereumAddress, serialize } from '../../types/wire-types.js'
import { Collapsible } from '../subcomponents/Collapsible.js'
import { Switch } from '../subcomponents/Switch.js'
import { Layout, useLayout } from '../subcomponents/DefaultLayout.js'
import { MessageToPopup, RetrieveWebsiteAccessFilter } from '../../types/interceptor-messages.js'
import { AddressBookEntries } from '../../types/addressBookTypes.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { InterceptorDisabledIcon, RequestBlockedIcon, SearchIcon, TrashIcon } from '../subcomponents/icons.js'
import { updateWebsiteAccess } from '../../background/settings.js'
import { setInterceptorDisabledForWebsite } from '../../background/accessManagement.js'

type SearchParameters = {
	query: string
	preSelectIndex: number
}

type WebsiteAccessContext = {
	search: Signal<SearchParameters>
	accessList: Signal<WebsiteAccessArray | undefined>
	selectedDomain: Signal<string | undefined>
}

const WebsiteAccessContext = createContext<WebsiteAccessContext | undefined>(undefined)
const WebsiteAccessProvider = ({ children }: { children: ComponentChildren }) => {
	const accessList = useSignal<WebsiteAccessArray | undefined>(undefined)
	const addressAccessFromStore = useSignal<AddressBookEntries | undefined>(undefined)
	const search = useSignal<SearchParameters>({ query: '', preSelectIndex: 0 })
	const selectedDomain = useSignal<string | undefined>(undefined)

	const syncAccessList = (filter?: RetrieveWebsiteAccessFilter) => {
		const data = filter ? filter : { query: '' }
		sendPopupMessageToBackgroundPage({ method: 'popup_retrieveWebsiteAccess', data })
	}

	const updateListOnSearch = () => {
		selectedDomain.value = undefined
		syncAccessList({ query: search.value.query })
	}

	const setDefaultSelection = () => {
		if (selectedDomain.value !== undefined) return
		selectedDomain.value = accessList.value?.at(0)?.website.websiteOrigin
	}

	useSignalEffect(updateListOnSearch)

	useSignalEffect(() => console.log(selectedDomain.value))

	useEffect(() => {
		const popupMessageListener = async (msg: unknown) => {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return // not a message we are interested in
			const parsed = maybeParsed.value
			switch (parsed.method) {
				case 'popup_setDisableInterceptorReply':
				case 'popup_websiteAccess_changed': syncAccessList({ query: '' }); break
				case 'popup_retrieveWebsiteAccessReply':
					accessList.value = parsed.data.websiteAccess
					addressAccessFromStore.value = parsed.data.addressAccess
					setDefaultSelection()
					break
			}
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	}, [])

	useEffect(syncAccessList, [])

	return <WebsiteAccessContext.Provider value = { { search, accessList, selectedDomain } }>{ children }</WebsiteAccessContext.Provider>
}

export function useWebsiteAccess() {
	const context = useContext(WebsiteAccessContext)
	if (!context) throw new Error('useWebsiteAccess can only be used within chilren components of WebsiteAccessProvider')
	return context
}

export const WebsiteAccessView = () => {
	return (
		<WebsiteAccessProvider>
			<Layout>
				<Layout.Header>
					<h1 style = { { flex: 1, fontSize: '1.5rem', fontWeight: 500, whiteSpace: 'nowrap', color: 'var(--text-color)' } }>Manage Websites</h1>
					<SearchForm id = 'site_search' name = 'search' placeholder = 'Enter a website address' />
				</Layout.Header>
				<Layout.Sidebar>
					<WebsiteAccessListing />
				</Layout.Sidebar>
				<Layout.Main>
					<WebsiteAccessDetails />
				</Layout.Main>
			</Layout>
		</WebsiteAccessProvider>
	)
}

type SearchFormProps = {
	id: string
	name: string
	placeholder?: string
	defaultValue?: string
	hidden?: boolean
}

const SearchForm = ({ hidden, ...props }: SearchFormProps) => {
	const inputRef = useRef<HTMLInputElement>(null)
	const { search } = useWebsiteAccess()

	const updateSearchParameters = (event: Event) => {
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const formData = new FormData(event.currentTarget)
		const inputValue = formData.get(props.name)?.toString()
		search.value = { query: inputValue || '', preSelectIndex: 0 }
	}

	const commitSelectionOrReset = (event: Event) => {
		event.preventDefault()
		if (!(event instanceof SubmitEvent)) return
		if (!(event.currentTarget instanceof HTMLFormElement) || !inputRef.current) return

		if (event.submitter instanceof HTMLButtonElement && event.submitter.value === 'clear') {
			event.currentTarget.reset()

			const formData = new FormData(event.currentTarget)
			const inputValue = formData.get(props.name)?.toString()
			search.value = { query: inputValue || '', preSelectIndex: 0 }
			inputRef.current.focus()
			return
		}
	}

	return (
		<form role = 'search' onInput = { updateSearchParameters } onSubmit = { commitSelectionOrReset }>
			<fieldset>
				<label for = { props.id }><SearchIcon /> </label>
				<input { ...props } name = { props.name } ref = { inputRef } type = 'search' value = { search.value.query } autoFocus autoComplete = 'off' />
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

const WebsiteAccessListing = () => {
	const { isStacked } = useLayout()
	const listRef = useRef<HTMLDivElement>(null)
	const { accessList, search, selectedDomain } = useWebsiteAccess()

	const queryString = useComputed(() => search.value.query)

	const updateSelection = (event: Event) => {
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		event.preventDefault()
		const formData = new FormData(event.currentTarget)
		selectedDomain.value = formData.get('search_option')?.toString() || ''
	}

	useSignalEffect(() => {
		if (!isStacked.value || !(typeof queryString.value === 'string') || !listRef.current) return
		listRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
	})

	if (!accessList.value) return <></>
	if (accessList.value.length < 1) return <EmptyAccessList />

	return (
		<section ref = { listRef } style = { { scrollMarginTop: 'var(--header-height)', paddingBlock: '1rem' } }>
			<h4 style = { { fontSize: '0.875rem', display: 'grid', gridTemplateColumns: '1fr max-content' } }>Websites</h4>
			<form onChange = { updateSelection }>
				<div role = 'listbox'>
					{ accessList.value.map((access) => (
						<WebsiteAccessOverview key = { access.website.websiteOrigin } { ...access } />
					)) }
				</div>
			</form>
		</section>
	)
}

const EmptyAccessList = () => {
	const { search } = useWebsiteAccess()
	const clearSearch = () => { search.value = { ...search.peek(), query: '' } }

	return (
		<div style = { { display: 'flex', flexDirection: 'column', rowGap: '0.5rem', border: '1px dashed var(--line-color)', padding: '1rem', textAlign: 'center' } }>
			<p style = { { color: 'var(--disabled-text-color)', fontSize: '0.9rem', lineHeight: 1.2 } }>Did not find anything that matched your search query</p>
			<button onClick = { clearSearch } type = 'button' class = 'btn btn--outline btn--sm' style = { { fontSize: '0.9rem' } }>Clear Search</button>
		</div>
	)
}

const WebsiteAccessOverview = ({ website, interceptorDisabled, declarativeNetRequestBlockMode }: WebsiteAccess) => {
	const { selectedDomain } = useWebsiteAccess()

	const isSelected = useComputed(() => selectedDomain.value === website.websiteOrigin)
	const statusMap = {
		'disabled': interceptorDisabled,
		'blocking': declarativeNetRequestBlockMode === 'block-all'
	}

	// list only status for properties that are enabled
	const statuses = Object.keys(Object.fromEntries(Object.entries(statusMap).filter(([_, value]) => value)))

	return (
		<label role = 'option' htmlFor = { website.websiteOrigin } class = 'flexy flexy-sm' tabIndex = { -1 }>
			<input type = 'radio' id = { website.websiteOrigin } name = 'search_option' value = { website.websiteOrigin } checked = { isSelected.value } />
			{ website.icon ? <img role = 'img' src = { website.icon } style = { { width: '1.5rem', aspectRatio: 1, maxWidth: 'none' } } title = 'Website Icon' /> : <></>
			}
			<div class = 'flexy' style = { { textAlign: 'left', flex: '1', '--pad-y': 0 } }>
				<div style = { { flex: 1 } }>
					<h4 class = 'truncate' style = { { color: 'var(--heading-color)', fontWeight: 'var(--heading-weight)' } }>{ website.title }</h4>
					<p class = 'truncate' style = { { fontSize: '0.875rem', lineHeight: 1.25, direction: 'rtl', color: 'var(--subheading-color)' } }>&lrm;{ website.websiteOrigin }</p>
				</div>
				<SiteStatusIndicator statuses = { statuses } />
			</div>
		</label>
	)
}

const SiteStatusIndicator = ({ statuses }: { statuses: string[] }) => {
	return <>
		{ statuses.includes('blocking') ? (
			<span class = 'status-warn' role = 'img' title = 'External Request Blocked' aria-label = 'External Request Blocked'><RequestBlockedIcon /></span>
		) : <></> }
		{ statuses.includes('disabled') ? (
			<span class = 'status-danger' role = 'img' title = 'Protection Disabled' aria-label = 'Protection Disabled'><InterceptorDisabledIcon /></span>
		) : <></> }
	</>
}

const WebsiteAccessDetails = () => {
	const detailsRef = useRef<HTMLDivElement>(null)
	const { isStacked } = useLayout()
	const { accessList, selectedDomain } = useWebsiteAccess()

	const scrollIntoViewOnUserSelection = () => {
		if (!isStacked.value || !selectedDomain.value || !detailsRef.current) return
		detailsRef.current.scrollIntoView({ behavior: 'smooth' })
	}

	const activeAccess = useComputed(() => accessList.value?.find(access => access.website.websiteOrigin === selectedDomain.value))
	useSignalEffect(scrollIntoViewOnUserSelection)

	if (!activeAccess.value) return <></>

	return (
		<div ref = { detailsRef } style = { { scrollMarginTop: 'var(--header-height)' } }>
			<header style = { { paddingBlock: '1rem', position: 'sticky', top: 'var(--header-height)', background: 'var(--bg-color)', zIndex: 1 } }>
				<BackToTop />
				<div class = 'flexy' style = { { '--gap-x': '1rem' } }>
					<figure><img width = '34' height = '34' src = { activeAccess.value.website.icon } /></figure>
					<div style = { { flex: 1 } }>
						<h2 class = 'truncate' style = { { fontSize: 'clamp(1.25rem,2vw,2rem)', fontWeight: 600, color: 'var(--text-color)' } }>{ activeAccess.value.website.title }</h2>
						<p><span class = 'truncate' style = { { flex: 1, lineHeight: 1, color: 'var(--disabled-text-color)', direction: 'rtl', textAlign: 'left' } }>&lrm;{ activeAccess.value.website.websiteOrigin }</span></p>
					</div>
				</div>
			</header>
			<AddressAccessList websiteAccess = { activeAccess.value } />
			<AdvancedSettings websiteAccess = { activeAccess.value } />
		</div>
	)
}

const BackToTop = () => {
	const { isStacked } = useLayout()
	const scrollToTop = () => { window.scrollTo({ top: 0, behavior: 'smooth' }) }

	if (!isStacked.value) return <></>

	return <button type = 'button' class = 'btn btn--outline' style = { { width: '100%', marginBottom: '0.5rem' } } onClick = { scrollToTop }>&uarr; Show website list</button>
}

const AddressAccessList = ({ websiteAccess }: { websiteAccess: WebsiteAccess }) => {
	if (websiteAccess.addressAccess === undefined || websiteAccess.addressAccess.length < 1) return <></>

	return (
		<Collapsible summary = 'Address Access' defaultOpen>
			<p style = { { fontSize: '0.875rem', color: 'var(--text-color)', marginTop: '0.5rem' } }>Configure website access these address(es). <button class = 'btn btn--ghost' style = { { fontSize: '0.875rem', border: '1px solid', width: '1rem', height: '1rem', padding: 0, borderRadius: '100%', display: 'inline-flex' } }>?</button></p>
			<div style = { { display: 'grid', rowGap: '0.5rem', padding: '0.5rem 0' } }>
				{ websiteAccess.addressAccess.map(addressAcces => (
					<AddressAccessCard key = { Object.values(addressAcces).join('_') } websiteAccess = { websiteAccess } addressAccess = { addressAcces } />
				)) }
			</div>
		</Collapsible>
	)
}

const AddressAccessCard = ({ websiteAccess, addressAccess }: { websiteAccess: WebsiteAccess, addressAccess: WebsiteAddressAccess }) => {
	const { search } = useWebsiteAccess()
	const updateAddressAccessForWebsite = async (shouldAllowAccess: boolean) => {
		const websiteOrigin = websiteAccess.website.websiteOrigin
		await updateWebsiteAccess((existingAccessList) => {
			// use Map to have mutable copies of current configuration
			const newWebsiteAccessMap = new Map(existingAccessList.map(existingAccess => [existingAccess.website.websiteOrigin, { ...existingAccess }]))
			if (newWebsiteAccessMap.has(websiteOrigin)) {
				// get should already be known here https://github.com/microsoft/TypeScript/issues/13086
				const websiteAccessOfWebsiteOrigin = newWebsiteAccessMap.get(websiteOrigin)!
				if (!websiteAccessOfWebsiteOrigin.addressAccess) return existingAccessList
				const addressAccessOfWebsiteOriginMap = new Map(websiteAccessOfWebsiteOrigin.addressAccess.map(addressAccess => [addressAccess.address, { ...addressAccess }]))
				if (addressAccessOfWebsiteOriginMap.has(addressAccess.address)) {
					addressAccessOfWebsiteOriginMap.get(addressAccess.address)!.access = shouldAllowAccess
				}
				websiteAccessOfWebsiteOrigin.addressAccess = Array.from(addressAccessOfWebsiteOriginMap.values())
			}
			return Array.from(newWebsiteAccessMap.values())
		})

		sendPopupMessageToBackgroundPage({ method: 'popup_retrieveWebsiteAccess',  data: { query: search.value.query } })
	}

	const toggleAddressAccess = (event: JSX.TargetedEvent<HTMLInputElement>) => {
		updateAddressAccessForWebsite(event.currentTarget.checked)
	}

	return (
		<div style = { { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) min-content min-content', columnGap: '1rem', alignItems: 'center' } }>
			<AddressCard key = { websiteAccess.website.websiteOrigin } address = { addressAccess.address } />
			<RemoveAddressConfirmation key = { websiteAccess.website.websiteOrigin } websiteOrigin = { websiteAccess.website.websiteOrigin } address = { addressAccess.address } />
			<Switch key = { websiteAccess.website.websiteOrigin } checked = { addressAccess.access } onChange = { toggleAddressAccess } />
		</div>
	)
}

const RemoveAddressConfirmation = ({ websiteOrigin, address }: { address: bigint, websiteOrigin: string }) => {
	const { search } = useWebsiteAccess()
	const addressString = serialize(EthereumAddress, address)

	const removeAddressAccessForWebsite = async () => {
		await updateWebsiteAccess((existingAccessList) => {
			const newWebsiteAccessMap = new Map(existingAccessList.map(access => [access.website.websiteOrigin, { ...access }]))
			if (newWebsiteAccessMap.has(websiteOrigin)) {
				const websiteAccessOfWebsiteOrigin = newWebsiteAccessMap.get(websiteOrigin)!
				if (!websiteAccessOfWebsiteOrigin.addressAccess) return existingAccessList
				const addressAccessOfWebsiteOriginMap = new Map(websiteAccessOfWebsiteOrigin.addressAccess.map(addressAccess => [addressAccess.address, { ...addressAccess }]))
				if (addressAccessOfWebsiteOriginMap.has(address)) addressAccessOfWebsiteOriginMap.delete(address)
				websiteAccessOfWebsiteOrigin.addressAccess = Array.from(addressAccessOfWebsiteOriginMap.values())
			}
			return Array.from(newWebsiteAccessMap.values())
		})

		sendPopupMessageToBackgroundPage({ method: 'popup_retrieveWebsiteAccess',  data: { query: search.value.query } })
	}

	const confirmOrRejectRemoval = (returnValue: string) => {
		if (returnValue !== 'confirm') return
		removeAddressAccessForWebsite()
	}

	return (
		<Modal>
			<Modal.Open class = 'btn btn--ghost'><TrashIcon /></Modal.Open>
			<Modal.Dialog class = 'dialog' style = { { textAlign: 'center', color: 'var(--disabled-text-color)' } } onClose = { confirmOrRejectRemoval }>
				<h2 style = { { fontWeight: 600, fontSize: '1.125rem', color: 'var(--text-color)', marginBlock: '1rem' } }>Removing Address</h2>
				<p style = { { marginBlock: '0.5rem' } }>This will permanently premove ***.*** access to the following address <data value = { addressString } style = { { backgroundColor: 'var(--card-bg-color)', color: 'var(--text-color)', padding: '2px 4px', borderRadius: 2 } }>{ addressString }</data></p>
				<p style = { { marginBlock: '1rem' } }>Are you sure you want to continue?</p>
				<div style = { { display: 'flex', flexWrap: 'wrap', columnGap: '1rem', justifyContent: 'center', marginBlock: '1rem' } }>
					<Modal.Close class = 'btn btn--outline' value = 'reject'>Cancel</Modal.Close>
					<Modal.Close class = 'btn btn--destructive' value = 'confirm'>Confirm</Modal.Close>
				</div>

			</Modal.Dialog>
		</Modal>
	)
}

const AddressCard = ({ address }: { address: bigint }) => {
	return (
		<article class = 'flexy flexy-sm'>
			<figure><Blockie style = { { fontSize: '2rem' } } address = { address } /></figure>
			<section style = { { flex: 1 } }>
				<p style = { { color: 'var(--text-color)' } }>vitalik.eth</p>
				<BigIntToEthereumAddress bigIntAddress = { address } class = 'truncate' style = { { fontSize: '0.875rem', color: 'var(--disabled-text-color)' } } />
			</section>
		</article>
	)
}

type BigIntToEthereumAddress = Omit<JSX.HTMLAttributes<HTMLDataElement>, 'value'> & { bigIntAddress: bigint }
const BigIntToEthereumAddress = ({ bigIntAddress, onClick, ...props }: BigIntToEthereumAddress) => {
	const ethereumAddress = serialize(EthereumAddress, bigIntAddress)
	return <data { ...props } value = { ethereumAddress }>{ ethereumAddress }</data>
}

const AdvancedSettings = ({ websiteAccess }: { websiteAccess: WebsiteAccess }) => {
	return (
		<Collapsible summary = 'Advanced Settings' defaultOpen>
			<BlockRequestSetting key = { websiteAccess.declarativeNetRequestBlockMode } websiteAccess = { websiteAccess } />
			<DisableProtectionSetting key = { websiteAccess.interceptorDisabled } websiteAccess = { websiteAccess } />
			<RemoveWebsiteSetting websiteAccess = { websiteAccess } />
		</Collapsible>
	)
}

const BlockRequestSetting = ({ websiteAccess }: { websiteAccess: WebsiteAccess }) => {
	const { search } = useWebsiteAccess()
	const requestBlockMode = useComputed(() => websiteAccess.declarativeNetRequestBlockMode)

	const blockExternalRequests = async (shouldBlock: boolean = true) => {
		const activeWebsite = websiteAccess.website

		await updateWebsiteAccess((previousAccess) => {
			return previousAccess.map((access) => {
				if (access.website.websiteOrigin === activeWebsite.websiteOrigin) {
					return { ...access, declarativeNetRequestBlockMode: shouldBlock ? 'block-all' : 'disabled' }
				}
				return access
			})
		})

		sendPopupMessageToBackgroundPage({ method: 'popup_retrieveWebsiteAccess',  data: { query: search.value.query } })
	}

	const confirmOrRejectDialog = (response: string) => {
		if (response === 'confirm') blockExternalRequests()
	}

	if (!websiteAccess.access) return <></>

	return (
		<article class = 'flexy flexy-lg'>
			<figure><i class = 'status-lg status-warn'><RequestBlockedIcon /></i></figure>
			<section class = 'flexy' style = { { flex: 1, '--pad-y': 0 } }>
				<div style = { { contain: 'inline-size', flex: '1 20ch', marginBottom: '0.5rem' } }>
					<h1 style = { { color: 'var(--text-color)', whiteSpace: 'nowrap' } }>Block External Request</h1>
					<p style = { { color: 'var(--disabled-text-color)', fontSize: '0.875rem' } }>The Interceptor can block network requests from this domain, effectively preventing the website from dialing to unknown domains and services.</p>
				</div>
				<aside>

					{ requestBlockMode.value === 'block-all' ? (
						<button class = 'btn btn--primary' onClick = { () => blockExternalRequests(false) }><span style = { { whiteSpace: 'nowrap' } }>Unblock Requests</span></button>
					) : (
						<Modal>
							<Modal.Open class = 'btn btn--destructive'><span style = { { whiteSpace: 'nowrap' } }>Block Requests</span></Modal.Open>
							<Modal.Dialog class = 'dialog' style = { { textAlign: 'center', color: 'var(--disabled-text-color)' } } onClose = { confirmOrRejectDialog }>
								<h2 style = { { fontWeight: 600, fontSize: '1.125rem', color: 'var(--text-color)', marginBlock: '1rem' } }>Confirm Blocking External Requests</h2>
								<p></p>
								<p style = { { marginBlock: '0.5rem' } }>This will prevent <pre>{ websiteAccess.website.websiteOrigin }</pre> from requesting resources outside its domain, which can lead to erratic behavior or even cause it to stop functioning entirely.</p>
								<p style = { { marginBlock: '1rem' } }>Are you sure you want to continue?</p>
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

const DisableProtectionSetting = ({ websiteAccess }: { websiteAccess: WebsiteAccess }) => {
	const { search} = useWebsiteAccess()
	const isInterceptorDisabled = useComputed(() => Boolean(websiteAccess.interceptorDisabled))

	const disableWebsiteProtection = async (shouldDisable: boolean = true) => {
		if (!websiteAccess) return
		await setInterceptorDisabledForWebsite(websiteAccess.website, shouldDisable)
		sendPopupMessageToBackgroundPage({ method: 'popup_retrieveWebsiteAccess',  data: { query: search.value.query } })
	}

	const confirmOrRejectDialog = async (response: string) => {
		if (response === 'reject') return
		disableWebsiteProtection()
	}

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
						<button class = 'btn btn--primary' onClick = { () => disableWebsiteProtection(false) }><span style = { { whiteSpace: 'nowrap' } }>Enable Protection</span></button>
					) : (
						<Modal>
							<Modal.Open class = 'btn btn--destructive'><span style = { { whiteSpace: 'nowrap' } }>Disable Protection</span></Modal.Open>
							<Modal.Dialog class = 'dialog' style = { { textAlign: 'center', color: 'var(--disabled-text-color)' } } onClose = { confirmOrRejectDialog }>
								<h2 style = { { fontWeight: 600, fontSize: '1.125rem', color: 'var(--text-color)', marginBlock: '1rem' } }>Disable Interceptor Protection</h2>
								<p></p>
								<p style = { { marginBlock: '0.5rem' } }>Interceptor will no longer be able to simulate transactions from <pre>{ websiteAccess.website.websiteOrigin }</pre>, which could lead to a loss of assets. Please exercise caution.</p>
								<p style = { { marginBlock: '1rem' } }>Are you sure you want to continue?</p>
								<div style = { { display: 'flex', flexWrap: 'wrap', columnGap: '1rem', justifyContent: 'center', marginBlock: '1rem' } }>
									<Modal.Close class = 'btn btn--outline' value = 'reject'>Cancel</Modal.Close>
									<Modal.Close class = 'btn btn--destructive' value = 'confirm'>Confirm</Modal.Close>
								</div>

							</Modal.Dialog>
						</Modal>) }

				</aside>
			</section>
		</article>
	)
}

const RemoveWebsiteSetting = ({ websiteAccess }: { websiteAccess: WebsiteAccess }) => {
	const { search } = useWebsiteAccess()
	const confirmOrRejectUpdate = async (response: string) => {
		if (response !== 'confirm') return
		await updateWebsiteAccess((previousAccess) => previousAccess.filter(access => access.website.websiteOrigin !== websiteAccess.website.websiteOrigin))
		sendPopupMessageToBackgroundPage({ method: 'popup_retrieveWebsiteAccess',  data: { query: search.value.query } })
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
						<Modal.Dialog class = 'dialog' style = { { textAlign: 'center', color: 'var(--disabled-text-color)' } } onClose = { confirmOrRejectUpdate }>
							<h2 style = { { fontWeight: 600, fontSize: '1.125rem', color: 'var(--text-color)', marginBlock: '1rem' } }>Confirm Website Removal</h2>
							<p></p>
							<p style = { { marginBlock: '0.5rem' } }>You are about to remove <pre>{ websiteAccess.website.websiteOrigin }</pre> from the list of allowed sites. By doing so, the website will no longer have access to your wallet addresses.</p>
							<p style = { { marginBlock: '1rem' } }>Are you sure you want to continue?</p>
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
