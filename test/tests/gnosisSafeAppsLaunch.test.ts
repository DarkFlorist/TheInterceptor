import * as assert from 'node:assert'
import * as fs from 'node:fs'
import { spyOn, test } from 'bun:test'
import ts from 'typescript'
import { installBrowserMock, createEthereumWithGetBlockCounter, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'
import { openNativeGnosisSafeApp } from '../../app/ts/background/gnosisSafeAppsLaunch.js'
import { PopupMessage } from '../../app/ts/types/interceptor-messages.js'
import { getPopupMessageDomain, requiresExtensionPageSender } from '../../app/ts/types/popupMessageProtocol.js'
import { getGnosisSafeAppsCompatibilityMode, getSettings, setGnosisSafeAppsCompatibilityMode } from '../../app/ts/background/settings.js'
import { dispatchPopupMessage } from '../../app/ts/background/popupMessageDispatcher.js'

for (const manifestVersion of [2, 3] as const) test(`the background replaces the current tab with the MV${ manifestVersion } host without keeping a website source`, async () => {
	const { readStoredValue, setStorageHooks } = installBrowserMock({ manifestVersion })
	const modeWrites: boolean[] = []
	setStorageHooks({ beforeSet: async (items) => { if (typeof items.safeAppsCompatibilityMode === 'boolean') modeWrites.push(items.safeAppsCompatibilityMode) } })
	const root = `${ manifestVersion === 2 ? 'moz-extension' : 'chrome-extension' }://test-extension/`
	Object.assign(browser.runtime, { getURL: (file: string) => new URL(file, root).href })
	const sourceUrl = 'https://app.example/current?view=swap#route'
	const source = spyOn(browser.tabs, 'get').mockResolvedValue({ id: 23, active: true, url: sourceUrl })
	const create = spyOn(browser.tabs, 'create')
	const update = spyOn(browser.tabs, 'update').mockImplementation(async (tabId, details) => {
		assert.equal(readStoredValue('safeAppsCompatibilityMode'), true, 'enable compatibility before navigating')
		assert.equal(tabId, 23, 'replace the selected website tab itself')
		return { id: tabId, active: true, url: details.url }
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
		assert.equal(create.mock.calls.length, 0, 'launch must not create a companion tab')
		assert.equal(update.mock.calls.length, 1)
		const host = new URL(update.mock.calls[0]?.[1].url ?? '', root)
		assert.equal(host.pathname, manifestVersion === 2 ? '/html/gnosisSafeAppsHost.html' : '/html3/gnosisSafeAppsHostV3.html')
		assert.equal(host.searchParams.get('hostTabId'), '23')
		assert.equal(host.searchParams.get('sourceTabId'), null, 'the launch contains no original website tab dependency')
		assert.equal(host.searchParams.get('appUrl'), sourceUrl)
		assert.equal((await openNativeGnosisSafeApp(23)).ok, true)
		assert.deepEqual(modeWrites, [true], 'relaunching an enabled mode must not invalidate existing sessions with a same-value write')
		assert.equal(create.mock.calls.length, 0)
		assert.equal(update.mock.calls.length, 2)
	} finally { source.mockRestore(); create.mockRestore(); update.mockRestore() }
})

test('the compatibility setter emits storage changes only for actual mode transitions', async () => {
	const { setStorageHooks } = installBrowserMock()
	const modeWrites: boolean[] = []
	let modeEvents = 0
	setStorageHooks({ beforeSet: async (items) => { if (typeof items.safeAppsCompatibilityMode === 'boolean') modeWrites.push(items.safeAppsCompatibilityMode) } })
	browser.storage.onChanged.addListener((changes, area) => {
		if (area === 'local' && 'safeAppsCompatibilityMode' in changes) modeEvents++
	})
	await setGnosisSafeAppsCompatibilityMode(false)
	assert.deepEqual(modeWrites, [], 'the default false value needs no write')
	await setGnosisSafeAppsCompatibilityMode(true)
	await setGnosisSafeAppsCompatibilityMode(true)
	assert.equal(await getGnosisSafeAppsCompatibilityMode(), true)
	assert.deepEqual(modeWrites, [true])
	assert.equal(modeEvents, 1)
	await setGnosisSafeAppsCompatibilityMode(false)
	await setGnosisSafeAppsCompatibilityMode(false)
	assert.equal(await getGnosisSafeAppsCompatibilityMode(), false)
	assert.deepEqual(modeWrites, [true, false])
	assert.equal(modeEvents, 2, 'genuine revocation still emits its context invalidation')
})

test('closed, opaque and credential-bearing sources fail before changing settings or navigating a tab', async () => {
	for (const sourceUrl of [undefined, 'file:///app', 'chrome-extension://other-extension/page.html', 'https://user:password@app.example/']) {
		const { readStoredValue } = installBrowserMock()
		Object.assign(browser.runtime, { getURL: (file: string) => new URL(file, 'chrome-extension://test-extension/').href })
		const source = spyOn(browser.tabs, 'get').mockResolvedValue({ id: 23, active: true, url: sourceUrl })
		const create = spyOn(browser.tabs, 'create')
		const update = spyOn(browser.tabs, 'update')
		try {
			const reply = await openNativeGnosisSafeApp(23)
			assert.equal(reply.ok, false, String(sourceUrl))
			assert.equal(readStoredValue('safeAppsCompatibilityMode'), undefined)
			assert.equal(create.mock.calls.length, 0)
			assert.equal(update.mock.calls.length, 0)
		} finally { source.mockRestore(); create.mockRestore(); update.mockRestore() }
	}
	installBrowserMock()
	const source = spyOn(browser.tabs, 'get').mockRejectedValue(new Error('No tab with id: 23'))
	try { assert.equal((await openNativeGnosisSafeApp(23)).ok, false) } finally { source.mockRestore() }
})

test('unexpected source lookups and failed settings writes propagate without navigating the current tab', async () => {
	for (const failure of ['source', 'settings']) {
		installBrowserMock()
		Object.assign(browser.runtime, { getURL: (file: string) => new URL(file, 'chrome-extension://test-extension/').href })
		const source = spyOn(browser.tabs, 'get').mockResolvedValue({ id: 23, active: true, url: 'https://app.example/' })
		const write = spyOn(browser.storage.local, 'set')
		const create = spyOn(browser.tabs, 'create')
		const update = spyOn(browser.tabs, 'update')
		if (failure === 'source') source.mockRejectedValue(new Error('source lookup unavailable'))
		else write.mockRejectedValue(new Error('settings storage unavailable'))
		try {
			await assert.rejects(openNativeGnosisSafeApp(23), new RegExp(`${ failure } .*unavailable`))
			assert.equal(create.mock.calls.length, 0)
			assert.equal(update.mock.calls.length, 0)
		} finally { source.mockRestore(); write.mockRestore(); create.mockRestore(); update.mockRestore() }
	}
})

test('the Home launch action only sends the background command', () => {
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


test('same-tab launch stays separate from reusable tab orchestration and popup handler aggregation', () => {
	for (const file of ['gnosisSafeAppsLaunch', 'extensionTabs']) {
		const source = fs.readFileSync(`app/ts/background/${ file }.ts`, 'utf8')
		const module = ts.createSourceFile(`${ file }.ts`, source, ts.ScriptTarget.Latest, true)
		const imports = module.statements.flatMap((statement) => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : [])
		assert.ok(!imports.includes('./popupMessageHandlers.js'), `${ file } must not depend on the popup handler aggregator`)
		assert.ok(!imports.includes('./backgroundUtils.js'), `${ file } uses focused URL helpers directly`)
		if (file === 'gnosisSafeAppsLaunch') assert.ok(!imports.includes('./extensionTabs.js'), 'same-tab launch must not enter the reusable new-tab service')
	}
})
