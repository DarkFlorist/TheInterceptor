import * as assert from 'assert'
import { test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { useEffect } from 'preact/hooks'
import { clickRenderedElement, findRenderedElement, installDomMock } from './domMock.js'
import { withSilencedConsole } from './consoleSilence.js'

function replaceGlobal(name: string, value: unknown) {
	const previous = Object.getOwnPropertyDescriptor(globalThis, name)
	Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
	return () => {
		if (previous === undefined) Reflect.deleteProperty(globalThis, name)
		else Object.defineProperty(globalThis, name, previous)
	}
}

function installManagementShellMocks() {
	const dom = installDomMock()
	const hashListeners = new Set<EventListenerOrEventListenerObject>()
	const runtimeListeners = new Set<(message: unknown) => unknown>()
	let diagnosticsLoads = 0
	let websiteLoads = 0
	let unexpectedErrorBroadcasts = 0
	let hash = '#home'
	const storageState: Record<string, unknown> = {}
	const historyReplacements: string[] = []
	const location = {
		pathname: '/html3/managementViewV3.html',
		search: '',
		get hash() { return hash },
		set hash(nextHash: string) {
			hash = nextHash
			for (const listener of [...hashListeners]) {
				if (typeof listener === 'function') listener(new Event('hashchange'))
				else listener.handleEvent(new Event('hashchange'))
			}
		},
	}
	const addEventListener = (type: string, listener: EventListenerOrEventListenerObject) => {
		if (type === 'hashchange') hashListeners.add(listener)
	}
	const removeEventListener = (type: string, listener: EventListenerOrEventListenerObject) => {
		if (type === 'hashchange') hashListeners.delete(listener)
	}
	const restoreLocation = replaceGlobal('location', location)
	// replaceState swaps the current entry without firing hashchange, like the real History API.
	const restoreHistory = replaceGlobal('history', {
		state: undefined,
		replaceState(_state: unknown, _title: string, url: string) {
			historyReplacements.push(url)
			hash = url.slice(url.indexOf('#'))
		},
	})
	const restoreAddEventListener = replaceGlobal('addEventListener', addEventListener)
	const restoreRemoveEventListener = replaceGlobal('removeEventListener', removeEventListener)
	Object.defineProperty(globalThis.window, 'location', { configurable: true, value: location })
	Object.defineProperty(globalThis.window, 'addEventListener', { configurable: true, value: addEventListener })
	Object.defineProperty(globalThis.window, 'removeEventListener', { configurable: true, value: removeEventListener })
	const tabListLayout = { scrollLeft: 0, getBoundingClientRect: () => ({ left: 0, right: 100 }) }
	const diagnosticsTabLayout = { getBoundingClientRect: () => ({ left: 90, right: 150 }) }
	Object.defineProperty(dom.document, 'getElementById', { configurable: true, value: (id: string) => id === 'management-tab-diagnostics' ? diagnosticsTabLayout : null })
	Object.defineProperty(dom.document, 'querySelector', { configurable: true, value: (selector: string) => selector === '.management-tabs' ? tabListLayout : null })
	const restoreBrowser = replaceGlobal('browser', {
		runtime: {
			lastError: undefined,
			getManifest: () => ({ manifest_version: 3 }),
			async sendMessage(message: { method: string }) {
				if (message.method === 'popup_requestDiagnostics') {
					diagnosticsLoads += 1
					return { method: 'popup_requestDiagnostics', diagnostics: [] }
				}
				if (message.method === 'popup_retrieveWebsiteAccess') websiteLoads += 1
				if (message.method === 'popup_UnexpectedErrorOccured') unexpectedErrorBroadcasts += 1
				return undefined
			},
			onMessage: {
				addListener(listener: (message: unknown) => unknown) { runtimeListeners.add(listener) },
				removeListener(listener: (message: unknown) => unknown) { runtimeListeners.delete(listener) },
			},
		},
		storage: {
			local: {
				async get(keys?: string | string[]) {
					const requestedKeys = keys === undefined ? Object.keys(storageState) : Array.isArray(keys) ? keys : [keys]
					return Object.fromEntries(requestedKeys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
				},
				async set(items: Record<string, unknown>) { Object.assign(storageState, items) },
				async remove(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key] },
			},
		},
	})

	const restore = () => {
		restoreHistory()
		restoreBrowser()
		restoreRemoveEventListener()
		restoreAddEventListener()
		restoreLocation()
		dom.restore()
	}
	return { dom, runtimeListeners, tabListLayout, storageState, historyReplacements, getHash: () => hash, getUnexpectedErrorBroadcasts: () => unexpectedErrorBroadcasts, getDiagnosticsLoads: () => diagnosticsLoads, getWebsiteLoads: () => websiteLoads, restore }
}

test('management tabs reveal clipped selection, reload Diagnostics, and release hidden website listeners', async () => {
	const { dom, runtimeListeners, tabListLayout, getDiagnosticsLoads, getWebsiteLoads, restore } = installManagementShellMocks()

	try {
		const { ManagementView } = await import('../../app/ts/components/pages/ManagementView.js')
		await act(() => { render(h(ManagementView, {}), dom.document.body) })

		async function selectTab(label: string) {
			const tab = findRenderedElement(dom.document.body, (node) => node.tagName === 'BUTTON' && node.textContent === label)
			assert.ok(tab, `Missing ${ label } tab`)
			await act(async () => { await clickRenderedElement(tab) })
		}

		await selectTab('Diagnostics')
		assert.equal(getDiagnosticsLoads(), 1)
		assert.equal(tabListLayout.scrollLeft, 50)
		await selectTab('Home')
		await selectTab('Diagnostics')
		assert.equal(getDiagnosticsLoads(), 2)

		await selectTab('Websites')
		assert.equal(getWebsiteLoads() > 0, true)
		assert.equal(runtimeListeners.size > 0, true)
		await selectTab('Home')
		assert.equal(dom.document.body.textContent.includes('Manage Websites'), false)
		assert.equal(runtimeListeners.size, 0)
		const loadsAfterLeaving = getWebsiteLoads()
		for (const listener of [...runtimeListeners]) listener({ role: 'all', method: 'popup_websiteAccess_changed' })
		assert.equal(getWebsiteLoads(), loadsAfterLeaving)
	} finally {
		await act(() => { render(null, dom.document.body) })
		restore()
	}
})

test('every management panel releases its runtime message listeners when it is hidden or the shell unmounts', async () => {
	const { dom, runtimeListeners, restore } = installManagementShellMocks()
	const { managementPages } = await import('../../app/ts/utils/managementPages.js')
	const panelLabels: Readonly<Record<string, string>> = { websites: 'Websites', 'address-book': 'Address Book', 'simulation-stack': 'Simulation Stack', diagnostics: 'Diagnostics', settings: 'Settings' }

	try {
		const { ManagementView } = await import('../../app/ts/components/pages/ManagementView.js')
		await act(() => { render(h(ManagementView, {}), dom.document.body) })
		const selectTab = async (label: string) => {
			const tab = findRenderedElement(dom.document.body, (node) => node.tagName === 'BUTTON' && node.getAttribute('role') === 'tab' && node.textContent === label)
			assert.ok(tab, `Missing ${ label } tab`)
			await act(async () => { await clickRenderedElement(tab) })
		}
		assert.equal(runtimeListeners.size, 0, 'the home panel should not subscribe to runtime messages')

		for (const page of managementPages.filter((managementPage) => managementPage !== 'home')) {
			const label = panelLabels[page]
			assert.ok(label, `Missing tab label for ${ page }`)
			await selectTab(label)
			assert.doesNotMatch(dom.document.body.textContent ?? '', /could not be displayed/u, `${ label } rendered the error fallback instead of its panel`)
			await selectTab('Home')
			assert.equal(runtimeListeners.size, 0, `${ label } left runtime message listeners registered after it was hidden`)
		}

		await selectTab('Settings')
		assert.equal(runtimeListeners.size > 0, true)
		await act(() => { render(null, dom.document.body) })
		assert.equal(runtimeListeners.size, 0, 'unmounting the shell left runtime message listeners registered')
	} finally {
		await act(() => { render(null, dom.document.body) })
		restore()
	}
})

test('a failing panel keeps the shell header and tabs usable, reports the failure, and recovers on retry', async () => {
	const { dom, storageState, getUnexpectedErrorBroadcasts, restore } = installManagementShellMocks()
	let diagnosticsPanelFails = true
	const { ManagementShell } = await import('../../app/ts/components/pages/ManagementView.js')
	const renderPanel = ({ route }: { route: { page: string } }) => {
		if (route.page === 'diagnostics' && diagnosticsPanelFails) throw new Error('diagnostics panel exploded')
		return <main class = 'test-panel'>{ `${ route.page } panel` }</main>
	}
	const storedPanelFailureCount = () => {
		const storedDiagnostics = storageState.interceptorErrorDiagnostics
		if (!Array.isArray(storedDiagnostics)) return 0
		return storedDiagnostics.filter((diagnostic) => typeof diagnostic === 'object' && diagnostic !== null && 'code' in diagnostic && diagnostic.code === 'management_panel_render_failed').length
	}
	const findButton = (label: string) => findRenderedElement(dom.document.body, (node) => node.tagName === 'BUTTON' && node.textContent === label)
	const click = async (label: string) => {
		const button = findButton(label)
		assert.ok(button, `Missing ${ label } button`)
		await act(async () => { await clickRenderedElement(button) })
	}

	try {
		await withSilencedConsole(async () => {
			await act(() => { render(<ManagementShell renderPanel = { renderPanel } />, dom.document.body) })
			await click('Diagnostics')
			for (let attempt = 0; attempt < 20 && getUnexpectedErrorBroadcasts() < 1; attempt++) await act(async () => { await Promise.resolve() })
		})

		const text = () => dom.document.body.textContent
		assert.match(text(), /Diagnostics could not be displayed/u)
		assert.match(text(), /diagnostics panel exploded/u)
		assert.ok(findRenderedElement(dom.document.body, (node) => node.tagName === 'NAV' && node.getAttribute('role') === 'tablist'), 'tab navigation was unmounted by the panel failure')
		assert.ok(findButton('Settings'), 'tabs were unmounted by the panel failure')
		assert.equal(storedPanelFailureCount(), 1, 'the panel failure was not reported')

		await click('Settings')
		assert.match(text(), /settings panel/u)
		assert.doesNotMatch(text(), /could not be displayed/u)

		await withSilencedConsole(async () => {
			await click('Diagnostics')
			for (let attempt = 0; attempt < 20 && getUnexpectedErrorBroadcasts() < 2; attempt++) await act(async () => { await Promise.resolve() })
		})
		assert.match(text(), /Diagnostics could not be displayed/u)
		assert.equal(storedPanelFailureCount(), 2)
		diagnosticsPanelFails = false
		await click('Try again')
		assert.match(text(), /diagnostics panel/u)
		assert.doesNotMatch(text(), /could not be displayed/u)
	} finally {
		await act(() => { render(null, dom.document.body) })
		restore()
	}
})

test('panels change the route only through navigate, and the shell hands the new route back as props', async () => {
	const { dom, restore } = installManagementShellMocks()
	const { ManagementShell } = await import('../../app/ts/components/pages/ManagementView.js')
	const { formatManagementRoute } = await import('../../app/ts/utils/managementPages.js')
	const renderPanel = ({ route, navigate }: { route: { page: string }, navigate: (route: { page: 'websites', websiteOrigin?: string }) => void }) => <main>
		<p>{ `route ${ formatManagementRoute({ page: 'home', ...route }) }` }</p>
		<button type = 'button' onClick = { () => navigate({ page: 'websites', websiteOrigin: 'example.com' }) }>Open example.com</button>
	</main>

	try {
		await act(() => { render(<ManagementShell renderPanel = { renderPanel } />, dom.document.body) })
		assert.match(dom.document.body.textContent, /route #home/u)

		const openButton = findRenderedElement(dom.document.body, (node) => node.tagName === 'BUTTON' && node.textContent === 'Open example.com')
		assert.ok(openButton)
		await act(async () => { await clickRenderedElement(openButton) })

		assert.equal(globalThis.location.hash, '#websites?origin=example.com')
		assert.match(dom.document.body.textContent, /route #websites\?origin=example\.com/u)
	} finally {
		await act(() => { render(null, dom.document.body) })
		restore()
	}
})

test('replace navigation updates the current history entry and still hands the new route to the panel', async () => {
	const { dom, historyReplacements, getHash, restore } = installManagementShellMocks()
	const { ManagementShell } = await import('../../app/ts/components/pages/ManagementView.js')
	const { formatManagementRoute } = await import('../../app/ts/utils/managementPages.js')
	const renderPanel = ({ route, navigate }: { route: { page: string }, navigate: (route: { page: 'websites', websiteOrigin?: string }, options?: { replace?: boolean }) => void }) => <main>
		<p>{ `route ${ formatManagementRoute({ page: 'home', ...route }) }` }</p>
		<button type = 'button' onClick = { () => navigate({ page: 'websites', websiteOrigin: 'auto.example' }, { replace: true }) }>Auto-select</button>
	</main>

	try {
		await act(() => { render(<ManagementShell renderPanel = { renderPanel } />, dom.document.body) })
		const autoSelectButton = findRenderedElement(dom.document.body, (node) => node.tagName === 'BUTTON' && node.textContent === 'Auto-select')
		assert.ok(autoSelectButton)
		await act(async () => { await clickRenderedElement(autoSelectButton) })

		assert.deepEqual(historyReplacements, ['/html3/managementViewV3.html#websites?origin=auto.example'])
		assert.equal(getHash(), '#websites?origin=auto.example')
		assert.match(dom.document.body.textContent, /route #websites\?origin=auto\.example/u)
	} finally {
		await act(() => { render(null, dom.document.body) })
		restore()
	}
})


for (const page of ['websites', 'simulation-stack'] as const) test(`a failed ${ page } panel retries on same-page routes without remounting healthy navigation`, async () => {
	const { dom, getUnexpectedErrorBroadcasts, restore } = installManagementShellMocks()
	const { ManagementShell } = await import('../../app/ts/components/pages/ManagementView.js')
	let mounts = 0
	const hashFor = (value: string) => page === 'websites'
		? `#websites?origin=${ value }.example`
		: `#simulation-stack?simulation-stack-target=simulation-stack-transaction-0x${ value }`
	const failingHash = hashFor('bad')
	const renderPanel = ({ route }: { route: { page: string } }) => {
		useEffect(() => { mounts += 1 }, [])
		if (globalThis.location.hash === failingHash) throw new Error('route-specific failure')
		return <main>{ `${ route.page } recovered` }</main>
	}
	try {
		await withSilencedConsole(async () => {
			globalThis.location.hash = failingHash
			await act(() => { render(<ManagementShell renderPanel = { renderPanel } />, dom.document.body) })
			assert.match(dom.document.body.textContent, /could not be displayed/u)
			await act(() => { globalThis.location.hash = hashFor('1') })
			assert.match(dom.document.body.textContent, /recovered/u)
			assert.doesNotMatch(dom.document.body.textContent, /could not be displayed/u)
			const healthyMounts = mounts
			await act(() => { globalThis.location.hash = hashFor('2') })
			assert.equal(mounts, healthyMounts, 'healthy same-page navigation preserves the panel')
			await act(() => { globalThis.location.hash = failingHash })
			assert.match(dom.document.body.textContent, /could not be displayed/u)
			const tab = findRenderedElement(dom.document.body, (node) => node.tagName === 'BUTTON' && node.getAttribute('id') === `management-tab-${ page }`)
			assert.ok(tab)
			await act(async () => { await clickRenderedElement(tab) })
			assert.match(dom.document.body.textContent, /recovered/u)
			// Both failed renders report asynchronously; keep their browser mock installed until persistence and broadcasting finish.
			for (let attempt = 0; attempt < 20 && getUnexpectedErrorBroadcasts() < 2; attempt++) await act(async () => { await Promise.resolve() })
			assert.equal(getUnexpectedErrorBroadcasts(), 2)
		})
	} finally {
		await act(() => { render(null, dom.document.body) })
		restore()
	}
})

test('a management panel counts as failed only when the boundary holds an error, whichever empty value Preact uses', async () => {
	const { isPanelRenderFailure } = await import('../../app/ts/components/pages/ManagementView.js')
	assert.equal(isPanelRenderFailure(undefined), false)
	assert.equal(isPanelRenderFailure(null), false)
	assert.equal(isPanelRenderFailure(new Error('panel failed')), true)
	assert.equal(isPanelRenderFailure('panel failed'), true)
})
