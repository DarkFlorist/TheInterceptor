import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { waitFor } from '../harness/async.js'
import { replaceProperty } from '../harness/globals.js'
import { createFakeWindow, type FakePageWindow, getPageProvider, type InpageRequest, withFakeInpageWindow } from './inpageSignerBridgeHarness.js'
import { readProperty } from '../harness/assertions.js'

const isPropertyPresent = (value: unknown, property: PropertyKey) => typeof value === 'object' && value !== null && property in value

// Models a signer that writes its accounts onto window.ethereum or window.web3 itself; Reflect.set fails quietly where strict-mode assignment would throw a TypeError for a read-only property.
function attemptSignerAssignment(target: unknown, property: PropertyKey, value: unknown) {
	if (typeof target === 'object' && target !== null) Reflect.set(target, property, value)
}

function createLockedCompatibilitySigner() {
	const baseSigner = {
		isMetaMask: true,
		isConnected: () => true,
		request: async ({ method }: { method: string }) => {
			switch (method) {
				case 'eth_chainId':
					return '0x1'
				default:
					throw new Error(`Unexpected signer request: ${ method }`)
			}
		},
		on: () => baseSigner,
		removeListener: () => baseSigner,
	}

	Object.defineProperty(baseSigner, 'selectedAddress', {
		configurable: false,
		enumerable: true,
		get: () => undefined,
	})

	return baseSigner
}

function createConfigurableGetterOnlyCompatibilitySigner() {
	const baseSigner = {
		isMetaMask: true,
		isConnected: () => true,
		request: async ({ method }: { method: string }) => {
			switch (method) {
				case 'eth_chainId':
					return '0x1'
				default:
					throw new Error(`Unexpected signer request: ${ method }`)
			}
		},
		on: () => baseSigner,
		removeListener: () => baseSigner,
	}

	Object.defineProperty(baseSigner, 'selectedAddress', {
		configurable: true,
		enumerable: true,
		get: () => undefined,
	})

	return baseSigner
}

describe('inpage MetaMask compatibility properties', () => {
	test('preserves large chain IDs in the legacy networkVersion compatibility property', async () => {
		const largeChainId = '0x20000000000001'
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundReply) => {
				if (request.method === 'connected_to_signer') {
					sendBackgroundReply({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: request.method,
						result: { metamaskCompatibilityMode: true },
					})
					return true
				}
				if (request.method !== 'eth_chainId') return false
				sendBackgroundReply({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: request.method,
					result: largeChainId,
				})
				return true
			},
		})
		Reflect.deleteProperty(fakeWindow, 'ethereum')

		await withFakeInpageWindow(fakeWindow, 'large-network-version', async () => {
			const provider = getPageProvider(fakeWindow)
			assert.equal(await provider.request({ method: 'eth_chainId' }), largeChainId)
			assert.equal(provider.networkVersion, '9007199254740993')
		})
	})

	test('keeps signer selectedAddress mutations hidden until Interceptor account replay', async () => {
		const signerAccount = '0x1111111111111111111111111111111111111111'
		let mutationAttempted = false
		let pendingRequest: InpageRequest | undefined
		let pendingSendBackgroundMessage: ((data: unknown) => void) | undefined
		let exposedWindow: FakePageWindow | undefined
		const createdWindow = createFakeWindow({
			signerInitialSelectedAddress: signerAccount,
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method !== 'eth_requestAccounts') return false
				if (exposedWindow === undefined) throw new Error('fake window was not initialized')
				attemptSignerAssignment(exposedWindow.ethereum, 'selectedAddress', signerAccount)
				if ('web3' in exposedWindow && exposedWindow.web3 !== undefined) attemptSignerAssignment(exposedWindow.web3, 'accounts', [signerAccount])
				mutationAttempted = true
				pendingRequest = request
				pendingSendBackgroundMessage = sendBackgroundMessageForRequest
				return true
			},
		})
		const { fakeWindow, signerRequests, sendBackgroundMessage } = createdWindow
		exposedWindow = fakeWindow

		await withFakeInpageWindow(fakeWindow, 'selected-address-mutation-mask', async () => {
			const provider = getPageProvider(fakeWindow)
			await waitFor(() => signerRequests.includes('eth_chainId'))
			assert.equal(provider.selectedAddress, undefined)
			assert.deepEqual(provider.send({ id: 1, method: 'eth_accounts', params: [] }).result, [])
			assert.deepEqual(readProperty(fakeWindow.web3, 'accounts'), [])

			const requestPromise = provider.request({ method: 'eth_requestAccounts' })
			await waitFor(() => mutationAttempted)
			assert.equal(provider.selectedAddress, undefined)
			assert.deepEqual(provider.send({ id: 2, method: 'eth_accounts', params: [] }).result, [])
			assert.deepEqual(readProperty(fakeWindow.web3, 'accounts'), [])
			if (pendingRequest === undefined || pendingSendBackgroundMessage === undefined) throw new Error('eth_requestAccounts was not captured')

			pendingSendBackgroundMessage({
				interceptorApproved: true,
				requestId: pendingRequest.requestId,
				type: 'result',
				method: 'connect',
				result: ['0x1'],
			})
			pendingSendBackgroundMessage({
				interceptorApproved: true,
				requestId: pendingRequest.requestId,
				type: 'result',
				method: 'accountsChanged',
				result: [signerAccount],
			})
			pendingSendBackgroundMessage({
				interceptorApproved: true,
				requestId: pendingRequest.requestId,
				type: 'result',
				method: 'eth_accounts',
				result: [signerAccount],
			})
			const accountReply = await requestPromise
			assert.deepEqual(accountReply, [signerAccount])
			assert.equal(provider.selectedAddress, signerAccount)
			pendingSendBackgroundMessage({
				interceptorApproved: true,
				requestId: pendingRequest.requestId,
				type: 'result',
				method: 'accountsChanged',
				result: [signerAccount],
			})
			await waitFor(() => provider.selectedAddress === signerAccount)
			assert.deepEqual(provider.send({ id: 3, method: 'eth_accounts', params: [] }).result, [signerAccount])
			assert.deepEqual(readProperty(fakeWindow.web3, 'accounts'), [signerAccount])

			const accountEvents: unknown[] = []
			const disconnectEvents: unknown[] = []
			provider.on('accountsChanged', (accounts) => accountEvents.push(accounts))
			provider.on('disconnect', (error) => disconnectEvents.push(error))
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'accountsChanged',
				result: [],
			})
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'disconnect',
				result: [],
			})
			await waitFor(() => provider.selectedAddress === undefined && !provider.isConnected())
			assert.deepEqual(accountEvents, [[]])
			assert.deepEqual(disconnectEvents, [{ name: 'disconnect', code: 4900, message: 'Provider disconnected from all chains.' }])
			assert.deepEqual(provider.send({ id: 4, method: 'eth_accounts', params: [] }).result, [])
			assert.deepEqual(readProperty(fakeWindow.web3, 'accounts'), [])
		})
	})

	test('freezes non-configurable writable compatibility properties before signer mutation can expose accounts', async () => {
		const signerAccount = '0x1111111111111111111111111111111111111111'
		let mutationAttempted = false
		let pendingRequest: InpageRequest | undefined
		let pendingSendBackgroundMessage: ((data: unknown) => void) | undefined
		let exposedWindow: FakePageWindow | undefined
		const createdWindow = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method !== 'eth_requestAccounts') return false
				if (exposedWindow === undefined) throw new Error('fake window was not initialized')
				attemptSignerAssignment(exposedWindow.ethereum, 'selectedAddress', signerAccount)
				if ('web3' in exposedWindow && exposedWindow.web3 !== undefined) attemptSignerAssignment(exposedWindow.web3, 'accounts', [signerAccount])
				mutationAttempted = true
				pendingRequest = request
				pendingSendBackgroundMessage = sendBackgroundMessageForRequest
				return true
			},
		})
		const { fakeWindow, fakeSigner, signerRequests } = createdWindow
		exposedWindow = fakeWindow
		Object.defineProperty(fakeSigner, 'selectedAddress', {
			configurable: false,
			enumerable: true,
			value: signerAccount,
			writable: true,
		})
		const legacyWeb3 = { accounts: [signerAccount], currentProvider: fakeSigner }
		fakeWindow.web3 = legacyWeb3
		Object.defineProperty(legacyWeb3, 'accounts', {
			configurable: false,
			enumerable: true,
			value: [signerAccount],
			writable: true,
		})

		await withFakeInpageWindow(fakeWindow, 'non-configurable-writable-compatibility-mask', async () => {
			const provider = getPageProvider(fakeWindow)
			await waitFor(() => signerRequests.includes('eth_chainId'))
			assert.equal(provider.selectedAddress, undefined)
			assert.deepEqual(provider.send({ id: 1, method: 'eth_accounts', params: [] }).result, [])
			assert.deepEqual(readProperty(fakeWindow.web3, 'accounts'), [])

			const requestPromise = provider.request({ method: 'eth_requestAccounts' })
			await waitFor(() => mutationAttempted)
			assert.equal(provider.selectedAddress, undefined)
			assert.deepEqual(provider.send({ id: 2, method: 'eth_accounts', params: [] }).result, [])
			assert.deepEqual(readProperty(fakeWindow.web3, 'accounts'), [])
			if (pendingRequest === undefined || pendingSendBackgroundMessage === undefined) throw new Error('eth_requestAccounts was not captured')

			pendingSendBackgroundMessage({
				interceptorApproved: true,
				requestId: pendingRequest.requestId,
				type: 'result',
				method: 'connect',
				result: ['0x1'],
			})
			pendingSendBackgroundMessage({
				interceptorApproved: true,
				requestId: pendingRequest.requestId,
				type: 'result',
				method: 'accountsChanged',
				result: [signerAccount],
			})
			pendingSendBackgroundMessage({
				interceptorApproved: true,
				requestId: pendingRequest.requestId,
				type: 'result',
				method: 'eth_accounts',
				result: [signerAccount],
			})
			assert.deepEqual(await requestPromise, [signerAccount])
			assert.equal(provider.selectedAddress, signerAccount)
			assert.deepEqual(readProperty(fakeWindow.web3, 'accounts'), [signerAccount])
		})
	})

	test('skips readonly compatibility properties without warning', async () => {
		const { fakeWindow } = createFakeWindow()
		const warnings: unknown[] = []
		fakeWindow.ethereum = createLockedCompatibilitySigner()
		const restoreWarn = replaceProperty(console, 'warn', (...args: unknown[]) => { warnings.push(args) })

		try {
			await withFakeInpageWindow(fakeWindow, 'locked-compatibility', async () => {
				await waitFor(() => isPropertyPresent(fakeWindow.ethereum, 'isInterceptor'))
				assert.equal(readProperty(fakeWindow.ethereum, 'selectedAddress'), undefined)
				assert.deepEqual(warnings, [])
			})
		} finally {
			restoreWarn()
		}
	})

	test('does not invoke an accessor-backed window.web3 compatibility shim', async () => {
		let connectedToSigner = false
		let web3GetterCalls = 0
		const { fakeWindow } = createFakeWindow({
			onConnectedToSignerRequest: () => {
				connectedToSigner = true
			},
		})
		Object.defineProperty(fakeWindow, 'web3', {
			configurable: true,
			enumerable: true,
			get: () => {
				web3GetterCalls++
				return { currentProvider: fakeWindow.ethereum }
			},
		})

		await withFakeInpageWindow(fakeWindow, 'accessor-backed-web3-compatibility', async () => {
			await waitFor(() => connectedToSigner)
			assert.equal(web3GetterCalls, 0)
			const descriptor = Object.getOwnPropertyDescriptor(fakeWindow, 'web3')
			assert.equal(descriptor !== undefined && 'value' in descriptor, true)
		})
	})

	test('does not assign through the MetaMask window.web3 proxy shim', async () => {
		let connectedToSigner = false
		let web3ShimAssignments = 0
		const { fakeWindow } = createFakeWindow({
			onConnectedToSignerRequest: () => {
				connectedToSigner = true
			},
		})
		const web3ShimTarget = { currentProvider: fakeWindow.ethereum }
		Object.defineProperty(web3ShimTarget, '__isMetaMaskShim__', {
			configurable: false,
			enumerable: true,
			value: true,
			writable: false,
		})
		const web3Shim = new Proxy(web3ShimTarget, {
			set: (target, property, value) => {
				web3ShimAssignments++
				return Reflect.set(target, property, value)
			},
		})
		fakeWindow.web3 = web3Shim

		await withFakeInpageWindow(fakeWindow, 'metamask-web3-proxy-compatibility', async () => {
			await waitFor(() => connectedToSigner)
			assert.equal(web3ShimAssignments, 0)
			assert.notEqual(fakeWindow.web3, web3Shim)
			assert.equal(readProperty(fakeWindow.web3, 'currentProvider'), fakeWindow.ethereum)
		})
	})

	test('skips non-configurable accessor compatibility arrays without reading descriptor value', async () => {
		let connectedToSigner = false
		const { fakeWindow } = createFakeWindow({
			onConnectedToSignerRequest: () => {
				connectedToSigner = true
			},
		})
		const web3 = { currentProvider: fakeWindow.ethereum }
		Object.defineProperty(web3, 'accounts', {
			configurable: false,
			enumerable: true,
			get: () => [],
		})
		Object.defineProperty(fakeWindow, 'web3', {
			configurable: false,
			enumerable: true,
			value: web3,
			writable: false,
		})

		await withFakeInpageWindow(fakeWindow, 'non-configurable-accessor-empty-array-compatibility', async () => {
			await waitFor(() => connectedToSigner)
			assert.equal(isPropertyPresent(fakeWindow.ethereum, 'isInterceptor'), true)
			assert.deepEqual(readProperty(web3, 'accounts'), [])
			assert.equal(isPropertyPresent(web3.currentProvider, 'isInterceptor'), true)
		})
	})

	test('updates configurable getter-only compatibility properties without throwing', async () => {
		let connectedToSigner = false
		const { fakeWindow, sendBackgroundMessage } = createFakeWindow({
			onConnectedToSignerRequest: () => {
				connectedToSigner = true
			},
		})
		const warnings: unknown[] = []
		fakeWindow.ethereum = createConfigurableGetterOnlyCompatibilitySigner()
		const restoreWarn = replaceProperty(console, 'warn', (...args: unknown[]) => { warnings.push(args) })

		try {
			await withFakeInpageWindow(fakeWindow, 'configurable-getter-compatibility', async () => {
				await waitFor(() => connectedToSigner)
				sendBackgroundMessage({
					interceptorApproved: true,
					type: 'result',
					method: 'accountsChanged',
					result: ['0x1111111111111111111111111111111111111111'],
				})
				await waitFor(() => readProperty(fakeWindow.ethereum, 'selectedAddress') === '0x1111111111111111111111111111111111111111')
				assert.deepEqual(readProperty(fakeWindow.ethereum, 'selectedAddress'), '0x1111111111111111111111111111111111111111')
				assert.deepEqual(warnings, [])
			})
		} finally {
			restoreWarn()
		}
	})

	test('keeps controlled compatibility properties working after target becomes non-extensible', async () => {
		let fakeWindowWithSigner: FakePageWindow | undefined
		const { fakeWindow, sendBackgroundMessage, signerRequests } = createFakeWindow({
			onConnectedToSignerRequest: () => {
				const injectedProvider = fakeWindowWithSigner?.ethereum
				if (typeof injectedProvider !== 'object' || injectedProvider === null) return
				Object.preventExtensions(injectedProvider)
			},
		})
		fakeWindowWithSigner = fakeWindow
		const warnings: string[] = []
		const restoreWarn = replaceProperty(console, 'warn', (...args: unknown[]) => { warnings.push(String(args[0])) })

		try {
			await withFakeInpageWindow(fakeWindow, 'non-extensible-compatibility', async () => {
				await waitFor(() => signerRequests.includes('eth_chainId'))
				sendBackgroundMessage({
					interceptorApproved: true,
					type: 'result',
					method: 'accountsChanged',
					result: ['0x1111111111111111111111111111111111111111'],
				})
				await waitFor(() => readProperty(fakeWindow.ethereum, 'selectedAddress') === '0x1111111111111111111111111111111111111111')
				assert.deepEqual(warnings, [])
			})
		} finally {
			restoreWarn()
		}
	})

})
