import { useEffect, useRef, useState } from 'preact/hooks'
import { RenameAddressCallBack } from './types/user-interface-types.js'
import { GetAddressBookDataReply, MessageToPopup } from './types/interceptor-messages.js'
import { arrayToChunks } from './utils/typed-arrays.js'
import { AddNewAddress } from './components/pages/AddNewAddress.js'
import { BigAddress } from './components/subcomponents/address.js'
import Hint from './components/subcomponents/Hint.js'
import { sendPopupMessageToBackgroundPage } from './background/backgroundUtils.js'
import { assertNever } from './utils/typescript.js'
import { checksummedAddress } from './utils/bigint.js'
import { AddressBookEntries, AddressBookEntry } from './types/addressBookTypes.js'
import { ModifyAddressWindowState } from './types/visualizer-types.js'

type Modals =  { page: 'noModal' }
	| { page: 'addNewAddress', state: ModifyAddressWindowState }
	| { page: 'confirmaddressBookEntryToBeRemoved' }

type ActiveFilter = 'My Active Addresses' | 'My Contacts' | 'ERC20 Tokens' | 'ERC1155 Tokens' | 'Non Fungible Tokens' | 'Other Contracts'
const ActiveFilterSingle = {
	'My Active Addresses': 'Active Address',
	'My Contacts': 'Contact',
	'ERC20 Tokens': 'ERC20 Token',
	'ERC1155 Tokens': 'ERC1155 Token',
	'Non Fungible Tokens': 'Non Fungible Token',
	'Other Contracts': 'contract',
}

const PAGE_SIZE = 20
const ELEMENT_SIZE_PX = {
	'My Active Addresses': 105,
	'My Contacts': 120,
	'ERC20 Tokens': 129,
	'ERC1155 Tokens': 129,
	'Non Fungible Tokens': 129,
	'Other Contracts': 131,
}
const ELEMENT_PADDING_PX = 10
const UNLOAD_DISTANCE = 8
const LOAD_DISTANCE = 4

export function FilterLink(param: { name: ActiveFilter, currentFilter: ActiveFilter, setActiveFilter: (activeFilter: ActiveFilter) => void }) {
	return <a
		class = { param.currentFilter === param.name ? `is-active` : '' }
		onClick = { () => param.setActiveFilter(param.name) }>
			{ param.name }
	</a>
}

type ConfirmaddressBookEntryToBeRemovedParams = {
	category: ActiveFilter,
	addressBookEntry: AddressBookEntry,
	removeEntry: (entry: AddressBookEntry) => void,
	close: () => void,
	renameAddressCallBack: RenameAddressCallBack,
}

export function ConfirmaddressBookEntryToBeRemoved(param: ConfirmaddressBookEntryToBeRemovedParams) {
	const remove = () => {
		param.removeEntry(param.addressBookEntry)
		param.close()
	}
	return <>
		<div class = 'modal-background'> </div>
		<div class = 'modal-card'>
			<header class = 'modal-card-head card-header interceptor-modal-head window-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'icon'>
						<img src = '../img/address-book.svg'/>
					</span>
				</div>
				<div class = 'card-header-title'>
					<p className = 'paragraph'> { `Remove ${ ActiveFilterSingle[param.category] }` } </p>
				</div>
				<button class = 'card-header-icon' aria-label = 'close' onClick = { param.close }>
					<span class = 'icon' style = 'color: var(--text-color);'> X </span>
				</button>
			</header>
			<section class = 'modal-card-body' style = 'overflow: visible;'>
				<div class = 'card' style = 'margin: 10px;'>
					<div class = 'card-content'>
						<BigAddress
							addressBookEntry = { param.addressBookEntry }
							renameAddressCallBack = { param.renameAddressCallBack }
						/>
					</div>
				</div>
			</section>
			<footer class = 'modal-card-foot window-footer' style = 'border-bottom-left-radius: unset; border-bottom-right-radius: unset; border-top: unset; padding: 10px;'>
				<button class = 'button is-success is-primary' onClick = { remove }> { 'Remove' } </button>
				<button class = 'button is-warning is-danger' onClick = { param.close }>Cancel</button>
			</footer>
		</div>
	</>
}

type ListElementParam = (AddressBookEntry | { type: 'empty' }) & {
	listKey: string,
	category: ActiveFilter,
	removeEntry: (entry: AddressBookEntry) => void,
	renameAddressCallBack: RenameAddressCallBack,
}

export function ListElement(entry: ListElementParam) {
	return <li style = { `margin: 0px; padding-bottom: ${ ELEMENT_PADDING_PX }px` } key = { entry.listKey }>
		<div class = 'card' style = { `height: ${ ELEMENT_SIZE_PX[entry.category] }px` }>
			<div class = 'card-content' style = 'height: 100%; width: 500px;'>
				<div class = 'media' style = 'height: 100%;'>
					<div class = 'media-content' style = 'overflow-y: visible; overflow-x: unset; height: 100%; display: flex; flex-direction: column;'>
						<div style = 'padding-bottom: 10px; height: 40px'>
							{ entry.type === 'empty'
								? <></>
								: <BigAddress
									addressBookEntry = { { ...entry, ...{ name: `${ entry.name }${ 'symbol' in entry ? ` (${ entry.symbol })` : '' }`} } }
									noCopying = { false }
									renameAddressCallBack = { entry.renameAddressCallBack }
								/>
							}
						</div>

						{ entry.category === 'ERC20 Tokens'
							? <div>
								<p class = 'paragraph' style = 'display: inline-block; font-size: 13px; vertical-align: top;'>{ `Decimals: ${ 'decimals' in entry && entry.decimals !== undefined ? entry.decimals.toString() : 'MISSING' }` }</p>
							</div>
							: <></>
						}

						{ entry.category === 'Non Fungible Tokens' || entry.category === 'Other Contracts'
							? <div>
								<p class = 'paragraph' style = 'display: inline-block; font-size: 13px; vertical-align: top;'>
									{ `Protocol: ${ 'protocol' in entry ? entry.protocol : '' } ` }
								</p>
							</div>
							: <></>
						}

						{ entry.category === 'My Active Addresses' ?
							<label class = 'form-control' style = 'padding-top: 10px'>
								<input type = 'checkbox' checked = { 'askForAddressAccess' in entry && !entry.askForAddressAccess } disabled = { true }/>
								<p class = 'paragraph checkbox-text'>Don't request for an access (insecure) </p>
							</label>
							: 
							<div>
								<p class = 'paragraph' style = 'display: inline-block; font-size: 13px; vertical-align: top; width: 420px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;'>
									{ `ABI: ${ 'abi' in entry && entry.abi !== undefined ? entry.abi : 'No ABI available' } ` }
								</p>
							</div>
						}
						<div>
							<p class = 'paragraph' style = 'display: inline-block; font-size: 13px; color: var(--subtitle-text-color);'>
								{ `Source: ${ 'entrySource' in entry ? entry.entrySource : '' }` }
							</p>
						</div>
					</div>

					<div class = 'content' style = 'color: var(--text-color); display: flex; height: 100%; flex-direction: column; justify-content: space-between;'>
						<button class = 'card-header-icon' style = 'padding: 0px; margin-left: auto;' aria-label = 'delete' disabled = { entry.type === 'empty' || (entry.entrySource !== 'User' && entry.entrySource !== 'OnChain') } onClick = { () => entry.type !== 'empty' ? entry.removeEntry(entry) : undefined }>
							<p class = 'icon'> X </p>
						</button>
						<button class = 'button is-primary is-small' onClick = { entry.type !== 'empty' ? () => entry.renameAddressCallBack(entry) : () => {} }>Edit</button>
					</div>
				</div>
			</div>
		</div>
	</li>
}

type AddressList = {
	addressBookEntries: AddressBookEntries | undefined | 'fetching',
	numberOfEntries: number,
	startIndex: number,
	listName: string,
	filter: ActiveFilter,
	removeEntry: (entry: AddressBookEntry) => void,
	renameAddressCallBack: RenameAddressCallBack,
}

export function AddressList({ addressBookEntries, numberOfEntries, startIndex, listName, filter, removeEntry, renameAddressCallBack }: AddressList) {
	const entries = addressBookEntries === undefined || addressBookEntries === 'fetching'
		? Array.from(new Array(numberOfEntries + 1)).map(() => ({
			type: 'empty' as const
		}))
		: addressBookEntries
	return <>
		{ entries.map( (entry, index) => <ListElement
			{ ...entry }
			removeEntry = { removeEntry }
			category = { filter }
			listKey = { `${ (startIndex + index).toString() } ${ listName }`}
			renameAddressCallBack = { renameAddressCallBack }
		/> ) }
	</>
}

type AddressBookState = {
	pages: Map<number, AddressBookEntries | 'fetching'>,
	maxIndex: number,
	maxPages: number,
	searchString: string | undefined,
	activeFilter: ActiveFilter,
}

export function AddressBook() {
	const [activeFilter, setActiveFilter] = useState<ActiveFilter>('My Active Addresses')
	const [searchString, setSearchString] = useState<string | undefined>(undefined)
	const [currentPage, setCurrentPage] = useState<number>(0)
	const [modalState, setModalState] = useState<Modals>({ page: 'noModal' })
	const [addressBookState, setAddressBookState] = useState<AddressBookState | undefined>(undefined)
	const [addressBookEntryToBeRemoved, setAddressBookEntryToBeRemoved] = useState<AddressBookEntry | undefined>(undefined)

	const activeFilterRef = useRef<ActiveFilter>(activeFilter)
	const searchStringRef = useRef<string | undefined>(searchString)
	const currentPageRef = useRef<number>(currentPage)

	const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

	useEffect(() => { activeFilterRef.current = activeFilter }, [activeFilter])
	useEffect(() => { searchStringRef.current = searchString }, [searchString])
	useEffect(() => { currentPageRef.current = currentPage }, [currentPage])

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
		const popupMessageListener = async (msg: unknown) => {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return // not a message we are interested in
			const parsed = maybeParsed.value
			if (parsed.method === 'popup_addressBookEntriesChanged') {
				// fields updated, refresh
				changeFilter(activeFilterRef.current)
				return
			}
			if (parsed.method !== 'popup_getAddressBookDataReply') return
			const reply = GetAddressBookDataReply.parse(msg)
			setAddressBookState((previousState) => {
				if ( activeFilterRef.current !== reply.data.data.filter || searchStringRef.current !== reply.data.data.searchString) return previousState

				const startPageIndex = Math.ceil(reply.data.data.startIndex / PAGE_SIZE)
				const chunkedresults = arrayToChunks(reply.data.entries, PAGE_SIZE)

				const newPages: Map<number, AddressBookEntries | 'fetching'> = (previousState !== undefined
					&& reply.data.data.filter === previousState.activeFilter
					&& reply.data.data.searchString === previousState.searchString ? new Map(previousState.pages) : new Map())

				Array.from(chunkedresults).forEach((entries, pageOffset) => newPages.set(startPageIndex + pageOffset, entries))
				const newData = {
					pages: newPages,
					maxIndex: reply.data.maxDataLength,
					maxPages: Math.ceil((reply.data.maxDataLength) / PAGE_SIZE),
					searchString: reply.data.data.searchString,
					activeFilter: reply.data.data.filter,
				}
				return newData
			})
		}
		changeFilter(activeFilter)
		browser.runtime.onMessage.addListener(popupMessageListener)
		const scrollListener = () => update()
		globalThis.addEventListener('scroll', scrollListener)

		return () => {
			browser.runtime.onMessage.removeListener(popupMessageListener)
			globalThis.removeEventListener('scroll', scrollListener)
		}
	}, [])

	function update() {
		if (scrollTimer.current !== undefined) clearTimeout(scrollTimer.current);
		scrollTimer.current = setTimeout(function() { // batch calls together if user is scrolling fast
			setAddressBookState((previousState) => {
				if (previousState === undefined) return previousState
				const pageSizePx = PAGE_SIZE * (ELEMENT_SIZE_PX[previousState.activeFilter] + ELEMENT_PADDING_PX)
				const newPage = Math.min(Math.floor(globalThis.scrollY / pageSizePx + 0.5), previousState.maxPages)
				if (currentPageRef.current === newPage) return previousState

				setCurrentPage(newPage)
				// load pages that are in loading distance
				const pagesToQuery = Array.from(new Array(2 * LOAD_DISTANCE + 1), (_, pageDiff) => newPage + pageDiff - LOAD_DISTANCE).filter((pageToLoad) => {
					return previousState && pageToLoad >= 0 && previousState.pages.get(pageToLoad) === undefined
				})

				const newPages = unloadExtra(previousState.pages, newPage)
				if ( Math.max(...pagesToQuery) - Math.min(...pagesToQuery) === pagesToQuery.length - 1 ) {
					sendQuery(activeFilterRef.current, searchStringRef.current, Math.min(...pagesToQuery), Math.max(...pagesToQuery))
				} else {
					pagesToQuery.forEach((page) => {
						newPages.set(page, 'fetching')
						sendQuery(activeFilterRef.current, searchStringRef.current, page, page)
					})
				}
				return {
					...previousState,
					pages: newPages
				}
			})
		}, 10)
	}

	function sendQuery(filter: ActiveFilter, searchString: string | undefined, startPage: number, endPage: number) {
		sendPopupMessageToBackgroundPage({ method: 'popup_getAddressBookData', data: {
			filter: filter,
			searchString: searchString,
			startIndex: startPage * PAGE_SIZE,
			maxIndex: endPage * PAGE_SIZE + PAGE_SIZE,
		} })
	}

	function changeFilter(filter: ActiveFilter) {
		setCurrentPage(0)
		setActiveFilter(filter)
		setSearchString(undefined)
		sendQuery(filter, undefined, 0, LOAD_DISTANCE + 1)
	}

	function search(searchString: string | undefined) {
		setCurrentPage(0)
		setSearchString(searchString)
		sendQuery(activeFilterRef.current, searchString, 0, LOAD_DISTANCE + 1)
	}

	function getNoResultsError() {
		if (searchString && searchString.trim().length > 0 ) return `No entries found for "${ searchString }" in ${ activeFilter }`
		return `No cute dinosaurs in ${ activeFilter }`
	}

	function renderAddressList(currentPage: number) {
		return <> { addressBookState !== undefined && currentPage >= 0 && currentPage < addressBookState.maxPages ?
			<AddressList
				addressBookEntries = { addressBookState.pages.get(currentPage) }
				numberOfEntries = { currentPage === addressBookState.maxPages - 1 ? addressBookState.maxIndex % PAGE_SIZE : PAGE_SIZE }
				startIndex = { currentPage * PAGE_SIZE }
				filter = { addressBookState.activeFilter }
				listName = { `${ addressBookState.searchString }|${ addressBookState.activeFilter }` }
				removeEntry = { openConfirmaddressBookEntryToBeRemoved }
				renameAddressCallBack = { renameAddressCallBack }
			/> : <></>
		} </>
	}

	function getPageSizeInPixels(filter: ActiveFilter) {
		return PAGE_SIZE * (ELEMENT_SIZE_PX[filter] + ELEMENT_PADDING_PX)
	}

	function getWindowSizeInPages(filter: ActiveFilter) {
		return Math.ceil(globalThis.innerHeight / getPageSizeInPixels(filter) )
	}

	function openNewAddress(filter: ActiveFilter) {
		const getTypeFromFilter = (filter: ActiveFilter) => {
			switch(filter) {
				case 'My Active Addresses': return 'activeAddress'
				case 'My Contacts': return 'contact'
				case 'ERC20 Tokens': return 'ERC20'
				case 'ERC1155 Tokens': return 'ERC1155'
				case 'Non Fungible Tokens': return 'ERC721'
				case 'Other Contracts': return 'contract'
				default: assertNever(filter)
			}
		}
		
		return setModalState({ page: 'addNewAddress', state: {
			windowStateId: 'AddressBookAdd',
			errorState: undefined,
			incompleteAddressBookEntry: {
				addingAddress: true,
				symbol: undefined,
				decimals: undefined,
				logoUri: undefined,
				type: getTypeFromFilter(filter),
				name: undefined,
				address: undefined,
				askForAddressAccess: true,
				entrySource: 'FilledIn',
				abi: undefined,
			}
		} })
	}

	function openConfirmaddressBookEntryToBeRemoved(entry: AddressBookEntry) {
		setAddressBookEntryToBeRemoved(entry)
		setModalState({ page: 'confirmaddressBookEntryToBeRemoved' })
	}

	function renameAddressCallBack(entry: AddressBookEntry) {
		return setModalState({ page: 'addNewAddress', state: {
			windowStateId: 'AddressBookRename',
			errorState: undefined,
			incompleteAddressBookEntry: {
				addingAddress: false,
				askForAddressAccess: false,
				symbol: undefined,
				decimals: undefined,
				logoUri: undefined,
				...entry,
				abi: 'abi' in entry ? entry.abi : undefined,
				address: checksummedAddress(entry.address)
			}
		} })
	}

	function removeAddressBookEntry(entry: AddressBookEntry) {
		sendPopupMessageToBackgroundPage({
			method: 'popup_removeAddressBookEntry',
			data: {
				address: entry.address,
				addressBookCategory: activeFilter,
			}
		})
	}

	return (
		<main>
			<Hint>
				<div class = 'columns' style = 'margin: 10px; width: fit-content; margin: auto;'>
					<div style = 'padding: 10px'>
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
									<li> <FilterLink name = 'ERC20 Tokens' currentFilter = { activeFilter } setActiveFilter = { changeFilter }/> </li>
									<li> <FilterLink name = 'Non Fungible Tokens' currentFilter = { activeFilter } setActiveFilter = { changeFilter }/> </li>
									<li> <FilterLink name = 'ERC1155 Tokens' currentFilter = { activeFilter } setActiveFilter = { changeFilter }/> </li>
									<li> <FilterLink name = 'Other Contracts' currentFilter = { activeFilter } setActiveFilter = { changeFilter }/> </li>
								</ul>
							</ul>
						</aside>
					</div>
					<div style = 'padding: 10px; width: 520px;'>
						<div style = 'display: flex; padding-bottom: 10px'>
							<div class = 'field is-grouped' style = 'max-width: 400px; margin: 10px'>
								<div class = 'control is-expanded'>
									<input class = 'input' type = 'text' placeholder = 'Search In Category' value = { searchString === undefined ? '' : searchString } onInput = { e => search((e.target as HTMLInputElement).value) } />
								</div>
							</div>
							<div style = 'margin-left: auto;'>
								{ addressBookState !== undefined ?
									<button
										class = 'button is-primary'
										onClick = { () => openNewAddress(addressBookState.activeFilter) }
									>
									{ `Add New ${ ActiveFilterSingle[addressBookState.activeFilter] }` }
								</button> : <></> }
							</div>
						</div>
						{ addressBookState === undefined
							? <></>
							: <>
								{ addressBookState.maxIndex === 0 ? <p class = 'paragraph'> { getNoResultsError() } </p> : <></> }
								<ul style = { `height: ${ addressBookState.maxIndex * (ELEMENT_SIZE_PX[addressBookState.activeFilter] + ELEMENT_PADDING_PX) }px; overflow: hidden;` }>
									<li style = { `margin: 0px; height: ${ getPageSizeInPixels(addressBookState.activeFilter) * Math.max(0, currentPage - getWindowSizeInPages(addressBookState.activeFilter) ) }px` } key = { -1 }> </li>
									{ Array(2 * getWindowSizeInPages(addressBookState.activeFilter) + 1).fill(0).map((_, i) => renderAddressList(currentPage + ( i - getWindowSizeInPages(addressBookState.activeFilter) ))) }
								</ul>
							</>
						}
					</div>
				</div>

				<div class = { `modal ${ modalState.page !== 'noModal' ? 'is-active' : ''}` }>
					{ modalState.page === 'addNewAddress' ?
						<AddNewAddress
							setActiveAddressAndInformAboutIt = { undefined }
							modifyAddressWindowState = { modalState.state }
							close = { () => setModalState({ page: 'noModal' }) }
							activeAddress = { undefined }
						/>
					: <></> }
					{ modalState.page === 'confirmaddressBookEntryToBeRemoved' && addressBookEntryToBeRemoved !== undefined ?
						<ConfirmaddressBookEntryToBeRemoved
							category = { activeFilter }
							addressBookEntry = { addressBookEntryToBeRemoved }
							removeEntry = { removeAddressBookEntry }
							close = { () => setModalState({ page: 'noModal' }) }
							renameAddressCallBack = { renameAddressCallBack }
						/>
					: <></> }
				</div>
			</Hint>
		</main>
	)
}
