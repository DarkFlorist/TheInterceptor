import { useEffect, useRef, useState } from 'preact/hooks'
import { addressString } from './utils/bigint.js'
import { AddressBookEntries } from './utils/user-interface-types.js'
import Blockie from './components/subcomponents/PreactBlocky.js'
import { GetAddressBookDataReply, MessageToPopup } from './utils/interceptor-messages.js'
import { arrayToChunks } from './utils/typed-arrays.js'

type ActiveFilter = 'My Active Addresses' | 'My Contacts' | 'Tokens' | 'Non Fungible Tokens' | 'Other Contracts'
const PAGE_SIZE = 20
const ELEMENT_SIZE_PX = 68 + 10
const PAGE_SIZE_PX = (ELEMENT_SIZE_PX * PAGE_SIZE)
const WINDOW_SIZE_IN_PAGES = Math.ceil(window.innerHeight / PAGE_SIZE_PX )
const UNLOAD_DISTANCE = WINDOW_SIZE_IN_PAGES * 8
const LOAD_DISTANCE = WINDOW_SIZE_IN_PAGES *  4

export function FilterLink(param: { name: ActiveFilter, currentFilter: ActiveFilter, setActiveFilter: (activeFilter: ActiveFilter) => void }) {
	return <a
		class = { param.currentFilter === param.name ? `is-active` : '' }
		onClick = { () => param.setActiveFilter(param.name) }>
			{ param.name }
	</a>
}

export function AddressList({ addressBookEntries, numberOfEntries  }: { addressBookEntries: AddressBookEntries | undefined | 'fetching', numberOfEntries: number }) {
	const entries = addressBookEntries === undefined || addressBookEntries === 'fetching' ?
		Array.from(new Array(numberOfEntries + 1)).map((_, index) => ({
			key: index,
			type: 'empty' as const,
		})) : addressBookEntries
	return <>
		{ entries.map( (entry, _) => (
			<li style = 'margin: 0px; padding-bottom: 10px' key = { entry.type === 'empty' ? entry.key : entry.address }>
				<div class = 'card' style = 'height: 68px'>
					<div class = 'card-content'>
						<div class = 'media'>
							<div class = 'media-left'>
								<figure class = 'image'>
									{ entry.type === 'empty' ? <img src = { 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=' } style = 'width: 40px; height: 40px'/> :
										<Blockie seed = { addressString(entry.address).toLowerCase() } size = { 8 } scale = { 5 } />
									}
								</figure>
							</div>

							<div class = 'media-content' style = 'overflow-y: visible; overflow-x: unset;'>
								<div className = 'field is-grouped' style = 'margin-bottom: 0px'>
									<div className = 'control is-expanded'>
										<input className = 'input interceptorInput' type = 'text' value = { entry.type === 'empty' ? '' : entry.name }
											style = 'overflow: visible;'
											maxLength = { 42 }
										/>
									</div>
								</div>
								<div className = 'field is-grouped' style = 'margin-bottom: 0px'>
									<div className = 'control is-expanded'>
										<input className = 'input interceptorInput' type = 'text' value = { entry.type === 'empty' ? '' : addressString(entry.address) }
											style = { `overflow: visible; color: var(--text-color)` } />
									</div>
								</div>
								{ 'askForAddressAccess' in entry ?
									<label class = 'form-control'>
										<input type = 'checkbox' checked = { !entry.askForAddressAccess }  />
										Don't request for an access (unsecure)
									</label>
								: <></> }
							</div>

							<div class = 'content' style = 'color: var(--text-color);'>
								<button class = 'card-header-icon' style = 'padding: 0px;' aria-label = 'delete'>
									<span class = 'icon' style = 'color: var(--text-color);'> X </span>
								</button>
							</div>
						</div>
					</div>
				</div>
			</li>
		) ) }
	</>
}

type AddressBookState = {
	pages: Map<number, AddressBookEntries | 'fetching'>,
	maxIndex: number,
	maxPages: number,
	searchString: string | undefined,
	activeFilter: ActiveFilter,
	loadingFirst: boolean,
}

export function AddressBook() {
	const [activeFilter, setActiveFilter] = useState<ActiveFilter>('My Active Addresses')
	const [searchString, setSearchString] = useState<string | undefined>(undefined)
	const [currentPage, setCurrentPage] = useState<number>(0)
	const [addressBookState, setAddressBookState] = useState<AddressBookState | undefined>(undefined)
	const previousState = useRef<AddressBookState | undefined>(undefined)

	const activeFilterRef = useRef<ActiveFilter>(activeFilter)
	const searchStringRef = useRef<string | undefined>(searchString)
	const previousPage = useRef<number>(currentPage)
	const scrollTimer = useRef<NodeJS.Timeout | undefined>(undefined)

	function unloadExtra(pages: Map<number, AddressBookEntries | 'fetching'>, currentPage: number) {
		// unloads pages that are not in viewing distance
		const pagesToUnload = Array.from(pages.entries()).filter(([page, _]) => Math.abs(currentPage - page) > UNLOAD_DISTANCE)

		if (pagesToUnload.length > 0) {
			const unloadedPages = new Map(pages)
			pagesToUnload.forEach(([page, _]) => unloadedPages.delete(page))
			return unloadedPages
		}
		return new Map(pages)
	}

	useEffect(() => {
		const popupMessageListener = async (msg: MessageToPopup) => {
			if (msg.message !== 'popup_getAddressBookData') return
			const reply = GetAddressBookDataReply.parse(msg)
			if (reply.data.options.filter !== activeFilterRef.current || reply.data.options.searchString !== searchStringRef.current) return

			const startPageIndex = Math.ceil(reply.data.options.startIndex / PAGE_SIZE)
			const chunkedresults = arrayToChunks(reply.data.entries, PAGE_SIZE)

			const newPages = (previousState.current !== undefined ? new Map(previousState.current.pages) : new Map())

			Array.from(chunkedresults).forEach((entries, pageOffset) => newPages.set(startPageIndex + pageOffset, entries))

			const newState = {
				pages: newPages,
				maxIndex: reply.data.lenght,
				maxPages: Math.ceil( (reply.data.lenght) / PAGE_SIZE),
				searchString: reply.data.options.searchString,
				activeFilter: reply.data.options.filter,
				loadingFirst: false,
			}
			setAddressBookState(newState)
			previousState.current = newState
		}
		changeFilter(activeFilter)
		browser.runtime.onMessage.addListener(popupMessageListener)
		const scrollListener = () => update()
		window.addEventListener('scroll', scrollListener)

		return () => {
			browser.runtime.onMessage.removeListener(popupMessageListener)
			window.removeEventListener('scroll', scrollListener)
		}
	}, [])

	function update() {
		if (scrollTimer.current !== undefined) clearTimeout(scrollTimer.current);
		scrollTimer.current = setTimeout(function(){ // batch calls together if user is scrolling fast
			if (previousState.current === undefined) return
			const newPage = Math.min(Math.floor(window.scrollY / PAGE_SIZE_PX + 0.5), previousState.current.maxPages)
			if (previousPage.current === newPage) return

			setCurrentPage(newPage)
			previousPage.current = newPage
			// load pages that are in loading distance
			const pagesToQuery = Array.from(new Array(2 * LOAD_DISTANCE + 1), (_, pageDiff) => newPage + pageDiff - LOAD_DISTANCE).filter((pageToLoad) => {
				return previousState.current && pageToLoad >= 0 && previousState.current.pages.get(pageToLoad) === undefined
			})

			const newPages = unloadExtra(previousState.current.pages, newPage)
			if ( Math.max(...pagesToQuery) - Math.min(...pagesToQuery) === pagesToQuery.length - 1 ) {
				sendQuery(activeFilterRef.current, searchStringRef.current, Math.min(...pagesToQuery), Math.max(...pagesToQuery))
			} else {
				pagesToQuery.forEach((page) => {
					newPages.set(page, 'fetching')
					sendQuery(activeFilterRef.current, searchStringRef.current, page, page)
				})
			}
			const newState = {
				...previousState.current,
				pages: newPages
			}
			setAddressBookState(newState)
			previousState.current = newState
		}, 10)
	}

	function sendQuery(filter: ActiveFilter, searchString: string | undefined, startPage: number, endPage: number) {
		console.log('query:',startPage,'-', endPage)
		browser.runtime.sendMessage({ method: 'popup_getAddressBookData', options: {
			filter: filter,
			searchString: searchString,
			startIndex: startPage * PAGE_SIZE,
			maxIndex: endPage * PAGE_SIZE + PAGE_SIZE,
		} })
	}

	function changeFilter(filter: ActiveFilter) {
		setCurrentPage(0)
		previousPage.current = 0
		setActiveFilter(filter)
		activeFilterRef.current = filter
		setSearchString(undefined)

		const newState = {
			pages: new Map(),
			maxIndex: 0,
			maxPages: 0,
			searchString: undefined,
			activeFilter: filter,
			loadingFirst: true,
		}
		previousState.current = newState
		searchStringRef.current = undefined
		sendQuery(filter, undefined, 0, LOAD_DISTANCE + 1)
	}

	function search(searchString: string | undefined) {
		setCurrentPage(0)
		previousPage.current = 0
		const newState = {
			pages: new Map(),
			maxIndex: 0,
			maxPages: 0,
			searchString: searchString,
			activeFilter: activeFilterRef.current,
			loadingFirst: true,
		}
		previousState.current = newState
		searchStringRef.current = searchString
		setSearchString(searchString)
		sendQuery(activeFilterRef.current, searchString, 0, LOAD_DISTANCE + 1)
	}

	function getNoResultsError() {
		if ( searchString && searchString.trim().length > 0 ) return `No entries found for "${ searchString }" in ${ activeFilter }`
		return `No cute dinosaurs in ${ activeFilter }`
	}

	return (
		<main>
			<div class = 'columns' style = 'margin: 10px'>
				<div class = 'column is-2'>
					<aside class = 'menu'>
						<ul class = 'menu-list'>
							<p class = 'paragraph' style = 'color: var(--disabled-text-color)'> My Addresses </p>
							<ul>
								<li> <FilterLink name = 'My Active Addresses' currentFilter = { activeFilter } setActiveFilter = { changeFilter }/> </li>
								<li> <FilterLink name = 'My Contacts' currentFilter = { activeFilter } setActiveFilter = { changeFilter }/> </li>
							</ul>
						</ul>
						<ul class = 'menu-list'>
							<p class = 'paragraph' style = 'color: var(--disabled-text-color)'> Contracts </p>
							<ul>
								<li> <FilterLink name = 'Tokens' currentFilter = { activeFilter } setActiveFilter = { changeFilter }/> </li>
								<li> <FilterLink name = 'Non Fungible Tokens' currentFilter = { activeFilter } setActiveFilter = { changeFilter }/> </li>
								<li> <FilterLink name = 'Other Contracts' currentFilter = { activeFilter } setActiveFilter = { changeFilter }/> </li>
							</ul>
						</ul>
					</aside>
				</div>
				<div class = 'column'>
					<div class = 'field is-grouped' style = 'max-width: 400px; margin: 10px'>
						<p class = 'control is-expanded'>
							<input class = 'input interceptorInput' type = 'text' placeholder = 'Search In Category' value = { searchString === undefined ? '' : searchString } onInput = { e => search((e.target as HTMLInputElement).value) } />
						</p>
					</div>
					{ addressBookState === undefined || addressBookState.loadingFirst ? <></> :
						addressBookState.maxPages === 0 ? <p class = 'paragraph'> { getNoResultsError() } </p> :<>
							<ul style = { `height: ${ addressBookState.maxIndex * ELEMENT_SIZE_PX }px` }>
								<li style = { `margin: 0px; height: ${ PAGE_SIZE_PX * Math.max(0, currentPage - WINDOW_SIZE_IN_PAGES) }px` } key = { -1 }> </li>
								{ Array(2 * WINDOW_SIZE_IN_PAGES + 1).fill(0).map((_, i) => <>
									{ currentPage + ( i - WINDOW_SIZE_IN_PAGES ) >= 0 && currentPage + ( i - WINDOW_SIZE_IN_PAGES ) < addressBookState.maxPages?
										<AddressList
											addressBookEntries = { addressBookState.pages.get(currentPage + ( i - WINDOW_SIZE_IN_PAGES ) ) }
											numberOfEntries = { currentPage === addressBookState.maxPages - 1 ? addressBookState.maxIndex % PAGE_SIZE : PAGE_SIZE }
										/>
										: <></>
									} </>
								) }
							</ul>
						</>
					}

				</div>
			</div>
		</main>
	)
}
