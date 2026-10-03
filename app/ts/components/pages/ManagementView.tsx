import { useEffect } from 'preact/hooks'
import { batch, useSignal } from '@preact/signals'
import type { JSX } from 'preact'
import { AddressBook } from '../../AddressBook.js'
import { WebsiteAccessView } from './WebsiteAccess.js'
import { SettingsView } from './SettingsView.js'
import { SimulationStackPage } from './SimulationStackPage.js'
import { DiagnosticsView } from './DiagnosticsView.js'
import Hint from '../subcomponents/Hint.js'
import { createMountedManagementPages, getManagementPageFromHash, getManagementPageFromNavigationKey, getManagementPageHash, managementPages, mountManagementPage, type ManagementPage } from '../../utils/managementPages.js'

const managementSectionDetails: Readonly<Record<ManagementPage, { label: string, icon: string, description: string }>> = {
	home: { label: 'Home', icon: '../img/management-home.svg', description: '' },
	websites: { label: 'Websites', icon: '../img/internet.svg', description: 'Review website access and permissions.' },
	'address-book': { label: 'Address Book', icon: '../img/address-book.svg', description: 'Manage saved addresses and contacts.' },
	'simulation-stack': { label: 'Simulation Stack', icon: '../img/simulation-stack.svg', description: 'Inspect pending and simulated activity.' },
	diagnostics: { label: 'Diagnostics', icon: '../img/diagnostics.svg', description: 'Browse recorded errors and technical details.' },
	settings: { label: 'Settings', icon: '../img/settings.svg', description: 'Configure networks and extension preferences.' },
}

type ManagementTabParams = {
	page: ManagementPage
	selectedPage: ManagementPage | undefined
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
		tabIndex = { selected || (selectedPage === undefined && page === 'home') ? 0 : -1 }
		onClick = { () => selectPage(page) }
	>
		<img src = { icon } width = '24' height = '24' alt = '' />
		<span>{ label }</span>
	</button>
}

function ManagementHome({ selectPage }: { selectPage: (page: ManagementPage) => void }) {
	return <main class = 'management-home'>
		<header class = 'management-home-intro'>
			<h2>Manage The Interceptor</h2>
			<p>Choose a section to manage your extension.</p>
		</header>
		<div class = 'management-home-grid'>
			{ managementPages.filter((page) => page !== 'home').map((page) => {
				const section = managementSectionDetails[page]
				return <button key = { page } type = 'button' class = 'management-home-card' onClick = { () => selectPage(page) }>
					<img src = { section.icon } width = '28' height = '28' alt = '' />
					<span class = 'management-home-card-copy'>
						<strong>{ section.label }</strong>
						<span>{ section.description }</span>
					</span>
					<span class = 'management-home-card-arrow' aria-hidden = 'true'>→</span>
				</button>
			}) }
		</div>
	</main>
}

export function ManagementView() {
	const initialPage = getManagementPageFromHash(globalThis.location.hash)
	const selectedPage = useSignal<ManagementPage | undefined>(initialPage)
	const mountedPages = useSignal(createMountedManagementPages(initialPage))

	useEffect(() => {
		const updateSelectedPage = () => {
			activatePage(getManagementPageFromHash(globalThis.location.hash))
		}
		globalThis.addEventListener('hashchange', updateSelectedPage)
		return () => globalThis.removeEventListener('hashchange', updateSelectedPage)
	}, [])

	useEffect(() => {
		const revealSelectedTab = () => {
			const tab = globalThis.document.getElementById(`management-tab-${ selectedPage.value }`)
			const tabList = globalThis.document.querySelector<HTMLElement>('.management-tabs')
			if (tab === null || tabList === null) return
			const tabBounds = tab.getBoundingClientRect()
			const listBounds = tabList.getBoundingClientRect()
			if (tabBounds.left < listBounds.left) tabList.scrollLeft -= listBounds.left - tabBounds.left
			else if (tabBounds.right > listBounds.right) tabList.scrollLeft += tabBounds.right - listBounds.right
		}
		revealSelectedTab()
		globalThis.addEventListener('resize', revealSelectedTab)
		return () => globalThis.removeEventListener('resize', revealSelectedTab)
	}, [selectedPage.value])

	function activatePage(page: ManagementPage | undefined) {
		batch(() => {
			if (page !== undefined) mountedPages.value = mountManagementPage(mountedPages.peek(), page)
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
				{ managementPages.map((page) => <ManagementTab key = { page } page = { page } selectedPage = { selectedPage.value } label = { managementSectionDetails[page].label } icon = { managementSectionDetails[page].icon } selectPage = { selectPage } />) }
			</nav>
		</header>
		{ selectedPage.value === undefined && <main class = 'management-panel management-unavailable'>
			<h2>Management page unavailable</h2>
			<p>Choose a tab above to continue.</p>
		</main> }
		<section
			id = 'management-panel-home'
			class = 'management-panel'
			role = 'tabpanel'
			aria-labelledby = 'management-tab-home'
			tabIndex = { selectedPage.value === 'home' ? 0 : -1 }
			hidden = { selectedPage.value !== 'home' }
		>
			{ mountedPages.value.home ? <ManagementHome selectPage = { selectPage } /> : <></> }
		</section>
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
