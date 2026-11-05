import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { PublishRpcConnectionStatus } from '../../app/ts/background/rpcSlowRequestTracking.js'
import type { Website } from '../../app/ts/types/websiteAccessTypes.js'
import { ERROR_SIMULATION_MODE_ENABLED_AFTER_REQUEST, METAMASK_ERROR_NOT_AUTHORIZED } from '../../app/ts/utils/constants.js'
import { withSilencedConsole } from './consoleSilence.js'
import { confirmedSignerOwnership, createDeferredValue, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'

const ACCOUNT = 0x1111111111111111111111111111111111111111n
const SIMULATION_ONLY_ACCOUNT = 0x2222222222222222222222222222222222222222n
const WEBSITE_ORIGIN = 'https://forward-guard.example'
const WEBSITE: Website = { websiteOrigin: WEBSITE_ORIGIN, icon: undefined, title: undefined }
const SIMULATION_MODE_ADD_CHAIN_ERROR = { code: 10000, message: 'wallet_addEthereumChain not implemented' }
type RpcCall = { readonly method: string, readonly params: readonly unknown[] }
const ADD_ETHEREUM_CHAIN: RpcCall = { method: 'wallet_addEthereumChain', params: [{ chainId: '0x2105', chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'] }] }

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
	const sendRequest = async (requestId: number, rpcCall: RpcCall, websitePromise: Promise<Website> | Website = WEBSITE, publishRpcConnectionStatus: PublishRpcConnectionStatus = noopPublishRpcConnectionStatus) => {
		await modules.handleInterceptedRequest(port, WEBSITE_ORIGIN, websitePromise, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId, requestSocket: socket },
			...rpcCall,
		}, websiteTabConnections, publishRpcConnectionStatus)
		return messages.filter((message) => message.requestId === requestId)
	}
	const sendAddEthereumChain = async (requestId: number, websitePromise: Promise<Website> | Website = WEBSITE, publishRpcConnectionStatus: PublishRpcConnectionStatus = noopPublishRpcConnectionStatus) => await sendRequest(requestId, ADD_ETHEREUM_CHAIN, websitePromise, publishRpcConnectionStatus)
	// Resolves the website metadata only once the request is parked on it, which is after discovery and the access check and right before the settings read used for routing.
	const sendRequestAfterArming = async (requestId: number, rpcCall: RpcCall, armHooks: () => Promise<void>) => {
		const website = createDeferredValue<Website>()
		const replies = sendRequest(requestId, rpcCall, website.promise)
		await new Promise((resolve) => setTimeout(resolve, 0))
		await armHooks()
		website.resolve(WEBSITE)
		return await replies
	}
	const sendAddEthereumChainAfterArming = async (requestId: number, armHooks: () => Promise<void>) => await sendRequestAfterArming(requestId, ADD_ETHEREUM_CHAIN, armHooks)
	return { modules, ethereum, messages, setStorageHooks, readStoredValue, enableSimulationMode, sendAddEthereumChain, sendAddEthereumChainAfterArming, sendRequestAfterArming }
}

function assertAnsweredInSimulationMode(replies: readonly { type?: unknown, error?: unknown }[]) {
	assert.equal(replies.some((reply) => reply.type === 'forwardToSigner'), false)
	assert.deepEqual(replies.map((reply) => reply.error), [SIMULATION_MODE_ADD_CHAIN_ERROR])
}

// getSettings() is the only reader of simulationMode, and after the arming point a request reads the settings once per routing attempt. Handling the request again from the start would read them more often.
const isSettingsRead = (keys: unknown) => Array.isArray(keys) && keys.includes('simulationMode')

async function readAppSources() {
	const sourceDirectory = new URL('../../app/ts/', import.meta.url).pathname
	const sources: { readonly path: string, readonly source: string }[] = []
	for await (const path of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: sourceDirectory })) {
		sources.push({ path, source: await Bun.file(`${ sourceDirectory }${ path }`).text() })
	}
	return sources
}

// The argument text of each direct browser.storage.local.set call, found by matching its parentheses.
function getRawStorageWriteArguments(source: string) {
	return [...source.matchAll(/\bstorage\s*\.\s*local\s*\.\s*set\s*\(/gu)].map((call) => {
		const argumentsStart = call.index + call[0].length
		let argumentsEnd = argumentsStart
		for (let depth = 1; depth > 0 && argumentsEnd < source.length; argumentsEnd++) {
			if (source[argumentsEnd] === '(') depth++
			if (source[argumentsEnd] === ')') depth--
		}
		return source.slice(argumentsStart, argumentsEnd - 1)
	})
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

	test('re-routes a refused forward once, on fresh settings, without handling the request from the start', async () => {
		const { setStorageHooks, enableSimulationMode, sendAddEthereumChainAfterArming } = await setUpSigningModeWebsite()
		let routingAttempts = 0
		const replies = await sendAddEthereumChainAfterArming(8, async () => setStorageHooks({
			afterGet: async (keys) => {
				if (isSettingsRead(keys)) routingAttempts++
				if (keys === 'tabState_1' && routingAttempts === 1) await enableSimulationMode()
			},
		}))
		setStorageHooks({})
		assert.equal(routingAttempts, 2)
		assertAnsweredInSimulationMode(replies)
	})

	test('does not repeat the access check for a refused forward', async () => {
		const { setStorageHooks, messages, enableSimulationMode, sendRequestAfterArming } = await setUpSigningModeWebsite()
		const replies = await sendRequestAfterArming(9, { method: 'wallet_getCapabilities', params: [`0x${ ACCOUNT.toString(16) }`] }, async () => setStorageHooks({
			afterGet: async (keys) => {
				if (keys !== 'tabState_1') return
				setStorageHooks({})
				await enableSimulationMode()
			},
		}))
		// An account identity request ignores the connection approval, so each access check that grants access tells the website it is connected.
		assert.equal(messages.filter((message) => message.method === 'connect').length, 1)
		assert.deepEqual(replies.map((reply) => reply.type), ['result'])
		assert.equal(replies[0]?.error, undefined)
	})

	test('forwards from the re-route when the fresh settings are back in signing mode', async () => {
		const { modules, setStorageHooks, enableSimulationMode, sendAddEthereumChainAfterArming } = await setUpSigningModeWebsite()
		const replies = await sendAddEthereumChainAfterArming(10, async () => setStorageHooks({
			afterGet: async (keys) => {
				if (keys !== 'tabState_1') return
				setStorageHooks({})
				await enableSimulationMode()
				await modules.changeSimulationMode({ simulationMode: false })
			},
		}))
		assert.deepEqual(replies.map((reply) => reply.type), ['forwardToSigner'])
	})

	test('stops at the routing bound and refuses without forwarding when simulation mode keeps being enabled', async () => {
		const { modules, setStorageHooks, enableSimulationMode, sendAddEthereumChainAfterArming } = await setUpSigningModeWebsite()
		let routingAttempts = 0
		const replies = await sendAddEthereumChainAfterArming(11, async () => setStorageHooks({
			afterGet: async (keys) => {
				if (isSettingsRead(keys)) routingAttempts++
				if (keys !== 'tabState_1') return
				await enableSimulationMode()
				await modules.changeSimulationMode({ simulationMode: false })
			},
		}))
		setStorageHooks({})
		assert.equal(routingAttempts, 3)
		assert.equal(replies.some((reply) => reply.type === 'forwardToSigner'), false)
		assert.deepEqual(replies.map((reply) => reply.error), [ERROR_SIMULATION_MODE_ENABLED_AFTER_REQUEST.error])
	})

	test('refuses a re-route onto a simulation address the website has no access to', async () => {
		const { modules, setStorageHooks, enableSimulationMode, sendAddEthereumChainAfterArming } = await setUpSigningModeWebsite()
		await modules.setUseSignersAddressAsActiveAddress(false)
		await modules.changeSimulationMode({ simulationMode: false, activeSimulationAddress: SIMULATION_ONLY_ACCOUNT })
		const replies = await sendAddEthereumChainAfterArming(12, async () => setStorageHooks({
			afterGet: async (keys) => {
				if (keys !== 'tabState_1') return
				setStorageHooks({})
				await enableSimulationMode()
			},
		}))
		assert.equal(replies.some((reply) => reply.type === 'forwardToSigner'), false)
		assert.deepEqual(replies.map((reply) => reply.error?.code), [METAMASK_ERROR_NOT_AUTHORIZED])
	})

	test('re-routes onto a different simulation address the website has access to', async () => {
		const { modules, setStorageHooks, enableSimulationMode, sendAddEthereumChainAfterArming } = await setUpSigningModeWebsite()
		await modules.setUseSignersAddressAsActiveAddress(false)
		await modules.changeSimulationMode({ simulationMode: false, activeSimulationAddress: SIMULATION_ONLY_ACCOUNT })
		await modules.updateWebsiteAccess(() => [{ website: WEBSITE, access: true, addressAccess: [{ address: ACCOUNT, access: true }, { address: SIMULATION_ONLY_ACCOUNT, access: true }] }])
		const replies = await sendAddEthereumChainAfterArming(13, async () => setStorageHooks({
			afterGet: async (keys) => {
				if (keys !== 'tabState_1') return
				setStorageHooks({})
				await enableSimulationMode()
			},
		}))
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
		// A separate instance of the settings module reads the settings like a popup's JS context does.
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

	test('raw storage writes stay in the storage modules and only the guard module writes simulationMode', async () => {
		const rawWrites = (await readAppSources()).flatMap(({ path, source }) => getRawStorageWriteArguments(source).map((writtenItems) => ({ path, writtenItems })))
		assert.deepEqual([...new Set(rawWrites.map(({ path }) => path))].sort(), ['background/simulationModeGuard.ts', 'utils/largeStateStore.ts', 'utils/storageUtils.ts'])
		assert.deepEqual(rawWrites.filter(({ path, writtenItems }) => path !== 'background/simulationModeGuard.ts' && writtenItems.includes('simulationMode')), [])
	})

	test('browserStorageLocalSet2 cannot write simulationMode because the key is not in its runtype', async () => {
		const { readStoredValue } = installBrowserMock()
		const { browserStorageLocalSet2 } = await import('../../app/ts/utils/storageUtils.js')
		await browserStorageLocalSet2(Object.fromEntries([['simulationMode', true]]))
		assert.equal(readStoredValue('simulationMode'), undefined)
	})
})
