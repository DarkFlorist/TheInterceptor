// @ts-nocheck
import * as assert from 'assert'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, run, runIfRoot, should } from '../micro-should.js'
import { installDomMock } from './someTimeAgo.js'

type RuntimeMessageListener = (message: unknown) => unknown

function createBrowserMock() {
	const listeners: RuntimeMessageListener[] = []

	// @ts-expect-error test shim intentionally overrides extension globals
	globalThis.browser = {
		runtime: {
			lastError: null,
			async sendMessage(message: any) {
				for (const listener of [...listeners]) listener(message)
				if (message?.method === 'popup_isMainPopupWindowOpen') {
					return { type: 'RequestIsMainPopupWindowOpenReply', data: { isOpen: true } }
				}
				return undefined
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: {
				addListener(listener: RuntimeMessageListener) {
					listeners.push(listener)
				},
				removeListener(listener: RuntimeMessageListener) {
					const index = listeners.indexOf(listener)
					if (index >= 0) listeners.splice(index, 1)
				},
			},
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get() { return {} },
				async set() { return undefined },
				async remove() { return undefined },
			},
		},
		tabs: {
			async query() { return [] },
			async get() { return undefined },
			async update() { return undefined },
			onUpdated: { addListener: () => undefined, removeListener: () => undefined },
			onRemoved: { addListener: () => undefined, removeListener: () => undefined },
		},
		windows: {
			async get() { return undefined },
			async update() { return undefined },
		},
		action: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
		browserAction: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
	}
	// @ts-expect-error test shim intentionally overrides extension globals
	globalThis.chrome = { runtime: { id: 'test-extension' } }

	return {
		dispatch(message: unknown) {
			for (const listener of [...listeners]) listener(message)
		},
	}
}

function makePendingTransaction(simulationConductedTimestamp: Date) {
	const activeAddress = 0x1111111111111111111111111111111111111111n
	const recipientAddress = 0x2222222222222222222222222222222222222222n
	const rpcNetwork = {
		name: 'Test Chain',
		chainId: 1337n,
		httpsRpc: 'https://example.invalid',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		currencyLogoUri: undefined,
		primary: true,
		minimized: true,
	}
	const addressEntry = {
		type: 'contact' as const,
		name: 'Test Account',
		address: activeAddress,
		entrySource: 'User' as const,
	}
	const recipientEntry = {
		type: 'contact' as const,
		name: 'Recipient',
		address: recipientAddress,
		entrySource: 'User' as const,
	}
	const transactionIdentifier = 1n
	const created = new Date('2024-01-01T00:00:00.000Z')
	const pendingTransaction = {
		type: 'Transaction' as const,
		popupOrTabId: { type: 'popup' as const, id: 1 },
		originalRequestParameters: {
			method: 'eth_sendTransaction' as const,
			params: [{
				from: activeAddress,
				to: recipientAddress,
				value: 0n,
				gas: 21_000n,
				maxFeePerGas: 1n,
				maxPriorityFeePerGas: 1n,
				input: new Uint8Array(),
			}],
		},
		uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } },
		simulationMode: true,
		activeAddress,
		created,
		transactionIdentifier,
		website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		approvalStatus: { status: 'WaitingForUser' as const },
		popupVisualisation: {
			statusCode: 'success' as const,
			data: {
				activeAddress,
				simulationMode: true,
				uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } },
				transactionToSimulate: {
					website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
					created,
					originalRequestParameters: {
						method: 'eth_sendTransaction' as const,
						params: [{
							from: activeAddress,
							to: recipientAddress,
							value: 0n,
							gas: 21_000n,
							maxFeePerGas: 1n,
							maxPriorityFeePerGas: 1n,
							input: new Uint8Array(),
						}],
					},
					transactionIdentifier,
					success: true as const,
					transaction: {
						from: addressEntry,
						to: recipientEntry,
						value: 0n,
						input: new Uint8Array(),
						rpcNetwork,
						hash: 0x1234n,
						gas: 21_000n,
						nonce: 0n,
						type: '1559' as const,
						maxFeePerGas: 1n,
						maxPriorityFeePerGas: 1n,
					},
				},
				signerName: 'NoSignerDetected',
				addressBookEntries: [addressEntry, recipientEntry],
				tokenPriceEstimates: [],
				namedTokenIds: [],
				simulationState: {
					success: true as const,
					simulationStateInput: [],
					simulatedBlocks: [],
					blockNumber: 123n,
					blockTimestamp: new Date('2024-01-01T00:00:00.000Z'),
					baseFeePerGas: 0n,
					simulationConductedTimestamp,
					rpcNetwork,
				},
				visualizedSimulationState: {
					success: true as const,
					visualizedBlocks: [{
						simulatedAndVisualizedTransactions: [{
							website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
							created,
							parsedInputData: { type: 'NonParsed' as const, input: new Uint8Array() },
							transactionIdentifier,
							originalRequestParameters: {
								method: 'eth_sendTransaction' as const,
								params: [{
									from: activeAddress,
									to: recipientAddress,
									value: 0n,
									gas: 21_000n,
									maxFeePerGas: 1n,
									maxPriorityFeePerGas: 1n,
									input: new Uint8Array(),
								}],
							},
							tokenBalancesAfter: [],
							tokenPriceEstimates: [],
							tokenPriceQuoteToken: undefined,
							gasSpent: 21_000n,
							realizedGasPrice: 1n,
							quarantine: false,
							quarantineReasons: [],
							events: [],
							transactionStatus: 'Transaction Succeeded' as const,
							transaction: {
								from: addressEntry,
								to: recipientEntry,
								value: 0n,
								input: new Uint8Array(),
								rpcNetwork,
								hash: 0x1234n,
								gas: 21_000n,
								nonce: 0n,
								type: '1559' as const,
								maxFeePerGas: 1n,
								maxPriorityFeePerGas: 1n,
							},
						}],
						visualizedPersonalSignRequests: [],
						blockTimeManipulation: { type: 'No Delay' as const },
					}],
				},
			},
		},
	}

	return pendingTransaction
}

async function main() {
	const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
	const { serialize } = await import('../../app/ts/types/wire-types.js')
	const { ConfirmTransaction } = await import('../../app/ts/components/pages/ConfirmTransaction.js')
	describe('ConfirmTransaction', () => {
		should('updates the simulation age when a refreshed pending transaction arrives', async () => {
			const dom = installDomMock()
			const browser = createBrowserMock()
			const olderPendingTransaction = makePendingTransaction(new Date('2024-01-01T00:00:05.000Z'))
			const newerPendingTransaction = makePendingTransaction(new Date('2024-01-01T00:00:09.000Z'))

			await act(() => {
				// @ts-expect-error test shim uses a lightweight container
				render(h(ConfirmTransaction, {}), dom.document.body)
			})

			await act(() => {
				browser.dispatch(serialize(MessageToPopup, {
					role: 'all',
					method: 'popup_update_confirm_transaction_dialog_pending_transactions',
					data: {
						pendingTransactionAndSignableMessages: [olderPendingTransaction],
						currentBlockNumber: 123n,
					},
				}))
			})
			assert.equal(dom.document.body.textContent?.includes('Simulated 5s ago'), true)

			await act(() => {
				browser.dispatch(serialize(MessageToPopup, {
					role: 'all',
					method: 'popup_update_confirm_transaction_dialog_pending_transactions',
					data: {
						pendingTransactionAndSignableMessages: [newerPendingTransaction],
						currentBlockNumber: 123n,
					},
				}))
			})
			assert.equal(dom.document.body.textContent?.includes('Simulated 1s ago'), true)

			dom.restore()
		})

		should('updates the simulation age when the real refresh flow runs', async () => {
			const dom = installDomMock()
			const browser = createBrowserMock()
			const olderPendingTransaction = makePendingTransaction(new Date('2024-01-01T00:00:05.000Z'))
			const { EthereumClientService, mockSignTransaction } = await import('../../app/ts/simulation/services/SimulationModeEthereumClientService.js')
			const { defaultActiveAddresses } = await import('../../app/ts/background/settings.js')
			const { updateInterceptorTransactionStack } = await import('../../app/ts/background/storageVariables.js')
			const { refreshPopupConfirmTransactionSimulation } = await import('../../app/ts/background/popupMessageHandlers.js')

			const fakeRpcNetwork = {
				name: 'Test Chain',
				chainId: 1337n,
				httpsRpc: 'https://example.invalid',
				currencyName: 'Ether',
				currencyTicker: 'ETH',
				currencyLogoUri: undefined,
				primary: true,
				minimized: true,
			}
			const fakeBlock = {
				author: 0n,
				difficulty: 0n,
				extraData: new Uint8Array(),
				gasLimit: 30_000_000n,
				gasUsed: 21_000n,
				hash: 0x1234n,
				logsBloom: 0n,
				miner: 0n,
				mixHash: 0n,
				nonce: 0n,
				number: 123n,
				parentHash: 0x1n,
				receiptsRoot: 0n,
				sha3Uncles: 0n,
				stateRoot: 0n,
				timestamp: new Date('2024-01-01T00:00:00.000Z'),
				size: 0n,
				totalDifficulty: 0n,
				uncles: [],
				baseFeePerGas: 1n,
				transactionsRoot: 0n,
				transactions: [],
				withdrawals: [],
				withdrawalsRoot: 0n,
			}
			const fakeRequestHandler = {
				rpcUrl: fakeRpcNetwork.httpsRpc,
				clearCache() {},
				async jsonRpcRequest(rpcRequest: { method: string }) {
					switch (rpcRequest.method) {
						case 'eth_getBlockByNumber':
							return serialize((await import('../../app/ts/types/wire-types.js')).EthereumBlockHeader, fakeBlock)
						case 'eth_getTransactionCount':
							return serialize((await import('../../app/ts/types/wire-types.js')).EthereumQuantity, 0n)
						case 'eth_getBalance':
							return serialize((await import('../../app/ts/types/wire-types.js')).EthereumQuantity, 0n)
						case 'eth_getCode':
							return '0x'
						case 'eth_gasPrice':
							return serialize((await import('../../app/ts/types/wire-types.js')).EthereumQuantity, 1n)
						case 'eth_simulateV1':
							return serialize((await import('../../app/ts/types/ethSimulate-types.js')).EthSimulateV1Result, [{
								number: 123n,
								hash: 0x9876n,
								timestamp: 0x65920080n,
								gasLimit: 30_000_000n,
								gasUsed: 21_000n,
								baseFeePerGas: 1n,
								calls: [{
									status: '0x1',
									gasUsed: 21_000n,
									logs: [],
									returnData: '0x',
								}],
							}])
						default:
							throw new Error(`Unexpected RPC method: ${ rpcRequest.method }`)
					}
				},
			}
			const ethereum = new EthereumClientService(fakeRequestHandler, async () => undefined, async () => undefined, fakeRpcNetwork)
			const simulator = {
				ethereum,
				tokenPriceService: {
					estimateEthereumPricesForTokens: async () => [],
				},
			}

			await browser.storage.local.set({
				pendingTransactionsAndMessages: [olderPendingTransaction],
			})
			await updateInterceptorTransactionStack(() => ({ operations: [] }))

			await act(async () => {
				// @ts-expect-error test shim uses a lightweight container
				render(h(ConfirmTransaction, {}), dom.document.body)
				await refreshPopupConfirmTransactionSimulation(simulator)
			})

			assert.equal(dom.document.body.textContent?.includes('Simulated 1s ago'), true)

			dom.restore()
		})
	})
}

await runIfRoot(async () => {
	await main()
	await run()
}, import.meta)
