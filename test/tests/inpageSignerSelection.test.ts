import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { waitFor } from '../harness/async.js'
import { createFakeWindow, getPageProvider, type InpageRequest, isEthAccountsReplyCandidate, parseSignerReply, waitOneEventLoopTurn, withFakeInpageWindow } from './inpageSignerBridgeHarness.js'

type ThrowingProviderProperty = 'isMetaMask' | 'request' | 'on' | 'isBraveWallet'
const throwingMetaMaskProviderProperties: readonly ThrowingProviderProperty[] = ['isMetaMask', 'request', 'on', 'isBraveWallet']

function createThrowingMetaMaskProviderProperty(property: ThrowingProviderProperty) {
	const provider = {
		isMetaMask: true,
		isConnected: () => true,
		request: async () => undefined,
		on: () => provider,
	}
	Object.defineProperty(provider, property, {
		configurable: true,
		get: () => { throw new Error(`Invalid ${ property } getter`) },
	})
	return provider
}

describe('inpage signer selection between injected, aggregated and EIP-6963 announced wallets', () => {
	test('waits for late MetaMask instead of using Brave for the first account request and signing', async () => {
		const signerAccountReplies: unknown[] = []
		const connectedSignerNames: unknown[] = []
		const signerRequestMethods: string[] = []
		const braveSignerRequestMethods: string[] = []
		const signedTransactionHash = '0x2222222222222222222222222222222222222222222222222222222222222222'
		let pendingAccountRequest: InpageRequest | undefined
		const { fakeWindow, fakeSigner, signerAccounts, sendBackgroundMessage } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method === 'connected_to_signer') {
					connectedSignerNames.push(request.params?.[1])
					return false
				}
				if (request.method === 'eth_requestAccounts' && request.internal !== true) {
					pendingAccountRequest = request
					return true
				}
				if (request.method === 'eth_accounts_reply') {
					const signerAccountsReply = request.params?.[0]
					if (!isEthAccountsReplyCandidate(signerAccountsReply)) throw new Error('Malformed signer accounts reply')
					signerAccountReplies.push(signerAccountsReply)
					sendBackgroundMessageForRequest({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'eth_accounts_reply',
						result: undefined,
					})
					const accountRequest = pendingAccountRequest
					if (signerAccountsReply.type !== 'success' || !Array.isArray(signerAccountsReply.accounts) || accountRequest === undefined) return true
					pendingAccountRequest = undefined
					sendBackgroundMessageForRequest({
						interceptorApproved: true,
						requestId: accountRequest.requestId,
						type: 'result',
						method: 'eth_accounts',
						result: signerAccountsReply.accounts,
					})
					return true
				}
				if (request.method === 'eth_sendTransaction') {
					sendBackgroundMessageForRequest({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'forwardToSigner',
						method: request.method,
						params: request.params,
					})
					return true
				}
				if (request.method !== 'signer_reply') return false
				const signerReply = parseSignerReply(request)
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: signerReply.forwardRequest.requestId,
					type: 'result',
					method: 'eth_sendTransaction',
					result: signerReply.reply,
				})
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'signer_reply',
					result: '0x',
				})
				return true
			},
			handleSignerRequest: ({ method }) => {
				signerRequestMethods.push(method)
				if (method === 'eth_sendTransaction') return signedTransactionHash
				return undefined
			},
		})
		const lateMetaMaskProvider = fakeSigner
		const braveSigner = {
			isBraveWallet: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				braveSignerRequestMethods.push(method)
				if (method === 'eth_chainId') return '0x1'
				if (method === 'eth_accounts' || method === 'eth_requestAccounts') return []
				throw new Error(`Unexpected Brave signer request: ${ method }`)
			},
			on: () => braveSigner,
			removeListener: () => braveSigner,
		}
		Object.defineProperty(fakeWindow, 'ethereum', { configurable: true, writable: true, value: braveSigner })

		await withFakeInpageWindow(fakeWindow, 'late-metamask-first-connect-and-signing', async () => {
			const interceptorProvider = getPageProvider(fakeWindow)
			const accountRequest = interceptorProvider.request({ method: 'eth_requestAccounts' })
			await waitFor(() => pendingAccountRequest !== undefined)
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			await waitOneEventLoopTurn()
			assert.equal(braveSignerRequestMethods.includes('eth_requestAccounts'), false)

			fakeWindow.addEventListener('eip6963:requestProvider', () => fakeWindow.dispatchEvent({
				type: 'eip6963:announceProvider',
				detail: {
					info: { uuid: '55555555-5555-4555-8555-555555555555', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' },
					provider: lateMetaMaskProvider,
				},
			}))

			await waitFor(() => signerAccountReplies.length === 1, { timeoutMs: 500 })
			assert.deepEqual(signerAccountReplies, [{ type: 'success', accounts: signerAccounts, requestAccounts: true, signerProviderGeneration: 4 }])
			assert.deepEqual(await accountRequest, signerAccounts)
			assert.equal(await interceptorProvider.request({ method: 'eth_sendTransaction', params: [{ from: signerAccounts[0] }] }), signedTransactionHash)
		})

		assert.deepEqual(connectedSignerNames, ['Brave', 'MetaMask'])
		assert.equal(braveSignerRequestMethods.includes('eth_requestAccounts'), false)
		assert.equal(signerRequestMethods.includes('eth_requestAccounts'), true)
		assert.equal(signerRequestMethods.includes('eth_sendTransaction'), true)
	})

	test('retries an in-flight Brave account request when MetaMask becomes available', async () => {
		const connectedSignerNames: unknown[] = []
		const braveSignerRequestMethods: string[] = []
		const braveAccounts = ['0x3333333333333333333333333333333333333333']
		let resolveBraveAccounts: ((accounts: string[]) => void) | undefined
		const { fakeWindow, fakeSigner, signerAccounts, backgroundEthAccountsReplies, sendBackgroundMessage } = createFakeWindow({
			handleRequest: (request) => {
				if (request.method === 'connected_to_signer') connectedSignerNames.push(request.params?.[1])
				return false
			},
		})
		const lateMetaMaskProvider = fakeSigner
		const braveSigner = {
			isBraveWallet: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				braveSignerRequestMethods.push(method)
				if (method === 'eth_chainId') return '0x1'
				if (method === 'eth_requestAccounts') {
					return await new Promise<string[]>((resolve) => { resolveBraveAccounts = resolve })
				}
				if (method === 'eth_accounts') return braveAccounts
				throw new Error(`Unexpected Brave signer request: ${ method }`)
			},
			on: () => braveSigner,
			removeListener: () => braveSigner,
		}
		Object.defineProperty(fakeWindow, 'ethereum', { configurable: true, writable: true, value: braveSigner })

		await withFakeInpageWindow(fakeWindow, 'replace-in-flight-brave-accounts', async () => {
			await waitFor(() => connectedSignerNames.includes('Brave'))
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			await waitFor(() => resolveBraveAccounts !== undefined, { timeoutMs: 3500 })

			fakeWindow.addEventListener('eip6963:requestProvider', () => fakeWindow.dispatchEvent({
				type: 'eip6963:announceProvider',
				detail: {
					info: { uuid: '66666666-6666-4666-8666-666666666666', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' },
					provider: lateMetaMaskProvider,
				},
			}))
			fakeWindow.dispatchEvent({ type: 'ethereum#initialized' })

			await waitFor(() => connectedSignerNames.includes('MetaMask'))
			await waitFor(() => backgroundEthAccountsReplies.length === 1)
			assert.deepEqual(backgroundEthAccountsReplies, [{ type: 'success', accounts: signerAccounts, requestAccounts: true, signerProviderGeneration: 4 }])

			resolveBraveAccounts?.(braveAccounts)
			await waitOneEventLoopTurn()
			assert.equal(backgroundEthAccountsReplies.length, 1)
		})

		assert.deepEqual(connectedSignerNames, ['Brave', 'MetaMask'])
		assert.equal(braveSignerRequestMethods.filter((method) => method === 'eth_requestAccounts').length, 1)
	}, 7000)

	test('uses a concrete MetaMask provider from an unmarked legacy aggregate for signing', async () => {
		const concreteSignerRequests: string[] = []
		const aggregateSignerRequests: string[] = []
		const signedTransactionHash = '0x2222222222222222222222222222222222222222222222222222222222222222'
		const { fakeWindow, fakeSigner } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method === 'eth_sendTransaction') {
					sendBackgroundMessageForRequest({ interceptorApproved: true, requestId: request.requestId, type: 'forwardToSigner', method: request.method, params: request.params })
					return true
				}
				if (request.method !== 'signer_reply') return false
				const signerReply = parseSignerReply(request)
				sendBackgroundMessageForRequest({ interceptorApproved: true, requestId: signerReply.forwardRequest.requestId, type: 'result', method: 'eth_sendTransaction', result: signerReply.reply })
				sendBackgroundMessageForRequest({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: 'signer_reply', result: '0x' })
				return true
			},
			handleSignerRequest: ({ method }) => {
				concreteSignerRequests.push(method)
				if (method === 'eth_sendTransaction') return signedTransactionHash
				return undefined
			},
		})
		const concreteMetaMaskProvider = fakeSigner
		const invalidConnectedMetaMaskProvider = {
			isMetaMask: true,
			isConnected: true,
			request: async () => undefined,
			on: () => invalidConnectedMetaMaskProvider,
		}
		const throwingMetaMaskProvider = {
			isMetaMask: true,
			request: async () => undefined,
			on: () => { throw new Error('Invalid provider subscription') },
		}
		const throwingConnectedMetaMaskProvider = {
			isMetaMask: true,
			isConnected: () => { throw new Error('Invalid provider connection state') },
			request: async () => undefined,
			on: () => throwingConnectedMetaMaskProvider,
		}
		const conflictingMetaMaskProviders = [
			{ ...concreteMetaMaskProvider, isAmbire: true },
			{ ...concreteMetaMaskProvider, isBraveWallet: true },
			{ ...concreteMetaMaskProvider, isCoinbaseWallet: true },
			{ ...concreteMetaMaskProvider, isRabby: true },
			{ ...concreteMetaMaskProvider, isInterceptor: true },
		]
		let statefulMetaMaskMarkerReads = 0
		const statefulMetaMaskProvider = { ...concreteMetaMaskProvider }
		Object.defineProperty(statefulMetaMaskProvider, 'isMetaMask', {
			get: () => {
				statefulMetaMaskMarkerReads++
				if (statefulMetaMaskMarkerReads > 3) throw new Error('MetaMask marker was read after preparation')
				return true
			},
		})
		const throwingGetterProviders = throwingMetaMaskProviderProperties.map(createThrowingMetaMaskProviderProperty)
		const legacyProviders = [undefined, null, 1, ...throwingGetterProviders, invalidConnectedMetaMaskProvider, throwingConnectedMetaMaskProvider, throwingMetaMaskProvider, ...conflictingMetaMaskProviders, statefulMetaMaskProvider, concreteMetaMaskProvider]
		Object.defineProperty(legacyProviders, 0, { configurable: true, get: () => { throw new Error('Invalid legacy provider entry') } })
		const aggregateProvider = {
			providers: legacyProviders,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				aggregateSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x1'
				return await new Promise<never>(() => undefined)
			},
			on: () => aggregateProvider,
			removeListener: () => aggregateProvider,
		}
		for (const rootProperty of ['isBraveWallet', 'providerMap', 'isCoinbaseWallet']) {
			Object.defineProperty(aggregateProvider, rootProperty, { get: () => { throw new Error(`Invalid aggregate ${ rootProperty }`) } })
		}
		Object.defineProperty(fakeWindow, 'ethereum', { configurable: true, writable: true, value: aggregateProvider })

		await withFakeInpageWindow(fakeWindow, 'legacy-unmarked-metamask-signing', async () => {
			const result = await getPageProvider(fakeWindow).request({ method: 'eth_sendTransaction', params: [{ from: '0x1111111111111111111111111111111111111111' }] })
			assert.equal(result, signedTransactionHash)
		})

		assert.equal(concreteSignerRequests.includes('eth_sendTransaction'), true)
		assert.equal(aggregateSignerRequests.includes('eth_sendTransaction'), false)
		assert.equal(statefulMetaMaskMarkerReads, 3)
	})

	test('uses an EIP-6963 announced MetaMask provider instead of Brave for signing', async () => {
		const concreteSignerRequests: string[] = []
		const aggregateSignerRequests: string[] = []
		const aggregateEventHandlers = new Map<string, (value: unknown) => void>()
		const ignoredProviderSubscriptions: string[] = []
		const announcedProviderSubscriptions: string[] = []
		const duplicateProviderSubscriptions: string[] = []
		const backgroundMessages: InpageRequest[] = []
		const signedTransactionHash = '0x1111111111111111111111111111111111111111111111111111111111111111'
		const { fakeWindow, fakeSigner, emitSignerEvent } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				backgroundMessages.push(request)
				if (request.method === 'eth_sendTransaction') {
					sendBackgroundMessageForRequest({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'forwardToSigner',
						method: request.method,
						params: request.params,
					})
					return true
				}
				if (request.method !== 'signer_reply') return false
				const signerReply = parseSignerReply(request)
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: signerReply.forwardRequest.requestId,
					type: 'result',
					method: 'eth_sendTransaction',
					result: signerReply.reply,
				})
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'signer_reply',
					result: '0x',
				})
				return true
			},
			handleSignerRequest: ({ method }) => {
				concreteSignerRequests.push(method)
				if (method === 'eth_sendTransaction') return signedTransactionHash
				return undefined
			},
		})
		const concreteMetaMaskProvider = fakeSigner
		const aggregateProvider = {
			isBraveWallet: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				aggregateSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x1'
				if (method === 'eth_accounts' || method === 'eth_requestAccounts') return ['0x1111111111111111111111111111111111111111']
				return await new Promise<never>(() => undefined)
			},
			on: (kind: string, callback: (value: unknown) => void) => {
				aggregateEventHandlers.set(kind, callback)
				return aggregateProvider
			},
			removeListener: () => aggregateProvider,
		}
		const announcedMetaMaskProvider = {
			isConnected: concreteMetaMaskProvider.isConnected,
			request: concreteMetaMaskProvider.request,
			on: (kind: string, callback: (value: unknown) => void) => {
				announcedProviderSubscriptions.push(kind)
				return concreteMetaMaskProvider.on(kind, callback)
			},
			removeListener: concreteMetaMaskProvider.removeListener,
		}
		const ignoredProvider = {
			request: async () => undefined,
			on: (kind: string) => {
				ignoredProviderSubscriptions.push(kind)
				return ignoredProvider
			},
		}
		const duplicateMetaMaskProvider = {
			request: async () => undefined,
			on: (kind: string) => {
				duplicateProviderSubscriptions.push(kind)
				return duplicateMetaMaskProvider
			},
		}
		const throwingAnnouncedProvider = {
			request: async () => undefined,
			on: () => { throw new Error('Invalid announced provider subscription') },
		}
		const partialSubscriptions = new Map<string, (value: unknown) => void>()
		const partiallyThrowingAnnouncedProvider = {
			request: async () => undefined,
			on: (kind: string, callback: (value: unknown) => void) => {
				partialSubscriptions.set(kind, callback)
				if (partialSubscriptions.size === 3) throw new Error('Invalid partial provider subscription')
				return partiallyThrowingAnnouncedProvider
			},
			removeListener: (kind: string) => {
				partialSubscriptions.delete(kind)
				return partiallyThrowingAnnouncedProvider
			},
		}
		let statefulRequestProviderSubscriptions = 0
		let statefulRequestReads = 0
		const statefulRequestAnnouncedProvider = {
			on: () => {
				statefulRequestProviderSubscriptions++
				return statefulRequestAnnouncedProvider
			},
			removeListener: () => statefulRequestAnnouncedProvider,
		}
		Object.defineProperty(statefulRequestAnnouncedProvider, 'request', {
			get: () => {
				statefulRequestReads++
				if (statefulRequestReads > 1) throw new Error('Invalid stateful request getter')
				return async () => undefined
			},
		})
		const metaMaskInfo = { uuid: '11111111-1111-4111-8111-111111111111', name: 'MetaMask', icon: 'data:image/png;base64,dGVzdA', rdns: 'io.metamask' }
		const throwingGetterProviders = throwingMetaMaskProviderProperties.map(createThrowingMetaMaskProviderProperty)
		Object.defineProperty(fakeWindow, 'ethereum', { configurable: true, writable: true, value: aggregateProvider })
		fakeWindow.addEventListener('eip6963:requestProvider', () => {
			const hostileAnnouncementError = {
				get message() { throw new Error('Invalid hostile announcement error message getter') },
				toString() { throw new Error('Invalid hostile announcement error toString') },
			}
			const throwingDetailEvent = { type: 'eip6963:announceProvider', detail: undefined }
			Object.defineProperty(throwingDetailEvent, 'detail', { get: () => { throw hostileAnnouncementError } })
			fakeWindow.dispatchEvent(throwingDetailEvent)
			for (const detailProperty of ['provider', 'info']) {
				const detail = { provider: ignoredProvider, info: metaMaskInfo }
				Object.defineProperty(detail, detailProperty, { get: () => { throw new Error(`Invalid announcement ${ detailProperty }`) } })
				fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail })
			}
			for (const infoProperty of ['uuid', 'name', 'icon', 'rdns']) {
				const info = { ...metaMaskInfo }
				Object.defineProperty(info, infoProperty, { get: () => { throw new Error(`Invalid announcement ${ infoProperty }`) } })
				fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { provider: ignoredProvider, info } })
			}
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { provider: announcedMetaMaskProvider } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: { ...metaMaskInfo, rdns: 'com.example.wallet' }, provider: { ...ignoredProvider, isMetaMask: true } } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: { ...metaMaskInfo, uuid: 'not-a-uuid' }, provider: ignoredProvider } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: { ...metaMaskInfo, name: 'Another wallet' }, provider: ignoredProvider } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: { ...metaMaskInfo, icon: '' }, provider: ignoredProvider } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: { ...metaMaskInfo, icon: 'data:image/not-a-data-uri' }, provider: ignoredProvider } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: { ...metaMaskInfo, icon: 'data:image/png;base64,not@@base64' }, provider: ignoredProvider } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: { ...metaMaskInfo, icon: 'data:image/svg+xml,%ZZ' }, provider: ignoredProvider } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: metaMaskInfo, provider: { ...ignoredProvider, isMetaMask: 'yes' } } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: metaMaskInfo, provider: { ...ignoredProvider, isMetaMask: false } } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: metaMaskInfo, provider: { ...ignoredProvider, isBraveWallet: true } } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: metaMaskInfo, provider: { ...ignoredProvider, isCoinbaseWallet: true } } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: metaMaskInfo, provider: { ...ignoredProvider, isInterceptor: true } } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: metaMaskInfo, provider: { ...ignoredProvider, isConnected: true } } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: metaMaskInfo, provider: throwingAnnouncedProvider } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: metaMaskInfo, provider: partiallyThrowingAnnouncedProvider } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: metaMaskInfo, provider: statefulRequestAnnouncedProvider } })
			for (const provider of throwingGetterProviders) fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: metaMaskInfo, provider } })
			fakeWindow.dispatchEvent({
				type: 'eip6963:announceProvider',
				detail: {
					info: metaMaskInfo,
					provider: announcedMetaMaskProvider,
				},
			})
			fakeWindow.dispatchEvent({
				type: 'eip6963:announceProvider',
				detail: {
					info: metaMaskInfo,
					provider: duplicateMetaMaskProvider,
				},
			})
		})

		await withFakeInpageWindow(fakeWindow, 'eip6963-metamask-signing', async () => {
			const result = await getPageProvider(fakeWindow).request({ method: 'eth_sendTransaction', params: [{ from: '0x1111111111111111111111111111111111111111' }] })
			assert.equal(result, signedTransactionHash)
		})

		assert.equal(concreteSignerRequests.includes('eth_sendTransaction'), true)
		assert.equal(aggregateSignerRequests.includes('eth_sendTransaction'), false)
		assert.deepEqual(ignoredProviderSubscriptions, [])
		assert.deepEqual(announcedProviderSubscriptions, ['accountsChanged', 'connect', 'disconnect', 'chainChanged'])
		assert.deepEqual(duplicateProviderSubscriptions, [])
		assert.equal(partialSubscriptions.size, 0)
		assert.equal(statefulRequestProviderSubscriptions, 0)
		const hostileAnnouncementDiagnostic = backgroundMessages.find((message) => message.method === 'InterceptorError' && typeof message.params?.[0] === 'string' && message.params[0].includes('phase: read EIP-6963 MetaMask announcement'))
		if (hostileAnnouncementDiagnostic === undefined || typeof hostileAnnouncementDiagnostic.params?.[0] !== 'string') throw new Error('missing hostile EIP-6963 announcement diagnostic')
		assert.match(hostileAnnouncementDiagnostic.params[0], /Failed to read thrown-value summary: Error: Invalid hostile announcement error message getter/)
		await waitFor(() => backgroundMessages.some((message) => message.method === 'signer_chainChanged'))

		const messageCountBeforeStaleEvents = backgroundMessages.length
		aggregateEventHandlers.get('accountsChanged')?.(['0x2222222222222222222222222222222222222222'])
		aggregateEventHandlers.get('connect')?.({ chainId: '0x2' })
		aggregateEventHandlers.get('disconnect')?.({ code: 4900, message: 'disconnected' })
		aggregateEventHandlers.get('chainChanged')?.('0x2')
		await waitOneEventLoopTurn()
		assert.equal(backgroundMessages.length, messageCountBeforeStaleEvents)

		emitSignerEvent('chainChanged', '0x3')
		await waitFor(() => backgroundMessages.some((message) => message.method === 'signer_chainChanged' && message.params?.[0] === '0x3'))
	})

	test('uses an initially announced MetaMask provider instead of MetaMask-compatible Ambire or Rabby', async () => {
		const walletCases = [
			{ name: 'Ambire', marker: { isAmbire: true, isMetaMask: true } },
			{ name: 'Rabby', marker: { isMetaMask: true, isRabby: true } },
		]

		for (const walletCase of walletCases) {
			const connectedSignerNames: unknown[] = []
			const announcedSignerRequests: string[] = []
			const { fakeWindow } = createFakeWindow({
				handleRequest: (request) => {
					if (request.method === 'connected_to_signer') connectedSignerNames.push(request.params?.[1])
					return false
				},
			})
			const rootSigner = {
				...walletCase.marker,
				isConnected: () => true,
				request: async ({ method }: { method: string }) => method === 'eth_chainId' ? '0x1' : [],
				on: () => rootSigner,
				removeListener: () => rootSigner,
			}
			const announcedMetaMaskProvider = {
				isMetaMask: true,
				isConnected: () => true,
				request: async ({ method }: { method: string }) => {
					announcedSignerRequests.push(method)
					return method === 'eth_chainId' ? '0x1' : []
				},
				on: () => announcedMetaMaskProvider,
				removeListener: () => announcedMetaMaskProvider,
			}
			Object.defineProperty(fakeWindow, 'ethereum', { configurable: true, writable: true, value: rootSigner })
			fakeWindow.addEventListener('eip6963:requestProvider', () => fakeWindow.dispatchEvent({
				type: 'eip6963:announceProvider',
				detail: {
					info: { uuid: '55555555-5555-4555-8555-555555555555', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' },
					provider: announcedMetaMaskProvider,
				},
			}))

			await withFakeInpageWindow(fakeWindow, `eip6963-replace-${ walletCase.name }-${ Date.now() }-${ Math.random() }`, async () => {
				await waitFor(() => connectedSignerNames.includes('MetaMask'))
				await waitFor(() => announcedSignerRequests.includes('eth_chainId'))
			})

			assert.deepEqual(connectedSignerNames, [walletCase.name, 'MetaMask'])
		}
	})

	test('reports unusable-root NoSigner before EIP-6963 MetaMask recovery', async () => {
		const connectedSignerNames: unknown[] = []
		const { fakeWindow, fakeSigner, signerRequests } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method !== 'connected_to_signer') return false
				connectedSignerNames.push(request.params?.[1])
				const delay = request.params?.[1] === 'NoSigner' ? 10 : 0
				setTimeout(() => sendBackgroundMessage({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'connected_to_signer',
					result: { metamaskCompatibilityMode: true },
				}), delay)
				return true
			},
		})
		const announcedMetaMaskProvider = fakeSigner
		const unusableRootProvider = {
			on: () => unusableRootProvider,
			removeListener: () => unusableRootProvider,
		}
		Object.defineProperty(unusableRootProvider, 'request', { get: () => { throw new Error('Invalid root request') } })
		Object.defineProperty(fakeWindow, 'ethereum', { configurable: true, writable: true, value: unusableRootProvider })
		fakeWindow.addEventListener('eip6963:requestProvider', () => fakeWindow.dispatchEvent({
			type: 'eip6963:announceProvider',
			detail: {
				info: { uuid: '33333333-3333-4333-8333-333333333333', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' },
				provider: announcedMetaMaskProvider,
			},
		}))

		await withFakeInpageWindow(fakeWindow, 'serialized-no-signer-eip-recovery', async () => {
			await waitFor(() => connectedSignerNames.length === 2)
			await waitFor(() => signerRequests.includes('eth_chainId'))
		})

		assert.deepEqual(connectedSignerNames, ['NoSigner', 'MetaMask'])
	})

	test('recognizes supported MetaMask-compatible wallets and does not replace selected non-MetaMask signers from announcements', async () => {
		const signerCases = [
			{ name: 'Ambire', marker: { isAmbire: true, isMetaMask: true } },
			{ name: 'CoinbaseWallet', marker: { isCoinbaseWallet: true } },
			{ name: 'NotRecognizedSigner', marker: {} },
			{ name: 'Rabby', marker: { isMetaMask: true, isRabby: true } },
		]

		for (const signerCase of signerCases) {
			const connectedSignerNames: unknown[] = []
			let announcedProviderSubscriptionCount = 0
			const { fakeWindow } = createFakeWindow({
				handleRequest: (request) => {
					if (request.method === 'connected_to_signer') connectedSignerNames.push(request.params?.[1])
					return false
				},
			})
			const signer = {
				...signerCase.marker,
				isConnected: () => true,
				request: async ({ method }: { method: string }) => method === 'eth_chainId' ? '0x1' : [],
				on: () => signer,
				removeListener: () => signer,
			}
			Object.defineProperty(fakeWindow, 'ethereum', { configurable: true, writable: true, value: signer })

			await withFakeInpageWindow(fakeWindow, `eip6963-protect-${ signerCase.name }-${ Date.now() }-${ Math.random() }`, async () => {
				await waitFor(() => connectedSignerNames.includes(signerCase.name))
				const announcedProvider = {
					isMetaMask: true,
					request: async () => undefined,
					on: () => {
						announcedProviderSubscriptionCount++
						return announcedProvider
					},
				}
				fakeWindow.dispatchEvent({
					type: 'eip6963:announceProvider',
					detail: { info: { uuid: '22222222-2222-4222-8222-222222222222', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' }, provider: announcedProvider },
				})
				await waitOneEventLoopTurn()
				assert.equal(announcedProviderSubscriptionCount, 0)
				assert.equal(connectedSignerNames.includes('MetaMask'), false)
			})
		}
	})

	test('only replaces a selected Brave signer during requested provider discovery', async () => {
		const connectedSignerNames: unknown[] = []
		let announcedProviderSubscriptionCount = 0
		const { fakeWindow, sendBackgroundMessage } = createFakeWindow({
			handleRequest: (request) => {
				if (request.method === 'connected_to_signer') connectedSignerNames.push(request.params?.[1])
				return false
			},
		})
		const braveSigner = {
			isBraveWallet: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => method === 'eth_chainId' ? '0x1' : [],
			on: () => braveSigner,
			removeListener: () => braveSigner,
		}
		const announcedProvider = {
			isMetaMask: true,
			isConnected: () => true,
			request: async () => undefined,
			on: () => {
				announcedProviderSubscriptionCount += 1
				return announcedProvider
			},
			removeListener: () => announcedProvider,
		}
		Object.defineProperty(fakeWindow, 'ethereum', { configurable: true, writable: true, value: braveSigner })

		await withFakeInpageWindow(fakeWindow, 'eip6963-ignore-late-page-announcement', async () => {
			await waitFor(() => connectedSignerNames.includes('Brave'))
			fakeWindow.dispatchEvent({
				type: 'eip6963:announceProvider',
				detail: {
					info: { uuid: '44444444-4444-4444-8444-444444444444', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' },
					provider: announcedProvider,
				},
			})
			await waitOneEventLoopTurn()
			assert.equal(announcedProviderSubscriptionCount, 0)
			assert.deepEqual(connectedSignerNames, ['Brave'])

			fakeWindow.addEventListener('eip6963:requestProvider', () => fakeWindow.dispatchEvent({
				type: 'eip6963:announceProvider',
				detail: {
					info: { uuid: '44444444-4444-4444-8444-444444444444', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' },
					provider: announcedProvider,
				},
			}))
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			await waitFor(() => connectedSignerNames.includes('MetaMask'))
		})

		assert.equal(announcedProviderSubscriptionCount > 0, true)
		assert.deepEqual(connectedSignerNames, ['Brave', 'MetaMask'])
	})
})
