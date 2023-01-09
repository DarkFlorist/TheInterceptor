import { useEffect, useRef, useState } from 'preact/hooks'
import { addressString } from './utils/bigint.js'
import { AddressBookEntries } from './utils/user-interface-types.js'
import Blockie from './components/subcomponents/PreactBlocky.js'
import { GetAddressBookDataReply, MessageToPopup } from './utils/interceptor-messages.js'

type ActiveFilter = 'My Active Addresses' | 'My Contacts' | 'Tokens' | 'Non Fungible Tokens' | 'Other Contracts'
const PAGE_SIZE = 100

export function FilterLink(param: { name: ActiveFilter, currentFilter: ActiveFilter, setActiveFilter: (activeFilter: ActiveFilter) => void}) {
	return <a
		class = { param.currentFilter === param.name ? `is-active` : '' }
		onClick = { () => param.setActiveFilter(param.name) }>
			{ param.name }
	</a>
}

export function AddressList({ addressBookEntries }: { addressBookEntries: AddressBookEntries | undefined }) {
	if (addressBookEntries === undefined) return <p class = 'paragraph'> Loading... </p>
	return <>
		<ul>
			{ addressBookEntries.map( (entry, _index) => (
				<li>
					<div class = 'card'>
						<div class = 'card-content'>
							<div class = 'media'>
								<div class = 'media-left'>
									<figure class = 'image'>
										<Blockie seed = { addressString(entry.address).toLowerCase() } size = { 8 } scale = { 5 } />
									</figure>
								</div>

								<div class = 'media-content' style = 'overflow-y: visible; overflow-x: unset;'>
									<div className = 'field is-grouped' style = 'margin-bottom: 0px'>
										<div className = 'control is-expanded'>
											<input className = 'input interceptorInput' type = 'text' value = { entry.name }
												style = 'overflow: visible;'
												maxLength = { 42 }/>
										</div>
									</div>
									<div className = 'field is-grouped' style = 'margin-bottom: 0px'>
										<div className = 'control is-expanded'>
											<input className = 'input interceptorInput' type = 'text' value = { addressString(entry.address) }
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
		</ul>
	</>
}
export function PaginationList({ currentPage, lastPage, setPage }: { currentPage: number, lastPage: number, setPage: (page: number) => void }) {
	function Page( { pageNumber, enabled, setPage, text }: { pageNumber: number, setPage: (page: number) => void, enabled: boolean, text: string } ) {
		return <li style = 'margin: 0px;'>
			<button class = { `is-primary pagination-link is-small ${ currentPage === pageNumber ? 'is-current' : ''};` }
				disabled = { !enabled }
				onClick = { () => setPage(pageNumber) }
			>
				{ text }
			</button>
		</li>
	}
	if (lastPage === 1) return <></>
	return <>
		<Page pageNumber = { 1 } enabled = { true } setPage = { setPage } text = { 'First Page' } />
		<Page pageNumber = { currentPage - 1} enabled = { currentPage - 1 > 1 } setPage = { setPage } text = { '<' } />
		<Page pageNumber = { currentPage } enabled = { false } setPage = { setPage } text = { `Page ${ currentPage } / ${ lastPage }` } />
		<Page pageNumber = { currentPage + 1 } enabled = { currentPage + 1 < lastPage } setPage = { setPage } text = { '>' } />
		<Page pageNumber = { lastPage } enabled = { true } setPage = { setPage } text = { 'Last Page' } />
	</>

}

export function AddressBook() {
	const [activeFilter, setActiveFilter] = useState<ActiveFilter>('My Active Addresses')
	const [addressBookEntries, setAddressBookEntries] = useState<AddressBookEntries | undefined>(undefined)
	const [currentPage, setCurrentPage] = useState<number>(1)
	const [lastPage, setLastPage] = useState<number>(1)
	const [searchString, setSearchString] = useState<string | undefined>(undefined)
	const activeFilterRef = useRef<ActiveFilter>(activeFilter)

	useEffect(() => {
		const popupMessageListener = async (msg: MessageToPopup) => {
			if (msg.message !== 'popup_getAddressBookData') return
			const reply = GetAddressBookDataReply.parse(msg)
			if (reply.data.options.filter === activeFilterRef.current) {
				setAddressBookEntries(reply.data.entries)
				setCurrentPage( Math.floor( (reply.data.options.startIndex + 1) / PAGE_SIZE) + 1)
				setLastPage(Math.floor( (reply.data.lenght + 1) / PAGE_SIZE) + 1)
			}
		}
		changeFilter(activeFilter)
		browser.runtime.onMessage.addListener(popupMessageListener)

		return () => {
			browser.runtime.onMessage.removeListener(popupMessageListener)
		}
	}, [])

	function sendQuery(filter: ActiveFilter, searchString: string | undefined, startIndex: number) {
		setAddressBookEntries([])
		browser.runtime.sendMessage({ method: 'popup_getAddressBookData', options: {
			filter: filter,
			searchString: searchString,
			startIndex: startIndex,
			maxIndex: startIndex + PAGE_SIZE
		} })
		window.scrollTo({ top: 0 })
	}

	function changeFilter(filter: ActiveFilter) {
		setActiveFilter(filter)
		activeFilterRef.current = filter
		setSearchString(undefined)
		sendQuery(filter, searchString, 0)
	}

	function setPage(page: number) {
		const index = (page - 1) * PAGE_SIZE
		sendQuery(activeFilterRef.current, searchString, index)
	}

	function search(searchString: string | undefined) {
		setSearchString(searchString)
		sendQuery(activeFilterRef.current, searchString, 0)
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
							<input class = 'input interceptorInput' type = 'text' placeholder = 'Search In Category' value = { searchString } onInput = { e => search((e.target as HTMLInputElement).value) } />
						</p>
					</div>
					{ addressBookEntries !== undefined && addressBookEntries.length === 0 ? <p class = 'paragraph'> { getNoResultsError() } </p> :
						<AddressList addressBookEntries = { addressBookEntries }/>
					}
					<nav class = 'pagination is-small' role = 'navigation' aria-label = 'pagination' style = 'margin: 10px'>
						<ul class = 'pagination-list'>
							<PaginationList currentPage = { currentPage } lastPage = { lastPage } setPage = { setPage } />
						</ul>
					</nav>
				</div>
			</div>
		</main>
	)
}
