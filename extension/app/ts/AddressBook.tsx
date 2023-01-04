import { useEffect, useRef, useState } from 'preact/hooks'
import { addressString } from './utils/bigint.js'
import { AddressBookEntries } from './utils/user-interface-types.js'
import Blockie from './components/subcomponents/PreactBlocky.js'
import { GetAddressBookDataReply, MessageToPopup } from './utils/interceptor-messages.js'

type ActiveFilter = 'My Active Addresses' | 'My Contacts' | 'Tokens' | 'Non Fungible Tokens' | 'Other Contracts'

export function FilterLink(param: { name: ActiveFilter, currentFilter: ActiveFilter, setActiveFilter: (activeFilter: ActiveFilter) => void}) {
	return <a
		class = { param.currentFilter === param.name ? `is-active` : '' }
		onClick = { () => param.setActiveFilter(param.name) }>
			{ param.name }
	</a>
}

export function AddressList(param: { addressBookEntries: AddressBookEntries | undefined }) {
	if (param.addressBookEntries === undefined) return <p class = 'paragraph'> Loading... </p>
	return <ul>
		{ param.addressBookEntries.length === 0 ? <p class = 'paragraph'> No cute dinosaurs here </p> : param.addressBookEntries.map( (entry, _index) => (
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
}

export function AddressBook() {
	const [activeFilter, setActiveFilter] = useState<ActiveFilter>('My Active Addresses')
	const [addressBookEntries, setAddressBookEntries] = useState<AddressBookEntries | undefined>(undefined)
	const activeFilterRef = useRef<ActiveFilter>(activeFilter)

	useEffect( () => {
		const popupMessageListener = async (msg: MessageToPopup) => {
			if (msg.message !== 'popup_getAddressBookData') return
			const reply = GetAddressBookDataReply.parse(msg)
			if (reply.data.options.filter === activeFilterRef.current) {
				setAddressBookEntries(reply.data.entries)
			}
		}
		changeFilter(activeFilter)
		browser.runtime.onMessage.addListener(popupMessageListener)

		return () => {
			browser.runtime.onMessage.removeListener(popupMessageListener)
		}
	}, [])

	function changeFilter(filter: ActiveFilter) {
		setActiveFilter(filter)
		activeFilterRef.current = filter
		browser.runtime.sendMessage({ method: 'popup_getAddressBookData', options: { filter: filter, startIndex: 0, maxIndex: 100 } })
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
					<AddressList addressBookEntries = { addressBookEntries }/>
				</div>
			</div>
		</main>
	)
}
