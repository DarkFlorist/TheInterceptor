import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { signal } from '@preact/signals'
import { installDomMock, type MockElement } from './domMock.js'
import { collectElements, clickElement, isDisabled } from './domQueries.js'
import { InterceptorSimulationExport, InterceptorTransactionStack, type InterceptorStackOperation, type PreSimulationTransaction } from '../../app/ts/types/visualizer-types.js'
import { NEW_BLOCK_ABORT } from '../../app/ts/utils/constants.js'
import { createSafeTx } from '../../app/ts/safe/safeCore.js'
import { getSafeTxHash } from '../../app/ts/utils/eip712.js'
import { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import { flushMicrotasks } from '../harness/async.js'
import { installBrowserMock } from '../harness/browserMock.js'
import { replaceGlobal } from '../harness/globals.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'
import { createStubEthereumClient } from './stubEthereumClient.js'
import { overrideProperty } from './typedPropertyOverride.js'

// The app modules are imported after the browser globals exist, as in the extension.
installBrowserMock()
replaceGlobal('indexedDB', undefined)
const installBrowserMockForTest = createPerTestBrowserMockInstaller()

async function loadModules() {
	return {
		...await import('../../app/ts/background/popupMessageHandlers/simulation.js'),
		...await import('../../app/ts/components/pages/ImportSimulationStack.js'),
	}
}

const modulesPromise = loadModules()

const createExportPayload = (operations: readonly InterceptorStackOperation[]): InterceptorSimulationExport => ({
	name: 'Interceptor Simulation Export',
	version: '1.0.0',
	eth_simulateV1: {
		method: 'eth_simulateV1',
		params: [{
			blockStateCalls: [],
			traceTransfers: true,
			validation: true,
		}, 'latest'],
	},
	interceptorSimulateStack: { operations },
})

const exportPayload = createExportPayload([{
	type: 'TimeManipulation',
	blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 3n, deltaUnit: 'Seconds' },
}])

const exportString = JSON.stringify(InterceptorSimulationExport.serialize(exportPayload))

const create7702PreSimulationTransaction = (): PreSimulationTransaction => ({
	signedTransaction: {
		type: '7702',
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
		yParity: 'odd',
		authorizationList: [{
			chainId: 1n,
			address: 0x3333333333333333333333333333333333333333n,
			nonce: 5n,
			authority: 0x4444444444444444444444444444444444444444n,
			r: 6n,
			s: 7n,
			yParity: 'even',
		}],
	},
	website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
	created: new Date('2024-01-01T00:00:00.000Z'),
	originalRequestParameters: {
		method: 'eth_sendTransaction',
		params: [{
			type: '7702',
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
				yParity: 'even',
			}],
		}],
	},
	transactionIdentifier: 77n,
})

const create7702ExportPayload = () => createExportPayload([{ type: 'Transaction', preSimulationTransaction: create7702PreSimulationTransaction() }])

function createSafeSimulationExportPayload() {
	const safeTx = createSafeTx(1n, 0x5555555555555555555555555555555555555555n, {
		to: 0x2222222222222222222222222222222222222222n,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	return createExportPayload([{
		type: 'Transaction',
		preSimulationTransaction: {
			...create7702PreSimulationTransaction(),
			safeTransaction: {
				safeTx,
				safeTxHash: BigInt(getSafeTxHash(safeTx)),
				created: new Date('2024-01-01T00:00:00.000Z'),
				websiteOrigin: 'https://example.com',
				transactionIdentifier: 78n,
				signatures: [],
			},
		},
	}])
}

// The import handler only needs the client to fail the follow-up simulation the way a superseded block does.
const createAbortingEthereumClient = () => createStubEthereumClient(async () => { throw NEW_BLOCK_ABORT })

const createTokenPriceService = () => new TokenPriceService(createStubEthereumClient(), 0)

const findImportButton = (root: MockElement) => collectElements(root, 'button').find((button) => button.textContent.includes('Import'))

describe('import simulation stack', () => {
	test('returns a typed failure reply when stack persistence fails', async () => {
		const modules = await modulesPromise
		const browserMock = installBrowserMockForTest()
		const storeItems = browserMock.browser.storage.local.set
		browserMock.browser.storage.local.set = async (items) => {
			if ('interceptorTransactionStack' in items) throw new Error('Resource::kQuotaBytes quota exceeded')
			await storeItems(items)
		}

		const reply = await modules.importSimulationStack(createStubEthereumClient(), createTokenPriceService(), { method: 'popup_importSimulationStack', data: exportPayload })

		assert.equal(reply.type, 'ImportSimulationStackReply')
		assert.ok(!reply.ok, 'Expected a failed import reply')
		assert.match(reply.message, /quota/i)
		assert.match(reply.message, /simulation stack/i)
	})

	test('rejects Safe operations that must use synchronized Safe stack import', async () => {
		const modules = await modulesPromise
		const browserMock = installBrowserMockForTest()
		const parsedExport = InterceptorSimulationExport.parse(
			InterceptorSimulationExport.serialize(createSafeSimulationExportPayload())
		)

		const reply = await modules.importSimulationStack(createStubEthereumClient(), createTokenPriceService(), { method: 'popup_importSimulationStack', data: parsedExport })

		assert.equal(reply.type, 'ImportSimulationStackReply')
		assert.ok(!reply.ok, 'Expected a failed import reply')
		assert.match(reply.message, /Use Import Gnosis Safe/u)
		assert.equal('interceptorTransactionStack' in browserMock.readStorage(), false)
		assert.equal('safeTransactionStacks' in browserMock.readStorage(), false)
	})

	test('excludes synchronized Safe proposals from simulation-mode export', async () => {
		const modules = await modulesPromise
		const safeExport = createSafeSimulationExportPayload()
		installBrowserMockForTest({ storage: { local: {
			interceptorTransactionStack: InterceptorTransactionStack.serialize(safeExport.interceptorSimulateStack),
			simulationMode: true,
		} } })
		let exportedSimulationInput: unknown
		const ethereum = createStubEthereumClient()
		overrideProperty(ethereum, 'getBlockNumber', async () => 1n)
		overrideProperty(ethereum, 'ethSimulateV1Input', async (simulationInput) => {
			exportedSimulationInput = simulationInput
			return { method: 'eth_simulateV1', params: [{ blockStateCalls: [], traceTransfers: true, validation: true }, 'latest'] }
		})

		const reply = await modules.requestInterceptorSimulationInput(ethereum)

		assert.equal(reply.ok, true)
		if (!reply.ok) throw new Error(reply.message)
		const exported = InterceptorSimulationExport.parse(JSON.parse(reply.ethSimulateV1InputString))
		assert.deepEqual(exported.interceptorSimulateStack.operations, [])
		assert.deepEqual(exportedSimulationInput, [])
	})

	test('preserves EIP-7702 authorization signatures when importing an exported stack', async () => {
		const modules = await modulesPromise
		const browserMock = installBrowserMockForTest()
		const serializedExport = InterceptorSimulationExport.serialize(create7702ExportPayload())
		const parsedExport = InterceptorSimulationExport.parse(serializedExport)

		const reply = await modules.importSimulationStack(createAbortingEthereumClient(), createTokenPriceService(), { method: 'popup_importSimulationStack', data: parsedExport })

		assert.equal(reply.type, 'ImportSimulationStackReply')
		assert.equal(reply.ok, true)
		const { interceptorTransactionStack } = browserMock.readStorage()
		const storedStack = InterceptorTransactionStack.parse(interceptorTransactionStack)
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
		installBrowserMockForTest({ handlers: { runtimeMessage: async () => ({ type: 'ImportSimulationStackReply', ok: false, message: 'Quota exceeded while saving the imported stack.' }) } })
		const dom = installDomMock()
		let closeCount = 0

		await act(() => {
			render(h(modules.ImportSimulationStack, {
				close: () => { closeCount += 1 },
				simulationInput: signal(exportString),
			}), dom.document.body)
		})

		const importButton = findImportButton(dom.document.body)
		assert.ok(importButton)

		await act(async () => {
			await clickElement(importButton)
			await flushMicrotasks()
		})

		assert.equal(closeCount, 0)
		assert.match(dom.document.body.textContent, /Quota exceeded while saving the imported stack\./)
		dom.restore()
	})

	test('shows import progress and disables modal controls while waiting for the reply', async () => {
		const modules = await modulesPromise
		const deferredReply = Promise.withResolvers<unknown>()
		installBrowserMockForTest({ handlers: { runtimeMessage: async () => await deferredReply.promise } })
		const dom = installDomMock()
		let closeCount = 0

		await act(() => {
			render(h(modules.ImportSimulationStack, {
				close: () => { closeCount += 1 },
				simulationInput: signal(exportString),
			}), dom.document.body)
		})

		const buttons = collectElements(dom.document.body, 'button')
		const closeButton = buttons.find((button) => !button.textContent.includes('Import'))
		const importButton = findImportButton(dom.document.body)
		const textareas = collectElements(dom.document.body, 'textarea')
		const textarea = textareas[0]
		assert.ok(importButton)
		assert.ok(closeButton)
		assert.ok(textarea)

		await act(async () => {
			await clickElement(importButton)
			await flushMicrotasks()
		})

		assert.match(importButton.textContent, /Importing\.\.\./)
		assert.equal(isDisabled(importButton), true)
		assert.equal(isDisabled(closeButton), true)
		assert.equal(isDisabled(textarea), true)
		assert.equal(closeCount, 0)

		await act(async () => {
			deferredReply.resolve({ type: 'ImportSimulationStackReply', ok: true })
			await deferredReply.promise
			await flushMicrotasks()
		})

		assert.equal(closeCount, 1)
		dom.restore()
	})

	test('shows a missing-reply import error', async () => {
		const modules = await modulesPromise
		installBrowserMockForTest({ handlers: { runtimeMessage: async () => undefined } })
		const dom = installDomMock()

		await act(() => {
			render(h(modules.ImportSimulationStack, {
				close: () => undefined,
				simulationInput: signal(exportString),
			}), dom.document.body)
		})

		const importButton = findImportButton(dom.document.body)
		assert.ok(importButton)

		await act(async () => {
			await clickElement(importButton)
			await flushMicrotasks()
		})

		assert.match(dom.document.body.textContent, /Importing the simulation stack failed because the background page did not return a reply\./)
		dom.restore()
	})

	test('closes the modal after a successful import reply', async () => {
		const modules = await modulesPromise
		installBrowserMockForTest({ handlers: { runtimeMessage: async () => ({ type: 'ImportSimulationStackReply', ok: true }) } })
		const dom = installDomMock()
		let closeCount = 0

		await act(() => {
			render(h(modules.ImportSimulationStack, {
				close: () => { closeCount += 1 },
				simulationInput: signal(exportString),
			}), dom.document.body)
		})

		const importButton = findImportButton(dom.document.body)
		assert.ok(importButton)

		await act(async () => {
			await clickElement(importButton)
			await flushMicrotasks()
		})

		assert.equal(closeCount, 1)
		dom.restore()
	})
})
