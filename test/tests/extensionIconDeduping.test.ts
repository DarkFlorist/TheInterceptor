import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { ICON_ACCESS_DENIED, ICON_NOT_ACTIVE, ICON_SIMULATING } from '../../app/ts/utils/constants.js'
import { flushMicrotasks } from '../harness/async.js'
import { type BrowserMock, createMockPort } from '../harness/browserMock.js'
import { createPerTestRestorer } from '../harness/perTest.js'

const { installBrowserMockForTest } = createPerTestRestorer()

// The generation only tags popup_websiteIconChanged messages, which these tests do not inspect.
const popupRefreshGeneration = 0

function installBrowserMockWithExampleTab() {
	const browserMock = installBrowserMockForTest({ tabs: [{ id: 1, url: 'https://example.test', status: 'complete' }] })
	return {
		browserMock,
		readSetIconCalls: () => browserMock.calls.action.flatMap((call) => call.api === 'action' && call.method === 'setIcon' ? [call.details] : []),
		readSetTitleCalls: () => browserMock.calls.action.flatMap((call) => call.api === 'action' && call.method === 'setTitle' ? [call.details] : []),
	}
}

async function loadModules() {
	return {
		...await import('../../app/ts/background/accessManagement.js'),
		...await import('../../app/ts/background/websiteAccessReconciliation.js'),
		...await import('../../app/ts/background/backgroundUtils.js'),
		...await import('../../app/ts/background/iconHandler.js'),
		...await import('../../app/ts/background/settings.js'),
		...await import('../../app/ts/background/popupMessageHandlers/settings.js'),
		...await import('../../app/ts/background/storageVariables.js'),
		...await import('../../app/ts/background/websiteTabConnections.js'),
		...await import('../../app/ts/background/signerStateOwnership.js'),
	}
}

function createPort(browserMock: BrowserMock, tabId: number) {
	const tab = browserMock.getTab(tabId)
	assert.ok(tab !== undefined, `tab ${ tabId } is not seeded in the browser mock`)
	return createMockPort({ name: '0x0', sender: { tab } }).port
}

describe('extension icon deduping', () => {
	test('setIcon runs on the first state change and not on an identical follow-up update', async () => {
		const { readSetIconCalls, readSetTitleCalls } = installBrowserMockWithExampleTab()
		const { changeSimulationMode, updateExtensionIcon, updateTabState } = await loadModules()

		await changeSimulationMode({ simulationMode: false, activeSigningAddress: undefined })
		await updateTabState(1, (previousState) => ({
			...previousState,
			tabIconDetails: {
				icon: ICON_SIMULATING,
				iconReason: 'The Interceptor simulates your sent transactions.',
			},
		}))

		await updateExtensionIcon(new Map(), 1, 'example.test', popupRefreshGeneration)
		assert.equal(readSetIconCalls().length, 1)
		assert.equal(readSetTitleCalls().length, 1)

		await updateExtensionIcon(new Map(), 1, 'example.test', popupRefreshGeneration)
		assert.equal(readSetIconCalls().length, 1)
		assert.equal(readSetTitleCalls().length, 1)
	})

	test('title-only icon updates skip setIcon', async () => {
		const { readSetIconCalls, readSetTitleCalls } = installBrowserMockWithExampleTab()
		const { changeSimulationMode, updateExtensionIcon, updateTabState } = await loadModules()

		await changeSimulationMode({ simulationMode: false, activeSigningAddress: undefined })
		await updateTabState(1, (previousState) => ({
			...previousState,
			tabIconDetails: {
				icon: ICON_NOT_ACTIVE,
				iconReason: 'Old reason',
			},
		}))

		await updateExtensionIcon(new Map(), 1, 'example.test', popupRefreshGeneration)
		assert.equal(readSetIconCalls().length, 0)
		assert.equal(readSetTitleCalls().length, 1)
		assert.equal(readSetTitleCalls()[0]?.title, 'No active address selected.')
	})

	test('icon-only updates skip setTitle', async () => {
		const { readSetIconCalls, readSetTitleCalls } = installBrowserMockWithExampleTab()
		const { changeSimulationMode, updateExtensionIcon, updateTabState } = await loadModules()

		await changeSimulationMode({ simulationMode: false, activeSigningAddress: undefined })
		await updateTabState(1, (previousState) => ({
			...previousState,
			tabIconDetails: {
				icon: ICON_SIMULATING,
				iconReason: 'No active address selected.',
			},
		}))

		await updateExtensionIcon(new Map(), 1, 'example.test', popupRefreshGeneration)
		assert.equal(readSetIconCalls().length, 1)
		assert.equal(readSetTitleCalls().length, 0)
		assert.deepEqual(readSetIconCalls()[0]?.path, { 128: ICON_NOT_ACTIVE })
	})

	test('blocked websites with denied access keep the plain denied icon', async () => {
		const { readSetIconCalls, readSetTitleCalls } = installBrowserMockWithExampleTab()
		const { updateExtensionIcon, updateTabState, updateWebsiteAccess } = await loadModules()

		await updateWebsiteAccess(() => [{
			website: { websiteOrigin: 'example.test', icon: undefined, title: 'Example' },
			addressAccess: undefined,
			access: false,
			declarativeNetRequestBlockMode: 'block-all',
		}])
		await updateTabState(1, (previousState) => ({
			...previousState,
			tabIconDetails: {
				icon: ICON_SIMULATING,
				iconReason: 'The Interceptor simulates your sent transactions.',
			},
		}))

		await updateExtensionIcon(new Map(), 1, 'example.test', popupRefreshGeneration)

		assert.deepEqual(readSetIconCalls().at(-1)?.path, { 128: ICON_ACCESS_DENIED })
		assert.match(readSetTitleCalls().at(-1)?.title ?? '', /DENIED.*blocking external requests/u)
	})

	test('access refresh collapses duplicate icon recomputations for the same tab and origin', async () => {
		const { browserMock, readSetIconCalls, readSetTitleCalls } = installBrowserMockWithExampleTab()
		const { changeSimulationMode, updateTabState, syncWebsiteApprovalsWithSettings } = await loadModules()

		await changeSimulationMode({ simulationMode: false, activeSigningAddress: undefined })
		await updateTabState(1, (previousState) => ({
			...previousState,
			tabIconDetails: {
				icon: ICON_SIMULATING,
				iconReason: 'The Interceptor simulates your sent transactions.',
			},
		}))

		const port = createPort(browserMock, 1)
		const websiteTabConnections = new Map([
			[1, {
				connections: {
					first: { port, socket: { tabId: 1, connectionName: 0n }, websiteOrigin: 'example.test', approved: false, wantsToConnect: false },
					second: { port, socket: { tabId: 1, connectionName: 1n }, websiteOrigin: 'example.test', approved: false, wantsToConnect: false },
				},
			}],
		])

		await syncWebsiteApprovalsWithSettings(websiteTabConnections, { promptForAccessesIfNeeded: false })
		await flushMicrotasks()

		assert.equal(readSetIconCalls().length, 1)
		assert.equal(readSetTitleCalls().length, 1)
	})

	test('access refresh updates stale icons for tabs without active connections', async () => {
		const { readSetIconCalls, readSetTitleCalls } = installBrowserMockWithExampleTab()
		const { changeSimulationMode, updateTabState, syncWebsiteApprovalsWithSettings } = await loadModules()

		await changeSimulationMode({ simulationMode: false, activeSigningAddress: undefined })
		await updateTabState(1, (previousState) => ({
			...previousState,
			website: { websiteOrigin: 'example.test', icon: undefined, title: 'Example' },
			tabIconDetails: {
				icon: ICON_SIMULATING,
				iconReason: 'The Interceptor simulates your sent transactions.',
			},
		}))

		await syncWebsiteApprovalsWithSettings(new Map(), { promptForAccessesIfNeeded: false })
		await flushMicrotasks()

		assert.equal(readSetIconCalls().length, 1)
		assert.equal(readSetTitleCalls().length, 1)
		assert.deepEqual(readSetIconCalls()[0]?.path, { 128: ICON_NOT_ACTIVE })
		assert.equal(readSetTitleCalls()[0]?.title, 'No active address selected.')
	})

	test('imported mode change updates tabs without active connections', async () => {
		const { changeSimulationMode, getSettings, importSettings, updateTabState, syncWebsiteApprovalsWithSettings } = await loadModules()
		const { readSetIconCalls, readSetTitleCalls } = installBrowserMockWithExampleTab()
		const importedSettingsReply = JSON.stringify({
			name: 'InterceptorSettingsAndAddressBook',
			version: '1.4',
			exportedDate: '2026-05-21',
			settings: {
				activeSimulationAddress: '0x0000000000000000000000000000000000000002',
				rpcNetwork: {
					name: 'Imported',
					chainId: '0x1',
					httpsRpc: 'https://example.test/rpc',
					currencyName: 'Ether',
					currencyTicker: 'ETH',
					primary: true,
					minimized: true,
				},
				openedPage: { page: 'Home' },
				useSignersAddressAsActiveAddress: false,
				websiteAccess: [],
				simulationMode: false,
				addressBookEntries: [],
				useTabsInsteadOfPopup: false,
				metamaskCompatibilityMode: false,
			},
		})

		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: 0x1n, activeSigningAddress: undefined })
		await updateTabState(1, (previousState) => ({
			...previousState,
			website: { websiteOrigin: 'example.test', icon: undefined, title: 'Example' },
			tabIconDetails: {
				icon: ICON_SIMULATING,
				iconReason: 'The Interceptor simulates your sent transactions.',
			},
		}))

		const importSettingsReply = await importSettings({ method: 'popup_import_settings', data: { fileContents: importedSettingsReply } })
		assert.equal(importSettingsReply.data.success, true)
		await syncWebsiteApprovalsWithSettings(new Map(), { promptForAccessesIfNeeded: false })
		await flushMicrotasks()

		const settings = await getSettings()
		assert.equal(settings.activeRpcNetwork.httpsRpc, 'https://example.test/rpc')
		assert.equal(settings.simulationMode, false)

		assert.deepEqual(readSetIconCalls()[0]?.path, { 128: ICON_NOT_ACTIVE })
		assert.equal(readSetTitleCalls()[0]?.title, 'No active address selected.')
	})

	test('last-port disconnect removes the tab entry', async () => {
		const { browserMock } = installBrowserMockWithExampleTab()
		const { removeWebsiteTabConnection, websiteSocketToString } = await loadModules()

		const socket = { tabId: 1, connectionName: 0n }
		const port = createPort(browserMock, 1)
		const websiteTabConnections = new Map([
			[1, {
				connections: {
					[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'example.test', approved: false, wantsToConnect: false },
				},
			}],
		])

		await removeWebsiteTabConnection(websiteTabConnections, socket, port)

		assert.equal(websiteTabConnections.has(1), false)
	})

	test('stale port disconnect keeps a replacement connection with the same socket identifier', async () => {
		const { browserMock } = installBrowserMockWithExampleTab()
		const { removeWebsiteTabConnection, websiteSocketToString } = await loadModules()

		const socket = { tabId: 1, connectionName: 0n }
		const disconnectedPort = createPort(browserMock, 1)
		const replacementPort = createPort(browserMock, 1)
		const connectionIdentifier = websiteSocketToString(socket)
		const websiteTabConnections = new Map([
			[1, {
				connections: {
					[connectionIdentifier]: { port: replacementPort, socket, websiteOrigin: 'example.test', approved: false, wantsToConnect: false },
				},
			}],
		])

		await removeWebsiteTabConnection(websiteTabConnections, socket, disconnectedPort)

		assert.strictEqual(websiteTabConnections.get(1)?.connections[connectionIdentifier]?.port, replacementPort)
		await removeWebsiteTabConnection(websiteTabConnections, socket, replacementPort)
		assert.equal(websiteTabConnections.has(1), false)
	})

	test('signer owner disconnect releases ownership while sibling connections remain', async () => {
		const { browserMock } = installBrowserMockWithExampleTab()
		const { removeWebsiteTabConnection, websiteSocketToString } = await loadModules()

		const ownerSocket = { tabId: 1, connectionName: 0n }
		const siblingSocket = { tabId: 1, connectionName: 1n }
		const ownerPort = createPort(browserMock, 1)
		const siblingPort = createPort(browserMock, 1)
		const websiteTabConnections = new Map([
			[1, {
				connections: {
					[websiteSocketToString(ownerSocket)]: { port: ownerPort, socket: ownerSocket, websiteOrigin: 'example.test', approved: false, wantsToConnect: false },
					[websiteSocketToString(siblingSocket)]: { port: siblingPort, socket: siblingSocket, websiteOrigin: 'example.test', approved: false, wantsToConnect: false },
				},
				signerStateOwner: {
					connectionName: ownerSocket.connectionName,
					confirmed: true,
					generation: 1,
					providerGeneration: 1,
				},
			}],
		])

		await removeWebsiteTabConnection(websiteTabConnections, ownerSocket, ownerPort)

		const remainingTabConnection = websiteTabConnections.get(1)
		assert.equal(remainingTabConnection?.signerStateOwner?.connectionName, undefined)
		assert.equal(remainingTabConnection?.signerStateOwner?.confirmed, false)
		assert.strictEqual(remainingTabConnection?.connections[websiteSocketToString(siblingSocket)]?.port, siblingPort)
	})

	test('BFCache restoration provisionally reclaims signer ownership before the previous page disconnects', async () => {
		const { browserMock } = installBrowserMockWithExampleTab()
		const {
			getTabState,
			registerWebsiteConnectionAndProvisionallyClaimSignerState,
			removeWebsiteTabConnection,
			updateTabState,
			websiteSocketToString,
		} = await loadModules()

		const restoredSocket = { tabId: 1, connectionName: 10n }
		const previousPageSocket = { tabId: 1, connectionName: 11n }
		const staleRestoredPort = createPort(browserMock, 1)
		const restoredPort = createPort(browserMock, 1)
		const previousPagePort = createPort(browserMock, 1)
		const staleAccount = 0x1111111111111111111111111111111111111111n
		const websiteTabConnections = new Map([
			[1, {
				connections: {
					[websiteSocketToString(restoredSocket)]: { port: staleRestoredPort, socket: restoredSocket, websiteOrigin: 'example.test', approved: true, wantsToConnect: true },
					[websiteSocketToString(previousPageSocket)]: { port: previousPagePort, socket: previousPageSocket, websiteOrigin: 'example.test', approved: true, wantsToConnect: true },
				},
				signerStateOwner: {
					connectionName: previousPageSocket.connectionName,
					confirmed: true,
					generation: 1,
					providerGeneration: 5,
				},
			}],
		])
		await updateTabState(1, (previousState) => ({
			...previousState,
			signerName: 'MetaMask',
			signerConnected: true,
			signerAccounts: [staleAccount],
			signerChain: 1n,
			activeSigningAddress: staleAccount,
		}))

		await registerWebsiteConnectionAndProvisionallyClaimSignerState(
			websiteTabConnections,
			restoredSocket,
			{ port: restoredPort, socket: restoredSocket, websiteOrigin: 'example.test', approved: true, wantsToConnect: true },
			true,
		)
		await removeWebsiteTabConnection(websiteTabConnections, previousPageSocket, previousPagePort)

		const tabConnection = websiteTabConnections.get(1)
		assert.equal(tabConnection?.signerStateOwner?.connectionName, restoredSocket.connectionName)
		assert.equal(tabConnection?.signerStateOwner?.confirmed, false)
		assert.equal((await getTabState(restoredSocket.tabId)).signerName, 'NoSigner')
		assert.strictEqual(tabConnection?.connections[websiteSocketToString(restoredSocket)]?.port, restoredPort)
		const tabState = await getTabState(1)
		assert.deepEqual(tabState.signerAccounts, [])
		assert.equal(tabState.signerChain, undefined)
		assert.equal(tabState.activeSigningAddress, undefined)
	})
})
