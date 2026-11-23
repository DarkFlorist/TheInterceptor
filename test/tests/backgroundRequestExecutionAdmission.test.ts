import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { InterceptedRequest } from '../../app/ts/utils/requests.js'
import { settleWithin } from '../harness/async.js'
import { addressString, confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, createRestoringBrowserMockInstaller, createTestSimulationServicesOwner, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'

const installBrowserForTest = createRestoringBrowserMockInstaller()

// Pause a read after the access decision and service capture, without delaying the initial address lookup.
async function createAdmissionScenario(method: string, pauseKey = 'userAddressBookEntriesV3') {
	const browserMock = installBrowserForTest()
	const modules = await loadModules()
	const account = 1n
	const website = { websiteOrigin: 'https://execution-admission.example', icon: undefined, title: undefined }
	await modules.setUseSignersAddressAsActiveAddress(false)
	await modules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: account })
	await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])
	const socket = { tabId: 1, connectionName: 0n }
	const { port, messages } = createPort(1)
	const connections = new Map([[1, { ...confirmedSignerOwnership(socket), connections: {
		[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: website.websiteOrigin, approved: true, wantsToConnect: true },
	} }]])
	let originalReads = 0
	let installedReads = 0
	const original = createEthereumWithGetBlockCounter({ count: 0 }, { getChainId: () => { originalReads++; return 1n } })
	const installed = createEthereumWithGetBlockCounter({ count: 0 }, { getChainId: () => { installedReads++; return 2n } })
	const owner = createTestSimulationServicesOwner(original, () => installed)
	let servicesCaptured = false
	const requestOwner = { getCurrent: () => { servicesCaptured = true; return owner.getCurrent() }, reset: owner.reset }
	const paused = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	let didPause = false
	const read = browserMock.browser.storage.local.get
	browserMock.browser.storage.local.get = async (keys) => {
		if (servicesCaptured && !didPause && (keys === pauseKey || Array.isArray(keys) && keys.includes(pauseKey))) {
			didPause = true
			paused.resolve()
			await release.promise
		}
		return await read(keys)
	}
	const request: InterceptedRequest = {
		interceptorRequest: true, usingInterceptorWithoutSigner: true,
		...(method === 'safe_apps_request' ? { interceptorInternalRequest: true as const } : {}),
		uniqueRequestIdentifier: { requestId: 900, requestSocket: socket }, method, params: [],
	}
	const execution = modules.handleInterceptedRequest(port, website.websiteOrigin, website, requestOwner, socket, request, connections, noopPublishRpcConnectionStatus)
	await settleWithin(paused.promise, 1000, 'Request did not reach asynchronous preparation')
	return {
		modules, account, website, owner, installed, messages, connections,
		reads: () => ({ original: originalReads, installed: installedReads }),
		finish: async () => { release.resolve(); await settleWithin(execution, 1000, 'Request admission did not finish') },
	}
}

describe('request execution admission', () => {
	test('redecides after a network and service switch during preparation', async () => {
		const scenario = await createAdmissionScenario('eth_chainId')
		try {
			const settings = await scenario.modules.getSettings()
			await scenario.modules.changeSimulationMode({ simulationMode: true, rpcNetwork: { ...settings.activeRpcNetwork, chainId: 2n } })
			scenario.owner.reset(scenario.installed.ethereum.getRpcEntry())
		} finally { await scenario.finish() }
		assert.deepEqual(scenario.reads(), { original: 0, installed: 1 })
		assert.equal(scenario.messages.find(message => message.requestId === 900)?.result, '0x2')
	})

	test('answers public chain ID from settings without execution after access is revoked', async () => {
		const scenario = await createAdmissionScenario('eth_chainId')
		try {
			await scenario.modules.updateWebsiteAccess(() => [{ website: scenario.website, access: false, addressAccess: [] }])
			await scenario.modules.syncWebsiteApprovalsWithSettings(scenario.connections, { promptForAccessesIfNeeded: false, throwOnError: true })
		}
		finally { await scenario.finish() }
		assert.deepEqual(scenario.reads(), { original: 0, installed: 0 })
		// The public no-access chain-ID response comes from settings, without invoking either client.
		assert.equal(scenario.messages.find(message => message.requestId === 900)?.result, '0x1')
	})

	test('returns the newly selected address after an address switch during preparation', async () => {
		const scenario = await createAdmissionScenario('eth_accounts')
		const newAddress = 2n
		try {
			await scenario.modules.updateWebsiteAccess(() => [{ website: scenario.website, access: true, addressAccess: [{ address: scenario.account, access: true }, { address: newAddress, access: true }] }])
			await scenario.modules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: newAddress })
		} finally { await scenario.finish() }
		assert.deepEqual(scenario.messages.find(message => message.requestId === 900)?.result, [addressString(newAddress)])
	})

	test('redecides a prepared Safe Apps reply if access was revoked while preparation awaited', async () => {
		const scenario = await createAdmissionScenario('safe_apps_request', 'safeAppsCompatibilityMode')
		try {
			await scenario.modules.updateWebsiteAccess(() => [{ website: scenario.website, access: false, addressAccess: [] }])
			await scenario.modules.syncWebsiteApprovalsWithSettings(scenario.connections, { promptForAccessesIfNeeded: false, throwOnError: true })
		}
		finally { await scenario.finish() }
		assert.equal(scenario.messages.find(message => message.requestId === 900)?.error?.code, 4100)
	})
})
