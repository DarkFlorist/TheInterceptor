import { useEffect } from 'preact/hooks'
import { useSignal } from '@preact/signals'
import type { JSX } from 'preact'
import { AddressBook } from '../../AddressBook.js'
import { WebsiteAccessView } from './WebsiteAccess.js'
import { SettingsView } from './SettingsView.js'
import { SimulationStackPage } from './SimulationStackPage.js'
import { DiagnosticsView } from './DiagnosticsView.js'
import Hint from '../subcomponents/Hint.js'
import { getManagementPageFromHash, getManagementPageFromNavigationKey, getManagementPageHash, managementPages, type ManagementPage } from '../../utils/managementPages.js'
import { assertNever } from '../../utils/typescript.js'

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

function ManagementPanelContent({ page, selectPage }: { page: ManagementPage, selectPage: (page: ManagementPage) => void }) {
	switch (page) {
		case 'home': return <ManagementHome selectPage = { selectPage } />
		case 'websites': return <WebsiteAccessView />
		case 'address-book': return <AddressBook />
		case 'simulation-stack': return <Hint><SimulationStackPage /></Hint>
		case 'diagnostics': return <DiagnosticsView />
		case 'settings': return <SettingsView />
		default: return assertNever(page)
	}
}

export function ManagementView() {
	const initialPage = getManagementPageFromHash(globalThis.location.hash)
	const selectedPage = useSignal<ManagementPage | undefined>(initialPage)

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
			const leftOverflow = listBounds.left - tabBounds.left
			const rightOverflow = tabBounds.right - listBounds.right
			if (leftOverflow > 0) tabList.scrollLeft -= leftOverflow
			else if (rightOverflow > 0) tabList.scrollLeft += rightOverflow
		}
		revealSelectedTab()
		globalThis.addEventListener('resize', revealSelectedTab)
		return () => globalThis.removeEventListener('resize', revealSelectedTab)
	}, [selectedPage.value])

	function activatePage(page: ManagementPage | undefined) {
		selectedPage.value = page
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

	return <div class = { `management-page${ selectedPage.value === 'address-book' ? ' management-page--address-book' : '' }` }>
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
		{ managementPages.map((page) => {
			const active = selectedPage.value === page
			return <section
				key = { page }
				id = { `management-panel-${ page }` }
				class = 'management-panel'
				role = 'tabpanel'
				aria-labelledby = { `management-tab-${ page }` }
				tabIndex = { active ? 0 : -1 }
				hidden = { !active }
			>
				{ active ? <ManagementPanelContent page = { page } selectPage = { selectPage } /> : <></> }
			</section>
		}) }
	</div>
}
