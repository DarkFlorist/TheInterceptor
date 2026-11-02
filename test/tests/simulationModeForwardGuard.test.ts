import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { PublishRpcConnectionStatus } from '../../app/ts/background/rpcSlowRequestTracking.js'
import type { Website } from '../../app/ts/types/websiteAccessTypes.js'
import { withSilencedConsole } from './consoleSilence.js'
import { confirmedSignerOwnership, createDeferredValue, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'

const ACCOUNT = 0x1111111111111111111111111111111111111111n
const WEBSITE_ORIGIN = 'https://forward-guard.example'
const WEBSITE: Website = { websiteOrigin: WEBSITE_ORIGIN, icon: undefined, title: undefined }
const SIMULATION_MODE_ADD_CHAIN_ERROR = { code: 10000, message: 'wallet_addEthereumChain not implemented' }

async function setUpSigningModeWebsite({ initialBlockPolling = true }: { readonly initialBlockPolling?: boolean } = {}) {
	const { setStorageHooks, readStoredValue } = installBrowserMock()
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
	return { modules, ethereum, setStorageHooks, readStoredValue, enableSimulationMode, sendAddEthereumChain, sendAddEthereumChainAfterArming }
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

	test('does not forward when an enabling write is already visible in storage but has not completed', async () => {
		const { setStorageHooks, readStoredValue, enableSimulationMode, sendAddEthereumChainAfterArming } = await setUpSigningModeWebsite()
		let enabling: Promise<void> | undefined
		let storedModeWhileWithheld: unknown
		const replies = await sendAddEthereumChainAfterArming(7, async () => setStorageHooks({
			afterGet: async (keys) => {
				if (keys !== 'tabState_1') return
				setStorageHooks({
					afterSet: async (items) => {
						if (items.simulationMode !== true) return
						setStorageHooks({})
						storedModeWhileWithheld = readStoredValue('simulationMode')
						// Withhold completion for one macrotask; the already-routed request reaches its forward point meanwhile.
						await new Promise((resolve) => setTimeout(resolve, 0))
					},
				})
				enabling = enableSimulationMode()
			},
		}))
		await enabling
		assert.equal(storedModeWhileWithheld, true)
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

	test('routes a request in simulation mode when the stored simulation mode is corrupt, without writing it', async () => {
		const { modules, readStoredValue, sendAddEthereumChain } = await setUpSigningModeWebsite()
		await browser.storage.local.set({ simulationMode: 'corrupt' })
		const guardBeforeRouting = modules.captureSimulationModeGuard()
		const replies = await withSilencedConsole(async () => await sendAddEthereumChain(5))
		assertAnsweredInSimulationMode(replies)
		assert.equal(readStoredValue('simulationMode'), 'corrupt')
		assert.equal(guardBeforeRouting.allowsSignerForward(), true)
	})

	test('a settings read of a corrupt simulation mode cannot overwrite a later switch to signing mode', async () => {
		const { modules, setStorageHooks, readStoredValue, sendAddEthereumChain } = await setUpSigningModeWebsite()
		// A separate module instance has its own simulation-mode guard state, like a popup's JS context.
		const popupSettings = await import('../../app/ts/background/settings.js?popup-context')
		await browser.storage.local.set({ simulationMode: 'corrupt' })
		const simulationModeWrites: unknown[] = []
		setStorageHooks({ beforeSet: async (items) => { if ('simulationMode' in items) simulationModeWrites.push(items.simulationMode) } })
		await withSilencedConsole(async () => {
			const [backgroundSettings, popupContextSettings] = await Promise.all([modules.getSettings(), popupSettings.getSettings()])
			assert.equal(backgroundSettings.simulationMode, true)
			assert.equal(popupContextSettings.simulationMode, true)
		})
		await modules.changeSimulationMode({ simulationMode: false })
		setStorageHooks({})
		// Only the explicit switch wrote simulation mode, so forwarding matches the stored signing mode.
		assert.deepEqual(simulationModeWrites, [false])
		assert.equal(readStoredValue('simulationMode'), false)
		assert.deepEqual((await sendAddEthereumChain(6)).map((reply) => reply.type), ['forwardToSigner'])
	})

	test('a guard refuses the signer forward after any write that enables simulation mode, including settings import', async () => {
		installBrowserMock()
		const { captureSimulationModeGuard, changeSimulationMode, exportSettingsAndAddressBook, importSettingsAndAddressBook, refuseSignerForwardGuard } = await loadModules()
		const guardBeforeSigningModeWrite = captureSimulationModeGuard()
		await changeSimulationMode({ simulationMode: false })
		assert.equal(guardBeforeSigningModeWrite.allowsSignerForward(), true)
		await changeSimulationMode({ simulationMode: true })
		assert.equal(guardBeforeSigningModeWrite.allowsSignerForward(), false)
		await changeSimulationMode({ simulationMode: false })
		const guardBeforeImport = captureSimulationModeGuard()
		const exported = await exportSettingsAndAddressBook()
		await importSettingsAndAddressBook({ ...exported, settings: { ...exported.settings, simulationMode: true } })
		assert.equal(guardBeforeImport.allowsSignerForward(), false)
		assert.equal(captureSimulationModeGuard().allowsSignerForward(), true)
		assert.equal(refuseSignerForwardGuard.allowsSignerForward(), false)
	})

	test('a guard posts the forward only while it allows it, in the same synchronous step as the check', async () => {
		installBrowserMock()
		const { captureSimulationModeGuard, changeSimulationMode } = await loadModules()
		await changeSimulationMode({ simulationMode: false })
		const guard = captureSimulationModeGuard()
		let posts = 0
		assert.deepEqual(guard.postSignerForwardIfAllowed(() => ++posts), { posted: true, result: 1 })
		const enabling = changeSimulationMode({ simulationMode: true })
		// The enabling write is pending, so the forward is refused without calling the post.
		assert.deepEqual(guard.postSignerForwardIfAllowed(() => ++posts), { posted: false })
		await enabling
		assert.deepEqual(guard.postSignerForwardIfAllowed(() => ++posts), { posted: false })
		assert.equal(posts, 1)
	})

	test('only writeSimulationModeChanges writes simulationMode through the storage setter that allows it', async () => {
		const sourceDirectory = new URL('../../app/ts/', import.meta.url).pathname
		const callers: string[] = []
		for await (const path of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: sourceDirectory })) {
			const source = await Bun.file(`${ sourceDirectory }${ path }`).text()
			const calls = source.match(/browserStorageLocalSetWithSimulationMode\(/gu)?.length ?? 0
			if (calls > 0) callers.push(`${ path }: ${ calls }`)
		}
		// One call in settings.ts writeSimulationModeChanges, plus the definition in storageUtils.ts; browserStorageLocalSet rejects simulationMode by type.
		assert.deepEqual(callers.sort(), ['background/settings.ts: 1', 'utils/storageUtils.ts: 1'])
	})
})
