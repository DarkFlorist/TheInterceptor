import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { Website } from '../../app/ts/types/websiteAccessTypes.js'
import { confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, createRestoringBrowserMockInstaller, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'

const installBrowserMock = createRestoringBrowserMockInstaller()

const websiteOrigin = 'https://mode-switch.example'
const website: Website = { websiteOrigin, icon: undefined, title: undefined }
const account = 0x1111111111111111111111111111111111111111n
const optimism: RpcEntry = { name: 'Optimism', chainId: 10n, httpsRpc: 'https://optimism.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: false, minimized: false }
const socket = { tabId: 1, connectionName: 0n }

// Website metadata the router awaits only after it has decided access, which gives a test a point to change settings in between.
function createWebsiteMetadataGate() {
	const websiteMetadata = Promise.withResolvers<Website>()
	const accessDecided = Promise.withResolvers<void>()
	// A plain object rather than a native promise, because await only calls then() on non-native thenables.
	const websiteAfterAccessDecision: Promise<Website> = {
		then: (onFulfilled, onRejected) => {
			accessDecided.resolve()
			return websiteMetadata.promise.then(onFulfilled, onRejected)
		},
		catch: (onRejected) => websiteMetadata.promise.catch(onRejected),
		finally: (onFinally) => websiteMetadata.promise.finally(onFinally),
		[Symbol.toStringTag]: 'Promise',
	}
	return { websiteAfterAccessDecision, accessDecided: accessDecided.promise, releaseWebsite: () => { websiteMetadata.resolve(website) } }
}

// An approved website whose account has address access, with the Interceptor in simulation mode on the default network.
async function setUpApprovedWebsiteInSimulationMode() {
	installBrowserMock()
	const modules = await loadModules()
	await modules.setUseSignersAddressAsActiveAddress(false)
	await modules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: account })
	await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])
	const { port, messages } = createPort(socket.tabId)
	const connections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
		[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
	} }]])
	return { modules, port, messages, connections }
}

// Starts a wallet_addEthereumChain request in simulation mode from an approved website and returns once its access is decided; the caller changes settings, then releases the website metadata.
async function startRequestInSimulationMode() {
	const { modules, port, messages, connections } = await setUpApprovedWebsiteInSimulationMode()
	const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
	const gate = createWebsiteMetadataGate()
	const request = modules.handleInterceptedRequest(port, websiteOrigin, gate.websiteAfterAccessDecision, simulationServicesOwner, socket, {
		interceptorRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 51, requestSocket: socket },
		method: 'wallet_addEthereumChain',
		params: [{ chainId: '0x2a', chainName: 'Example', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.example'] }],
	}, connections, noopPublishRpcConnectionStatus)
	await gate.accessDecided
	const finish = async () => {
		gate.releaseWebsite()
		await request
		return messages.filter((message) => message.requestId === 51)
	}
	return { changeSimulationMode: modules.changeSimulationMode, finish }
}

describe('intercepted request settings context', () => {
	test('executes a request in the mode its access was decided in', async () => {
		const { changeSimulationMode, finish } = await startRequestInSimulationMode()
		await changeSimulationMode({ simulationMode: false })
		const replies = await finish()

		// Simulation mode answers locally; a signing-mode snapshot would have forwarded the request to the wallet.
		assert.equal(replies.some((message) => message.type === 'forwardToSigner'), false)
		assert.equal(replies.at(-1)?.error?.code, 10000)
	})

	test('decides access again when the active network changes while the website metadata loads', async () => {
		const { changeSimulationMode, finish } = await startRequestInSimulationMode()
		// The network switch installs simulation services for Optimism, so the simulation-mode snapshot on Ethereum must not execute with them.
		await changeSimulationMode({ simulationMode: false, rpcNetwork: optimism })
		const replies = await finish()

		// Decided again on the current settings: in signing mode the request needs a wallet account, and no wallet is connected here, so it is refused instead of being answered by the simulation.
		assert.equal(replies.some((message) => message.type === 'forwardToSigner'), false)
		assert.equal(replies.at(-1)?.error?.code, 4100)
	})
})
