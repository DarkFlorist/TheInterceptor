import { useEffect } from 'preact/hooks'
import { batch, useSignal } from '@preact/signals'
import type { JSX } from 'preact'
import { AddressBook } from '../../AddressBook.js'
import { WebsiteAccessView } from './WebsiteAccess.js'
import { SettingsView } from './SettingsView.js'
import { SimulationStackPage } from './SimulationStackPage.js'
import { DiagnosticsView } from './DiagnosticsView.js'
import Hint from '../subcomponents/Hint.js'
import { getMissingPopupReplyErrorMessage, sendPopupMessageWithReply } from '../../background/backgroundUtils.js'
import { hasActionableDiagnostics } from '../../utils/diagnostics.js'
import { useAsyncState } from '../../utils/preact-utilities.js'
import { createMountedManagementPages, getManagementPageFromHash, getManagementPageFromNavigationKey, getManagementPageHash, mountManagementPage, type ManagementPage } from '../../utils/managementPages.js'

type ManagementTabParams = {
	page: ManagementPage
	selectedPage: ManagementPage
	label: string
	icon: string
	attention?: boolean
	statusUnavailable?: boolean
	selectPage: (page: ManagementPage) => void
}

function ManagementTab({ page, selectedPage, label, icon, attention, statusUnavailable, selectPage }: ManagementTabParams) {
	const selected = page === selectedPage
	return <button
		type = 'button'
		role = 'tab'
		class = { `management-tab${ selected ? ' is-active' : '' }` }
		aria-selected = { selected }
		aria-controls = { `management-panel-${ page }` }
		id = { `management-tab-${ page }` }
		tabIndex = { selected ? 0 : -1 }
		aria-label = { attention ? `${ label }, needs attention` : undefined }
		title = { statusUnavailable ? 'Could not load diagnostics status' : undefined }
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
	const diagnosticsNeedAttention = useSignal(false)
	const { value: diagnosticsStatus, waitFor: waitForDiagnosticsStatus } = useAsyncState<void>()

	useEffect(() => {
		let active = true
		let requestNumber = 0
		async function loadDiagnosticsStatus() {
			const currentRequest = ++requestNumber
			const reply = await sendPopupMessageWithReply({ method: 'popup_requestDiagnostics' })
			if (reply === undefined) throw new Error(getMissingPopupReplyErrorMessage('Loading diagnostics status'))
			if (active && currentRequest === requestNumber) diagnosticsNeedAttention.value = hasActionableDiagnostics(reply.diagnostics)
		}
		const onStorageChanged = (changes: { readonly interceptorErrorDiagnostics?: browser.storage.StorageChange }, areaName: string) => {
			if (areaName !== 'local' || !('interceptorErrorDiagnostics' in changes)) return
			void waitForDiagnosticsStatus(loadDiagnosticsStatus)
		}
		browser.storage.onChanged.addListener(onStorageChanged)
		void waitForDiagnosticsStatus(loadDiagnosticsStatus)
		return () => {
			active = false
			browser.storage.onChanged.removeListener(onStorageChanged)
		}
	}, [])

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
				<ManagementTab page = 'simulation-stack' selectedPage = { selectedPage.value } label = 'Simulation Stack' icon = '../img/simulation-stack.svg' selectPage = { selectPage } />
				<ManagementTab page = 'diagnostics' selectedPage = { selectedPage.value } label = 'Diagnostics' icon = { diagnosticsNeedAttention.value ? '../img/warning-sign.svg' : '../img/diagnostics.svg' } attention = { diagnosticsNeedAttention.value } statusUnavailable = { diagnosticsStatus.value.state === 'rejected' } selectPage = { selectPage } />
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
