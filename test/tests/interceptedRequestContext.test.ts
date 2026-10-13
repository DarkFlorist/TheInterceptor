import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { Website } from '../../app/ts/types/websiteAccessTypes.js'
import { confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, createRestoringBrowserMockInstaller, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'

const installBrowserMock = createRestoringBrowserMockInstaller()

describe('intercepted request settings context', () => {
	test('executes a request in the mode its access was decided in', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, updateWebsiteAccess, changeSimulationMode, setUseSignersAddressAsActiveAddress } = await loadModules()
		const websiteOrigin = 'https://mode-switch.example'
		const website: Website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await setUseSignersAddressAsActiveAddress(false)
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account })
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		// The router awaits the website metadata only after it has decided access, which gives the test a point to switch modes in between.
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

		const request = handleInterceptedRequest(port, websiteOrigin, websiteAfterAccessDecision, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 51, requestSocket: socket },
			method: 'wallet_addEthereumChain',
			params: [{ chainId: '0x2a', chainName: 'Example', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.example'] }],
		}, connections, noopPublishRpcConnectionStatus)
		await accessDecided.promise
		await changeSimulationMode({ simulationMode: false })
		websiteMetadata.resolve(website)
		await request

		// Simulation mode answers locally; a signing-mode snapshot would have forwarded the request to the wallet.
		const replies = messages.filter((message) => message.requestId === 51)
		assert.equal(replies.some((message) => message.type === 'forwardToSigner'), false)
		assert.equal(replies.at(-1)?.error?.code, 10000)
	})
})
