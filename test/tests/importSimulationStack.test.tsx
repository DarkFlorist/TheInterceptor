import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { signal } from '@preact/signals'
import { installDomMock } from './domMock.js'
import { InterceptorSimulationExport, InterceptorTransactionStack } from '../../app/ts/types/visualizer-types.js'
import { NEW_BLOCK_ABORT } from '../../app/ts/utils/constants.js'
import { createSafeTx } from '../../app/ts/safe/safeCore.js'
import { getSafeTxHash } from '../../app/ts/utils/eip712.js'
import { createSafeMessageTypedData } from '../../app/ts/safe/safeMessage.js'
import { EIP712Message } from '../../app/ts/types/eip721.js'
import type { SignedMessageTransaction } from '../../app/ts/types/visualizer-types.js'
import { IMPORTED_SIGNATURE_QUARANTINE_REASON } from '../../app/ts/background/importedStackTrust.js'

const storageState: Record<string, unknown> = {}
let runtimeSendMessage = async (_message: unknown) => undefined
let localSetBehavior = async (items: Record<string, unknown>) => {
	Object.assign(storageState, items)
}

function installBrowser() {
	Object.defineProperty(globalThis, 'browser', {
		value: {
			runtime: {
				lastError: null,
				getManifest: () => ({ manifest_version: 3 }),
				sendMessage: async (message: unknown) => await runtimeSendMessage(message),
				onMessage: { addListener: () => undefined, removeListener: () => undefined },
				onConnect: { addListener: () => undefined, removeListener: () => undefined },
			},
			storage: {
				local: {
					async get(keys?: string | string[] | Record<string, unknown> | null) {
						if (keys === undefined || keys === null) return { ...storageState }
						if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
						if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
						return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
					},
					async set(items: Record<string, unknown>) {
						await localSetBehavior(items)
					},
					async remove(keys: string | string[]) {
						for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
					},
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
	Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true, writable: true })
}

installBrowser()

async function loadModules() {
	return {
		...await import('../../app/ts/background/popupMessageHandlers.js'),
		...await import('../../app/ts/components/pages/ImportSimulationStack.js'),
		...await import('../../app/ts/background/windows/personalSign.js'),
		...await import('../../app/ts/simulation/services/EthereumClientService.js'),
	}
}

const modulesPromise = loadModules()

const exportPayload = {
	name: 'Interceptor Simulation Export' as const,
	version: '1.0.0' as const,
	eth_simulateV1: {
		method: 'eth_simulateV1' as const,
		params: [{
			blockStateCalls: [],
			traceTransfers: true,
			validation: true,
		}, 'latest' as const],
	},
	interceptorSimulateStack: {
		operations: [{
			type: 'TimeManipulation' as const,
			blockTimeManipulation: { type: 'AddToTimestamp' as const, deltaToAdd: 3n, deltaUnit: 'Seconds' as const },
		}],
	},
}

const exportString = JSON.stringify(InterceptorSimulationExport.serialize(exportPayload))
const expectedInfrastructureEthereum = {
	getBlock: async () => { throw NEW_BLOCK_ABORT },
}

const create7702ExportPayload = () => ({
	name: 'Interceptor Simulation Export' as const,
	version: '1.0.0' as const,
	eth_simulateV1: {
		method: 'eth_simulateV1' as const,
		params: [{
			blockStateCalls: [],
			traceTransfers: true,
			validation: true,
		}, 'latest' as const],
	},
	interceptorSimulateStack: {
		operations: [{
			type: 'Transaction' as const,
			preSimulationTransaction: {
				signedTransaction: {
					type: '7702' as const,
					from: 0x1111111111111111111111111111111111111111n,
					nonce: 7n,
					maxFeePerGas: 2n,
					maxPriorityFeePerGas: 1n,
					gas: 50_000n,
					to: 0x2222222222222222222222222222222222222222n,
					value: 0n,
					input: new Uint8Array(),
					chainId: 1n,
					hash: 0xabcden,
					r: 3n,
					s: 4n,
					yParity: 'odd' as const,
					authorizationList: [{
						chainId: 1n,
						address: 0x3333333333333333333333333333333333333333n,
						nonce: 5n,
						authority: 0x4444444444444444444444444444444444444444n,
						r: 6n,
						s: 7n,
						yParity: 'even' as const,
					}],
				},
				website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
				created: new Date('2024-01-01T00:00:00.000Z'),
				originalRequestParameters: {
					method: 'eth_sendTransaction' as const,
					params: [{
						type: '7702' as const,
						from: 0x1111111111111111111111111111111111111111n,
						to: 0x2222222222222222222222222222222222222222n,
						value: 0n,
						gas: 50_000n,
						maxFeePerGas: 2n,
						maxPriorityFeePerGas: 1n,
						input: new Uint8Array(),
						authorizationList: [{
							chainId: 1n,
							address: 0x3333333333333333333333333333333333333333n,
							nonce: 5n,
							r: 6n,
							s: 7n,
							yParity: 'even' as const,
						}],
					}],
				},
				transactionIdentifier: 77n,
			},
		}],
	},
})

function createSafeSimulationExportPayload() {
	const payload = create7702ExportPayload()
	const operation = payload.interceptorSimulateStack.operations[0]
	if (operation === undefined) throw new Error('Expected transaction fixture')
	const safeTx = createSafeTx(1n, 0x5555555555555555555555555555555555555555n, {
		to: 0x2222222222222222222222222222222222222222n,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	return {
		...payload,
		interceptorSimulateStack: {
			operations: [{
				...operation,
				preSimulationTransaction: {
					...operation.preSimulationTransaction,
					safeTransaction: {
						safeTx,
						safeTxHash: BigInt(getSafeTxHash(safeTx)),
						created: new Date('2024-01-01T00:00:00.000Z'),
						websiteOrigin: 'https://example.com',
						transactionIdentifier: 78n,
						signatures: [],
					},
				},
			}],
		},
	}
}

// vitalik.eth is in the default address book, so visualizing a message signed by it needs no RPC.
const VITALIK_ADDRESS = 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n
const SAFE_MESSAGE_TEXT = 'Hello Safe'
// A Safe message envelope for the text above; its `message.message` is the digest that a review text has to hash to.
const SAFE_MESSAGE_TYPED_DATA = createSafeMessageTypedData(1n, VITALIK_ADDRESS, SAFE_MESSAGE_TEXT)

// A simulated signature as a stack operation. `activeAddress` and `fakeSignedFor` both claim the account the message is for, which is what an export would claim to keep the account check quiet.
type SignatureRequest = { readonly parameters: SignedMessageTransaction['originalRequestParameters'], readonly wireParams: readonly string[] }

function createMessageOperation(messageIdentifier: bigint, request: SignatureRequest, safeMessageReview?: { readonly text: string, readonly isTypedData: boolean }) {
	const signedMessageTransaction: SignedMessageTransaction = {
		website: { websiteOrigin: 'example.com', icon: undefined, title: 'Example' },
		created: new Date('2024-01-01T00:00:00.000Z'),
		fakeSignedFor: VITALIK_ADDRESS,
		activeAddress: VITALIK_ADDRESS,
		originalRequestParameters: request.parameters,
		request: {
			method: request.parameters.method,
			// The intercepted request keeps the wire form the page sent.
			params: [...request.wireParams],
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } },
		},
		simulationMode: true,
		messageIdentifier,
		...(safeMessageReview === undefined ? {} : { safeMessageReview }),
	}
	return { type: 'Message' as const, signedMessageTransaction }
}

const personalSignRequest = (): SignatureRequest => {
	const message = `0x${ Buffer.from('Welcome to example.com').toString('hex') }`
	return { parameters: { method: 'personal_sign', params: [message, VITALIK_ADDRESS] }, wireParams: [message, `0x${ VITALIK_ADDRESS.toString(16) }`] }
}

const safeMessageRequest = (): SignatureRequest => ({
	parameters: { method: 'eth_signTypedData_v4', params: [VITALIK_ADDRESS, EIP712Message.parse(JSON.stringify(SAFE_MESSAGE_TYPED_DATA))] },
	wireParams: [`0x${ VITALIK_ADDRESS.toString(16) }`, JSON.stringify(SAFE_MESSAGE_TYPED_DATA)],
})

// Imports the operations on top of what is already stored and returns the stored stack, observed operations first.
async function importMessageOperations(operations: readonly ReturnType<typeof createMessageOperation>[]) {
	const modules = await modulesPromise
	const parsedExport = InterceptorSimulationExport.parse(InterceptorSimulationExport.serialize({ ...exportPayload, interceptorSimulateStack: { operations } }))
	const reply = await modules.importSimulationStack(expectedInfrastructureEthereum as never, {} as never, { method: 'popup_importSimulationStack', data: parsedExport })
	assert.equal(reply.ok, true)
	return InterceptorTransactionStack.parse(storageState.interceptorTransactionStack).operations.map((operation) => {
		if (operation.type !== 'Message') throw new Error('Expected only message operations')
		return operation.signedMessageTransaction
	})
}

async function visualizeSignedMessage(signedMessageTransaction: SignedMessageTransaction) {
	const modules = await modulesPromise
	const rpcEntry = { name: 'Ethereum Mainnet', chainId: 1n, httpsRpc: 'https://rpc.example.invalid', currencyName: 'Ether', currencyTicker: 'ETH', currencyLogoUri: undefined, primary: true, minimized: false }
	const ethereum = new modules.EthereumClientService({ rpcUrl: rpcEntry.httpsRpc, clearCache: () => undefined, jsonRpcRequest: async () => { throw new Error('RPC should not be called') } }, async () => undefined, async () => undefined, rpcEntry)
	return await modules.craftPersonalSignPopupMessage(ethereum, undefined, signedMessageTransaction, rpcEntry)
}

function resetEnvironment() {
	for (const key of Object.keys(storageState)) delete storageState[key]
	runtimeSendMessage = async () => undefined
	localSetBehavior = async (items: Record<string, unknown>) => {
		Object.assign(storageState, items)
	}
	Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true, writable: true })
}

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
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve
	})
	return { promise, resolve: resolvePromise }
}

async function settleAsyncUpdates() {
	await Promise.resolve()
	await Promise.resolve()
	await new Promise((resolve) => setTimeout(resolve, 0))
	await Promise.resolve()
}

describe('import simulation stack', () => {
	test('returns a typed failure reply when stack persistence fails', async () => {
		const modules = await modulesPromise
		resetEnvironment()
		localSetBehavior = async (items: Record<string, unknown>) => {
			if ('interceptorTransactionStack' in items) throw new Error('Resource::kQuotaBytes quota exceeded')
			Object.assign(storageState, items)
		}

		const reply = await modules.importSimulationStack({} as never, {} as never, { method: 'popup_importSimulationStack', data: exportPayload })

		assert.equal(reply.type, 'ImportSimulationStackReply')
		assert.equal(reply.ok, false)
		assert.match(reply.message, /quota/i)
		assert.match(reply.message, /simulation stack/i)
	})

	test('rejects Safe operations that must use synchronized Safe stack import', async () => {
		const modules = await modulesPromise
		resetEnvironment()
		const parsedExport = InterceptorSimulationExport.parse(
			InterceptorSimulationExport.serialize(createSafeSimulationExportPayload())
		)

		const reply = await modules.importSimulationStack({} as never, {} as never, { method: 'popup_importSimulationStack', data: parsedExport })

		assert.equal(reply.type, 'ImportSimulationStackReply')
		assert.equal(reply.ok, false)
		assert.match(reply.message, /Use Import Gnosis Safe/u)
		assert.equal('interceptorTransactionStack' in storageState, false)
		assert.equal('safeTransactionStacks' in storageState, false)
	})

	test('excludes synchronized Safe proposals from simulation-mode export', async () => {
		const modules = await modulesPromise
		resetEnvironment()
		const safeExport = createSafeSimulationExportPayload()
		storageState.interceptorTransactionStack = InterceptorTransactionStack.serialize(safeExport.interceptorSimulateStack)
		storageState.simulationMode = true
		let exportedSimulationInput: unknown
		const ethereum = {
			async getBlockNumber() { return 1n },
			async ethSimulateV1Input(simulationInput: unknown) {
				exportedSimulationInput = simulationInput
				return { method: 'eth_simulateV1' as const, params: [{ blockStateCalls: [], traceTransfers: true, validation: true }, 'latest' as const] }
			},
		}

		const reply = await modules.requestInterceptorSimulationInput(ethereum as never)

		assert.equal(reply.ok, true)
		if (!reply.ok) throw new Error(reply.message)
		const exported = InterceptorSimulationExport.parse(JSON.parse(reply.ethSimulateV1InputString))
		assert.deepEqual(exported.interceptorSimulateStack.operations, [])
		assert.deepEqual(exportedSimulationInput, [])
	})

	test('flags an imported signature whose export claims the signing account was active, while an observed one keeps its values', async () => {
		resetEnvironment()
		const observed = createMessageOperation(1n, personalSignRequest())
		storageState.interceptorTransactionStack = InterceptorTransactionStack.serialize({ operations: [observed] })

		const [storedObserved, storedImported] = await importMessageOperations([createMessageOperation(2n, personalSignRequest())])
		if (storedObserved === undefined || storedImported === undefined) throw new Error('Expected the observed and the imported message')

		assert.deepEqual({ ...storedObserved, messageIdentifier: 0n }, { ...observed.signedMessageTransaction, messageIdentifier: 0n })
		assert.equal(storedObserved.importedFromExport, undefined)
		assert.equal(storedImported.importedFromExport, true)

		const visualizedObserved = await visualizeSignedMessage(storedObserved)
		assert.equal(visualizedObserved.quarantine, false)
		const visualizedImported = await visualizeSignedMessage(storedImported)
		assert.equal(visualizedImported.quarantine, true)
		assert.deepEqual(visualizedImported.quarantineReasons, [IMPORTED_SIGNATURE_QUARANTINE_REASON])
	})

	test('shows an imported Safe message with its review only when the review hashes to the digest it signs', async () => {
		resetEnvironment()
		const observed = createMessageOperation(1n, safeMessageRequest(), { text: SAFE_MESSAGE_TEXT, isTypedData: false })
		storageState.interceptorTransactionStack = InterceptorTransactionStack.serialize({ operations: [observed] })

		const [storedObserved, matchingReview, craftedReview] = await importMessageOperations([
			createMessageOperation(2n, safeMessageRequest(), { text: SAFE_MESSAGE_TEXT, isTypedData: false }),
			createMessageOperation(3n, safeMessageRequest(), { text: 'Harmless login request', isTypedData: false }),
		])
		if (storedObserved === undefined || matchingReview === undefined || craftedReview === undefined) throw new Error('Expected the observed and both imported messages')
		assert.deepEqual(storedObserved.safeMessageReview, { text: SAFE_MESSAGE_TEXT, isTypedData: false })

		const visualizedObserved = await visualizeSignedMessage(storedObserved)
		assert.equal(visualizedObserved.type, 'SafeMessage')
		assert.equal(visualizedObserved.quarantine, false)

		const visualizedMatching = await visualizeSignedMessage(matchingReview)
		if (visualizedMatching.type !== 'SafeMessage') throw new Error(`Expected a Safe message review, got ${ visualizedMatching.type }`)
		assert.deepEqual(visualizedMatching.review, { text: SAFE_MESSAGE_TEXT, isTypedData: false })
		assert.deepEqual(visualizedMatching.quarantineReasons, [IMPORTED_SIGNATURE_QUARANTINE_REASON])

		// A review text that does not hash to the signed digest is not shown; the message falls back to plain EIP-712 and stays flagged.
		const visualizedCrafted = await visualizeSignedMessage(craftedReview)
		assert.equal(visualizedCrafted.type, 'EIP712')
		assert.equal(visualizedCrafted.quarantine, true)
		assert.deepEqual(visualizedCrafted.quarantineReasons, [IMPORTED_SIGNATURE_QUARANTINE_REASON])
	})

	test('marks every imported message whatever the export file says about it', async () => {
		resetEnvironment()
		const withMarker = createMessageOperation(1n, personalSignRequest())
		const markedExport = InterceptorSimulationExport.serialize({ ...exportPayload, interceptorSimulateStack: { operations: [{ ...withMarker, signedMessageTransaction: { ...withMarker.signedMessageTransaction, importedFromExport: true } }] } })
		// The marker can only be `true`, so an export claiming `false` is not a valid export and never reaches the import.
		const [markedOperation] = markedExport.interceptorSimulateStack.operations
		if (markedOperation?.type !== 'Message') throw new Error('Expected the exported message')
		assert.equal(InterceptorSimulationExport.safeParse({ ...markedExport, interceptorSimulateStack: { operations: [{ ...markedOperation, signedMessageTransaction: { ...markedOperation.signedMessageTransaction, importedFromExport: false } }] } }).success, false)
		// Without the marker or with it already set, the import marks the message.
		const importedMessages = await importMessageOperations([createMessageOperation(2n, personalSignRequest()), { ...withMarker, signedMessageTransaction: { ...withMarker.signedMessageTransaction, importedFromExport: true } }])
		assert.deepEqual(importedMessages.map((message) => message.importedFromExport), [true, true])
	})

	test('keeps the import marker through the id regeneration of a later import and through stack persistence', async () => {
		resetEnvironment()
		const [firstImport] = await importMessageOperations([createMessageOperation(1n, personalSignRequest())])
		if (firstImport === undefined) throw new Error('Expected the imported message')
		// A later import regenerates the ids of every operation already in the stack, this one included, and stores the stack again.
		const [importedEarlier, importedLater] = await importMessageOperations([createMessageOperation(2n, personalSignRequest())])
		if (importedEarlier === undefined || importedLater === undefined) throw new Error('Expected both imported messages')
		assert.notEqual(importedEarlier.messageIdentifier, firstImport.messageIdentifier)
		assert.equal(importedEarlier.importedFromExport, true)
		assert.deepEqual((await visualizeSignedMessage(importedEarlier)).quarantineReasons, [IMPORTED_SIGNATURE_QUARANTINE_REASON])
	})

	test('leaves the import marker out of export files, and marks the messages again when the file is imported', async () => {
		const modules = await modulesPromise
		resetEnvironment()
		await importMessageOperations([createMessageOperation(1n, personalSignRequest())])
		storageState.simulationMode = true
		const ethereum = {
			async getBlockNumber() { return 1n },
			async ethSimulateV1Input() { return { method: 'eth_simulateV1' as const, params: [{ blockStateCalls: [], traceTransfers: true, validation: true }, 'latest' as const] } },
		}

		const exportReply = await modules.requestInterceptorSimulationInput(ethereum as never)

		if (!exportReply.ok) throw new Error(exportReply.message)
		assert.equal(exportReply.ethSimulateV1InputString.includes('importedFromExport'), false)
		const exported = InterceptorSimulationExport.parse(JSON.parse(exportReply.ethSimulateV1InputString))
		const [exportedMessage] = exported.interceptorSimulateStack.operations
		if (exportedMessage?.type !== 'Message') throw new Error('Expected the exported message')
		assert.equal(exportedMessage.signedMessageTransaction.importedFromExport, undefined)

		resetEnvironment()
		const [reimported] = await importMessageOperations([exportedMessage])
		assert.equal(reimported?.importedFromExport, true)
	})

	test('drops the simulation options an imported transaction claims, while a transaction already in the stack keeps its own', async () => {
		const modules = await modulesPromise
		resetEnvironment()
		const withSimulationOptions = (transactionIdentifier: bigint, simulationOptions: { readonly requiredChainId: bigint, readonly simulateWithZeroBaseFee: boolean }) => {
			const [operation] = create7702ExportPayload().interceptorSimulateStack.operations
			if (operation === undefined) throw new Error('Expected transaction fixture')
			return { ...operation, preSimulationTransaction: { ...operation.preSimulationTransaction, transactionIdentifier, simulationOptions } }
		}
		storageState.interceptorTransactionStack = InterceptorTransactionStack.serialize({ operations: [withSimulationOptions(1n, { requiredChainId: 1n, simulateWithZeroBaseFee: true })] })
		const parsedExport = InterceptorSimulationExport.parse(InterceptorSimulationExport.serialize({
			...exportPayload,
			interceptorSimulateStack: { operations: [
				// A zero base fee lets a contract notice it is being simulated and behave differently there.
				withSimulationOptions(2n, { requiredChainId: 1n, simulateWithZeroBaseFee: true }),
				// A required chain decides on which chain the transaction is simulated at all.
				withSimulationOptions(3n, { requiredChainId: 5n, simulateWithZeroBaseFee: false }),
			] },
		}))

		const reply = await modules.importSimulationStack(expectedInfrastructureEthereum as never, {} as never, { method: 'popup_importSimulationStack', data: parsedExport })

		assert.equal(reply.ok, true)
		const storedTransactions = InterceptorTransactionStack.parse(storageState.interceptorTransactionStack).operations.map((operation) => {
			if (operation.type !== 'Transaction') throw new Error('Expected only transaction operations')
			return operation.preSimulationTransaction
		})
		assert.deepEqual(storedTransactions.map((transaction) => transaction.simulationOptions), [{ requiredChainId: 1n, simulateWithZeroBaseFee: true }, undefined, undefined])
		assert.equal(storedTransactions.every((transaction) => transaction.signedTransaction.type === '7702'), true)
	})

	test('preserves EIP-7702 authorization signatures when importing an exported stack', async () => {
		const modules = await modulesPromise
		resetEnvironment()
		const serializedExport = InterceptorSimulationExport.serialize(create7702ExportPayload())
		const parsedExport = InterceptorSimulationExport.parse(serializedExport)

		const reply = await modules.importSimulationStack(expectedInfrastructureEthereum as never, {} as never, { method: 'popup_importSimulationStack', data: parsedExport })

		assert.equal(reply.type, 'ImportSimulationStackReply')
		assert.equal(reply.ok, true)
		const storedStack = InterceptorTransactionStack.parse(storageState.interceptorTransactionStack)
		const [operation] = storedStack.operations
		if (operation === undefined || operation.type !== 'Transaction') throw new Error('Expected imported transaction operation')
		assert.notEqual(operation.preSimulationTransaction.transactionIdentifier, 77n)
		const transaction = operation.preSimulationTransaction.signedTransaction
		assert.equal(transaction.type, '7702')
		if (transaction.type !== '7702') throw new Error('Expected imported type-7702 transaction')
		const [authorization] = transaction.authorizationList
		if (authorization === undefined) throw new Error('Expected imported authorization')
		assert.equal(authorization.authority, 0x4444444444444444444444444444444444444444n)
		assert.equal(authorization.yParity, 'even')
		assert.equal(authorization.r, 6n)
		assert.equal(authorization.s, 7n)
	})

	test('keeps the modal open and shows the returned import error', async () => {
		const modules = await modulesPromise
		resetEnvironment()
		const dom = installDomMock()
		let closeCount = 0
		runtimeSendMessage = async () => ({ type: 'ImportSimulationStackReply', ok: false, message: 'Quota exceeded while saving the imported stack.' })

		await act(() => {
			render(h(modules.ImportSimulationStack, {
				close: () => { closeCount += 1 },
				simulationInput: signal(exportString),
			}), dom.document.body)
		})

		const buttons = collectElements(dom.document.body, 'button')
		const importButton = buttons.find((button) => button.textContent?.includes('Import'))
		assert.ok(importButton)

		await act(async () => {
			await clickElement(importButton)
			await settleAsyncUpdates()
		})

		assert.equal(closeCount, 0)
		assert.match(dom.document.body.textContent, /Quota exceeded while saving the imported stack\./)
		dom.restore()
	})

	test('shows import progress and disables modal controls while waiting for the reply', async () => {
		const modules = await modulesPromise
		resetEnvironment()
		const dom = installDomMock()
		const deferredReply = createDeferred<unknown>()
		let closeCount = 0
		runtimeSendMessage = async () => deferredReply.promise

		await act(() => {
			render(h(modules.ImportSimulationStack, {
				close: () => { closeCount += 1 },
				simulationInput: signal(exportString),
			}), dom.document.body)
		})

		const buttons = collectElements(dom.document.body, 'button')
		const closeButton = buttons.find((button) => button.textContent?.includes('Import') !== true)
		const importButton = buttons.find((button) => button.textContent?.includes('Import'))
		const textareas = collectElements(dom.document.body, 'textarea')
		const textarea = textareas[0]
		assert.ok(importButton)
		assert.ok(closeButton)
		assert.ok(textarea)

		await act(async () => {
			await clickElement(importButton)
			await settleAsyncUpdates()
		})

		assert.match(importButton.textContent ?? '', /Importing\.\.\./)
		assert.equal(isDisabled(importButton), true)
		assert.equal(isDisabled(closeButton), true)
		assert.equal(isDisabled(textarea), true)
		assert.equal(closeCount, 0)

		await act(async () => {
			deferredReply.resolve({ type: 'ImportSimulationStackReply', ok: true })
			await deferredReply.promise
			await settleAsyncUpdates()
		})

		assert.equal(closeCount, 1)
		dom.restore()
	})

	test('shows a missing-reply import error', async () => {
		const modules = await modulesPromise
		resetEnvironment()
		const dom = installDomMock()
		runtimeSendMessage = async () => undefined

		await act(() => {
			render(h(modules.ImportSimulationStack, {
				close: () => undefined,
				simulationInput: signal(exportString),
			}), dom.document.body)
		})

		const buttons = collectElements(dom.document.body, 'button')
		const importButton = buttons.find((button) => button.textContent?.includes('Import'))
		assert.ok(importButton)

		await act(async () => {
			await clickElement(importButton)
			await settleAsyncUpdates()
		})

		assert.match(dom.document.body.textContent, /Importing the simulation stack failed because the background page did not return a reply\./)
		dom.restore()
	})

	test('closes the modal after a successful import reply', async () => {
		const modules = await modulesPromise
		resetEnvironment()
		const dom = installDomMock()
		let closeCount = 0
		runtimeSendMessage = async () => ({ type: 'ImportSimulationStackReply', ok: true })

		await act(() => {
			render(h(modules.ImportSimulationStack, {
				close: () => { closeCount += 1 },
				simulationInput: signal(exportString),
			}), dom.document.body)
		})

		const buttons = collectElements(dom.document.body, 'button')
		const importButton = buttons.find((button) => button.textContent?.includes('Import'))
		assert.ok(importButton)

		await act(async () => {
			await clickElement(importButton)
			await settleAsyncUpdates()
		})

		assert.equal(closeCount, 1)
		dom.restore()
	})
})
