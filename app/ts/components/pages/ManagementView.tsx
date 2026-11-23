import { useEffect, useErrorBoundary } from 'preact/hooks'
import { useSignal } from '@preact/signals'
import type { ComponentChildren, JSX } from 'preact'
import { AddressBook } from '../../AddressBook.js'
import { WebsiteAccessView } from './WebsiteAccess.js'
import { SettingsView } from './SettingsView.js'
import { SimulationStackView } from './SimulationStackPage.js'
import { DiagnosticsView } from './DiagnosticsView.js'
import { getManagementPageFromNavigationKey, managementPages, type ManagementPage, type ManagementRoute } from '../../utils/managementPages.js'
import { readManagementRoute, replaceWithCanonicalManagementHash, subscribeToManagementRoute, writeManagementRoute, type ManagementNavigationOptions } from '../../utils/managementLocation.js'
import { assertNever } from '../../utils/typescript.js'
import { ErrorComponent } from '../subcomponents/Error.js'
import { reportUnexpectedError } from '../../utils/errors.js'
import { getErrorMessage } from '../../utils/caughtErrors.js'

// layoutClass sizes the whole shell for the active section and panelClass styles that section's panel; pages carry no container-specific styling of their own.
const managementSectionDetails: Readonly<Record<ManagementPage, { label: string, icon: string, description: string, layoutClass: string, panelClass: string }>> = {
	home: { label: 'Home', icon: '../img/management-home.svg', description: '', layoutClass: '', panelClass: '' },
	websites: { label: 'Websites', icon: '../img/internet.svg', description: 'Review website access and permissions.', layoutClass: '', panelClass: '' },
	'address-book': { label: 'Address Book', icon: '../img/address-book.svg', description: 'Manage saved addresses and contacts.', layoutClass: ' management-page--contained management-page--address-book', panelClass: '' },
	'simulation-stack': { label: 'Simulation Stack', icon: '../img/simulation-stack.svg', description: 'Inspect pending and simulated activity.', layoutClass: ' management-page--contained', panelClass: ' management-panel--scrollable' },
	diagnostics: { label: 'Diagnostics', icon: '../img/diagnostics.svg', description: 'Browse recorded errors and technical details.', layoutClass: '', panelClass: '' },
	settings: { label: 'Settings', icon: '../img/settings.svg', description: 'Configure networks and extension preferences.', layoutClass: '', panelClass: '' },
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

type ManagementPanelContentParams = { route: ManagementRoute, navigate: (route: ManagementRoute, options?: ManagementNavigationOptions) => void }

// Each panel receives its part of the route as props and changes it only through navigate, so the shell stays the single owner of the location.
function ManagementPanelContent({ route, navigate }: ManagementPanelContentParams) {
	switch (route.page) {
		case 'home': return <ManagementHome selectPage = { (page) => navigate({ page }) } />
		case 'websites': return <WebsiteAccessView websiteOrigin = { route.websiteOrigin } selectWebsite = { (websiteOrigin, options) => navigate(websiteOrigin === undefined ? { page: 'websites' } : { page: 'websites', websiteOrigin }, options) } />
		case 'address-book': return <AddressBook />
		case 'simulation-stack': return <SimulationStackView stackTarget = { route.stackTarget } />
		case 'diagnostics': return <DiagnosticsView />
		case 'settings': return <SettingsView />
		default: return assertNever(route)
	}
}

function ManagementPanelRenderError({ page, error, retry }: { page: ManagementPage, error: unknown, retry: () => void }) {
	useEffect(() => {
		const reportPanelRenderError = async () => {
			await reportUnexpectedError(error, {
				source: 'managementView',
				code: 'management_panel_render_failed',
				displayMessage: `The ${ managementSectionDetails[page].label } section failed to display.`,
				details: { page },
				suppressExpectedHandledErrors: false,
			})
		}
		void reportPanelRenderError()
	}, [error])

	return <main class = 'management-unavailable management-panel-error' role = 'alert'>
		<h2>{ managementSectionDetails[page].label } could not be displayed</h2>
		<ErrorComponent text = { getErrorMessage(error) ?? 'An unexpected error occurred while rendering this section.' } containerStyle = { { margin: '1rem 0' } } />
		<button type = 'button' class = 'button is-primary' onClick = { retry }>Try again</button>
	</main>
}

// A failed panel retries on navigation, including another route within its page or reselecting its tab. Healthy panels retain their state across same-page navigation.
function ManagementPanelErrorBoundary({ route, children }: { route: ManagementRoute, children: ComponentChildren }) {
	const [error, resetError] = useErrorBoundary()
	// Preact types the caught error as any and has used both undefined and null for "no error", so either means the panel is healthy.
	const panelFailed = error !== undefined && error !== null
	useEffect(() => {
		if (panelFailed) resetError()
	}, [route])
	if (panelFailed) return <ManagementPanelRenderError page = { route.page } error = { error } retry = { resetError } />
	return <>{ children }</>
}

export function ManagementView() {
	return <ManagementShell renderPanel = { ManagementPanelContent } />
}

export function ManagementShell({ renderPanel: RenderPanel }: { renderPanel: (params: ManagementPanelContentParams) => JSX.Element }) {
	const route = useSignal<ManagementRoute | undefined>(readManagementRoute())
	const selectedPage = route.value?.page

	useEffect(() => {
		replaceWithCanonicalManagementHash()
		return subscribeToManagementRoute((nextRoute) => { route.value = nextRoute })
	}, [])

	useEffect(() => {
		const revealSelectedTab = () => {
			const tab = globalThis.document.getElementById(`management-tab-${ selectedPage }`)
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
	}, [selectedPage])

	// Sets the route directly as well, because a replace navigation does not fire hashchange.
	function navigate(nextRoute: ManagementRoute, options?: ManagementNavigationOptions) {
		route.value = nextRoute
		writeManagementRoute(nextRoute, options)
	}

	function selectPage(page: ManagementPage) {
		navigate({ page })
	}

	function handleTabKeyDown(event: JSX.TargetedKeyboardEvent<HTMLElement>) {
		const page = getManagementPageFromNavigationKey(selectedPage, event.key)
		if (page === undefined) return
		event.preventDefault()
		selectPage(page)
		globalThis.document.getElementById(`management-tab-${ page }`)?.focus()
	}

	const pageLayoutClass = selectedPage === undefined ? '' : managementSectionDetails[selectedPage].layoutClass
	return <div class = { `management-page${ pageLayoutClass }` }>
		<header class = 'management-header window-header'>
			<div class = 'management-brand'>
				<img src = '../img/LOGOA.svg' alt = 'The Interceptor' width = '32' height = '32' />
				<h1>The Interceptor</h1>
			</div>
			<nav class = 'management-tabs' role = 'tablist' aria-label = 'Interceptor management' onKeyDown = { handleTabKeyDown }>
				{ managementPages.map((page) => <ManagementTab key = { page } page = { page } selectedPage = { selectedPage } label = { managementSectionDetails[page].label } icon = { managementSectionDetails[page].icon } selectPage = { selectPage } />) }
			</nav>
		</header>
		{ selectedPage === undefined && <main class = 'management-panel management-unavailable'>
			<h2>Management page unavailable</h2>
			<p>Choose a tab above to continue.</p>
		</main> }
		{ managementPages.map((page) => {
			const activeRoute = route.value?.page === page ? route.value : undefined
			return <section
				key = { page }
				id = { `management-panel-${ page }` }
				class = { `management-panel${ managementSectionDetails[page].panelClass }` }
				role = 'tabpanel'
				aria-labelledby = { `management-tab-${ page }` }
				tabIndex = { activeRoute !== undefined ? 0 : -1 }
				hidden = { activeRoute === undefined }
			>
				{ activeRoute !== undefined ? <ManagementPanelErrorBoundary key = { page } route = { activeRoute }><RenderPanel route = { activeRoute } navigate = { navigate } /></ManagementPanelErrorBoundary> : <></> }
			</section>
		}) }
	</div>
}
