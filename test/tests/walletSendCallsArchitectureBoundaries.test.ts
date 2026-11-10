import * as assert from 'node:assert'
import { test } from 'bun:test'

const readSource = async (path: string) => await Bun.file(new URL(`../../app/ts/${ path }`, import.meta.url)).text()

const confirmTransactionSource = await readSource('background/windows/confirmTransaction.ts')
const confirmTransactionSimulationSource = await readSource('background/confirmTransactionSimulation.ts')
const walletSendCallsConfirmationSource = await readSource('background/walletSendCallsConfirmation.ts')
const walletSendCallsSource = await readSource('background/walletSendCalls.ts')
const walletSendCallsBatchIdsSource = await readSource('background/walletSendCallsBatchIds.ts')
const walletSendCallsBindingSource = await readSource('background/walletSendCallsBinding.ts')
// The confirmation support that both confirmation flows share, one concern per module, and what each module owns.
const confirmationSupportModules = {
	'confirmationAdmissionLock.ts': ['runWithPendingConfirmationLock'],
	'confirmationWindow.ts': ['AnswerRequestsOfClosedWindow', 'getPendingTransactionWindow', 'updateViewAfterPendingRequestRemoved'],
	'confirmationDialogUpdates.ts': ['toPopupPendingTransactionOrSignableMessage', 'sendConfirmTransactionDialogUpdates', 'updateConfirmTransactionView'],
	'confirmationPreviews.ts': ['shouldReplacePopupVisualisation', 'refreshConfirmationMetadata'],
	'confirmationReplies.ts': ['formRejectMessage'],
} as const
const confirmationSupportSources = Object.fromEntries(await Promise.all(Object.keys(confirmationSupportModules).map(async (module) => [module, await readSource(`background/${ module }`)] as const)))
const getConfirmationSupportSource = (module: keyof typeof confirmationSupportModules) => confirmationSupportSources[module] ?? ''
const transactionPreparationSource = await readSource('background/transactionPreparation.ts')
const accessRequestTypesSource = await readSource('types/accessRequest.ts')
const storageVariablesSource = await readSource('background/storageVariables.ts')
const backgroundSource = await readSource('background/background.ts')
const confirmationSimulationRunSource = await readSource('background/confirmationSimulationRun.ts')
const popupMessageHandlersSource = await readSource('background/popupMessageHandlers.ts')
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
	'simulatePendingTransactionBatch',
	'storeTransactionBatchSimulation',
	'refreshPendingTransactionBatchSimulation',
	'admitTransactionBatch',
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
	assert.equal(importsFrom(walletSendCallsConfirmationSource, 'transactionPreparation.js'), true)
	for (const supportSource of [...Object.values(confirmationSupportSources), transactionPreparationSource]) {
		assert.equal(importsFrom(supportSource, 'windows/confirmTransaction.js'), false)
		assert.equal(importsFrom(supportSource, 'walletSendCallsConfirmation.js'), false)
	}
	assert.equal(importsFrom(confirmTransactionSource, 'transactionPreparation.js'), true)
	// One admission lock serializes every confirmation that is added to the queue.
	assert.match(getConfirmationSupportSource('confirmationAdmissionLock.ts'), /const pendingConfirmationSemaphore = new Semaphore\(1\)/u)
	assert.doesNotMatch(confirmTransactionSource, /new Semaphore\(/u)
	assert.doesNotMatch(walletSendCallsConfirmationSource, /new Semaphore\(/u)
})

test('each shared confirmation concern has one owner module, which both confirmation flows import it from', () => {
	const exportOf = (name: string) => new RegExp(`^export (?:const|async function|function|type) ${ name }\\b`, 'mu')
	for (const [module, ownedNames] of Object.entries(confirmationSupportModules)) {
		for (const name of ownedNames) {
			const owners = Object.entries(confirmationSupportSources).filter(([, source]) => exportOf(name).test(source)).map(([owner]) => owner)
			assert.deepEqual(owners, [module], name)
			for (const flowSource of [confirmTransactionSource, walletSendCallsConfirmationSource, popupMessageHandlersSource]) assert.doesNotMatch(flowSource, exportOf(name), name)
		}
	}
	for (const flowSource of [confirmTransactionSource, walletSendCallsConfirmationSource]) {
		for (const module of ['confirmationAdmissionLock.js', 'confirmationWindow.js', 'confirmationPreviews.js', 'confirmationReplies.js', 'confirmationDialogUpdates.js']) assert.equal(importsFrom(flowSource, module), true, module)
		assert.equal(importsFrom(flowSource, 'confirmationWindowSupport.js'), false)
	}
})

test('the confirmation window hands batches to the batch owner at one admission point and one dispatch point', () => {
	assert.match(confirmTransactionSource, /import \{ admitTransactionBatch, resolvePendingTransactionBatch, type TransactionBatchRequest \} from '\.\.\/walletSendCallsConfirmation\.js'/u)
	assert.match(confirmTransactionSource, /if \(storedPending\.type === 'TransactionBatch'\) return await resolvePendingTransactionBatch\(/u)
	assert.equal(confirmTransactionSource.match(/await admitTransactionBatch\(/gu)?.length, 1)
	assert.doesNotMatch(confirmTransactionSource, /excludeTransactionBatch/u)
})

const simulationModeHandlersSource = await readSource('background/simulationModeHandlers.ts')

test('every confirmation opener supplies the closed-window answerer of the generic dispatch, and the RPC layer supplies none', async () => {
	// The answerer is private to the module that owns the dispatch, so no other module can build or pass one.
	assert.match(confirmTransactionSource, /^const answerRequestsOfClosedConfirmationWindow = /mu)
	assert.doesNotMatch(confirmTransactionSource, /^export const answerRequestsOfClosedConfirmationWindow\b/mu)
	const openers = ['openConfirmTransactionDialogForMessage', 'openConfirmTransactionDialogForTransaction', 'openConfirmTransactionDialogForTransactionBatch']
	for (const opener of openers) {
		const start = confirmTransactionSource.indexOf(`export async function ${ opener }(`)
		assert.ok(start >= 0, opener)
		assert.match(confirmTransactionSource.slice(start, confirmTransactionSource.indexOf('\n}\n', start)), /answerRequestsOfClosedConfirmationWindow\(ethereumClientService, tokenPriceService, websiteTabConnections\)/u, opener)
	}
	// The RPC layer only calls the openers: it neither builds an answerer nor reaches the batch owner around the confirmation window.
	assert.doesNotMatch(simulationModeHandlersSource, /answerRequestsOfClosedConfirmationWindow|AnswerRequestsOfClosedWindow/u)
	assert.equal(importsFrom(simulationModeHandlersSource, 'walletSendCallsConfirmation.js'), false)
	const confirmationWindowImport = simulationModeHandlersSource.match(/^import \{ ([^}]*) \} from '\.\/windows\/confirmTransaction\.js'$/mu)?.[1]
	assert.deepEqual(confirmationWindowImport?.split(', ').sort(), openers)
	// Only the confirmation window admits batches.
	const appSourceDirectory = new URL('../../app/ts/', import.meta.url).pathname
	for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: appSourceDirectory, absolute: true })) {
		if (file.endsWith('/background/windows/confirmTransaction.ts') || file.endsWith('/background/walletSendCallsConfirmation.ts')) continue
		assert.doesNotMatch(await Bun.file(file).text(), /admitTransactionBatch/u, file)
	}
})

test('the Gnosis Safe confirmation flow is typed without wallet_sendCalls batches', () => {
	for (const source of safeConfirmationSources) {
		assert.match(source, /PendingTransactionOrSignableMessageExceptBatch/u)
		assert.doesNotMatch(source, /\bPendingTransactionOrSignableMessage\b/u)
	}
})

test('batch ids are looked up only in the batch id records, not on simulation stack transactions', () => {
	assert.doesNotMatch(visualizerTypesSource, /walletSendCallsBatchId/u)
	assert.match(walletSendCallsBatchIdsSource, /updatePendingTransactionsAndWalletSendCallsBatchIds\(/u)
	assert.doesNotMatch(walletSendCallsBatchIdsSource, /getPendingTransactionsAndMessages\(/u)
})

const importedModules = (source: string) => [...source.matchAll(/^import [^\n]* from '([^']+)'/gmu)].map((match) => match[1]).filter((path): path is string => path !== undefined).sort()

test('the batch id registry owns its records and their consistency with the queue and the stack, and depends only on storage', () => {
	for (const name of ['getWalletSendCallsBatchId', 'getWalletSendCallTransactionIdentifier', 'isTransactionBatchOnStack', 'isWalletSendCallsIdInUse', 'addPendingTransactionBatch', 'releasePendingTransactionBatch', 'removeApprovedTransactionBatch', 'getWalletSendCallsBatchTransactionIdentifiers']) {
		assert.match(walletSendCallsBatchIdsSource, new RegExp(`^export (?:const|async function|function) ${ name }\\b`, 'mu'), name)
		for (const otherSource of [walletSendCallsSource, walletSendCallsBindingSource, walletSendCallsConfirmationSource]) assert.doesNotMatch(otherSource, new RegExp(`^export (?:const|async function|function) ${ name }\\b`, 'mu'), name)
	}
	assert.deepEqual(importedModules(walletSendCallsBatchIdsSource).filter((path) => path.startsWith('./')), ['./storageVariables.js'])
	for (const recordStore of ['updatePendingTransactionsAndWalletSendCallsBatchIds', 'getPendingTransactionsAndWalletSendCallsBatchIds', 'getWalletSendCallsBatchIds']) {
		assert.doesNotMatch(walletSendCallsSource, new RegExp(recordStore, 'u'), recordStore)
		assert.doesNotMatch(walletSendCallsBindingSource, new RegExp(recordStore, 'u'), recordStore)
	}
})

test('walletSendCalls.ts keeps only the EIP-5792 wire contract, and the admission binding has its own module', () => {
	// The wire contract reads the simulated receipts for wallet_getCallsStatus and the registry for the calls of a batch id, and nothing about accounts, website access or settings.
	assert.deepEqual(importedModules(walletSendCallsSource).filter((path) => !path.startsWith('../types/') && !path.startsWith('../utils/') && path !== 'funtypes'), ['../simulation/services/EthereumClientService.js', '../simulation/services/SimulationModeEthereumClientService.js', './walletSendCallsBatchIds.js'])
	for (const name of ['lookUpWalletSendCallsAccount', 'getWalletSendCallsBindingError', 'getWalletSendCallsApprovalError', 'isEthereumClientOnBatchChain']) {
		assert.match(walletSendCallsBindingSource, new RegExp(`^export (?:const|async function|function) ${ name }\\b`, 'mu'), name)
		assert.doesNotMatch(walletSendCallsSource, new RegExp(`^export (?:const|async function|function) ${ name }\\b`, 'mu'), name)
	}
})

test('the batch-free confirmation type is derived from the full union, and the queue is sorted into it exhaustively', () => {
	assert.match(accessRequestTypesSource, /type PendingTransactionOrSignableMessageExceptBatch = Exclude<PendingTransactionOrSignableMessage, \{ readonly type: 'TransactionBatch' \}>/u)
	assert.doesNotMatch(storageVariablesSource, /pending is PendingTransactionOrSignableMessageExceptBatch/u)
})

test('wallet_sendCalls resolves and compares the active account with the shared rule', () => {
	assert.equal(importsFrom(walletSendCallsBindingSource, 'websiteActiveAddress.js'), true)
	assert.match(walletSendCallsBindingSource, /import \{ haveSameActiveAddressSettings \} from '\.\/backgroundUtils\.js'/u)
	for (const source of [walletSendCallsSource, walletSendCallsBindingSource]) assert.doesNotMatch(source, /getActiveAddressForCurrentSignerState|const haveSameActiveAddressSettings|activeSimulationAddress/u)
	assert.doesNotMatch(backgroundSource, /function getActiveAddressForRequest/u)
})

test('both confirmation flows share the simulation run machinery from a neutral module', () => {
	assert.equal(importsFrom(walletSendCallsConfirmationSource, 'confirmTransactionSimulation.js'), false)
	assert.equal(importsFrom(walletSendCallsConfirmationSource, 'confirmationSimulationRun.js'), true)
	assert.equal(importsFrom(confirmTransactionSimulationSource, 'confirmationSimulationRun.js'), true)
	for (const flowModule of ['windows/confirmTransaction.js', 'confirmTransactionSimulation.js', 'walletSendCallsConfirmation.js']) assert.equal(importsFrom(confirmationSimulationRunSource, flowModule), false, flowModule)
	for (const runState of ['const inFlightConfirmationRuns = new Map<string,', 'let latestConfirmationRunId']) {
		assert.ok(confirmationSimulationRunSource.includes(runState), runState)
		assert.ok(!confirmTransactionSimulationSource.includes(runState), runState)
	}
})

test('the confirmation metadata refresh routes batches to their owner and shares how a refreshed preview is stored', () => {
	assert.match(popupMessageHandlersSource, /case 'TransactionBatch': return await refreshPendingTransactionBatchMetadata\(/u)
	assert.match(walletSendCallsConfirmationSource, /export async function refreshPendingTransactionBatchMetadata\(/u)
	assert.match(getConfirmationSupportSource('confirmationPreviews.ts'), /export async function refreshConfirmationMetadata</u)
	assert.doesNotMatch(popupMessageHandlersSource, /isEthereumClientOnBatchChain|isSameConfirmationSimulation|storeRefreshedConfirmationMetadata/u)
	assert.doesNotMatch(walletSendCallsConfirmationSource, /isSameConfirmationSimulation|visualizeSimulatorState\(refreshedVisualisation/u)
})

test('the appended gas estimate and simulation preparation fill RPC blocks by one shared rule', async () => {
	const preparationSource = await readSource('simulation/services/EthereumClientService.ts')
	const simulationServiceSource = await readSource('simulation/services/SimulationModeEthereumClientService.ts')
	const appendedEstimateSource = simulationServiceSource.slice(simulationServiceSource.indexOf('export const simulateEstimateGasAppendedToSimulation'))
	const generalEstimateStart = simulationServiceSource.indexOf('export const simulateEstimateGas =')
	const generalEstimateSource = simulationServiceSource.slice(generalEstimateStart, simulationServiceSource.indexOf('\n}\n', generalEstimateStart))
	assert.match(preparationSource, /export const fitsInRpcBlock = \(usedGas: bigint, transactionGas: bigint, blockGasLimit: bigint\) => transactionGas <= getGasLeftInRpcBlock\(usedGas, blockGasLimit\)/u)
	// Preparation measures each transaction by the call the node runs (getExecutedTransaction), whose gas a Gnosis Safe execution's executor call sets.
	assert.match(preparationSource, /if \(fitsInRpcBlock\(currentChunkGasSum, gas, gasLimit\)\)/u)
	assert.doesNotMatch(preparationSource, /currentChunkGasSum \+ (?:transaction\.)?gas <=|calculateTotalGasUsed/u)
	for (const rule of ['getGasUsedInLastRpcBlock(', 'getGasLeftInRpcBlock(', 'fitsInRpcBlock(']) assert.ok(appendedEstimateSource.includes(rule), rule)
	// A Gnosis Safe's own call, which a configured Safe's batch call is, is estimated by the Safe layer. It keeps its runs in the last RPC block by the same rule, and checks the RPC block of the executor's call with the estimated gas by preparing the input as preview and approval do, instead of by repeating preparation's rules.
	const safeExecutionSimulationSource = await readSource('safe/safeExecutionSimulation.ts')
	const safeEstimateStart = safeExecutionSimulationSource.indexOf('export async function estimateSafeExecutionGas(')
	const safeEstimateSource = safeExecutionSimulationSource.slice(safeEstimateStart, safeExecutionSimulationSource.indexOf('\n}\n', safeEstimateStart))
	for (const rule of ['getGasUsedInLastRpcBlock(', 'getGasLeftInRpcBlock(', 'ethereum.prepareEthSimulateV1Input(', 'getSafeExecutorGasLimit(']) assert.ok(safeEstimateSource.includes(rule), rule)
	assert.doesNotMatch(safeEstimateSource, /fitsInRpcBlock\(|blockGasLimit - |lastRpcBlockGas \+ |\* 64n \/ 63n/u)
	assert.doesNotMatch(appendedEstimateSource, /blockGasLimit - |lastRpcBlockGas \+ /u)
	// The general estimate runs in a new block and carries none of the appended placement.
	assert.doesNotMatch(generalEstimateSource, /appendToLastPrefixBlock|RpcBlock/u)
})

test('the simulation stack is written in one critical section', () => {
	assert.equal(storageVariablesSource.match(/setLargeStateValue\('interceptorTransactionStack'/gu)?.length, 1)
	assert.match(storageVariablesSource, /async function updateInterceptorTransactionStackOrRefuse</u)
	for (const wrapper of ['updateInterceptorTransactionStack', 'updateInterceptorTransactionStackUnlessRefused']) {
		const start = storageVariablesSource.search(new RegExp(`export async function ${ wrapper }[<(]`, 'u'))
		assert.ok(start >= 0, wrapper)
		const body = storageVariablesSource.slice(start, storageVariablesSource.indexOf('\n}\n', start))
		assert.match(body, /await updateInterceptorTransactionStackOrRefuse</u, wrapper)
		assert.doesNotMatch(body, /transactionStateSemaphore|assertUniqueInterceptorTransactionIds|setLargeStateValue/u, wrapper)
	}
})

test('confirmation run ids are only taken by the run module, before a run reads its inputs', async () => {
	assert.match(confirmationSimulationRunSource, /^function getNextConfirmationRunId\(\) \{$/mu)
	assert.match(confirmationSimulationRunSource, /^export async function runConfirmationSimulation<T>\(uniqueRequestIdentifier: UniqueRequestIdentifier, run: \(confirmationRun: ConfirmationRun\) => Promise<T>\): Promise<T> \{\n\treturn await run\(\{ uniqueRequestIdentifier, confirmationRunId: getNextConfirmationRunId\(\) \}\)\n\}$/mu)
	const appSourceDirectory = new URL('../../app/ts/', import.meta.url).pathname
	for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: appSourceDirectory, absolute: true })) {
		if (file.endsWith('/background/confirmationSimulationRun.ts')) continue
		assert.doesNotMatch(await Bun.file(file).text(), /getNextConfirmationRunId/u, file)
	}
	// Every flow that starts a confirmation simulation run does its preparation inside the run.
	const runsIn = (source: string) => source.match(/await runConfirmationSimulation\([\w.]+\.uniqueRequestIdentifier, async \(confirmationRun\) =>/gu)?.length ?? 0
	assert.equal(runsIn(confirmTransactionSource), 2)
	assert.equal(runsIn(popupMessageHandlersSource), 1)
	assert.equal(runsIn(walletSendCallsConfirmationSource), 1)
})

test('both confirmation flows run and record a simulation run only through the shared run protocol', () => {
	// Starting a run is private to the protocol, so no flow can start, visualize or record a run on its own.
	assert.match(confirmationSimulationRunSource, /^function startConfirmationRun\(/mu)
	assert.match(confirmationSimulationRunSource, /^function finishConfirmationRun\(/mu)
	// Runs are only tracked per request, so no module-wide abort controller lets one confirmation abort another's run.
	assert.doesNotMatch(confirmationSimulationRunSource, /^let \w*AbortController\b/mu)
	assert.match(confirmationSimulationRunSource, /^export async function simulateConfirmationRun\(request: ConfirmationSimulationRunRequest\): Promise<ConfirmationSimulationRecord \| undefined> \{$/mu)
	for (const flowSource of [confirmTransactionSimulationSource, walletSendCallsConfirmationSource]) {
		assert.equal(flowSource.match(/await simulateConfirmationRun\(\{/gu)?.length, 1)
		assert.doesNotMatch(flowSource, /startConfirmationRun|finishConfirmationRun|visualizeSimulatorState\(|JSON_RPC_ERROR_CODE_INTERNAL_ERROR|blockNumber: 0n|simulationConductedTimestamp|getTabState\(/u)
	}
	// A batch stores the run's record as it is.
	assert.match(accessRequestTypesSource, /^export const ConfirmTransactionBatchVisualization = ConfirmationSimulationRecord$/mu)
})

test('a batch stores its website origin and account only in its binding', () => {
	const batchBaseStart = accessRequestTypesSource.indexOf('const PendingTransactionBatchBase = ')
	const batchBase = accessRequestTypesSource.slice(batchBaseStart, accessRequestTypesSource.indexOf('\n}))\n', batchBaseStart))
	assert.match(batchBase, /\tbinding: WalletSendCallsBinding,/u)
	assert.doesNotMatch(batchBase, /\t(?:activeAddress|website|websiteOrigin|account):/u)
	for (const source of [walletSendCallsConfirmationSource, walletSendCallsBatchIdsSource, walletSendCallsBindingSource]) assert.doesNotMatch(source, /pendingBatch\.(?:activeAddress|website)\b|pending\.website\b/u)
})
