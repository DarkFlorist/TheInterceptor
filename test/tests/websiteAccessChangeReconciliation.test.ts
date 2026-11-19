import * as websiteAccessUpdating from '../../app/ts/background/websiteAccessUpdating.js'
import * as assert from 'assert'
import { afterEach, describe, mock, spyOn, test } from 'bun:test'
import * as errors from '../../app/ts/utils/errors.js'
import { reconcileContentScriptRegistration } from '../../app/ts/background/contentScriptRegistration.js'
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
	await reconcileContentScriptRegistration()
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
		// Denying access without touching the Interceptor setting leaves the disabled sites as they were, so neither the content script update nor the reload runs.
		denyAccessInAccessEditor: async () => await withSilencedConsole(async () => await modules.changeInterceptorAccess(simulationServicesOwner, websiteTabConnections, {
			method: 'popup_changeInterceptorAccess',
			data: [{ removed: false, oldEntry: websiteAccessEntry, newEntry: { ...websiteAccessEntry, access: false } }],
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
		blockExternalRequests: async () => await withSilencedConsole(async () => await modules.blockOrAllowExternalRequests(simulationServicesOwner, websiteTabConnections, {
			method: 'popup_blockOrAllowExternalRequests',
			data: { website, shouldBlock: true },
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

const mockContentScriptInjectionUpdate = (contentScriptUpdateError?: Error) => spyOn(browser.scripting, 'updateContentScripts').mockImplementation(async () => {
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

		await assert.rejects(handlers.removeWebsiteAddressAccess(), /current tab lookup failed/u)

		assert.deepEqual((await modules.getSettings()).websiteAccess[0]?.addressAccess, [])
		assertConnectionDeApproved()
		const latestUnexpectedError = await modules.getLatestUnexpectedError()
		assert.equal(latestUnexpectedError, undefined)
		assert.deepEqual(reloadedTabIds, connectedTabIds)
		assert.equal(sentPopupMessageMethods().includes('popup_websiteAccess_changed'), false)
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
			assert.ok('failures' in error)
			assert.deepEqual(error.failures, [{ code: 'website_access_connected_tabs_reload_failed', error: reloadStepError }, { code: 'website_access_approval_reconciliation_failed', error: reconcileError }])
			return true
		})
	})
})

describe('website access registration and reconciliation', () => {
	test('registers and reloads before reconciling and notifying the popup', async () => {
		const { handlers, sentPopupMessageMethods, sideEffectOrder } = await setUpApprovedConnectionAndOtherTab()
		spyOn(browser.scripting, 'updateContentScripts').mockImplementation(async () => { sideEffectOrder.push('content script update') })
		spyOn(browser.tabs, 'reload').mockImplementation(async (tabId) => { sideEffectOrder.push(`reload tab ${ String(tabId) }`) })
		const accessManagement = await importAccessManagement()
		const reconcileApprovals = accessManagement.updateWebsiteApprovalAccesses
		spyOn(accessManagement, 'updateWebsiteApprovalAccesses').mockImplementation(async (...args) => {
			sideEffectOrder.push('reconcile')
			return await reconcileApprovals(...args)
		})

		await handlers.denyAccessAndDisableInterceptorInAccessEditor()

		assert.deepEqual(sideEffectOrder, ['content script update', 'reload tab 1', 'reload tab 3', 'reconcile', 'port accountsChanged', 'port disconnect'])
		assert.equal(sentPopupMessageMethods().at(-1), 'popup_interceptor_access_changed')
	})

	test('uses the injection layer reload decision without predicting which settings require it', async () => {
		const { handlers, connectedTabIds, reloadedTabIds } = await setUpApprovedConnectionAndOtherTab()
		spyOn(websiteAccessUpdating, 'tryUpdateWebsiteAccessAndContentScriptInjectionStrategy').mockImplementation(async (connections, update) => {
			const { updateWebsiteAccess } = await import('../../app/ts/background/settings.js')
			await updateWebsiteAccess(update)
			for (const tabId of connections.keys()) await browser.tabs.reload(tabId)
			return { status: 'completed', reload: 'handled', storage: 'written' }
		})
		// This mutation changes no disabled sites. The coordinator still honors the injection owner's decision to reload.
		await handlers.blockExternalRequests()
		assert.deepEqual(reloadedTabIds, connectedTabIds)
	})

	test('does not run follow-ups when the initial storage write fails', async () => {
		const { reloadedTabIds, handlers, assertConnectionStillApproved } = await setUpApprovedConnectionAndOtherTab()
		const registration = mockContentScriptInjectionUpdate()
		const reconcile = spyOn(await importAccessManagement(), 'updateWebsiteApprovalAccesses')
		const writeError = new Error('storage write failed')
		spyOn(browser.storage.local, 'set').mockImplementation(async () => { throw writeError })

		await assert.rejects(handlers.denyAccessAndDisableInterceptorInAccessEditor(), (error) => error === writeError)

		assert.equal(registration.mock.calls.length, 0)
		assert.deepEqual(reloadedTabIds, [])
		assert.equal(reconcile.mock.calls.length, 0)
		assertConnectionStillApproved()
	})

	test('keeps saved permissions and reconciles approvals when registration fails', async () => {
		const { modules, reloadedTabIds, handlers, assertConnectionDeApproved } = await setUpApprovedConnectionAndOtherTab()
		const registrationError = new Error('registration failed')
		mockContentScriptInjectionUpdate(registrationError)
		const reconcile = spyOn(await importAccessManagement(), 'updateWebsiteApprovalAccesses')

		await assert.rejects(handlers.denyAccessAndDisableInterceptorInAccessEditor(), (error) => error === registrationError)

		assert.equal((await modules.getSettings()).websiteAccess[0]?.access, false)
		assert.equal((await modules.getSettings()).websiteAccess[0]?.interceptorDisabled, true)
		assert.deepEqual(reloadedTabIds, [])
		assert.equal(reconcile.mock.calls.length, 1)
		assertConnectionDeApproved()
	})

	test('preserves registration and reconciliation failures together', async () => {
		const { handlers } = await setUpApprovedConnectionAndOtherTab()
		const registrationError = new Error('registration failed')
		const reconciliationError = new Error('reconciliation failed')
		mockContentScriptInjectionUpdate(registrationError)
		await makeReconciliationReject(reconciliationError)
		await assert.rejects(handlers.denyAccessAndDisableInterceptorInAccessEditor(), (error) => {
			assert.ok(error instanceof AggregateError)
			assert.deepEqual(error.errors, [registrationError, reconciliationError])
			return true
		})
	})

	for (const { handler, interceptorDisabled, updatesContentScripts, reloadsTabs } of [
		{ handler: 'removeWebsiteAccess', interceptorDisabled: false, updatesContentScripts: false, reloadsTabs: false },
		{ handler: 'removeWebsiteAccess', interceptorDisabled: true, updatesContentScripts: true, reloadsTabs: true },
		{ handler: 'denyAccessInAccessEditor', interceptorDisabled: false, updatesContentScripts: false, reloadsTabs: false },
		{ handler: 'denyAccessAndDisableInterceptorInAccessEditor', interceptorDisabled: false, updatesContentScripts: true, reloadsTabs: true },
		{ handler: 'disableInterceptor', interceptorDisabled: false, updatesContentScripts: true, reloadsTabs: true },
		{ handler: 'disableInterceptor', interceptorDisabled: true, updatesContentScripts: false, reloadsTabs: true },
		{ handler: 'removeWebsiteAddressAccess', interceptorDisabled: true, updatesContentScripts: false, reloadsTabs: true },
		{ handler: 'blockExternalRequests', interceptorDisabled: true, updatesContentScripts: false, reloadsTabs: true },
	] as const) {
		test(`${ handler } (disabled: ${ interceptorDisabled }) refreshes registration if needed and reconciles once`, async () => {
			const { reloadedTabIds, connectedTabIds, handlers } = await setUpApprovedConnectionAndOtherTab({ interceptorDisabled })
			const registration = mockContentScriptInjectionUpdate()
			const reconcile = spyOn(await importAccessManagement(), 'updateWebsiteApprovalAccesses')

			await handlers[handler]()

			assert.equal(registration.mock.calls.length, updatesContentScripts ? 1 : 0)
			assert.deepEqual(reloadedTabIds, reloadsTabs ? connectedTabIds : [])
			assert.equal(reconcile.mock.calls.length, 1)
		})
	}
})
