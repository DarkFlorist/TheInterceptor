import * as assert from 'assert'
import { describe, spyOn, test } from 'bun:test'
import * as errors from '../../app/ts/utils/errors.js'
import { confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules } from './backgroundEthAccountsTestHarness.js'
import { withSilencedConsole } from './consoleSilence.js'

async function setUpApprovedConnectionAndOtherTab(browserMockOptions: Parameters<typeof installBrowserMock>[0]) {
	const { reloadedTabIds } = installBrowserMock(browserMockOptions)
	const modules = await loadModules()
	const websiteOrigin = 'https://example.test'
	const website = { websiteOrigin, icon: undefined, title: undefined }
	const account = 0x7171717171717171717171717171717171717171n
	await modules.changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
	await modules.setUseSignersAddressAsActiveAddress(false)
	await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])
	const approvedSocket = { tabId: 1, connectionName: 0n }
	const otherSocket = { tabId: 3, connectionName: 0n }
	await modules.updateTabState(approvedSocket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
	const { port: approvedPort, messages } = createPort(approvedSocket.tabId)
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
	const removeAddressAccess = async () => await withSilencedConsole(async () => await modules.removeWebsiteAddressAccess(simulationServicesOwner, websiteTabConnections, {
		method: 'popup_removeWebsiteAddressAccess',
		data: { websiteOrigin, address: account },
	}))
	const assertConnectionDeApproved = async () => {
		assert.deepEqual((await modules.getSettings()).websiteAccess[0]?.addressAccess, [])
		assert.equal(websiteTabConnections.get(approvedSocket.tabId)?.connections[approvedConnectionKey]?.approved, false)
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').at(-1)?.result, [])
		assert.equal(messages.some((message) => message.method === 'disconnect'), true)
	}
	return { modules, reloadedTabIds, connectedTabIds: [approvedSocket.tabId, otherSocket.tabId], removeAddressAccess, assertConnectionDeApproved }
}

// Reporting the per-tab reload failure throws, so the rejection escapes reloadConnectedTabs.
function makeReloadStepReject(reloadStepError: Error) {
	spyOn(browser.tabs, 'reload').mockImplementation(async () => { throw new Error('reload failed') })
	return spyOn(errors, 'reportUnexpectedError').mockImplementationOnce(async () => { throw reloadStepError })
}

describe('removeWebsiteAddressAccess', () => {
	test('de-approves the connection and reloads connected tabs when the current tab lookup fails', async () => {
		const { modules, reloadedTabIds, connectedTabIds, removeAddressAccess, assertConnectionDeApproved } = await setUpApprovedConnectionAndOtherTab({ firstCurrentTabIdReadError: new Error('current tab lookup failed') })

		await removeAddressAccess()

		await assertConnectionDeApproved()
		const latestUnexpectedError = await modules.getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, 'current tab lookup failed')
		assert.equal(latestUnexpectedError?.data.code, 'connected_tab_reload_current_tab_lookup_failed')
		assert.deepEqual(reloadedTabIds, connectedTabIds)
	})

	test('still de-approves the connection and rethrows when the reload step rejects', async () => {
		const { removeAddressAccess, assertConnectionDeApproved } = await setUpApprovedConnectionAndOtherTab({})
		const reloadStepError = new Error('reload failure report failed')
		const reportUnexpectedError = makeReloadStepReject(reloadStepError)
		try {
			await assert.rejects(removeAddressAccess(), (error) => error === reloadStepError)
		} finally {
			reportUnexpectedError.mockRestore()
		}

		await assertConnectionDeApproved()
	})

	test('rejects with both errors, reload first, when the reload step and reconciliation both reject', async () => {
		const { removeAddressAccess } = await setUpApprovedConnectionAndOtherTab({})
		const reloadStepError = new Error('reload failure report failed')
		const reconcileError = new Error('reconciliation failed')
		const reportUnexpectedError = makeReloadStepReject(reloadStepError)
		const accessManagement = await import('../../app/ts/background/accessManagement.js')
		const updateWebsiteApprovalAccesses = spyOn(accessManagement, 'updateWebsiteApprovalAccesses').mockImplementationOnce(async () => { throw reconcileError })
		try {
			await assert.rejects(removeAddressAccess(), (error) => {
				assert.ok(error instanceof AggregateError)
				assert.deepEqual(error.errors, [reloadStepError, reconcileError])
				return true
			})
		} finally {
			reportUnexpectedError.mockRestore()
			updateWebsiteApprovalAccesses.mockRestore()
		}
	})
})
