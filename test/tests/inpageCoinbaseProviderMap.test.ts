import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { waitFor } from '../harness/async.js'
import { createFakeWindow, getRpcError, type InpageRequest, withFakeInpageWindow } from './inpageSignerBridgeHarness.js'
import { readProperty } from '../harness/assertions.js'

// connected_to_signer requests carry the selected signer name as their second parameter.
function readConnectedSignerName(request: InpageRequest) {
	const signerName = request.params?.[1]
	return typeof signerName === 'string' ? signerName : undefined
}

describe('inpage signer bridge with a Coinbase providerMap', () => {
	test('uses mapped Coinbase provider for signer requests and signer name', async () => {
		let signerName: string | undefined
		const signerRequests: { brave: string[], coinbase: string[] } = {
			brave: [],
			coinbase: [],
		}
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method === 'connected_to_signer') {
					signerName = readConnectedSignerName(request)
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: { metamaskCompatibilityMode: true },
					})
					return true
				}
				return false
			},
		})

		const coinbaseSigner = {
			isCoinbaseWallet: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				signerRequests.coinbase.push(method)
				if (method === 'eth_chainId') return '0x1'
				if (method === 'eth_accounts') return ['0x1111111111111111111111111111111111111111']
				throw new Error(`Unexpected mapped signer request: ${ method }`)
			},
			on: () => coinbaseSigner,
			removeListener: () => coinbaseSigner,
		}
		const braveSigner = {
			isBraveWallet: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				signerRequests.brave.push(method)
				if (method === 'eth_chainId') return '0x99'
				throw new Error(`Unexpected brave signer request: ${ method }`)
			},
			on: () => braveSigner,
			removeListener: () => braveSigner,
		}
		fakeWindow.ethereum = {
			...braveSigner,
			providerMap: new Map([['CoinbaseWallet', coinbaseSigner]]),
		}

		await withFakeInpageWindow(fakeWindow, 'provider-map-coinbase-binding', async () => {
			await waitFor(() => signerName !== undefined)
			await waitFor(() => signerRequests.brave.length === 1 || signerRequests.coinbase.length === 1)
			assert.equal(signerName, 'CoinbaseWallet')
			assert.deepEqual(signerRequests.coinbase, ['eth_chainId'])
			assert.deepEqual(signerRequests.brave, [])
		})
	})

	test('uses providerMap CoinbaseWallet key as signer identity when mapped provider lacks isCoinbaseWallet flag', async () => {
		let signerName: string | undefined
		const signerRequests: { brave: string[], coinbase: string[] } = {
			brave: [],
			coinbase: [],
		}
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method === 'connected_to_signer') {
					signerName = readConnectedSignerName(request)
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: { metamaskCompatibilityMode: true },
					})
					return true
				}
				return false
			},
		})

		const mappedCoinbaseSigner = {
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				signerRequests.coinbase.push(method)
				if (method === 'eth_chainId') return '0x1'
				if (method === 'eth_accounts') return ['0x1111111111111111111111111111111111111111']
				throw new Error(`Unexpected mapped signer request: ${ method }`)
			},
			on: () => mappedCoinbaseSigner,
			removeListener: () => mappedCoinbaseSigner,
		}
		const braveSigner = {
			isBraveWallet: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				signerRequests.brave.push(method)
				if (method === 'eth_chainId') return '0x99'
				throw new Error(`Unexpected brave signer request: ${ method }`)
			},
			on: () => braveSigner,
			removeListener: () => braveSigner,
		}
		fakeWindow.ethereum = {
			...braveSigner,
			providerMap: new Map([['CoinbaseWallet', mappedCoinbaseSigner]]),
		}

		await withFakeInpageWindow(fakeWindow, 'provider-map-coinbase-missing-flag', async () => {
			await waitFor(() => signerName !== undefined)
			await waitFor(() => signerRequests.brave.length === 1 || signerRequests.coinbase.length === 1)
			assert.equal(signerName, 'CoinbaseWallet')
			assert.deepEqual(signerRequests.coinbase, ['eth_chainId'])
			assert.deepEqual(signerRequests.brave, [])
		})
	})

	test('uses root signer identity when CoinbaseWallet providerMap entry is unusable', async () => {
		let signerName: string | undefined
		const signerRequests: { root: string[] } = {
			root: [],
		}
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method === 'connected_to_signer') {
					signerName = readConnectedSignerName(request)
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: { metamaskCompatibilityMode: true },
					})
					return true
				}
				return false
			},
		})
		const rootSigner = {
			isMetaMask: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				signerRequests.root.push(method)
				if (method === 'eth_chainId') return '0x1'
				throw new Error(`Unexpected root signer request: ${ method }`)
			},
			on: () => rootSigner,
			removeListener: () => rootSigner,
		}
		fakeWindow.ethereum = {
			...rootSigner,
			providerMap: new Map([['CoinbaseWallet', { isCoinbaseWallet: true }]]),
		}

		await withFakeInpageWindow(fakeWindow, 'provider-map-unusable-coinbase-entry', async () => {
			await waitFor(() => signerName !== undefined)
			await waitFor(() => signerRequests.root.length >= 1)
			assert.equal(signerName, 'MetaMask')
			assert.deepEqual(signerRequests.root, ['eth_chainId'])
		})
	})

	test('does not fall back to the root provider when mapped CoinbaseWallet chain id request fails', async () => {
		let signerName: string | undefined
		const {
			fakeWindow,
			backgroundSignerChainChanges,
			interceptorErrorPayloads,
		} = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method === 'connected_to_signer') {
					signerName = readConnectedSignerName(request)
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: { metamaskCompatibilityMode: true },
					})
					return true
				}
				return false
			},
			signerChainIdReply: '0x2',
		})
		const rootSignerRequests: string[] = []
		const mappedSignerRequests: string[] = []
		let mappedSignerChainIdRequestCount = 0
		const mappedSigner = {
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				mappedSignerRequests.push(method)
				if (method === 'eth_chainId') {
					mappedSignerChainIdRequestCount += 1
					throw new Error('temporary failure in mapped signer')
				}
				throw new Error(`Unexpected mapped signer request: ${ method }`)
			},
			on: () => mappedSigner,
			removeListener: () => mappedSigner,
		}
		const rootSigner = {
			isMetaMask: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				rootSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x2'
				throw new Error(`Unexpected root signer request: ${ method }`)
			},
			on: () => rootSigner,
			removeListener: () => rootSigner,
		}
		fakeWindow.ethereum = {
			...rootSigner,
			providerMap: new Map([['CoinbaseWallet', mappedSigner]]),
		}

		await withFakeInpageWindow(fakeWindow, 'provider-map-chain-id-no-root-fallback', async () => {
			await waitFor(() => signerName !== undefined)
			assert.equal(mappedSignerChainIdRequestCount, 1)
			assert.deepEqual(mappedSignerRequests, ['eth_chainId'])
			assert.deepEqual(rootSignerRequests, [])
			assert.deepEqual(backgroundSignerChainChanges, [])
			await waitFor(() => interceptorErrorPayloads.length === 1)
			assert.equal(String(interceptorErrorPayloads[0]).includes('temporary failure in mapped signer'), true)
			assert.equal(signerName, 'CoinbaseWallet')
		})
	})

	test('does not fall back to the root provider when mapped CoinbaseWallet eth_accounts fails', async () => {
		let signerName: string | undefined
		const {
			fakeWindow,
			backgroundEthAccountsReplies,
			interceptorErrorPayloads,
			sendBackgroundMessage,
		} = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageInternal) => {
				if (request.method === 'connected_to_signer') {
					signerName = readConnectedSignerName(request)
					sendBackgroundMessageInternal({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: { metamaskCompatibilityMode: true },
					})
					return true
				}
				return false
			},
		})
		const rootSignerRequests: string[] = []
		const mappedSignerRequests: string[] = []
		const mappedSigner = {
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				mappedSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x2'
				if (method === 'eth_accounts') throw { code: -32603, message: 'internal account error' }
				throw new Error(`Unexpected mapped signer request: ${ method }`)
			},
			on: () => mappedSigner,
			removeListener: () => mappedSigner,
		}
		const rootSigner = {
			isMetaMask: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				rootSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x2'
				if (method === 'eth_accounts') return ['0x1111111111111111111111111111111111111111']
				throw new Error(`Unexpected root signer request: ${ method }`)
			},
			on: () => rootSigner,
			removeListener: () => rootSigner,
		}
		fakeWindow.ethereum = {
			...rootSigner,
			providerMap: new Map([['CoinbaseWallet', mappedSigner]]),
		}

		await withFakeInpageWindow(fakeWindow, 'provider-map-eth-accounts-no-fallback', async () => {
			await waitFor(() => signerName !== undefined)
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_accounts',
				result: [],
			})
			await waitFor(() => backgroundEthAccountsReplies.length === 1)
			assert.deepEqual(mappedSignerRequests, ['eth_chainId', 'eth_accounts'])
			assert.deepEqual(rootSignerRequests, [])
			assert.equal(backgroundEthAccountsReplies[0]?.requestAccounts, false)
			assert.equal(getRpcError(backgroundEthAccountsReplies[0]?.error).code, -32603)
			assert.equal(getRpcError(backgroundEthAccountsReplies[0]?.error).message, 'internal account error')
			assert.equal(interceptorErrorPayloads.length, 0)
		})
	})

	test('does not fall back to the root provider when mapped CoinbaseWallet eth_requestAccounts is rejected', async () => {
		let signerName: string | undefined
		const {
			fakeWindow,
			backgroundEthAccountsReplies,
			interceptorErrorPayloads,
			sendBackgroundMessage,
		} = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageInternal) => {
				if (request.method === 'connected_to_signer') {
					signerName = readConnectedSignerName(request)
					sendBackgroundMessageInternal({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: { metamaskCompatibilityMode: true },
					})
					return true
				}
				return false
			},
		})
		const rootSignerRequests: string[] = []
		const mappedSignerRequests: string[] = []
		const mappedSigner = {
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				mappedSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x2'
				if (method === 'eth_requestAccounts') throw { code: 4001, message: 'User rejected the request.' }
				throw new Error(`Unexpected mapped signer request: ${ method }`)
			},
			on: () => mappedSigner,
			removeListener: () => mappedSigner,
		}
		const rootSigner = {
			isMetaMask: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				rootSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x2'
				if (method === 'eth_requestAccounts') return ['0x1111111111111111111111111111111111111111']
				throw new Error(`Unexpected root signer request: ${ method }`)
			},
			on: () => rootSigner,
			removeListener: () => rootSigner,
		}
		fakeWindow.ethereum = {
			...rootSigner,
			providerMap: new Map([['CoinbaseWallet', mappedSigner]]),
		}

		await withFakeInpageWindow(fakeWindow, 'provider-map-no-fallback-on-reject', async () => {
			await waitFor(() => signerName !== undefined)
			await waitFor(() => mappedSignerRequests.includes('eth_chainId'))
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			await waitFor(() => backgroundEthAccountsReplies.length === 1)
			assert.deepEqual(signerName, 'CoinbaseWallet')
			assert.deepEqual(mappedSignerRequests, ['eth_chainId', 'eth_requestAccounts'])
			assert.deepEqual(rootSignerRequests, [])
			assert.equal(backgroundEthAccountsReplies.length, 1)
			assert.equal(backgroundEthAccountsReplies[0]?.requestAccounts, true)
			assert.equal(getRpcError(backgroundEthAccountsReplies[0]?.error).code, 4001)
			assert.equal(getRpcError(backgroundEthAccountsReplies[0]?.error).message, 'User rejected the request.')
			assert.equal(interceptorErrorPayloads.length, 0)
		})
	})

	test('does not fall back to the root provider when mapped CoinbaseWallet eth_requestAccounts returns 4001 with a non-standard message', async () => {
		let signerName: string | undefined
		const {
			fakeWindow,
			backgroundEthAccountsReplies,
			interceptorErrorPayloads,
			sendBackgroundMessage,
		} = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageInternal) => {
				if (request.method === 'connected_to_signer') {
					signerName = readConnectedSignerName(request)
					sendBackgroundMessageInternal({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: { metamaskCompatibilityMode: true },
					})
					return true
				}
				return false
			},
		})
		const rootSignerRequests: string[] = []
		const mappedSignerRequests: string[] = []
		const mappedSigner = {
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				mappedSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x2'
				if (method === 'eth_requestAccounts') throw { code: 4001, message: 'Wallet provider rejected internally.' }
				throw new Error(`Unexpected mapped signer request: ${ method }`)
			},
			on: () => mappedSigner,
			removeListener: () => mappedSigner,
		}
		const rootSigner = {
			isMetaMask: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				rootSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x2'
				if (method === 'eth_requestAccounts') return ['0x1111111111111111111111111111111111111111']
				throw new Error(`Unexpected root signer request: ${ method }`)
			},
			on: () => rootSigner,
			removeListener: () => rootSigner,
		}
		fakeWindow.ethereum = {
			...rootSigner,
			providerMap: new Map([['CoinbaseWallet', mappedSigner]]),
		}

		await withFakeInpageWindow(fakeWindow, 'provider-map-eth-requestaccounts-fallback-4001-message', async () => {
			await waitFor(() => signerName !== undefined)
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			await waitFor(() => backgroundEthAccountsReplies.length === 1)
			assert.deepEqual(signerName, 'CoinbaseWallet')
			assert.deepEqual(mappedSignerRequests, ['eth_chainId', 'eth_requestAccounts'])
			assert.deepEqual(rootSignerRequests, [])
			assert.equal(backgroundEthAccountsReplies[0]?.requestAccounts, true)
			assert.equal(getRpcError(backgroundEthAccountsReplies[0]?.error).code, 4001)
			assert.equal(getRpcError(backgroundEthAccountsReplies[0]?.error).message, 'Wallet provider rejected internally.')
			assert.equal(interceptorErrorPayloads.length, 0)
		})
	})

	test('does not fall back to the root provider when mapped CoinbaseWallet eth_requestAccounts returns 4001 without a message', async () => {
		let signerName: string | undefined
		const {
			fakeWindow,
			backgroundEthAccountsReplies,
			interceptorErrorPayloads,
			sendBackgroundMessage,
		} = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageInternal) => {
				if (request.method === 'connected_to_signer') {
					signerName = readConnectedSignerName(request)
					sendBackgroundMessageInternal({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: { metamaskCompatibilityMode: true },
					})
					return true
				}
				return false
			},
		})
		const rootSignerRequests: string[] = []
		const mappedSignerRequests: string[] = []
		const mappedSigner = {
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				mappedSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x2'
				if (method === 'eth_requestAccounts') throw { code: 4001 }
				throw new Error(`Unexpected mapped signer request: ${ method }`)
			},
			on: () => mappedSigner,
			removeListener: () => mappedSigner,
		}
		const rootSigner = {
			isMetaMask: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				rootSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x2'
				if (method === 'eth_requestAccounts') return ['0x1111111111111111111111111111111111111111']
				throw new Error(`Unexpected root signer request: ${ method }`)
			},
			on: () => rootSigner,
			removeListener: () => rootSigner,
		}
		fakeWindow.ethereum = {
			...rootSigner,
			providerMap: new Map([['CoinbaseWallet', mappedSigner]]),
		}

		await withFakeInpageWindow(fakeWindow, 'provider-map-eth-requestaccounts-code-only-4001', async () => {
			await waitFor(() => signerName !== undefined)
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			await waitFor(() => backgroundEthAccountsReplies.length === 1)
			assert.deepEqual(signerName, 'CoinbaseWallet')
			assert.deepEqual(mappedSignerRequests, ['eth_chainId', 'eth_requestAccounts'])
			assert.deepEqual(rootSignerRequests, [])
			assert.equal(backgroundEthAccountsReplies[0]?.requestAccounts, true)
			assert.equal(getRpcError(backgroundEthAccountsReplies[0]?.error).code, 4001)
			assert.equal(getRpcError(backgroundEthAccountsReplies[0]?.error).message, 'User rejected the request.')
			assert.equal(interceptorErrorPayloads.length, 0)
		})
	})

	test('falls back to the root provider when mapped CoinbaseWallet eth_requestAccounts fails with a non-user-rejected error', async () => {
		let signerName: string | undefined
		const {
			fakeWindow,
			backgroundEthAccountsReplies,
			interceptorErrorPayloads,
			sendBackgroundMessage,
		} = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageInternal) => {
				if (request.method === 'connected_to_signer') {
					signerName = readConnectedSignerName(request)
					sendBackgroundMessageInternal({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: { metamaskCompatibilityMode: true },
					})
					return true
				}
				return false
			},
		})
		const rootSignerRequests: string[] = []
		const mappedSignerRequests: string[] = []
		const mappedSigner = {
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				mappedSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x2'
				if (method === 'eth_requestAccounts') throw { code: 4100, message: 'Unknown account requested.' }
				throw new Error(`Unexpected mapped signer request: ${ method }`)
			},
			on: () => mappedSigner,
			removeListener: () => mappedSigner,
		}
		const rootSigner = {
			isMetaMask: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				rootSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x2'
				if (method === 'eth_requestAccounts') return ['0x1111111111111111111111111111111111111111']
				throw new Error(`Unexpected root signer request: ${ method }`)
			},
			on: () => rootSigner,
			removeListener: () => rootSigner,
		}
		fakeWindow.ethereum = {
			...rootSigner,
			providerMap: new Map([['CoinbaseWallet', mappedSigner]]),
		}

		await withFakeInpageWindow(fakeWindow, 'provider-map-eth-requestaccounts-fallback', async () => {
			await waitFor(() => signerName !== undefined)
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			await waitFor(() => backgroundEthAccountsReplies.length === 1)
			assert.deepEqual(signerName, 'CoinbaseWallet')
			assert.deepEqual(mappedSignerRequests, ['eth_chainId', 'eth_requestAccounts'])
			assert.deepEqual(rootSignerRequests, ['eth_requestAccounts'])
			assert.equal(backgroundEthAccountsReplies[0]?.requestAccounts, true)
			assert.equal(
				readProperty(backgroundEthAccountsReplies[0]?.accounts, 0),
				'0x1111111111111111111111111111111111111111',
			)
			assert.equal(interceptorErrorPayloads.length, 0)
		})
	})

	test('uses actual signer flags when providerMap has no CoinbaseWallet entry', async () => {
		let signerName: string | undefined
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method === 'connected_to_signer') {
					signerName = readConnectedSignerName(request)
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: { metamaskCompatibilityMode: true },
					})
					return true
				}
				return false
			},
		})
		const fakePrimarySigner = {
			isMetaMask: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				if (method === 'eth_chainId') return '0x1'
				throw new Error(`Unexpected signer request: ${ method }`)
			},
			on: () => fakePrimarySigner,
			removeListener: () => fakePrimarySigner,
		}
		fakeWindow.ethereum = {
			...fakePrimarySigner,
			providerMap: new Map([['OtherWallet', { request: async () => ['0x'] }]]),
		}

		await withFakeInpageWindow(fakeWindow, 'provider-map-no-coinbase', async () => {
			await waitFor(() => signerName !== undefined)
			assert.equal(signerName, 'MetaMask')
		})
	})

	test('uses mapped provider events in providerMap branch', async () => {
		type SignerEventCallback = (value: unknown) => void
		const signerEvents: {
			connect?: SignerEventCallback,
			disconnect?: SignerEventCallback,
			chainChanged?: SignerEventCallback,
			accountsChanged?: SignerEventCallback,
		} = {}
		const emitMappedSignerEvent = (kind: 'connect' | 'disconnect' | 'chainChanged' | 'accountsChanged', value: unknown) => {
			const callback = signerEvents[kind]
			if (callback === undefined) throw new Error(`The mapped signer has no ${ kind } listener`)
			callback(value)
		}
		const mappedOnKinds: string[] = []
		const rootOnKinds: string[] = []
		const backgroundMessages: { method: string, params?: readonly unknown[] }[] = []
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				backgroundMessages.push({ method: request.method, ...(request.params === undefined ? {} : { params: request.params }) })
				if (request.method === 'connected_to_signer') {
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: { metamaskCompatibilityMode: true },
					})
					return true
				}
				if (request.method === 'eth_accounts_reply') {
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: request.method,
						result: undefined,
					})
					return true
				}
				if (request.method === 'signer_chainChanged') {
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: request.method,
						result: '0x',
					})
					return true
				}
				return false
			},
		})
		const mappedSigner = {
			isCoinbaseWallet: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				if (method === 'eth_chainId') return '0x1'
				throw new Error(`Unexpected mapped signer request: ${ method }`)
			},
			on: (kind: string, callback: SignerEventCallback) => {
				mappedOnKinds.push(kind)
				if (kind === 'connect') signerEvents.connect = callback
				else if (kind === 'disconnect') signerEvents.disconnect = callback
				if (kind === 'accountsChanged') signerEvents.accountsChanged = callback
				else if (kind === 'chainChanged') signerEvents.chainChanged = callback
				return mappedSigner
			},
			removeListener: () => mappedSigner,
		}
		const rootSigner = {
			isBraveWallet: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				if (method === 'eth_chainId') return '0x2'
				throw new Error(`Unexpected root signer request: ${ method }`)
			},
			on: (kind: string) => {
				rootOnKinds.push(kind)
				return rootSigner
			},
			removeListener: () => rootSigner,
		}
		fakeWindow.ethereum = {
			...rootSigner,
			providerMap: new Map([['CoinbaseWallet', mappedSigner]]),
		}

		await withFakeInpageWindow(fakeWindow, `provider-map-events-${ Date.now() }-${ Math.random() }`, async () => {
			await waitFor(() => mappedOnKinds.length + rootOnKinds.length >= 4)
			assert.equal(mappedOnKinds.length >= 4, true)
			assert.equal(rootOnKinds.length, 0)
			assert.equal(signerEvents.accountsChanged !== undefined, true)
			await waitFor(() => signerEvents.chainChanged !== undefined)
			await waitFor(() => signerEvents.connect !== undefined)
			await waitFor(() => signerEvents.disconnect !== undefined)
			assert.equal(mappedOnKinds.includes('accountsChanged'), true)
			assert.equal(mappedOnKinds.includes('connect'), true)
			assert.equal(mappedOnKinds.includes('disconnect'), true)
			assert.equal(mappedOnKinds.includes('chainChanged'), true)
			emitMappedSignerEvent('connect', { chainId: '0x99' })
			await waitFor(() => backgroundMessages.filter((message) => message.method === 'connected_to_signer' && message.params?.[0] === true && message.params?.[1] === 'CoinbaseWallet').length >= 1)
			emitMappedSignerEvent('disconnect', { code: 4900, message: 'error' })
			await waitFor(() => backgroundMessages.filter((message) => message.method === 'connected_to_signer' && message.params?.[0] === false && message.params?.[1] === 'CoinbaseWallet').length >= 1)
			assert.equal(backgroundMessages.filter((message) => message.method === 'connected_to_signer' && message.params?.[0] === true && message.params?.[1] === 'CoinbaseWallet').length >= 1, true)
			assert.equal(backgroundMessages.filter((message) => message.method === 'connected_to_signer' && message.params?.[0] === false && message.params?.[1] === 'CoinbaseWallet').length >= 1, true)
			emitMappedSignerEvent('accountsChanged', ['0x1111111111111111111111111111111111111111'])
			assert.equal(typeof signerEvents.accountsChanged, 'function')
			assert.equal(typeof signerEvents.chainChanged, 'function')
			assert.equal(signerEvents.chainChanged !== undefined, true)
			assert.equal(signerEvents.accountsChanged !== undefined, true)
			await waitFor(() => backgroundMessages.some((message) => message.method === 'eth_accounts_reply' && readProperty(message.params?.[0], 'requestAccounts') === false))
			emitMappedSignerEvent('chainChanged', '0x2a')
			await waitFor(() => backgroundMessages.some((message) => message.method === 'signer_chainChanged' && message.params?.[0] === '0x2a'))
			const chainChangeCount = backgroundMessages.filter((message) => message.method === 'signer_chainChanged').length
			emitMappedSignerEvent('chainChanged', '42')
			await waitFor(() => backgroundMessages.filter((message) => message.method === 'signer_chainChanged' && message.params?.[0] === '0x2a').length >= 2)
			assert.equal(backgroundMessages.filter((message) => message.method === 'signer_chainChanged').length > chainChangeCount, true)
			emitMappedSignerEvent('chainChanged', '1garbage')
			await waitFor(() => backgroundMessages.some((message) => message.method === 'signer_chainChanged' && message.params?.[0] === '1garbage'))
		})
	})
})
