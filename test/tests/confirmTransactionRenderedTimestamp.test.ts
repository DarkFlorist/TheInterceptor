import * as assert from 'assert'
import { encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import { installDateMock, installDomMock } from './domMock.js'

type RuntimeMessageListener = (message: unknown) => unknown
const hexToBytes = (hex: string) => Uint8Array.from(Buffer.from(hex.slice(2), 'hex'))

function createBrowserMock() {
	const listeners: RuntimeMessageListener[] = []
	const storageState: Record<string, unknown> = {}

	const getStorageItems = (keys?: string | string[] | Record<string, unknown> | null) => {
		if (keys === undefined || keys === null) return { ...storageState }
		if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
		if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
		return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
	}

	const browser = {
		runtime: {
			lastError: null as browser.runtime._LastError | undefined | null,
			async sendMessage(message: unknown) {
				for (const listener of [...listeners]) listener(message)
				if (message?.method === 'popup_isMainPopupWindowOpen') {
					return {
						method: 'popup_isMainPopupWindowOpen',
						data: { isOpen: true },
					}
				}
				if (message?.method === 'popup_readyAndListening') {
					return {
						method: 'popup_readyAndListening',
						data: { popupOrTabId: { type: 'popup', id: 1 } },
					}
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
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					return getStorageItems(keys)
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
					return undefined
				},
				async remove(keys: string | string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
					return undefined
				},
			},
		},
		tabs: {
			async query() {
				return []
			},
			async get() {
				return undefined
			},
			async update() {
				return undefined
			},
			onUpdated: { addListener: () => undefined, removeListener: () => undefined },
			onRemoved: { addListener: () => undefined, removeListener: () => undefined },
		},
		windows: {
			async get() {
				return undefined
			},
			async update() {
				return undefined
			},
		},
		action: {
			async setIcon() {
				return undefined
			},
			async setTitle() {
				return undefined
			},
			async setBadgeText() {
				return undefined
			},
			async setBadgeBackgroundColor() {
				return undefined
			},
		},
		browserAction: {
			async setIcon() {
				return undefined
			},
			async setTitle() {
				return undefined
			},
			async setBadgeText() {
				return undefined
			},
			async setBadgeBackgroundColor() {
				return undefined
			},
		},
	}
	Object.defineProperty(globalThis, 'browser', {
		value: browser,
		configurable: true,
		writable: true,
	})
	Object.defineProperty(globalThis, 'chrome', {
		value: { runtime: { id: 'test-extension' } },
		configurable: true,
		writable: true,
	})

	return {
		storage: browser.storage,
		dispatch(message: unknown) {
			for (const listener of [...listeners]) listener(message)
		},
	}
}

createBrowserMock()

function makePendingTransaction(simulationConductedTimestamp: Date) {
	const activeAddress = 0x1111111111111111111111111111111111111111n
	const recipientAddress = 0x2222222222222222222222222222222222222222n
	const transactionIdentifier = 1n
	const created = new Date('2024-01-01T00:00:00.000Z')
	const website = {
		websiteOrigin: 'https://example.com',
		icon: undefined,
		title: undefined,
	}
	const originalRequestParameters = {
		method: 'eth_sendTransaction' as const,
		params: [
			{
				from: activeAddress,
				to: recipientAddress,
				value: 0n,
				gas: 21_000n,
				maxFeePerGas: 1n,
				maxPriorityFeePerGas: 1n,
				input: new Uint8Array(),
			},
		],
	}
	const transactionToSimulate = {
		website,
		created,
		originalRequestParameters,
		transactionIdentifier,
		success: false as const,
		error: {
			code: -32000,
			message: 'simulation failed',
		},
	}
	const pendingTransaction = {
		type: 'Transaction' as const,
		transactionOrMessageCreationStatus: 'FailedToSimulate' as const,
		popupOrTabId: { type: 'popup' as const, id: 1 },
		originalRequestParameters,
		uniqueRequestIdentifier: {
			requestId: 1,
			requestSocket: { tabId: 1, connectionName: 0n },
		},
		simulationMode: true,
		activeAddress,
		created,
		transactionIdentifier,
		transactionToSimulate,
		website,
		approvalStatus: { status: 'WaitingForUser' as const },
		popupVisualisation: {
			statusCode: 'failed' as const,
			data: {
				activeAddress,
				simulationMode: true,
				simulationStartedTimestamp: created,
				uniqueRequestIdentifier: {
					requestId: 1,
					requestSocket: { tabId: 1, connectionName: 0n },
				},
				transactionToSimulate,
				signerName: 'NoSignerDetected' as const,
				error: {
					code: -32000,
					message: 'simulation failed',
					decodedErrorMessage: 'simulation failed',
				},
				simulationState: {
					blockNumber: 123n,
					simulationConductedTimestamp,
				},
			},
		},
	}

	return pendingTransaction
}

const { UpdateConfirmTransactionDialogPendingTransactions } = await import('../../app/ts/types/interceptor-messages.js')
const { serialize } = await import('../../app/ts/types/wire-types.js')
const { ConfirmTransaction } = await import('../../app/ts/components/pages/ConfirmTransaction.js')
describe('ConfirmTransaction', () => {
	test('updates the simulation age when a refreshed pending transaction arrives', async () => {
		const dom = installDomMock()
		const clock = installDateMock('2024-01-01T00:00:10.000Z')
		const browser = createBrowserMock()
		const olderPendingTransaction = makePendingTransaction(new Date('2024-01-01T00:00:05.000Z'))
		const newerPendingTransaction = makePendingTransaction(new Date('2024-01-01T00:00:09.000Z'))

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})

		await act(() => {
			browser.dispatch({
				role: 'all',
				...serialize(UpdateConfirmTransactionDialogPendingTransactions, {
					method: 'popup_update_confirm_transaction_dialog_pending_transactions',
					data: {
						pendingTransactionAndSignableMessages: [olderPendingTransaction],
						currentBlockNumber: 123n,
						rpcConnectionStatus: undefined,
					},
				}),
			})
		})
		assert.equal(dom.document.body.textContent?.includes('Simulated 5s ago'), true)

		await act(() => {
			browser.dispatch({
				role: 'all',
				...serialize(UpdateConfirmTransactionDialogPendingTransactions, {
					method: 'popup_update_confirm_transaction_dialog_pending_transactions',
					data: {
						pendingTransactionAndSignableMessages: [newerPendingTransaction],
						currentBlockNumber: 123n,
						rpcConnectionStatus: undefined,
					},
				}),
			})
		})
		assert.equal(dom.document.body.textContent?.includes('Simulated 1s ago'), true)

		clock.restore()
		dom.restore()
	})

	test('updates the simulation age when the real refresh flow runs', { timeout: 15_000 }, async () => {
		const dom = installDomMock()
		const clock = installDateMock('2024-01-01T00:00:10.000Z')
		const browser = createBrowserMock()
		const olderPendingTransaction = makePendingTransaction(new Date('2024-01-01T00:00:05.000Z'))
		const { EthereumClientService } = await import('../../app/ts/simulation/services/EthereumClientService.js')
		const { updateInterceptorTransactionStack, getPendingTransactionsAndMessages } = await import('../../app/ts/background/storageVariables.js')
		const { refreshPopupConfirmTransactionSimulation } = await import('../../app/ts/background/popupMessageHandlers.js')
		const { browserStorageLocalSet2 } = await import('../../app/ts/utils/storageUtils.js')

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
			clearCache() {
				return undefined
			},
			async jsonRpcRequest(rpcRequest: { method: string; params?: readonly unknown[] }) {
				switch (rpcRequest.method) {
					case 'eth_getBlockByNumber':
						return serialize((await import('../../app/ts/types/wire-types.js')).EthereumBlockHeader, fakeBlock)
					case 'eth_getTransactionCount':
						return serialize((await import('../../app/ts/types/wire-types.js')).EthereumQuantity, 0n)
					case 'eth_getBalance':
						return serialize((await import('../../app/ts/types/wire-types.js')).EthereumQuantity, 0n)
					case 'eth_blockNumber':
						return serialize((await import('../../app/ts/types/wire-types.js')).EthereumQuantity, 123n)
					case 'eth_getCode':
						return '0x'
					case 'eth_gasPrice':
						return serialize((await import('../../app/ts/types/wire-types.js')).EthereumQuantity, 1n)
					case 'eth_simulateV1': {
						const multicallAbi = (await import('../../app/ts/utils/constants.js')).Multicall3ABI
						const balanceResult = encodeFunctionReturn(multicallAbi, 'getEthBalance', [0n])
						const aggregate3Result = encodeFunctionReturn(multicallAbi, 'aggregate3', [[{ success: true, returnData: balanceResult }]])
						const blockStateCalls = Array.isArray(rpcRequest.params?.[0]?.blockStateCalls) ? rpcRequest.params[0].blockStateCalls : [{}]
						return serialize(
							(await import('../../app/ts/types/ethSimulate-types.js')).EthSimulateV1Result,
							blockStateCalls.map((blockStateCall) => ({
								number: 123n,
								hash: 0x9876n,
								timestamp: 0x65920080n,
								gasLimit: 30_000_000n,
								gasUsed: 21_000n,
								baseFeePerGas: 1n,
								calls: Array.from(
									{
										length: Array.isArray(blockStateCall.calls) ? blockStateCall.calls.length : 0,
									},
									() => ({
										status: 'success',
										gasUsed: 21_000n,
										logs: [],
										returnData: hexToBytes(aggregate3Result),
									}),
								),
							})),
						)
					}
					default:
						throw new Error(`Unexpected RPC method: ${ rpcRequest.method }`)
				}
			},
		}
		const ethereum = new EthereumClientService(
			fakeRequestHandler,
			async () => undefined,
			async () => undefined,
			fakeRpcNetwork,
		)
		const simulator = {
			ethereum,
			tokenPriceService: {
				estimateEthereumPricesForTokens: async () => [],
			},
		}

		await browserStorageLocalSet2({
			pendingTransactionsAndMessages: [olderPendingTransaction],
		})
		await updateInterceptorTransactionStack(() => ({ operations: [] }))

		await act(async () => {
			await refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService as never)
		})

		const [refreshedPendingTransaction] = await getPendingTransactionsAndMessages()
		if (refreshedPendingTransaction === undefined || refreshedPendingTransaction.type !== 'Transaction') throw new Error('missing refreshed pending transaction')
		assert.ok(refreshedPendingTransaction.popupVisualisation.data.simulationState.simulationConductedTimestamp.getTime() > olderPendingTransaction.popupVisualisation.data.simulationState.simulationConductedTimestamp.getTime())

		await act(() => {
			render(h(ConfirmTransaction, {}), dom.document.body)
		})

		await act(() => {
			browser.dispatch({
				role: 'all',
				...serialize(UpdateConfirmTransactionDialogPendingTransactions, {
					method: 'popup_update_confirm_transaction_dialog_pending_transactions',
					data: {
						pendingTransactionAndSignableMessages: [refreshedPendingTransaction],
						currentBlockNumber: 123n,
						rpcConnectionStatus: undefined,
					},
				}),
			})
		})

		assert.equal(dom.document.body.textContent?.includes('Simulated 0s ago'), true)

		clock.restore()
		dom.restore()
	})
})
