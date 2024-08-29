import { useContext, useEffect, useRef } from 'preact/hooks'
import { Signal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { ComponentChildren, createContext, JSX } from 'preact'
import { Blockie } from '../subcomponents/SVGBlockie.js'
import { Website, WebsiteAccess, WebsiteAccessArray, WebsiteAddressAccess } from '../../types/websiteAccessTypes.js'
import { Modal } from '../subcomponents/Modal.js'
import { EthereumAddress, serialize } from '../../types/wire-types.js'
import { Collapsible } from '../subcomponents/Collapsible.js'
import { Switch } from '../subcomponents/Switch.js'
import { Layout } from '../subcomponents/DefaultLayout.js'
import { MessageToPopup, RetrieveWebsiteAccessFilter, SearchMetadata } from '../../types/interceptor-messages.js'
import { AddressBookEntries } from '../../types/addressBookTypes.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { InterceptorDisabledIcon, RequestBlockedIcon, SearchIcon, TrashIcon } from '../subcomponents/icons.js'
import { updateWebsiteAccess } from '../../background/settings.js'

type WebsiteAccessContext = {
	searchQuery: Signal<string>
	searchResultMap: Signal<Record<string, SearchMetadata | undefined>>
	websiteAccessList: Signal<WebsiteAccessArray>
	selectedDomain: Signal<string | undefined>
}

const WebsiteAccessContext = createContext<WebsiteAccessContext | undefined>(undefined)

const WebsiteAccessProvider = ({ children }: { children: ComponentChildren }) => {
	const websiteAccessList = useSignal<WebsiteAccessArray>([])
	const searchQuery = useSignal<string>('')
	const addressAccessFromStore = useSignal<AddressBookEntries | undefined>(undefined)
	const searchResultMap = useSignal<Record<string, SearchMetadata | undefined>>({})
	const selectedDomain = useSignal<string | undefined>(undefined)

	const retrieveWebsiteAccess = (filter?: RetrieveWebsiteAccessFilter) => {
		const data = filter ? filter : { query: '' }
		sendPopupMessageToBackgroundPage({ method: 'popup_retrieveWebsiteAccess', data })
	}

	const updateListOnSearch = () => {
		selectedDomain.value = undefined
		retrieveWebsiteAccess({ query: searchQuery.value })
	}

	useSignalEffect(updateListOnSearch)

	useEffect(() => {
		const popupMessageListener = async (msg: unknown) => {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return // not a message we are interested in
			const parsed = maybeParsed.value
			switch (parsed.method) {
				case 'popup_setDisableInterceptorReply':
				case 'popup_websiteAccess_changed':
					retrieveWebsiteAccess({ query: '' })
					break
				case 'popup_retrieveWebsiteAccessReply':
					websiteAccessList.value = parsed.data.websiteAccess
					addressAccessFromStore.value = parsed.data.addressAccess
					searchResultMap.value = parsed.data.searchMetadata
					break
			}
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	}, [])

	useEffect(retrieveWebsiteAccess, [])

	return <WebsiteAccessContext.Provider value = { { searchQuery, searchResultMap, websiteAccessList, selectedDomain } }>{ children }</WebsiteAccessContext.Provider>
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
					<h1>Manage Websites</h1>
					<SearchForm id = 'site_search' name = 'search' placeholder = 'Enter a website address' />
				</Layout.Header>
				<Layout.Main>
					<WebsiteSettingsList />
					<WebsiteSettingsDetail />
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
}

const SearchForm = (props: SearchFormProps) => {
	const inputRef = useRef<HTMLInputElement>(null)
	const { searchQuery } = useWebsiteAccess()

	const updateSearchParameters = (event: Event) => {
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const formData = new FormData(event.currentTarget)
		const inputValue = formData.get(props.name)?.toString()
		searchQuery.value = inputValue || ''
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
	const { websiteAccessList, selectedDomain } = useWebsiteAccess()

	const updateSelection = (event: Event) => {
		event.preventDefault()
		const formElement = event.currentTarget
		if (!(event instanceof SubmitEvent) || !(formElement instanceof HTMLFormElement)) return
		requestAnimationFrame(() => {
			const formData = new FormData(formElement)
			selectedDomain.value = formData.get('websiteOrigin')?.toString()
		})
	}

	return (
		<section style = { { scrollMarginTop: 'var(--header-height)', paddingBlock: '1rem' } }>
			<h4 style = { { color: 'var(--disabled-text-color)' , fontSize: '0.875rem', display: 'grid', gridTemplateColumns: '1fr max-content' } }>Websites</h4>
			<form onSubmit = { updateSelection }>
				{ websiteAccessList.value.length > 1 ? (
					<>
						<ul role = 'listbox'>{ websiteAccessList.value.map((access, index) => <WebsiteAccessOverview websiteAccess = { access } checked = { index === 0 } />) }</ul>
						<input type = 'submit' style = { { display: 'none' } } />
					</>
				) : <EmptyAccessList /> }
			</form>
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

type SiteOverviewProps = {
	websiteAccess: WebsiteAccess
	checked: boolean
}

const WebsiteAccessOverview = ({ websiteAccess, checked }: SiteOverviewProps) => {
	const handleChange = (event: Event) => {
		if (!(event.currentTarget instanceof HTMLLabelElement) || !event.currentTarget.form) return
		event.currentTarget.form.requestSubmit()
	}

	const getWebsiteStatus = () => {
		if (!websiteAccess.access) return
		if (websiteAccess.interceptorDisabled) return 'disabled'
		if (websiteAccess.declarativeNetRequestBlockMode === 'block-all') return 'blocked'
		return
	}

	return (
		<li role = 'option'>
			<input id = { websiteAccess.website.websiteOrigin } type = 'radio' name = 'websiteOrigin' value = { websiteAccess.website.websiteOrigin } defaultChecked = { checked } />
			<label htmlFor = { websiteAccess.website.websiteOrigin } style = { { cursor: 'pointer' } } onClick = { handleChange }>
				<div class = 'flexy flexy-sm'>
					<img role = 'img' src = { websiteAccess.website.icon } style = { { width: '1.5rem', aspectRatio: 1, maxWidth: 'none' } } title = 'Website Icon' />
					<div class = 'flexy' style = { { textAlign: 'left', flex: '1', '--pad-y': 0 } }>
						<div style = { { flex: 1 } }>
							<h4 class = 'truncate' style = { { color: 'var(--heading-color)', fontWeight: 'var(--heading-weight)' } }>{ websiteAccess.website.title }</h4>
							<p class = 'truncate' style = { { fontSize: '0.875rem', lineHeight: 1.25, direction: 'rtl', color: 'var(--subheading-color)' } }>&lrm;{ websiteAccess.website.websiteOrigin }</p>
						</div>
						<SiteStatusIndicator status = { getWebsiteStatus() } />
					</div>
				</div>
				<AddressAccessOverview websiteAccess = { websiteAccess } />
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

const MAX_ADDRESS_ICONS = 10

const AddressAccessOverview = ({ websiteAccess }: { websiteAccess: WebsiteAccess }) => {
	const { searchResultMap } = useWebsiteAccess()

	const websiteOrigin = websiteAccess.website.websiteOrigin
	const searchMetadata = useComputed(() => searchResultMap.value[websiteOrigin]?.scores)

	if (!websiteAccess.addressAccess || !searchMetadata.value) return <></>

	let addressIcons = []

	for (const { address } of websiteAccess.addressAccess) {
		const addressString = serialize(EthereumAddress, address)
		const score = searchMetadata.value[addressString]
		if (score === undefined || score >= ([Infinity, Infinity] as const)) continue
		addressIcons.push(<div style = { { borderRadius: '3px', overflow: 'hidden', fontSize: '1.5rem' } } title = { addressString }><Blockie address = { address } /></div>)
	}

	if (addressIcons.length < 1) return <></>

	return (
		<div style = { { paddingLeft: '2.5rem', display: 'grid', gridAutoFlow: 'column', gridAutoColumns: 'min-content', columnGap: '0.5rem', alignItems: 'center', paddingBottom: '0.5rem' } }>
			{ addressIcons.slice(0, MAX_ADDRESS_ICONS) }
			{ addressIcons.length > MAX_ADDRESS_ICONS ? <div style = { { fontSize: '0.75rem', lineHeight: 1, padding: '0.125rem 0.1875rem', backgroundColor: 'darkgoldenrod', color: 'white', borderRadius: 2, fontWeight: 600, border: '1px solid goldenrod' } }>+{ addressIcons.length - MAX_ADDRESS_ICONS }</div> : <></> }
			{ addressIcons.length > MAX_ADDRESS_ICONS ? (
				<div style = { { color: 'darkgoldenrod', fontSize: '0.75rem', whiteSpace: 'nowrap' } }> addresses</div>
			) : <></> }
		</div>
	)
}

const WebsiteSettingsDetail = () => {
	const { websiteAccessList, selectedDomain } = useWebsiteAccess()
	const dialogRef = useRef<HTMLDialogElement>(null)

	const websiteAccess = useComputed(() => websiteAccessList.value.find(access => access.website.websiteOrigin === selectedDomain.value)!)

	const closeDetails = () => { selectedDomain.value = undefined }

	useSignalEffect(() => {
		const dialogElement = dialogRef.current
		if (!websiteAccess.value || dialogElement === null) return
		dialogElement.showModal()
	})

	useEffect(() => {
		const dialogElement = dialogRef.current
		if (!dialogElement) return
		dialogElement.addEventListener('close', closeDetails)
		return () => dialogElement.removeEventListener('close', closeDetails)
	}, [dialogRef.current])

	return (
		<dialog ref = { dialogRef } class = 'access-details'>
			<form method = 'dialog' class = 'layout' onSubmit = { closeDetails }>
				<header style = { { paddingBlock: '1rem' } }>
					<button type = 'submit' class = 'btn btn--ghost' style = { { fontSize: '0.875rem', paddingInline: '0.5rem', paddingBlock: '0.125rem' } } autoFocus>&larr; Show website access list</button>
					{ !websiteAccess.value ? <></> : (
						<div class = 'flexy flexy-sm' style = { { '--gap-x': '1rem', flex: 1 } }>
							<figure><img width = '34' height = '34' src = { websiteAccess.value.website.icon } /></figure>
							<div style = { { flex: 1 } }>
								<h2 class = 'truncate' style = { { fontSize: 'clamp(1.25rem,2vw,2rem)', fontWeight: 600, color: 'var(--text-color)' } }>{ websiteAccess.value.website.title }</h2>
								<p><span class = 'truncate' style = { { flex: 1, lineHeight: 1, color: 'var(--disabled-text-color)', direction: 'rtl', textAlign: 'left' } }>&lrm;{ websiteAccess.value.website.websiteOrigin }</span></p>
							</div>
						</div>)
					}
				</header>
				{ websiteAccess.value ? (
					<article>
						<AddressAccessList websiteAccess = { websiteAccess } />
						<AdvancedSettings websiteAccess = { websiteAccess } />
					</article>
				) : <NoAccessPrompt />
				}
			</form>

		</dialog>
	)
}

const NoAccessPrompt = () => {
	return (
		<article style = { { height: 'calc(100% + 1px)' } }>
			<div style = { { color: 'var(--disabled-text-color)', border: '1px dashed', padding: '1rem', maxWidth: '32ch', textAlign: 'center', margin: '1rem auto' } }>
				<h4 style = { { fontWeight: 600, color: 'var(--text-color)' } }>Website is not connected</h4>
				<p style = { { fontSize: '0.875rem', lineHeight: 1.25 } }>This website does not have access to The Interceptor. Try visiting website connect using Interceptor.</p>
			</div>
		</article>
	)
}

const AddressAccessList = ({ websiteAccess }: { websiteAccess: Signal<WebsiteAccess> }) => {
	if (websiteAccess.value.addressAccess === undefined || websiteAccess.value.addressAccess.length < 1) return <></>

	return (
		<Collapsible summary = 'Address Access' defaultOpen>
			<p style = { { fontSize: '0.875rem', color: 'var(--text-color)', marginTop: '0.5rem' } }>Configure website access to these address(es). <button class = 'btn btn--ghost' style = { { fontSize: '0.875rem', border: '1px solid', width: '1rem', height: '1rem', padding: 0, borderRadius: '100%', display: 'inline-flex' } }>?</button></p>
			<div style = { { display: 'grid', rowGap: '0.5rem', padding: '0.5rem 0' } }>
				{ websiteAccess.value.addressAccess.map(addressAcces => (
					<AddressAccessCard website = { websiteAccess.value.website } addressAccess = { addressAcces } />
				)) }
			</div>
		</Collapsible>
	)
}

const AddressAccessCard = ({ website, addressAccess }: { website: Website, addressAccess: WebsiteAddressAccess }) => {
	const updateAddressAccess = () => {}

	return (
		<div style = { { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) min-content min-content', columnGap: '1rem', alignItems: 'center' } }>
			<AddressCard address = { addressAccess.address } />
			<RemoveAddressConfirmation websiteOrigin = { website.websiteOrigin } address = { addressAccess.address } />
			<Switch checked = { addressAccess.access } onChange = { updateAddressAccess } />
		</div>
	)
}

const RemoveAddressConfirmation = ({ websiteOrigin, address }: { address: bigint, websiteOrigin: string }) => {
	const { searchQuery } = useWebsiteAccess()
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

		sendPopupMessageToBackgroundPage({ method: 'popup_retrieveWebsiteAccess',  data: { query: searchQuery.value } })
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
				<p style = { { marginBlock: '0.5rem' } }>This will prevent <pre>{websiteOrigin}</pre> from accessing to the following address <data value = { addressString } style = { { backgroundColor: 'var(--card-bg-color)', color: 'var(--text-color)', padding: '2px 4px', borderRadius: 2 } }>{ addressString }</data></p>
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
	const requestBlockMode = websiteAccess.value.declarativeNetRequestBlockMode

	const setWebsiteExternalRequestBlocking = async (shouldBlock: boolean) => {
		sendPopupMessageToBackgroundPage({ method: 'popup_blockOrAllowExternalRequests', data: { website: websiteAccess.value.website, shouldBlock } })
	}

	const confirmOrRejectRequestBlocking = (response: string) => {
		if (response !== 'confirm') return
		setWebsiteExternalRequestBlocking(true)
	}

	if (!websiteAccess.value.access) return <></>

	return (
		<article class = 'flexy flexy-lg'>
			<figure><i class = 'status-lg status-warn'><RequestBlockedIcon /></i></figure>
			<section class = 'flexy' style = { { flex: 1, '--pad-y': 0 } }>
				<div style = { { contain: 'inline-size', flex: '1 20ch', marginBottom: '0.5rem' } }>
					<h1 style = { { color: 'var(--text-color)', whiteSpace: 'nowrap' } }>Block External Request</h1>
					<p style = { { color: 'var(--disabled-text-color)', fontSize: '0.875rem' } }>The Interceptor can block network requests from this domain, effectively preventing the website from dialing to unknown domains and services.</p>
				</div>
				<aside>

					{ requestBlockMode === 'block-all' ? (
						<button class = 'btn btn--primary' onClick = { () => setWebsiteExternalRequestBlocking(false) }><span style = { { whiteSpace: 'nowrap' } }>Unblock Requests</span></button>
					) : (
						<Modal>
							<Modal.Open class = 'btn btn--destructive'><span style = { { whiteSpace: 'nowrap' } }>Block Requests</span></Modal.Open>
							<Modal.Dialog class = 'dialog' style = { { textAlign: 'center', color: 'var(--disabled-text-color)' } } onClose = { confirmOrRejectRequestBlocking }>
								<h2 style = { { fontWeight: 600, fontSize: '1.125rem', color: 'var(--text-color)', marginBlock: '1rem' } }>Confirm Blocking External Requests</h2>
								<p></p>
								<p style = { { marginBlock: '0.5rem' } }>This will prevent <pre>{ websiteAccess.value.website.websiteOrigin }</pre> from requesting resources outside its domain, which can lead to erratic behavior or even cause it to stop functioning entirely.</p>
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

const DisableProtectionSetting = ({ websiteAccess }: { websiteAccess: Signal<WebsiteAccess> }) => {
	const isInterceptorDisabled = useComputed(() => Boolean(websiteAccess.value.interceptorDisabled))

	const disableWebsiteProtection = async (shouldDisable: boolean = true) => {
		if (!websiteAccess) return
		sendPopupMessageToBackgroundPage({ method: 'popup_setDisableInterceptor',  data: { website: websiteAccess.value.website, interceptorDisabled: shouldDisable } })
	}

	const confirmOrRejectDialog = async (response: string) => {
		if (response === 'reject') return
		disableWebsiteProtection()
	}

	if (!websiteAccess.value.access) return <></>

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
								<p style = { { marginBlock: '0.5rem' } }>Interceptor will no longer be able to simulate transactions from <pre>{ websiteAccess.value.website.websiteOrigin }</pre>, which could lead to a loss of assets. Please exercise caution.</p>
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

const RemoveWebsiteSetting = ({ websiteAccess }: { websiteAccess: Signal<WebsiteAccess> }) => {
	const { selectedDomain } = useWebsiteAccess()
	const confirmOrRejectUpdate = async (response: string) => {
		if (response !== 'confirm') return
		await sendPopupMessageToBackgroundPage({ method: 'popup_removeWebsiteAccess',  data: { websiteOrigin: websiteAccess.value.website.websiteOrigin } })
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
						<Modal.Dialog class = 'dialog' style = { { textAlign: 'center', color: 'var(--disabled-text-color)' } } onClose = { confirmOrRejectUpdate }>
							<h2 style = { { fontWeight: 600, fontSize: '1.125rem', color: 'var(--text-color)', marginBlock: '1rem' } }>Confirm Website Removal</h2>
							<p></p>
							<p style = { { marginBlock: '0.5rem' } }>You are about to remove <pre>{ websiteAccess.value.website.websiteOrigin }</pre> from the list of allowed sites. By doing so, the website will no longer have access to your wallet addresses.</p>
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
