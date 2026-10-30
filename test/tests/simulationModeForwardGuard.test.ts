import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { PublishRpcConnectionStatus } from '../../app/ts/background/rpcSlowRequestTracking.js'
import type { Website } from '../../app/ts/types/websiteAccessTypes.js'
import { confirmedSignerOwnership, createDeferredValue, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'

const ACCOUNT = 0x1111111111111111111111111111111111111111n
const WEBSITE_ORIGIN = 'https://forward-guard.example'
const WEBSITE: Website = { websiteOrigin: WEBSITE_ORIGIN, icon: undefined, title: undefined }
const SIMULATION_MODE_ADD_CHAIN_ERROR = { code: 10000, message: 'wallet_addEthereumChain not implemented' }

async function setUpSigningModeWebsite({ initialBlockPolling = true }: { readonly initialBlockPolling?: boolean } = {}) {
	const { setStorageHooks } = installBrowserMock()
	const modules = await loadModules()
	await modules.changeSimulationMode({ simulationMode: false, activeSimulationAddress: ACCOUNT, activeSigningAddress: ACCOUNT })
	// Both modes resolve the signer's address, so the website keeps access to the same account after the switch.
	await modules.setUseSignersAddressAsActiveAddress(true)
	await modules.updateWebsiteAccess(() => [{ website: WEBSITE, access: true, addressAccess: [{ address: ACCOUNT, access: true }] }])
	const socket = { tabId: 1, connectionName: 0n }
	await modules.updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [ACCOUNT], activeSigningAddress: ACCOUNT }))
	const { port, messages } = createPort(socket.tabId)
	const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
		[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: WEBSITE_ORIGIN, approved: true, wantsToConnect: true },
	} }]])
	const { ethereum, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 }, { initialBlockPolling })
	const enableSimulationMode = async () => await modules.changeSimulationMode({ simulationMode: true })
	const sendAddEthereumChain = async (requestId: number, websitePromise: Promise<Website> | Website = WEBSITE, publishRpcConnectionStatus: PublishRpcConnectionStatus = noopPublishRpcConnectionStatus) => {
		await modules.handleInterceptedRequest(port, WEBSITE_ORIGIN, websitePromise, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId, requestSocket: socket },
			method: 'wallet_addEthereumChain',
			params: [{ chainId: '0x2105', chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'] }],
		}, websiteTabConnections, publishRpcConnectionStatus)
		return messages.filter((message) => message.requestId === requestId)
	}
	// Resolves the website metadata only once the request is parked on it, which is right before the settings read used for routing.
	const sendAddEthereumChainAfterArming = async (requestId: number, armHooks: () => Promise<void>) => {
		const website = createDeferredValue<Website>()
		const replies = sendAddEthereumChain(requestId, website.promise)
		await new Promise((resolve) => setTimeout(resolve, 0))
		await armHooks()
		website.resolve(WEBSITE)
		return await replies
	}
	return { modules, ethereum, setStorageHooks, enableSimulationMode, sendAddEthereumChain, sendAddEthereumChainAfterArming }
}

function assertAnsweredInSimulationMode(replies: readonly { type?: unknown, error?: unknown }[]) {
	assert.equal(replies.some((reply) => reply.type === 'forwardToSigner'), false)
	assert.deepEqual(replies.map((reply) => reply.error), [SIMULATION_MODE_ADD_CHAIN_ERROR])
}

describe('simulation mode forward guard', () => {
	test('forwards to the signer when simulation mode does not change', async () => {
		const { sendAddEthereumChain } = await setUpSigningModeWebsite()
		const replies = await sendAddEthereumChain(1)
		assert.deepEqual(replies.map((reply) => reply.type), ['forwardToSigner'])
	})

	test('does not forward when simulation mode is enabled during the tab-state read', async () => {
		const { setStorageHooks, enableSimulationMode, sendAddEthereumChainAfterArming } = await setUpSigningModeWebsite()
		const replies = await sendAddEthereumChainAfterArming(2, async () => setStorageHooks({
			afterGet: async (keys) => {
				if (keys !== 'tabState_1') return
				setStorageHooks({})
				await enableSimulationMode()
			},
		}))
		assertAnsweredInSimulationMode(replies)
	})

	test('does not forward when simulation mode is enabled during wake-status publishing', async () => {
		const { modules, ethereum, enableSimulationMode, sendAddEthereumChain } = await setUpSigningModeWebsite({ initialBlockPolling: false })
		await modules.setRpcConnectionStatus({ isConnected: true, lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'), latestBlock: undefined, rpcNetwork: ethereum.getRpcEntry(), retrying: false })
		let publishCount = 0
		const replies = await sendAddEthereumChain(3, WEBSITE, async () => {
			publishCount++
			await enableSimulationMode()
		})
		assert.equal(publishCount, 1)
		assertAnsweredInSimulationMode(replies)
	})

	test('does not forward when simulation mode is enabled while the routing settings read is repairing storage', async () => {
		const { setStorageHooks, enableSimulationMode, sendAddEthereumChainAfterArming } = await setUpSigningModeWebsite()
		let repairedOpenedPage = false
		const replies = await sendAddEthereumChainAfterArming(4, async () => {
			// A corrupt page makes getSettings() await a repair write after it has already read simulation mode.
			await browser.storage.local.set({ openedPageV2: 'corrupt' })
			setStorageHooks({
				beforeSet: async (items) => {
					if (!('openedPageV2' in items)) return
					setStorageHooks({})
					repairedOpenedPage = true
					await enableSimulationMode()
				},
			})
		})
		assert.equal(repairedOpenedPage, true)
		assertAnsweredInSimulationMode(replies)
	})

	test('counts every write that enables simulation mode, including settings import', async () => {
		installBrowserMock()
		const { changeSimulationMode, exportSettingsAndAddressBook, getSimulationModeGeneration, importSettingsAndAddressBook } = await loadModules()
		const initialGeneration = getSimulationModeGeneration()
		await changeSimulationMode({ simulationMode: false })
		assert.equal(getSimulationModeGeneration(), initialGeneration)
		await changeSimulationMode({ simulationMode: true })
		assert.equal(getSimulationModeGeneration(), initialGeneration + 1)
		const exported = await exportSettingsAndAddressBook()
		await importSettingsAndAddressBook({ ...exported, settings: { ...exported.settings, simulationMode: true } })
		assert.equal(getSimulationModeGeneration(), initialGeneration + 2)
	})
})
