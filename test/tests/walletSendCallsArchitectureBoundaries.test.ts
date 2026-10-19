import * as assert from 'node:assert'
import { test } from 'bun:test'

const readSource = async (path: string) => await Bun.file(new URL(`../../app/ts/${ path }`, import.meta.url)).text()

const confirmTransactionSource = await readSource('background/windows/confirmTransaction.ts')
const confirmTransactionSimulationSource = await readSource('background/confirmTransactionSimulation.ts')
const walletSendCallsConfirmationSource = await readSource('background/walletSendCallsConfirmation.ts')
const walletSendCallsSource = await readSource('background/walletSendCalls.ts')
const confirmationWindowSupportSource = await readSource('background/confirmationWindowSupport.ts')
const transactionPreparationSource = await readSource('background/transactionPreparation.ts')
const visualizerTypesSource = await readSource('types/visualizer-types.ts')
const safeConfirmationSources = await Promise.all([
	'background/safeConfirmationResolver.ts',
	'background/safeConfirmationPersistence.ts',
	'background/safeSignerSelectionRefresh.ts',
	'safe/safePendingFlow.ts',
].map(readSource))

const batchConfirmationFunctions = [
	'toWalletSendCallStackOperation',
	'formWalletSendCallsTransactions',
	'simulateConfirmTransactionBatch',
	'simulatePendingTransactionBatch',
	'storeTransactionBatchSimulation',
	'refreshPendingTransactionBatchSimulation',
	'openConfirmTransactionDialogForTransactionBatch',
	'resolvePendingTransactionBatch',
	'finishApprovedTransactionBatch',
	'rejectTransactionBatch',
]
const definitionOf = (name: string) => new RegExp(`(?:function|const) ${ name }\\b`, 'u')

test('wallet_sendCalls batch confirmation is owned by walletSendCallsConfirmation.ts', () => {
	for (const name of batchConfirmationFunctions) {
		assert.match(walletSendCallsConfirmationSource, definitionOf(name), name)
		assert.doesNotMatch(confirmTransactionSource, definitionOf(name), name)
		assert.doesNotMatch(confirmTransactionSimulationSource, definitionOf(name), name)
	}
	assert.doesNotMatch(confirmTransactionSource, /transactionBatchResolutionScope|isWalletSendCallsIdInUse|updateInterceptorTransactionStackUnlessRefused/u)
})

const importsFrom = (source: string, modulePath: string) => new RegExp(`^import [^\\n]* from '[./]*${ modulePath.replaceAll('/', '\\/').replaceAll('.', '\\.') }'`, 'mu').test(source)

test('the batch owner depends on the shared confirmation support modules, not on the confirmation window it is dispatched from', () => {
	assert.equal(importsFrom(walletSendCallsConfirmationSource, 'windows/confirmTransaction.js'), false)
	assert.equal(importsFrom(walletSendCallsConfirmationSource, 'confirmationWindowSupport.js'), true)
	assert.equal(importsFrom(walletSendCallsConfirmationSource, 'transactionPreparation.js'), true)
	for (const supportSource of [confirmationWindowSupportSource, transactionPreparationSource]) {
		assert.equal(importsFrom(supportSource, 'windows/confirmTransaction.js'), false)
		assert.equal(importsFrom(supportSource, 'walletSendCallsConfirmation.js'), false)
	}
	assert.equal(importsFrom(confirmTransactionSource, 'confirmationWindowSupport.js'), true)
	assert.equal(importsFrom(confirmTransactionSource, 'transactionPreparation.js'), true)
	// One admission lock serializes every confirmation that is added to the queue.
	assert.match(confirmationWindowSupportSource, /const pendingConfirmationSemaphore = new Semaphore\(1\)/u)
	assert.doesNotMatch(confirmTransactionSource, /new Semaphore\(/u)
	assert.doesNotMatch(walletSendCallsConfirmationSource, /new Semaphore\(/u)
})

test('the confirmation window hands batches to the batch owner at one dispatch point', () => {
	assert.match(confirmTransactionSource, /import \{ resolvePendingTransactionBatch \} from '\.\.\/walletSendCallsConfirmation\.js'/u)
	assert.match(confirmTransactionSource, /if \(storedPending\.type === 'TransactionBatch'\) return await resolvePendingTransactionBatch\(/u)
	assert.doesNotMatch(confirmTransactionSource, /excludeTransactionBatch/u)
})

test('the Gnosis Safe confirmation flow is typed without wallet_sendCalls batches', () => {
	for (const source of safeConfirmationSources) {
		assert.match(source, /PendingTransactionOrSignableMessageExceptBatch/u)
		assert.doesNotMatch(source, /\bPendingTransactionOrSignableMessage\b/u)
	}
})

test('batch ids are looked up only in the batch id records, not on simulation stack transactions', () => {
	assert.doesNotMatch(visualizerTypesSource, /walletSendCallsBatchId/u)
	assert.match(walletSendCallsSource, /updatePendingTransactionsAndWalletSendCallsBatchIds\(/u)
	assert.doesNotMatch(walletSendCallsSource, /getPendingTransactionsAndMessages\(/u)
})
