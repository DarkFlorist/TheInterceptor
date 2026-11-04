import * as assert from 'assert'
import { afterEach, describe, mock, spyOn, test } from 'bun:test'
import * as errors from '../../app/ts/utils/errors.js'
import * as contentScriptsUpdating from '../../app/ts/utils/contentScriptsUpdating.js'
import { confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules } from './backgroundEthAccountsTestHarness.js'
import { withSilencedConsole } from './consoleSilence.js'

type SetUpOptions = { readonly browserMockOptions?: Parameters<typeof installBrowserMock>[0], readonly interceptorDisabled?: boolean }

async function setUpApprovedConnectionAndOtherTab({ browserMockOptions = {}, interceptorDisabled = false }: SetUpOptions = {}) {
	const { reloadedTabIds, runtimeMessages } = installBrowserMock(browserMockOptions)
	const modules = await loadModules()
	const websiteOrigin = 'https://example.test'
	const website = { websiteOrigin, icon: undefined, title: undefined }
	const account = 0x7171717171717171717171717171717171717171n
	await modules.changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
	await modules.setUseSignersAddressAsActiveAddress(false)
	const websiteAccessEntry = { website, access: true, addressAccess: [{ address: account, access: true }], interceptorDisabled }
	await modules.updateWebsiteAccess(() => [websiteAccessEntry])
	const approvedSocket = { tabId: 1, connectionName: 0n }
	const otherSocket = { tabId: 3, connectionName: 0n }
	await modules.updateTabState(approvedSocket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
	// Records the side effects of each step in the order they happen, for tests that check the step order.
	const sideEffectOrder: string[] = []
	const { port: approvedPort, messages } = createPort(approvedSocket.tabId, (message) => { sideEffectOrder.push(`port ${ String(message.method) }`) })
	const { port: otherPort } = createPort(otherSocket.tabId)
	const approvedConnectionKey = modules.websiteSocketToString(approvedSocket)
	const websiteTabConnections = new Map([
		[approvedSocket.tabId, { ...confirmedSignerOwnership(approvedSocket), connections: {
			[approvedConnectionKey]: { port: approvedPort, socket: approvedSocket, websiteOrigin, approved: true, wantsToConnect: true },
		} }],
		[otherSocket.tabId, { ...confirmedSignerOwnership(otherSocket), connections: {
			[modules.websiteSocketToString(otherSocket)]: { port: otherPort, socket: otherSocket, websiteOrigin: 'https://other.test', approved: false, wantsToConnect: false },
		} }],
	])
	const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
	const handlers = {
		removeWebsiteAddressAccess: async () => await withSilencedConsole(async () => await modules.removeWebsiteAddressAccess(simulationServicesOwner, websiteTabConnections, {
			method: 'popup_removeWebsiteAddressAccess',
			data: { websiteOrigin, address: account },
		})),
		removeWebsiteAccess: async () => await withSilencedConsole(async () => await modules.removeWebsiteAccess(simulationServicesOwner, websiteTabConnections, {
			method: 'popup_removeWebsiteAccess',
			data: { websiteOrigin },
		})),
		// Denying access and disabling the Interceptor in one edit changes the disabled sites, so the content script update and the reload both run.
		denyAccessAndDisableInterceptorInAccessEditor: async () => await withSilencedConsole(async () => await modules.changeInterceptorAccess(simulationServicesOwner, websiteTabConnections, {
			method: 'popup_changeInterceptorAccess',
			data: [{ removed: false, oldEntry: websiteAccessEntry, newEntry: { ...websiteAccessEntry, access: false, interceptorDisabled: true } }],
		})),
		disableInterceptor: async () => await withSilencedConsole(async () => await modules.disableInterceptor(simulationServicesOwner, websiteTabConnections, {
			method: 'popup_setDisableInterceptor',
			data: { website, interceptorDisabled: true },
		})),
	}
	const assertConnectionStillApproved = () => {
		assert.equal(websiteTabConnections.get(approvedSocket.tabId)?.connections[approvedConnectionKey]?.approved, true)
		assert.equal(messages.some((message) => message.method === 'accountsChanged' || message.method === 'disconnect'), false)
	}
	const assertConnectionDeApproved = () => {
		assert.equal(websiteTabConnections.get(approvedSocket.tabId)?.connections[approvedConnectionKey]?.approved, false)
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').at(-1)?.result, [])
		assert.equal(messages.some((message) => message.method === 'disconnect'), true)
	}
	const sentPopupMessageMethods = () => runtimeMessages.flatMap((message) => typeof message === 'object' && message !== null && 'method' in message ? [message.method] : [])
	return { modules, reloadedTabIds, connectedTabIds: [approvedSocket.tabId, otherSocket.tabId], handlers, assertConnectionDeApproved, assertConnectionStillApproved, sentPopupMessageMethods, sideEffectOrder }
}

// Reporting the per-tab reload failure throws, so the rejection escapes reloadConnectedTabs.
function makeReloadStepReject(reloadStepError: Error) {
	spyOn(browser.tabs, 'reload').mockImplementation(async () => { throw new Error('reload failed') })
	spyOn(errors, 'reportUnexpectedError').mockImplementationOnce(async () => { throw reloadStepError })
}

const mockContentScriptInjectionUpdate = (contentScriptUpdateError?: Error) => spyOn(contentScriptsUpdating, 'updateContentScriptInjectionStrategy').mockImplementation(async () => {
	if (contentScriptUpdateError !== undefined) throw contentScriptUpdateError
})

// Imported only after the harness installs the browser mock, which the background modules need when they load.
const importAccessManagement = async () => await import('../../app/ts/background/accessManagement.js')

const makeReconciliationReject = async (reconcileError: Error) => {
	const accessManagement = await importAccessManagement()
	spyOn(accessManagement, 'updateWebsiteApprovalAccesses').mockImplementationOnce(async () => { throw reconcileError })
}

afterEach(() => {
	mock.restore()
})

describe('removeWebsiteAddressAccess', () => {
	test('de-approves the connection and reloads connected tabs when the current tab lookup fails', async () => {
		const { modules, reloadedTabIds, connectedTabIds, handlers, assertConnectionDeApproved, sentPopupMessageMethods } = await setUpApprovedConnectionAndOtherTab({ browserMockOptions: { firstCurrentTabIdReadError: new Error('current tab lookup failed') } })

		await handlers.removeWebsiteAddressAccess()

		assert.deepEqual((await modules.getSettings()).websiteAccess[0]?.addressAccess, [])
		assertConnectionDeApproved()
		const latestUnexpectedError = await modules.getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, 'current tab lookup failed')
		assert.equal(latestUnexpectedError?.data.code, 'connected_tab_reload_current_tab_lookup_failed')
		assert.deepEqual(reloadedTabIds, connectedTabIds)
		assert.equal(sentPopupMessageMethods().includes('popup_websiteAccess_changed'), true)
	})

	test('still de-approves the connection and rethrows without notifying the popup when the reload step rejects', async () => {
		const { modules, handlers, assertConnectionDeApproved, sentPopupMessageMethods } = await setUpApprovedConnectionAndOtherTab()
		const reloadStepError = new Error('reload failure report failed')
		makeReloadStepReject(reloadStepError)

		await assert.rejects(handlers.removeWebsiteAddressAccess(), (error) => error === reloadStepError)

		assert.deepEqual((await modules.getSettings()).websiteAccess[0]?.addressAccess, [])
		assertConnectionDeApproved()
		assert.equal(sentPopupMessageMethods().includes('popup_websiteAccess_changed'), false)
	})

	test('rejects with both errors, reload first, when the reload step and reconciliation both reject', async () => {
		const { handlers } = await setUpApprovedConnectionAndOtherTab()
		const reloadStepError = new Error('reload failure report failed')
		const reconcileError = new Error('reconciliation failed')
		makeReloadStepReject(reloadStepError)
		await makeReconciliationReject(reconcileError)

		await assert.rejects(handlers.removeWebsiteAddressAccess(), (error) => {
			assert.ok(error instanceof AggregateError)
			assert.deepEqual(error.errors, [reloadStepError, reconcileError])
			assert.equal(error.message, 'Reloading connected tabs failed (reload failure report failed) and reconciling website approvals failed (reconciliation failed)')
			return true
		})
	})
})

describe('removeWebsiteAccess', () => {
	test('still de-approves the connection and rethrows without notifying the popup when the content script injection update rejects', async () => {
		const { modules, handlers, assertConnectionDeApproved, sentPopupMessageMethods } = await setUpApprovedConnectionAndOtherTab({ interceptorDisabled: true })
		const contentScriptUpdateError = new Error('content script update failed')
		const contentScriptInjectionUpdate = mockContentScriptInjectionUpdate(contentScriptUpdateError)

		await assert.rejects(handlers.removeWebsiteAccess(), (error) => error === contentScriptUpdateError)

		assert.equal(contentScriptInjectionUpdate.mock.calls.length, 1)
		assert.deepEqual((await modules.getSettings()).websiteAccess, [])
		assertConnectionDeApproved()
		assert.equal(sentPopupMessageMethods().includes('popup_websiteAccess_changed'), false)
	})
})

describe('changeInterceptorAccess', () => {
	test('updates the content scripts, then reloads the connected tabs, then reconciles, then notifies the popup', async () => {
		const { handlers, sentPopupMessageMethods, sideEffectOrder } = await setUpApprovedConnectionAndOtherTab()
		spyOn(contentScriptsUpdating, 'updateContentScriptInjectionStrategy').mockImplementation(async () => { sideEffectOrder.push('content script update') })
		spyOn(browser.tabs, 'reload').mockImplementation(async (tabId) => { sideEffectOrder.push(`reload tab ${ String(tabId) }`) })
		const accessManagement = await importAccessManagement()
		const reconcileApprovals = accessManagement.updateWebsiteApprovalAccesses
		spyOn(accessManagement, 'updateWebsiteApprovalAccesses').mockImplementation(async (...reconcileArguments) => {
			sideEffectOrder.push('reconcile')
			return await reconcileApprovals(...reconcileArguments)
		})

		await handlers.denyAccessAndDisableInterceptorInAccessEditor()

		assert.deepEqual(sideEffectOrder, ['content script update', 'reload tab 1', 'reload tab 3', 'reconcile', 'port accountsChanged', 'port disconnect'])
		assert.equal(sentPopupMessageMethods().at(-1), 'popup_interceptor_access_changed')
	})

	test('throws without updating the content scripts, reloading tabs, reconciling or notifying the popup when the website access write rejects', async () => {
		const { modules, reloadedTabIds, handlers, assertConnectionStillApproved, sentPopupMessageMethods } = await setUpApprovedConnectionAndOtherTab()
		const contentScriptInjectionUpdate = mockContentScriptInjectionUpdate()
		const reconcile = spyOn(await importAccessManagement(), 'updateWebsiteApprovalAccesses')
		const writeError = new Error('storage write failed')
		spyOn(browser.storage.local, 'set').mockImplementation(async () => { throw writeError })

		await assert.rejects(handlers.denyAccessAndDisableInterceptorInAccessEditor(), (error) => error === writeError)

		assert.equal((await modules.getSettings()).websiteAccess[0]?.access, true)
		assert.equal(contentScriptInjectionUpdate.mock.calls.length, 0)
		assert.deepEqual(reloadedTabIds, [])
		assert.equal(reconcile.mock.calls.length, 0)
		assertConnectionStillApproved()
		assert.equal(sentPopupMessageMethods().includes('popup_interceptor_access_changed'), false)
	})

	test('still de-approves the connection and rethrows without notifying the popup when the reload step rejects', async () => {
		const { handlers, assertConnectionDeApproved, sentPopupMessageMethods } = await setUpApprovedConnectionAndOtherTab()
		const contentScriptInjectionUpdate = mockContentScriptInjectionUpdate()
		const reloadStepError = new Error('reload failure report failed')
		makeReloadStepReject(reloadStepError)

		await assert.rejects(handlers.denyAccessAndDisableInterceptorInAccessEditor(), (error) => error === reloadStepError)

		assert.equal(contentScriptInjectionUpdate.mock.calls.length, 1)
		assertConnectionDeApproved()
		assert.equal(sentPopupMessageMethods().includes('popup_interceptor_access_changed'), false)
	})

	test('still attempts the reload and de-approves the connection, then rejects with both errors in step order, when the content script update and the reload step reject', async () => {
		const { handlers, assertConnectionDeApproved } = await setUpApprovedConnectionAndOtherTab()
		const contentScriptUpdateError = new Error('content script update failed')
		const reloadStepError = new Error('reload failure report failed')
		mockContentScriptInjectionUpdate(contentScriptUpdateError)
		makeReloadStepReject(reloadStepError)

		await assert.rejects(handlers.denyAccessAndDisableInterceptorInAccessEditor(), (error) => {
			assert.ok(error instanceof AggregateError)
			assert.deepEqual(error.errors, [contentScriptUpdateError, reloadStepError])
			assert.equal(error.message, 'Updating the content script injection failed (content script update failed) and reloading connected tabs failed (reload failure report failed)')
			return true
		})

		assertConnectionDeApproved()
	})

	test('names every failure in step order when the content script update, the reload step and reconciliation all reject', async () => {
		const { handlers } = await setUpApprovedConnectionAndOtherTab()
		const contentScriptUpdateError = new Error('content script update failed')
		const reloadStepError = new Error('reload failure report failed')
		const reconcileError = new Error('reconciliation failed')
		mockContentScriptInjectionUpdate(contentScriptUpdateError)
		makeReloadStepReject(reloadStepError)
		await makeReconciliationReject(reconcileError)

		await assert.rejects(handlers.denyAccessAndDisableInterceptorInAccessEditor(), (error) => {
			assert.ok(error instanceof AggregateError)
			assert.deepEqual(error.errors, [contentScriptUpdateError, reloadStepError, reconcileError])
			assert.equal(error.message, 'Updating the content script injection failed (content script update failed), reloading connected tabs failed (reload failure report failed), and reconciling website approvals failed (reconciliation failed)')
			return true
		})
	})
})

describe('disableInterceptor', () => {
	test('still reloads connected tabs, de-approves the connection and rethrows when the content script injection update rejects', async () => {
		const { modules, reloadedTabIds, connectedTabIds, handlers, assertConnectionDeApproved } = await setUpApprovedConnectionAndOtherTab()
		const contentScriptUpdateError = new Error('content script update failed')
		mockContentScriptInjectionUpdate(contentScriptUpdateError)

		await assert.rejects(handlers.disableInterceptor(), (error) => error === contentScriptUpdateError)

		assert.equal((await modules.getSettings()).websiteAccess[0]?.interceptorDisabled, true)
		assert.deepEqual(reloadedTabIds, connectedTabIds)
		assertConnectionDeApproved()
	})
})
