import * as assert from 'assert'
import { test } from 'bun:test'
import { clearSignerExecutionAuthorityForTab } from '../../app/ts/background/signerExecutionAuthority.js'
import { authorizeLegacySignerSocket, createPort, installBrowserMock, loadModules, addressString } from './backgroundEthAccountsTestHarness.js'

test('website state preserves approved simulation accounts but hides wallet identities until reconciliation', async () => {
	installBrowserMock()
	const { getSettings, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, websiteSocketToString } = await loadModules()
	const account = 0x1111111111111111111111111111111111111111n
	await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account })
	await setUseSignersAddressAsActiveAddress(false)
	await updateWebsiteAccess(() => [{ website: { websiteOrigin: 'https://example.test' }, access: true, addressAccess: [{ address: account, access: true }] }])
	const { sendActiveAccountChangeToApprovedWebsitePorts, sendProviderConnectionEventsToPort, sendAccountsChangedToPort } = await import('../../app/ts/background/accessManagement.js')
	const settings = await getSettings()
	const socket = { tabId: 1, connectionName: 99n }
	const otherSocket = { tabId: 1, connectionName: 100n }
	const approved = createPort(1, undefined, 2, socket.connectionName)
	const unapproved = createPort(1, undefined, 3, otherSocket.connectionName)
	const connections = new Map([[1, { connections: {
		[websiteSocketToString(socket)]: { port: approved.port, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
		[websiteSocketToString(otherSocket)]: { port: unapproved.port, socket: otherSocket, websiteOrigin: 'https://unapproved.test', approved: false, wantsToConnect: false },
	} }]])
	clearSignerExecutionAuthorityForTab(1)
	await sendActiveAccountChangeToApprovedWebsitePorts(connections, settings)
	assert.deepEqual(approved.messages.at(-1)?.result, [addressString(account)])
	assert.equal(unapproved.messages.length, 0)

	const walletSettings = { ...settings, simulationMode: false }
	await sendActiveAccountChangeToApprovedWebsitePorts(connections, walletSettings)
	assert.deepEqual(approved.messages.at(-1)?.result, [])
	sendProviderConnectionEventsToPort(connections, socket, walletSettings, [account])
	sendAccountsChangedToPort(connections, socket, [account], 12, walletSettings)
	assert.deepEqual(approved.messages.filter((message) => message.method === 'accountsChanged').slice(1).map((message) => message.result), [[], [], []])
	assert.equal(unapproved.messages.length, 0)

	authorizeLegacySignerSocket(socket)
	sendProviderConnectionEventsToPort(connections, socket, walletSettings, [account])
	assert.deepEqual(approved.messages.filter((message) => message.method === 'accountsChanged').at(-1)?.result, [addressString(account)])
})
