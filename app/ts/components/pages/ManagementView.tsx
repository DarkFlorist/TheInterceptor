import { useEffect } from 'preact/hooks'
import { batch, useSignal } from '@preact/signals'
import type { JSX } from 'preact'
import { AddressBook } from '../../AddressBook.js'
import { WebsiteAccessView } from './WebsiteAccess.js'
import { SettingsView } from './SettingsView.js'
import { SimulationStackPage } from './SimulationStackPage.js'
import { DiagnosticsView } from './DiagnosticsView.js'
import Hint from '../subcomponents/Hint.js'
import { createMountedManagementPages, getManagementPageFromHash, getManagementPageFromNavigationKey, getManagementPageHash, mountManagementPage, type ManagementPage } from '../../utils/managementPages.js'

type ManagementTabParams = {
	page: ManagementPage
	selectedPage: ManagementPage
	label: string
	icon: string
	selectPage: (page: ManagementPage) => void
}

function ManagementTab({ page, selectedPage, label, icon, selectPage }: ManagementTabParams) {
	const selected = page === selectedPage
	return <button
		type = 'button'
		role = 'tab'
		class = { `management-tab${ selected ? ' is-active' : '' }` }
		aria-selected = { selected }
		aria-controls = { `management-panel-${ page }` }
		id = { `management-tab-${ page }` }
		tabIndex = { selected ? 0 : -1 }
		onClick = { () => selectPage(page) }
	>
		<img src = { icon } width = '24' height = '24' alt = '' />
		<span>{ label }</span>
	</button>
}

export function ManagementView() {
	const initialPage = getManagementPageFromHash(globalThis.location.hash)
	const selectedPage = useSignal<ManagementPage>(initialPage)
	const mountedPages = useSignal(createMountedManagementPages(initialPage))

	useEffect(() => {
		const updateSelectedPage = () => {
			activatePage(getManagementPageFromHash(globalThis.location.hash))
		}
		globalThis.addEventListener('hashchange', updateSelectedPage)
		return () => globalThis.removeEventListener('hashchange', updateSelectedPage)
	}, [])

	function activatePage(page: ManagementPage) {
		batch(() => {
			mountedPages.value = mountManagementPage(mountedPages.peek(), page)
			selectedPage.value = page
		})
	}

	function selectPage(page: ManagementPage) {
		activatePage(page)
		globalThis.location.hash = getManagementPageHash(page)
	}

	function handleTabKeyDown(event: JSX.TargetedKeyboardEvent<HTMLElement>) {
		const page = getManagementPageFromNavigationKey(selectedPage.value, event.key)
		if (page === undefined) return
		event.preventDefault()
		selectPage(page)
		globalThis.document.getElementById(`management-tab-${ page }`)?.focus()
	}

	return <div class = 'management-page'>
		<header class = 'management-header window-header'>
			<div class = 'management-brand'>
				<img src = '../img/LOGOA.svg' alt = 'The Interceptor' width = '32' height = '32' />
				<h1>The Interceptor</h1>
			</div>
			<nav class = 'management-tabs' role = 'tablist' aria-label = 'Interceptor management' onKeyDown = { handleTabKeyDown }>
				<ManagementTab page = 'websites' selectedPage = { selectedPage.value } label = 'Websites' icon = '../img/internet.svg' selectPage = { selectPage } />
				<ManagementTab page = 'address-book' selectedPage = { selectedPage.value } label = 'Address Book' icon = '../img/address-book.svg' selectPage = { selectPage } />
				<ManagementTab page = 'simulation-stack' selectedPage = { selectedPage.value } label = 'Simulation Stack' icon = '../img/refresh.svg' selectPage = { selectPage } />
				<ManagementTab page = 'diagnostics' selectedPage = { selectedPage.value } label = 'Diagnostics' icon = '../img/warning-sign.svg' selectPage = { selectPage } />
				<ManagementTab page = 'settings' selectedPage = { selectedPage.value } label = 'Settings' icon = '../img/settings.svg' selectPage = { selectPage } />
			</nav>
		</header>
		<section
			id = 'management-panel-websites'
			class = 'management-panel'
			role = 'tabpanel'
			aria-labelledby = 'management-tab-websites'
			tabIndex = { selectedPage.value === 'websites' ? 0 : -1 }
			hidden = { selectedPage.value !== 'websites' }
		>
			{ mountedPages.value.websites ? <WebsiteAccessView /> : <></> }
		</section>
		<section
			id = 'management-panel-address-book'
			class = 'management-panel'
			role = 'tabpanel'
			aria-labelledby = 'management-tab-address-book'
			tabIndex = { selectedPage.value === 'address-book' ? 0 : -1 }
			hidden = { selectedPage.value !== 'address-book' }
		>
			{ mountedPages.value['address-book'] ? <AddressBook /> : <></> }
		</section>
		<section
			id = 'management-panel-simulation-stack'
			class = 'management-panel'
			role = 'tabpanel'
			aria-labelledby = 'management-tab-simulation-stack'
			tabIndex = { selectedPage.value === 'simulation-stack' ? 0 : -1 }
			hidden = { selectedPage.value !== 'simulation-stack' }
		>
			{ mountedPages.value['simulation-stack'] ? <Hint><SimulationStackPage /></Hint> : <></> }
		</section>
		<section
			id = 'management-panel-diagnostics'
			class = 'management-panel'
			role = 'tabpanel'
			aria-labelledby = 'management-tab-diagnostics'
			tabIndex = { selectedPage.value === 'diagnostics' ? 0 : -1 }
			hidden = { selectedPage.value !== 'diagnostics' }
		>
			{ mountedPages.value.diagnostics ? <DiagnosticsView /> : <></> }
		</section>
		<section
			id = 'management-panel-settings'
			class = 'management-panel'
			role = 'tabpanel'
			aria-labelledby = 'management-tab-settings'
			tabIndex = { selectedPage.value === 'settings' ? 0 : -1 }
			hidden = { selectedPage.value !== 'settings' }
		>
			{ mountedPages.value.settings ? <SettingsView /> : <></> }
		</section>
	</div>
}
