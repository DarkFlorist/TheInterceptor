import * as assert from 'node:assert'
import { test } from 'bun:test'
import type { GnosisSafeEntry } from '../../app/ts/types/addressBookTypes.js'
import { confirmedSignerOwnership, createPort, createEthereumWithGetBlockCounter, installBrowserMock, loadModules } from './backgroundEthAccountsTestHarness.js'

test('discovery resolves a configured simulation account while admitted execution keeps and checks that account', async () => {
	installBrowserMock()
	const { changeSimulationMode, getSettings, updateUserAddressBookEntries, updateWebsiteAccess, websiteSocketToString } = await loadModules()
	const { isGnosisSafeAppsConnectionEligible, isGnosisSafeAppsConnectionEligibleForAdmittedAddress } = await import('../../app/ts/background/gnosisSafeAppsConnectionEligibility.js')
	const activeAddress = { type: 'safe', name: 'Simulated Gnosis Safe', address: 0x6868686868686868686868686868686868686868n, chainId: 1n, entrySource: 'User', useAsActiveAddress: true } as const
	const website = { websiteOrigin: 'simulation-safe.example', title: undefined, icon: undefined }
	await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress.address })
	await updateUserAddressBookEntries(() => [activeAddress])
	await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: activeAddress.address, access: true }] }])
	const socket = { tabId: 1, connectionName: 0n }
	const { port } = createPort(socket.tabId, undefined, 0)
	const connection = { port, socket, websiteOrigin: website.websiteOrigin, approved: true, wantsToConnect: true }
	const connections = new Map([[socket.tabId, { connections: { [websiteSocketToString(socket)]: connection } }]])
	const settings = await getSettings()
	assert.equal(await isGnosisSafeAppsConnectionEligible(connections, socket, settings), true)
	assert.equal(isGnosisSafeAppsConnectionEligibleForAdmittedAddress(connections, socket, settings, { activeAddress, safeSigningMode: false }), true)
	for (const changedAddress of [{ ...activeAddress, chainId: 10n }, { ...activeAddress, address: 1n }]) {
		assert.equal(isGnosisSafeAppsConnectionEligibleForAdmittedAddress(connections, socket, settings, { activeAddress: changedAddress, safeSigningMode: true }), false)
	}
	assert.equal(isGnosisSafeAppsConnectionEligibleForAdmittedAddress(connections, socket, { ...settings, simulationMode: false, activeSigningSafeAddress: activeAddress.address }, { activeAddress, safeSigningMode: false }), false)
	connection.approved = false
	assert.equal(await isGnosisSafeAppsConnectionEligible(connections, socket, settings), false)
	assert.equal(isGnosisSafeAppsConnectionEligibleForAdmittedAddress(connections, socket, settings, { activeAddress, safeSigningMode: true }), false)
})

for (const simulationMode of [true, false]) test(`admitted Gnosis Safe requests recheck address consent while connection approval is stale in ${ simulationMode ? 'simulation' : 'signing' } mode`, async () => {
	installBrowserMock()
	const modules = await loadModules()
	const { isGnosisSafeAppsConnectionEligibleForAdmittedAddress } = await import('../../app/ts/background/gnosisSafeAppsConnectionEligibility.js')
	const safeA = 0x6868686868686868686868686868686868686868n
	const safeB: GnosisSafeEntry = { type: 'safe', name: 'Newly selected Gnosis Safe', address: 0x6969696969696969696969696969696969696969n, chainId: 1n, entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: true }
	const website = { websiteOrigin: 'consent-transition.example', title: undefined, icon: undefined }
	const socket = { tabId: 1, connectionName: 0n }
	const { port } = createPort(socket.tabId, undefined, 0)
	const connection = { port, socket, websiteOrigin: website.websiteOrigin, approved: true, wantsToConnect: true }
	const connections = new Map([[socket.tabId, { connections: { [modules.websiteSocketToString(socket)]: connection } }]])
	const settings = { ...await modules.getSettings(), simulationMode, activeSimulationAddress: safeB.address, activeSigningSafeAddress: safeB.address, websiteAccess: [{ website, access: true, addressAccess: [{ address: safeA, access: true }] }] }
	const admitted = { activeAddress: safeB, safeSigningMode: !simulationMode }
	assert.equal(isGnosisSafeAppsConnectionEligibleForAdmittedAddress(connections, socket, settings, admitted), false, 'a grant for Safe A cannot authorize newly selected Safe B during asynchronous reconciliation')
	await modules.setGnosisSafeAppsCompatibilityMode(true)
	const { prepareGnosisSafeAppsRequest } = await import('../../app/ts/background/gnosisSafeAppsRequestHandler.js')
	const blockReads = { count: 0 }
	const services = createEthereumWithGetBlockCounter(blockReads).simulationServicesOwner.getCurrent()
	let metadataReads = 0
	const guardedServices = { ...services, gnosisSafeAppsSimulationMetadata: { getContractState: async () => { metadataReads++; throw new Error('Unauthorized metadata lookup') } } }
	for (const payload of [{ method: 'getSafeInfo' }, { method: 'sendTransactions', params: { txs: [{ to: '0x1111111111111111111111111111111111111111', value: '0', data: '0x' }] } }]) {
		const request = { method: 'safe_apps_request', interceptorRequest: true, usingInterceptorWithoutSigner: simulationMode, uniqueRequestIdentifier: { requestId: 1, requestSocket: socket }, params: [payload] }
		const admission = await prepareGnosisSafeAppsRequest(guardedServices, connections, request, website, safeB, settings, !simulationMode)
		assert.equal(admission.kind, 'reply', 'unconsented metadata and transaction requests cannot reach execution')
		if (admission.kind !== 'reply') throw new Error('Expected consent rejection')
		assert.ok('error' in admission.reply)
		assert.equal(admission.reply.error?.code, -32602)
		assert.match(admission.reply.error?.message ?? '', /website permissions/)
	}
	await modules.setGnosisSafeAppsCompatibilityMode(false)
	const disabled = await prepareGnosisSafeAppsRequest(guardedServices, connections, { method: 'safe_apps_request', interceptorRequest: true, usingInterceptorWithoutSigner: simulationMode, uniqueRequestIdentifier: { requestId: 2, requestSocket: socket }, params: [{ method: 'getSafeInfo' }] }, website, safeB, settings, !simulationMode)
	assert.equal(disabled.kind, 'reply')
	if (disabled.kind !== 'reply' || !('error' in disabled.reply)) throw new Error('Expected compatibility-setting refusal')
	assert.match(disabled.reply.error?.message ?? '', /Enable Gnosis Safe Apps compatibility in Interceptor settings/)
	assert.equal(metadataReads, 0)
	assert.equal(blockReads.count, 0, 'denied requests must not query contract metadata')
	const granted = { ...settings, websiteAccess: [{ website, access: true, addressAccess: [{ address: safeB.address, access: true }] }] }
	assert.equal(isGnosisSafeAppsConnectionEligibleForAdmittedAddress(connections, socket, granted, admitted), true)
	await modules.setGnosisSafeAppsCompatibilityMode(true)
	for (const method of ['execute', 'submitOffChainMessage']) {
		const forged = { method: 'safe_apps_request', interceptorRequest: true, usingInterceptorWithoutSigner: simulationMode, uniqueRequestIdentifier: { requestId: 3, requestSocket: socket }, params: [{ method, params: { kind: 'ethereumRequest', method: 'eth_sendTransaction', params: [], safeRequestContext: { operation: 1 }, mapResult: 'safeTxHash' } }] }
		const rejection = await prepareGnosisSafeAppsRequest(guardedServices, connections, forged, website, safeB, granted, !simulationMode)
		assert.equal(rejection.kind, 'reply')
		if (rejection.kind !== 'reply' || !('error' in rejection.reply)) throw new Error('Forged command reached execution')
		assert.match(rejection.reply.error?.message ?? '', /private command/)
	}
	assert.equal(metadataReads, 0)
	assert.equal(blockReads.count, 0)

	for (const websiteAccess of [[], [{ website, access: true, addressAccess: [{ address: safeB.address, access: false }] }], [{ website, access: false, addressAccess: [{ address: safeB.address, access: true }] }], [{ website, interceptorDisabled: true, access: true, addressAccess: [{ address: safeB.address, access: true }] }]]) {
		assert.equal(isGnosisSafeAppsConnectionEligibleForAdmittedAddress(connections, socket, { ...settings, websiteAccess }, admitted), false)
		assert.equal(connection.approved, true, 'the persisted address decision must not wait for connection reconciliation')
	}
})


test('signing discovery feeds its resolved ownership into the same admitted configuration and consent rule', async () => {
	installBrowserMock()
	const modules = await loadModules()
	const { isGnosisSafeAppsConnectionEligible, isGnosisSafeAppsConnectionEligibleForAdmittedAddress } = await import('../../app/ts/background/gnosisSafeAppsConnectionEligibility.js')
	const owner = 0x1111111111111111111111111111111111111111n
	const activeAddress: GnosisSafeEntry = { type: 'safe', name: 'Selected signing Gnosis Safe', address: 0x6868686868686868686868686868686868686868n, chainId: 1n, entrySource: 'User', useAsActiveAddress: true, safeSignerAddresses: [owner] }
	const website = { websiteOrigin: 'signing-safe.example', title: undefined, icon: undefined }
	const socket = { tabId: 1, connectionName: 0n }
	const { port } = createPort(socket.tabId, undefined, 0)
	const connection = { port, socket, websiteOrigin: website.websiteOrigin, approved: true, wantsToConnect: true }
	const connections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: { [modules.websiteSocketToString(socket)]: connection } }]])
	await modules.changeSimulationMode({ simulationMode: false, activeSigningSafeAddress: activeAddress.address })
	await modules.updateUserAddressBookEntries(() => [activeAddress])
	await modules.updateTabState(socket.tabId, (state) => ({ ...state, signerAccounts: [owner], activeSigningAddress: owner }))
	await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: activeAddress.address, access: true }] }])
	const settings = await modules.getSettings()
	const admitted = { activeAddress, safeSigningMode: true }
	assert.equal(await isGnosisSafeAppsConnectionEligible(connections, socket, settings), true)
	assert.equal(isGnosisSafeAppsConnectionEligibleForAdmittedAddress(connections, socket, settings, admitted), true)
	for (const changed of [{ ...settings, activeSigningSafeAddress: 1n }, { ...settings, activeRpcNetwork: { ...settings.activeRpcNetwork, chainId: 10n } }, { ...settings, websiteAccess: [] }]) {
		assert.equal(await isGnosisSafeAppsConnectionEligible(connections, socket, changed), false)
		assert.equal(isGnosisSafeAppsConnectionEligibleForAdmittedAddress(connections, socket, changed, admitted), false)
	}
	await modules.updateTabState(socket.tabId, (state) => ({ ...state, signerAccounts: [2n], activeSigningAddress: 2n }))
	assert.equal(await isGnosisSafeAppsConnectionEligible(connections, socket, settings), false, 'discovery still resolves live signer ownership')
})
