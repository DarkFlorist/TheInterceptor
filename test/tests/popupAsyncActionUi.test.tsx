import * as assert from 'assert'
import { afterEach, describe, test } from 'bun:test'
import { signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { type GovernanceVoteInputParameters, SimulateExecutionReply } from '../../app/ts/types/interceptor-messages.js'
import { PopupRequestsReplies } from '../../app/ts/types/interceptor-reply-messages.js'
import type { VisualizedPersonalSignRequestSafeTx } from '../../app/ts/types/personal-message-definitions.js'
import type { SimulatedAndVisualizedTransaction } from '../../app/ts/types/visualizer-types.js'
import type { PendingAccessRequest } from '../../app/ts/types/accessRequest.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { installDomMock } from './domMock.js'

let runtimeSendMessage = async (_message: unknown) => undefined
const runtimeMessageListeners: Array<(message: unknown) => unknown> = []

function installBrowser() {
	Object.defineProperty(globalThis, 'browser', {
		value: {
			runtime: {
				lastError: null,
				getManifest: () => ({ manifest_version: 3 }),
				sendMessage: async (message: unknown) => await runtimeSendMessage(message),
				onMessage: {
					addListener: (listener: (message: unknown) => unknown) => { runtimeMessageListeners.push(listener) },
					removeListener: (listener: (message: unknown) => unknown) => {
						const index = runtimeMessageListeners.indexOf(listener)
						if (index !== -1) runtimeMessageListeners.splice(index, 1)
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
		},
		configurable: true,
		writable: true,
	})
	Object.defineProperty(globalThis, 'chrome', { value: { runtime: { id: 'test-extension' } }, configurable: true, writable: true })
}

installBrowser()

afterEach(() => {
	runtimeSendMessage = async (_message: unknown) => undefined
	runtimeMessageListeners.splice(0, runtimeMessageListeners.length)
})

async function loadModules() {
	return {
		...await import('../../app/ts/components/pages/AddNewAddress.js'),
		...await import('../../app/ts/components/pages/ChangeChain.js'),
		...await import('../../app/ts/components/pages/InterceptorAccess.js'),
		...await import('../../app/ts/components/simulationExplaining/customExplainers/GovernanceVoteVisualizer.js'),
		...await import('../../app/ts/components/simulationExplaining/customExplainers/GnosisSafeVisualizer.js'),
	}
}

const modulesPromise = loadModules()

type TestDomNode = {
	readonly tagName?: string
	readonly childNodes?: readonly TestDomNode[]
	readonly textContent?: string | null
	readonly l?: Record<string, (event: unknown) => unknown>
	readonly attributes?: Record<string, string | undefined>
	disabled?: boolean
}

function collectElements(node: TestDomNode | null | undefined, tagName: string, results: TestDomNode[] = []) {
	if (node?.tagName === tagName.toUpperCase()) results.push(node)
	for (const child of node?.childNodes ?? []) collectElements(child, tagName, results)
	return results
}

async function clickElement(element: { l?: Record<string, (event: unknown) => unknown> }) {
	const clickHandler = element.l === undefined ? undefined : Object.entries(element.l).find(([key]) => key.startsWith('Click'))?.[1]
	if (clickHandler === undefined) throw new Error('Expected click handler')
	await clickHandler({ currentTarget: element })
}

function isDisabled(element: TestDomNode | undefined) {
	if (element === undefined) return false
	return 'disabled' in element || element.attributes?.disabled !== undefined
}

function createDeferred<T>() {
	let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined
	let rejectPromise: (reason?: unknown) => void = () => undefined
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve
		rejectPromise = reject
	})
	return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function createAccessRequestFixture(): PendingAccessRequest {
	return {
		website: { websiteOrigin: 'https://example.test', icon: undefined, title: 'Example' },
		requestAccessToAddress: undefined,
		originalRequestAccessToAddress: undefined,
		associatedAddresses: [],
		signerAccounts: [0x1111111111111111111111111111111111111111n],
		signerName: 'MetaMask',
		simulationMode: false,
		popupOrTabId: { type: 'popup', id: 1 },
		socket: { tabId: 1, connectionName: 1n },
		request: undefined,
		activeAddress: undefined,
		accessRequestId: 'access-request',
	}
}

function createSimulationFailureReply(transactionOrMessageIdentifier: bigint, errorMessage: string) {
	return serialize(SimulateExecutionReply, {
		method: 'popup_simulateExecutionReply' as const,
		data: {
			success: false as const,
			errorType: 'Other' as const,
			transactionOrMessageIdentifier,
			errorMessage,
		},
	})
}

function createSimulationFailureBroadcast(transactionOrMessageIdentifier: bigint, errorMessage: string) {
	return { role: 'all' as const, ...createSimulationFailureReply(transactionOrMessageIdentifier, errorMessage) }
}

function createAbiLookupFailureReply(error: string) {
	return PopupRequestsReplies.popup_requestAbiAndNameFromBlockExplorer.serialize({
		method: 'popup_requestAbiAndNameFromBlockExplorer',
		data: {
			success: false as const,
			error,
		},
	})
}

async function emitRuntimeMessage(message: unknown) {
	for (const listener of [...runtimeMessageListeners]) {
		await listener(message)
	}
}

function getRuntimeMethod(message: unknown) {
	if (typeof message !== 'object' || message === null || !('method' in message)) return undefined
	const method = Reflect.get(message, 'method')
	return typeof method === 'string' ? method : undefined
}

async function settleAsyncUpdates() {
	await Promise.resolve()
	await Promise.resolve()
	await new Promise((resolve) => setTimeout(resolve, 0))
	await Promise.resolve()
}

const ASYNC_CHANNEL_CLOSED_ERROR = 'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received'

function createGovernanceVoteInputParameters(proposalId: bigint): GovernanceVoteInputParameters {
	return {
		proposalId,
		support: true,
		reason: undefined,
		params: undefined,
		signature: undefined,
		voter: undefined,
	}
}

function createGovernanceTransactionFixture(transactionIdentifier: bigint): SimulatedAndVisualizedTransaction {
	const governanceTransactionFixture = {
		transactionIdentifier,
		transaction: {
			to: {
				type: 'contract',
				name: 'Governance',
				address: 0x1n,
				entrySource: 'User',
				abi: '[]',
				chainId: 1n,
			},
		},
	} satisfies Pick<SimulatedAndVisualizedTransaction, 'transactionIdentifier' | 'transaction'>

	// GovernanceVoteVisualizer only reads transactionIdentifier and transaction.to in these tests.
	return governanceTransactionFixture as SimulatedAndVisualizedTransaction
}

const gnosisSignerAddress = {
	type: 'contact' as const,
	name: 'Signer',
	address: 0x2n,
	entrySource: 'User' as const,
	chainId: 1n,
}

const zeroAddressEntry = {
	type: 'contact' as const,
	name: '0x0 Address',
	address: 0n,
	entrySource: 'Interceptor' as const,
	chainId: 1n,
}

function createGnosisSafeMessageFixture(messageIdentifier: bigint): VisualizedPersonalSignRequestSafeTx {
	return {
		activeAddress: gnosisSignerAddress,
		rpcNetwork: {
			name: 'Ethereum Mainnet',
			chainId: 1n,
			httpsRpc: 'https://rpc.example',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: true,
			minimized: false,
		},
		simulationMode: true,
		signerName: 'NoSignerDetected',
		quarantineReasons: [],
		quarantine: false,
		account: gnosisSignerAddress,
		website: { websiteOrigin: 'https://safe.example', icon: undefined, title: undefined },
		created: new Date('2024-01-01T00:00:00.000Z'),
		rawMessage: '{}',
		stringifiedMessage: '{}',
		messageIdentifier,
		method: 'eth_signTypedData_v4',
		type: 'SafeTx',
		message: {
			types: {
				SafeTx: [
					{ name: 'to', type: 'address' },
					{ name: 'value', type: 'uint256' },
					{ name: 'data', type: 'bytes' },
					{ name: 'operation', type: 'uint8' },
					{ name: 'safeTxGas', type: 'uint256' },
					{ name: 'baseGas', type: 'uint256' },
					{ name: 'gasPrice', type: 'uint256' },
					{ name: 'gasToken', type: 'address' },
					{ name: 'refundReceiver', type: 'address' },
					{ name: 'nonce', type: 'uint256' },
				],
				EIP712Domain: [
					{ name: 'chainId', type: 'uint256' },
					{ name: 'verifyingContract', type: 'address' },
				],
			},
			primaryType: 'SafeTx',
			domain: {
				chainId: 1n,
				verifyingContract: gnosisSignerAddress.address,
			},
			message: {
				to: 0x3n,
				value: 0n,
				data: new Uint8Array(),
				operation: 0n,
				safeTxGas: 0n,
				baseGas: 0n,
				gasPrice: 0n,
				gasToken: zeroAddressEntry.address,
				refundReceiver: zeroAddressEntry.address,
				nonce: 1n,
			},
		},
		parsedMessageDataAddressBookEntries: [],
		parsedMessageData: { type: 'NonParsed', input: new Uint8Array() },
		gasToken: zeroAddressEntry,
		to: {
			type: 'contact',
			name: 'Recipient',
			address: 0x3n,
			entrySource: 'User',
			chainId: 1n,
		},
		refundReceiver: zeroAddressEntry,
		verifyingContract: {
			type: 'contract',
			name: 'Safe',
			address: gnosisSignerAddress.address,
			entrySource: 'User',
			abi: '[]',
			chainId: 1n,
		},
		messageHash: '0x1',
		domainHash: '0x2',
		safeTxHash: '0x3',
	}
}

function createChangeChainMessage() {
	return {
		role: 'all' as const,
		method: 'popup_ChangeChainRequest' as const,
		data: {
			website: { websiteOrigin: 'https://chain.example', icon: undefined, title: undefined },
			popupOrTabId: { type: 'tab' as const, id: 1 },
			request: {
				method: 'wallet_switchEthereumChain',
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: {
					requestId: 99,
					requestSocket: {
						tabId: 1,
						connectionName: '0x1',
					},
				},
			},
			rpcNetwork: {
				name: 'Ethereum Mainnet',
				chainId: '0x1',
				httpsRpc: 'https://rpc.example',
				currencyName: 'Ether',
				currencyTicker: 'ETH',
				primary: true,
				minimized: false,
			},
			simulationMode: false,
		},
	}
}

describe('popup async action UI', () => {
	test('keeps access approval pending across parent re-renders until the background reply settles', async () => {
		const modules = await modulesPromise
		const dom = installDomMock()
		const deferredReply = createDeferred<void>()
		let approveCount = 0
		const request = createAccessRequestFixture()
		const props = {
			pendingAccessRequests: [request],
			renameAddressCallBack: () => undefined,
			changeActiveAddress: () => undefined,
			refreshActiveAddress: async () => undefined,
			approve: async () => {
				approveCount += 1
				await deferredReply.promise
			},
			reject: async () => undefined,
			informationChangedRecently: signal(false),
		}

		await act(() => {
			render(h(modules.AccessRequests, props), dom.document.body)
		})
		const approveButton = collectElements(dom.document.body, 'button').find((button) => button.textContent?.includes('Grant Access'))
		if (approveButton === undefined) throw new Error('Expected access approval button to render')

		await act(async () => {
			await clickElement(approveButton)
			await settleAsyncUpdates()
			render(h(modules.AccessRequests, props), dom.document.body)
		})

		assert.equal(approveCount, 1)
		assert.equal(isDisabled(approveButton), true)
		assert.equal(approveButton.textContent?.includes('Granting access...'), true)

		await act(async () => {
			deferredReply.resolve()
			await deferredReply.promise
			await settleAsyncUpdates()
		})

		assert.equal(isDisabled(approveButton), false)
		dom.restore()
	})

	test('sends the change-chain request and resolves once a background reply arrives', async () => {
		const modules = await modulesPromise
		const dom = installDomMock()
		const deferredReply = createDeferred<unknown>()
		let chainDialogRequest: unknown = undefined
		runtimeSendMessage = async (message) => {
			if (getRuntimeMethod(message) === 'popup_changeChainDialog') {
				chainDialogRequest = message
				return deferredReply.promise
			}
			return undefined
		}

		await act(() => {
			render(h(modules.ChangeChain, {}), dom.document.body)
		})

		await act(async () => {
			await emitRuntimeMessage(createChangeChainMessage())
		})

		const changeChainButton = collectElements(dom.document.body, 'button').find((button) => button.textContent?.includes('Change chain'))
		if (changeChainButton === undefined) throw new Error('Expected chain change confirm button to render')

			await act(async () => {
				await clickElement(changeChainButton)
				await settleAsyncUpdates()
			})

			assert.equal(chainDialogRequest === undefined, false)
			assert.equal(isDisabled(changeChainButton), true)

			await act(async () => {
				deferredReply.resolve(undefined)
				await deferredReply.promise
				await settleAsyncUpdates()
			})

			assert.equal(isDisabled(changeChainButton), false)
			assert.equal(changeChainButton.textContent?.includes('Change chain'), true)
			assert.equal(chainDialogRequest === undefined, false)
			dom.restore()
		})

	test('shows ABI lookup progress and a missing-reply error in AddNewAddress', async () => {
		const modules = await modulesPromise
		const dom = installDomMock()
		const deferredReply = createDeferred<unknown>()
		let requestCount = 0
		runtimeSendMessage = async () => {
			requestCount += 1
			return requestCount === 1 ? deferredReply.promise : undefined
		}

		const modifyAddressWindowState = signal({
			windowStateId: 'window-1',
			errorState: undefined,
			incompleteAddressBookEntry: {
				addingAddress: false,
				type: 'contract' as const,
				address: '0x0000000000000000000000000000000000000001',
				askForAddressAccess: true,
				name: 'Governance Contract',
				symbol: undefined,
				decimals: undefined,
				logoUri: undefined,
				entrySource: 'User' as const,
				abi: undefined,
				useAsActiveAddress: undefined,
				declarativeNetRequestBlockMode: undefined,
				chainId: 1n,
			},
		})

		const rpcEntries = signal([{
			name: 'Ethereum Mainnet',
			chainId: 1n,
			httpsRpc: 'https://rpc.example',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: true,
			minimized: false,
			blockExplorer: { apiUrl: 'https://explorer.example/api', apiKey: '' },
		}])

		await act(() => {
			render(h(modules.AddNewAddress, {
				close: () => undefined,
				setActiveAddressAndInformAboutIt: undefined,
				modifyAddressWindowState,
				activeAddress: undefined,
				rpcEntries,
			}), dom.document.body)
		})

		const buttons = collectElements(dom.document.body, 'button')
		const fetchButton = buttons.find((button) => button.textContent?.includes('Fetch from Block Explorer'))
		const modifyButton = buttons.find((button) => button.textContent?.includes('Modify'))
		const cancelButton = buttons.find((button) => button.textContent?.includes('Cancel'))
		if (fetchButton === undefined || modifyButton === undefined || cancelButton === undefined) throw new Error('Expected address modal buttons to render')

		await act(async () => {
			await clickElement(fetchButton)
		})

		assert.match(fetchButton.textContent ?? '', /Fetching\.\.\./)
		assert.equal(isDisabled(fetchButton), true)
		assert.equal(isDisabled(modifyButton), true)
		assert.equal(isDisabled(cancelButton), true)

		await act(async () => {
			deferredReply.resolve(undefined)
			await deferredReply.promise
			await settleAsyncUpdates()
		})

		assert.equal(dom.document.body.textContent?.includes(modules.BLOCK_EXPLORER_REPLY_MISSING_ERROR), true)
		assert.equal(dom.document.body.textContent?.includes('Fetch from Block Explorer'), true)
		dom.restore()
	})

	test('ignores stale ABI lookup failures after the address changes', async () => {
		const modules = await modulesPromise
		const dom = installDomMock()
		const staleReply = createAbiLookupFailureReply('stale block explorer failure')
		const deferredReply = createDeferred<typeof staleReply>()
		runtimeSendMessage = async () => deferredReply.promise

		const modifyAddressWindowState = signal({
			windowStateId: 'window-1',
			errorState: undefined,
			incompleteAddressBookEntry: {
				addingAddress: false,
				type: 'contract' as const,
				address: '0x0000000000000000000000000000000000000001',
				askForAddressAccess: true,
				name: 'Governance Contract',
				symbol: undefined,
				decimals: undefined,
				logoUri: undefined,
				entrySource: 'User' as const,
				abi: undefined,
				useAsActiveAddress: undefined,
				declarativeNetRequestBlockMode: undefined,
				chainId: 1n,
			},
		})

		const rpcEntries = signal([{
			name: 'Ethereum Mainnet',
			chainId: 1n,
			httpsRpc: 'https://rpc.example',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: true,
			minimized: false,
			blockExplorer: { apiUrl: 'https://explorer.example/api', apiKey: '' },
		}])

		await act(() => {
			render(h(modules.AddNewAddress, {
				close: () => undefined,
				setActiveAddressAndInformAboutIt: undefined,
				modifyAddressWindowState,
				activeAddress: undefined,
				rpcEntries,
			}), dom.document.body)
		})

		const fetchButton = collectElements(dom.document.body, 'button').find((button) => button.textContent?.includes('Fetch from Block Explorer'))
		if (fetchButton === undefined) throw new Error('Expected block explorer fetch button to render')

		await act(async () => {
			await clickElement(fetchButton)
		})

		await act(async () => {
			modifyAddressWindowState.value = {
				...modifyAddressWindowState.value,
				incompleteAddressBookEntry: {
					...modifyAddressWindowState.value.incompleteAddressBookEntry,
					address: '0x0000000000000000000000000000000000000002',
				},
			}
			await settleAsyncUpdates()
		})

		assert.equal(dom.document.body.textContent?.includes('Fetching...'), false)

		await act(async () => {
			deferredReply.resolve(staleReply)
			await deferredReply.promise
			await settleAsyncUpdates()
		})

		assert.equal(dom.document.body.textContent?.includes('stale block explorer failure'), false)
		assert.equal(dom.document.body.textContent?.includes('Fetch from Block Explorer'), true)
		dom.restore()
	})

	test('shows governance simulation progress and a missing-reply error', async () => {
		const modules = await modulesPromise
		const dom = installDomMock()
		const deferredReply = createDeferred<unknown>()
		runtimeSendMessage = async () => deferredReply.promise

		await act(() => {
			render(h(modules.GovernanceVoteVisualizer, {
				simTx: createGovernanceTransactionFixture(5n),
				activeAddress: signal(0x2n),
				renameAddressCallBack: () => undefined,
				editEnsNamedHashCallBack: () => undefined,
				governanceVoteInputParameters: createGovernanceVoteInputParameters(42n),
			}), dom.document.body)
		})

		const buttons = collectElements(dom.document.body, 'button')
		const simulateButton = buttons.find((button) => button.textContent?.includes('Simulate execution on a passing vote'))
		if (simulateButton === undefined) throw new Error('Expected governance simulation button to render')

		await act(async () => {
			await clickElement(simulateButton)
		})

		assert.match(simulateButton.textContent ?? '', /Simulating\.\.\./)
		assert.equal(isDisabled(simulateButton), true)

		await act(async () => {
			deferredReply.resolve(undefined)
			await deferredReply.promise
			await settleAsyncUpdates()
		})

		assert.equal(dom.document.body.textContent?.includes('Simulating governance execution failed because the background page did not return a reply.'), true)
		assert.equal(dom.document.body.textContent?.includes('Simulate execution on a passing vote'), true)
		dom.restore()
	})

	test('matching governance broadcasts clear later missing direct-reply errors', async () => {
		const modules = await modulesPromise
		const dom = installDomMock()
		const deferredReply = createDeferred<unknown>()
		runtimeSendMessage = async (message) => {
			if (getRuntimeMethod(message) === 'popup_simulateGovernanceContractExecution') return deferredReply.promise
			return undefined
		}

		await act(() => {
			render(h(modules.GovernanceVoteVisualizer, {
				simTx: createGovernanceTransactionFixture(5n),
				activeAddress: signal(0x2n),
				renameAddressCallBack: () => undefined,
				editEnsNamedHashCallBack: () => undefined,
				governanceVoteInputParameters: createGovernanceVoteInputParameters(42n),
			}), dom.document.body)
		})

		const simulateButton = collectElements(dom.document.body, 'button').find((button) => button.textContent?.includes('Simulate execution on a passing vote'))
		if (simulateButton === undefined) throw new Error('Expected governance simulation button to render')

		await act(async () => {
			await clickElement(simulateButton)
		})

		await act(async () => {
			await emitRuntimeMessage(createSimulationFailureBroadcast(5n, 'governance broadcast reply'))
			await settleAsyncUpdates()
		})

		assert.equal(dom.document.body.textContent?.includes('governance broadcast reply'), true)

		await act(async () => {
			deferredReply.resolve(undefined)
			await deferredReply.promise
			await settleAsyncUpdates()
		})

		assert.equal(dom.document.body.textContent?.includes('governance broadcast reply'), true)
		assert.equal(dom.document.body.textContent?.includes('Simulating governance execution failed because the background page did not return a reply.'), false)
		dom.restore()
	})

	test('ignores stale governance simulation replies after the visualizer switches to another transaction', async () => {
		const modules = await modulesPromise
		const dom = installDomMock()
		const staleRequestReply = createSimulationFailureReply(5n, 'stale governance request reply')
		const deferredReply = createDeferred<typeof staleRequestReply>()
		runtimeSendMessage = async (message) => {
			if (getRuntimeMethod(message) === 'popup_simulateGovernanceContractExecution') return deferredReply.promise
			return undefined
		}

		await act(() => {
			render(h(modules.GovernanceVoteVisualizer, {
				simTx: createGovernanceTransactionFixture(5n),
				activeAddress: signal(0x2n),
				renameAddressCallBack: () => undefined,
				editEnsNamedHashCallBack: () => undefined,
				governanceVoteInputParameters: createGovernanceVoteInputParameters(42n),
			}), dom.document.body)
		})

		const originalSimulateButton = collectElements(dom.document.body, 'button').find((button) => button.textContent?.includes('Simulate execution on a passing vote'))
		if (originalSimulateButton === undefined) throw new Error('Expected governance simulation button to render')

		await act(async () => {
			await clickElement(originalSimulateButton)
		})

		await act(() => {
			render(h(modules.GovernanceVoteVisualizer, {
				simTx: createGovernanceTransactionFixture(6n),
				activeAddress: signal(0x2n),
				renameAddressCallBack: () => undefined,
				editEnsNamedHashCallBack: () => undefined,
				governanceVoteInputParameters: createGovernanceVoteInputParameters(43n),
			}), dom.document.body)
		})

		await act(async () => {
			await emitRuntimeMessage(createSimulationFailureBroadcast(5n, 'stale governance broadcast reply'))
			await settleAsyncUpdates()
		})

		assert.equal(dom.document.body.textContent?.includes('stale governance broadcast reply'), false)
		assert.equal(dom.document.body.textContent?.includes('Refresh'), false)

		await act(async () => {
			deferredReply.resolve(staleRequestReply)
			await deferredReply.promise
			await settleAsyncUpdates()
		})

		assert.equal(dom.document.body.textContent?.includes('stale governance request reply'), false)
		assert.equal(dom.document.body.textContent?.includes('Refresh'), false)

		await act(async () => {
			await emitRuntimeMessage(createSimulationFailureBroadcast(6n, 'current governance broadcast reply'))
			await settleAsyncUpdates()
		})

		assert.equal(dom.document.body.textContent?.includes('current governance broadcast reply'), true)
		dom.restore()
	})

	test('shows Gnosis Safe simulation progress and a missing-reply error', async () => {
		const modules = await modulesPromise
		const dom = installDomMock()
		const deferredReply = createDeferred<unknown>()
		runtimeSendMessage = async () => deferredReply.promise

		await act(() => {
			render(h(modules.GnosisSafeVisualizer, {
				gnosisSafeMessage: createGnosisSafeMessageFixture(7n),
				activeAddress: gnosisSignerAddress.address,
				renameAddressCallBack: () => undefined,
				editEnsNamedHashCallBack: () => undefined,
			}), dom.document.body)
		})

		const buttons = collectElements(dom.document.body, 'button')
		const simulateButton = buttons.find((button) => button.textContent?.includes('Simulate execution'))
		if (simulateButton === undefined) throw new Error('Expected Gnosis simulation button to render')

		await act(async () => {
			await clickElement(simulateButton)
		})

		assert.match(simulateButton.textContent ?? '', /Simulating\.\.\./)
		assert.equal(isDisabled(simulateButton), true)

		await act(async () => {
			deferredReply.resolve(undefined)
			await deferredReply.promise
			await settleAsyncUpdates()
		})

		assert.equal(dom.document.body.textContent?.includes('Simulating Gnosis Safe execution failed because the background page did not return a reply.'), true)
		dom.restore()
	})

	test('matching Gnosis broadcasts clear later closed-channel direct-reply errors', async () => {
		const modules = await modulesPromise
		const dom = installDomMock()
		const deferredReply = createDeferred<unknown>()
		runtimeSendMessage = async (message) => {
			if (getRuntimeMethod(message) === 'popup_simulateGnosisSafeTransaction') return deferredReply.promise
			return undefined
		}

		await act(() => {
			render(h(modules.GnosisSafeVisualizer, {
				gnosisSafeMessage: createGnosisSafeMessageFixture(7n),
				activeAddress: gnosisSignerAddress.address,
				renameAddressCallBack: () => undefined,
				editEnsNamedHashCallBack: () => undefined,
			}), dom.document.body)
		})

		const simulateButton = collectElements(dom.document.body, 'button').find((button) => button.textContent?.includes('Simulate execution'))
		if (simulateButton === undefined) throw new Error('Expected Gnosis simulation button to render')

		await act(async () => {
			await clickElement(simulateButton)
		})

		await act(async () => {
			await emitRuntimeMessage(createSimulationFailureBroadcast(7n, 'Gnosis broadcast reply'))
			await settleAsyncUpdates()
		})

		assert.equal(dom.document.body.textContent?.includes('Gnosis broadcast reply'), true)

		await act(async () => {
			deferredReply.reject(new Error(ASYNC_CHANNEL_CLOSED_ERROR))
			await deferredReply.promise.catch(() => undefined)
			await settleAsyncUpdates()
		})

		assert.equal(dom.document.body.textContent?.includes('Gnosis broadcast reply'), true)
		assert.equal(dom.document.body.textContent?.includes('Simulating Gnosis Safe execution failed because the background page did not return a reply.'), false)
		dom.restore()
	})

	test('ignores stale Gnosis Safe simulation replies after the visualizer switches to another message', async () => {
		const modules = await modulesPromise
		const dom = installDomMock()
		const staleRequestReply = createSimulationFailureReply(7n, 'stale Gnosis request reply')
		const deferredReply = createDeferred<typeof staleRequestReply>()
		runtimeSendMessage = async (message) => {
			if (getRuntimeMethod(message) === 'popup_simulateGnosisSafeTransaction') return deferredReply.promise
			return undefined
		}

		await act(() => {
			render(h(modules.GnosisSafeVisualizer, {
				gnosisSafeMessage: createGnosisSafeMessageFixture(7n),
				activeAddress: gnosisSignerAddress.address,
				renameAddressCallBack: () => undefined,
				editEnsNamedHashCallBack: () => undefined,
			}), dom.document.body)
		})

		const originalSimulateButton = collectElements(dom.document.body, 'button').find((button) => button.textContent?.includes('Simulate execution'))
		if (originalSimulateButton === undefined) throw new Error('Expected Gnosis simulation button to render')

		await act(async () => {
			await clickElement(originalSimulateButton)
		})

		await act(() => {
			render(h(modules.GnosisSafeVisualizer, {
				gnosisSafeMessage: createGnosisSafeMessageFixture(8n),
				activeAddress: gnosisSignerAddress.address,
				renameAddressCallBack: () => undefined,
				editEnsNamedHashCallBack: () => undefined,
			}), dom.document.body)
		})

		await act(async () => {
			await emitRuntimeMessage(createSimulationFailureBroadcast(7n, 'stale Gnosis broadcast reply'))
			await settleAsyncUpdates()
		})

		assert.equal(dom.document.body.textContent?.includes('stale Gnosis broadcast reply'), false)
		assert.equal(dom.document.body.textContent?.includes('Refresh simulation'), false)

		await act(async () => {
			deferredReply.resolve(staleRequestReply)
			await deferredReply.promise
			await settleAsyncUpdates()
		})

		assert.equal(dom.document.body.textContent?.includes('stale Gnosis request reply'), false)
		assert.equal(dom.document.body.textContent?.includes('Refresh simulation'), false)

		await act(async () => {
			await emitRuntimeMessage(createSimulationFailureBroadcast(8n, 'current Gnosis broadcast reply'))
			await settleAsyncUpdates()
		})

		assert.equal(dom.document.body.textContent?.includes('current Gnosis broadcast reply'), true)
		dom.restore()
	})
})
