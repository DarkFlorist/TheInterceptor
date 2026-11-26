import * as assert from 'node:assert'
import * as fs from 'node:fs'
import { spyOn, test } from 'bun:test'
import ts from 'typescript'
import { installBrowserMock, createEthereumWithGetBlockCounter, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'
import { openNativeGnosisSafeApp } from '../../app/ts/background/gnosisSafeAppsLaunch.js'
import { PopupMessage } from '../../app/ts/types/interceptor-messages.js'
import { getPopupMessageDomain, requiresExtensionPageSender } from '../../app/ts/types/popupMessageProtocol.js'
import { getGnosisSafeSessionCompatibilityMode, getSettings, setGnosisSafeSessionCompatibilityMode } from '../../app/ts/background/settings.js'
import { getIdsOfOpenedTabs } from '../../app/ts/background/storageVariables.js'
import { dispatchPopupMessage } from '../../app/ts/background/popupMessageDispatcher.js'

for (const manifestVersion of [2, 3] as const) test(`the background launch command validates the live source, enables compatibility and tracks the MV${ manifestVersion } host`, async () => {
	const { readStoredValue, setStorageHooks } = installBrowserMock({ manifestVersion })
	const modeWrites: boolean[] = []
	setStorageHooks({ beforeSet: async (items) => { if (typeof items.safeAppsCompatibilityMode === 'boolean') modeWrites.push(items.safeAppsCompatibilityMode) } })
	const root = `${ manifestVersion === 2 ? 'moz-extension' : 'chrome-extension' }://test-extension/`
	Object.assign(browser.runtime, { getURL: (file: string) => new URL(file, root).href })
	const sourceUrl = 'https://app.example/current?view=swap#route'
	const source = spyOn(browser.tabs, 'get').mockResolvedValue({ id: 23, active: true, url: sourceUrl })
	const created: string[] = []
	const create = spyOn(browser.tabs, 'create').mockImplementation(async (details) => {
		assert.equal(readStoredValue('safeAppsCompatibilityMode'), true, 'enable through the settings owner before launching the host')
		assert.ok(details.url)
		created.push(details.url)
		return { id: 98 + created.length, active: true, url: details.url }
	})
	try {
		const request = { method: 'popup_openGnosisSafeApp', data: { sourceTabId: 23 } } as const
		assert.equal(PopupMessage.safeParse(request).success, true)
		assert.equal(getPopupMessageDomain(request.method), 'safe')
		assert.equal(requiresExtensionPageSender(request.method), true)
		const reply = await dispatchPopupMessage({
			websiteTabConnections: new Map(),
			simulationServicesOwner: createEthereumWithGetBlockCounter({ count: 0 }).simulationServicesOwner,
			settings: await getSettings(),
			publishRpcConnectionStatus: noopPublishRpcConnectionStatus,
			simulationAbortController: new AbortController(),
			confirmTransactionAbortController: new AbortController(),
			resetSimulationState: async () => undefined,
		}, request)
		assert.deepEqual(reply, { type: 'OpenGnosisSafeAppReply', ok: true })
		assert.deepEqual(modeWrites, [true])
		assert.deepEqual(source.mock.calls, [[23]])
		assert.equal(created.length, 1)
		const host = new URL(created[0] ?? '', root)
		assert.equal(host.pathname, manifestVersion === 2 ? '/html/gnosisSafeAppsHost.html' : '/html3/gnosisSafeAppsHostV3.html')
		assert.equal(host.searchParams.get('sourceTabId'), '23')
		assert.equal(host.searchParams.get('appUrl'), sourceUrl)
		assert.equal((await getIdsOfOpenedTabs()).gnosisSafeAppsHost, 99)
		const existingHost = { id: 99, active: true, url: host.href }
		const query = spyOn(browser.tabs, 'query').mockResolvedValue([existingHost])
		const update = spyOn(browser.tabs, 'update').mockResolvedValue({ id: 99, active: true })
		try {
			assert.equal((await openNativeGnosisSafeApp(23)).ok, true)
			assert.equal(create.mock.calls.length, 1, 'the persisted host id reuses its existing tab')
			assert.equal(update.mock.calls[0]?.[0], 99)
			assert.deepEqual(update.mock.calls[0]?.[1], { active: true, highlighted: true }, 'an identical launch only focuses its live session without navigating')
			assert.deepEqual(modeWrites, [true], 'an already-enabled launch must not write a same-value mode change that invalidates the pending session')
			assert.equal((await getIdsOfOpenedTabs()).gnosisSafeAppsHost, 99)
			const currentSourceUrl = 'https://app.example/new-page'
			source.mockResolvedValue({ id: 23, active: true, url: currentSourceUrl })
			assert.equal((await openNativeGnosisSafeApp(23)).ok, true)
			assert.equal(create.mock.calls.length, 2, 'a changed live app URL opens another session')
			assert.equal(update.mock.calls.length, 1, 'the original host is never navigated to the changed app')
			const nextHost = new URL(created[1] ?? '', root)
			assert.equal(nextHost.searchParams.get('appUrl'), currentSourceUrl)
			assert.equal((await getIdsOfOpenedTabs()).gnosisSafeAppsHost, 100)
			assert.equal(existingHost.url, host.href)
			query.mockResolvedValue([{ id: 100, active: true, url: nextHost.href }])
			source.mockResolvedValue({ id: 24, active: true, url: currentSourceUrl })
			assert.equal((await openNativeGnosisSafeApp(24)).ok, true)
			assert.equal(create.mock.calls.length, 3, 'another source tab also gets its own host even for the same app URL')
			assert.equal(update.mock.calls.length, 1)
			assert.equal(new URL(created[2] ?? '', root).searchParams.get('sourceTabId'), '24')
			assert.equal((await getIdsOfOpenedTabs()).gnosisSafeAppsHost, 101)
			assert.deepEqual(modeWrites, [true], 'additional hosts also preserve the already-enabled session setting')
		} finally { query.mockRestore(); update.mockRestore() }
	} finally { source.mockRestore(); create.mockRestore() }
})

test('the compatibility setter emits storage changes only for actual mode transitions', async () => {
	const { setStorageHooks } = installBrowserMock()
	const modeWrites: boolean[] = []
	let modeEvents = 0
	setStorageHooks({ beforeSet: async (items) => { if (typeof items.safeAppsCompatibilityMode === 'boolean') modeWrites.push(items.safeAppsCompatibilityMode) } })
	browser.storage.onChanged.addListener((changes, area) => {
		if (area === 'local' && 'safeAppsCompatibilityMode' in changes) modeEvents++
	})
	await setGnosisSafeSessionCompatibilityMode(false)
	assert.deepEqual(modeWrites, [], 'the default false value needs no write')
	await setGnosisSafeSessionCompatibilityMode(true)
	await setGnosisSafeSessionCompatibilityMode(true)
	assert.equal(await getGnosisSafeSessionCompatibilityMode(), true)
	assert.deepEqual(modeWrites, [true])
	assert.equal(modeEvents, 1)
	await setGnosisSafeSessionCompatibilityMode(false)
	await setGnosisSafeSessionCompatibilityMode(false)
	assert.equal(await getGnosisSafeSessionCompatibilityMode(), false)
	assert.deepEqual(modeWrites, [true, false])
	assert.equal(modeEvents, 2, 'genuine revocation still emits its context invalidation')
})

test('closed, opaque and credential-bearing sources fail before changing settings or opening a tab', async () => {
	for (const sourceUrl of [undefined, 'file:///app', 'chrome-extension://other-extension/page.html', 'https://user:password@app.example/']) {
		const { readStoredValue } = installBrowserMock()
		Object.assign(browser.runtime, { getURL: (file: string) => new URL(file, 'chrome-extension://test-extension/').href })
		const source = spyOn(browser.tabs, 'get').mockResolvedValue({ id: 23, active: true, url: sourceUrl })
		const create = spyOn(browser.tabs, 'create')
		try {
			const reply = await openNativeGnosisSafeApp(23)
			assert.equal(reply.ok, false, String(sourceUrl))
			assert.equal(readStoredValue('safeAppsCompatibilityMode'), undefined)
			assert.equal(create.mock.calls.length, 0)
		} finally { source.mockRestore(); create.mockRestore() }
	}
	installBrowserMock()
	const source = spyOn(browser.tabs, 'get').mockRejectedValue(new Error('No tab with id: 23'))
	try { assert.equal((await openNativeGnosisSafeApp(23)).ok, false) } finally { source.mockRestore() }
})

test('unexpected source lookups and failed settings writes propagate without creating a host tab', async () => {
	for (const failure of ['source', 'settings']) {
		installBrowserMock()
		Object.assign(browser.runtime, { getURL: (file: string) => new URL(file, 'chrome-extension://test-extension/').href })
		const source = spyOn(browser.tabs, 'get').mockResolvedValue({ id: 23, active: true, url: 'https://app.example/' })
		const write = spyOn(browser.storage.local, 'set')
		const create = spyOn(browser.tabs, 'create')
		if (failure === 'source') source.mockRejectedValue(new Error('source lookup unavailable'))
		else write.mockRejectedValue(new Error('settings storage unavailable'))
		try {
			await assert.rejects(openNativeGnosisSafeApp(23), new RegExp(`${ failure } .*unavailable`))
			assert.equal(create.mock.calls.length, 0)
		} finally { source.mockRestore(); write.mockRestore(); create.mockRestore() }
	}
})

test('the Home launch action only sends the background command; source lifecycle observers remain independent', () => {
	const source = fs.readFileSync('app/ts/components/pages/Home.tsx', 'utf8')
	const module = ts.createSourceFile('Home.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
	let launch: ts.FunctionDeclaration | undefined
	const visit = (node: ts.Node) => {
		if (ts.isFunctionDeclaration(node) && node.name?.text === 'openGnosisSafeApp') launch = node
		ts.forEachChild(node, visit)
	}
	visit(module)
	assert.ok(launch)
	const action = launch.getText(module)
	assert.match(action, /sendPopupMessageWithReply\(\{ method: 'popup_openGnosisSafeApp'/u)
	assert.doesNotMatch(action, /browser\.tabs|browser\.runtime|nativeGnosisSafeAppsHostUrl|safeAppsCompatibilityMode|popup_ChangeSettings/u)
	for (const sourceTabId of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(PopupMessage.safeParse({ method: 'popup_openGnosisSafeApp', data: { sourceTabId } }).success, false)
})


test('launch and tab orchestration depend on the focused tab service instead of popup handlers', () => {
	for (const file of ['gnosisSafeAppsLaunch', 'extensionTabs']) {
		const source = fs.readFileSync(`app/ts/background/${ file }.ts`, 'utf8')
		const module = ts.createSourceFile(`${ file }.ts`, source, ts.ScriptTarget.Latest, true)
		const imports = module.statements.flatMap((statement) => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : [])
		assert.ok(!imports.includes('./popupMessageHandlers.js'), `${ file } must not depend on the popup handler aggregator`)
		assert.ok(!imports.includes('./backgroundUtils.js'), `${ file } uses focused URL helpers directly`)
		if (file === 'gnosisSafeAppsLaunch') assert.ok(imports.includes('./extensionTabs.js'))
	}
})
