import * as assert from 'node:assert'
import { test } from 'bun:test'

const readSource = async (path: string) => await Bun.file(new URL(`../../app/ts/${ path }`, import.meta.url)).text()

const confirmTransactionSource = await readSource('background/windows/confirmTransaction.ts')
const confirmTransactionSimulationSource = await readSource('background/confirmTransactionSimulation.ts')
const walletSendCallsConfirmationSource = await readSource('background/walletSendCallsConfirmation.ts')
const walletSendCallsSource = await readSource('background/walletSendCalls.ts')
const walletSendCallsBatchIdsSource = await readSource('background/walletSendCallsBatchIds.ts')
const walletSendCallsBindingSource = await readSource('background/walletSendCallsBinding.ts')
const activeAddressSettingsSource = await readSource('background/activeAddressSettings.ts')
const walletSendCallsRpcSource = await readSource('background/walletSendCallsRpc.ts')
const walletSendCallsStatusSource = await readSource('background/walletSendCallsStatus.ts')
// The confirmation support that both confirmation flows share, one concern per module, and what each module owns.
const confirmationSupportModules = {
	'confirmationAdmissionLock.ts': ['runWithPendingConfirmationLock'],
	'confirmationWindow.ts': ['AnswerRequestsOfClosedWindow', 'getPendingTransactionWindow', 'updateViewAfterPendingRequestRemoved', 'PendingRequestRemoval', 'removePendingRequestAndDeliverTerminalReply'],
	'confirmationDialogUpdates.ts': ['toPopupPendingTransactionOrSignableMessage', 'sendConfirmTransactionDialogUpdates', 'updateConfirmTransactionView'],
	'confirmationPreviews.ts': ['shouldReplacePopupVisualisation', 'refreshConfirmationMetadata'],
	'confirmationReplies.ts': ['formRejectMessage'],
} as const
const confirmationSupportSources = Object.fromEntries(await Promise.all(Object.keys(confirmationSupportModules).map(async (module) => [module, await readSource(`background/${ module }`)] as const)))
const getConfirmationSupportSource = (module: keyof typeof confirmationSupportModules) => confirmationSupportSources[module] ?? ''
const transactionPreparationSource = await readSource('background/transactionPreparation.ts')
const accessRequestTypesSource = await readSource('types/accessRequest.ts')
const storageVariablesSource = await readSource('background/storageVariables.ts')
const storedSettingsSource = await readSource('background/storedSettings.ts')
const backgroundSource = await readSource('background/background.ts')
const confirmationSimulationRunSource = await readSource('background/confirmationSimulationRun.ts')
const popupMessageHandlersSource = await readSource('background/popupMessageHandlers.ts')
const simulationUpdatingSource = await readSource('background/simulationUpdating.ts')
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
	// Nor on any module of the single-transaction, message or Gnosis Safe confirmation flows.
	for (const singleTransactionModule of ['confirmTransactionSimulation.js', 'safeTransactionConfirmation.js', 'safeConfirmationResolver.js', 'safeConfirmationPersistence.js', 'safeSignerSelectionRefresh.js', 'safeStackState.js', 'popupMessageHandlers.js', 'windows/personalSign.js']) {
		assert.equal(importsFrom(walletSendCallsConfirmationSource, singleTransactionModule), false, singleTransactionModule)
	}
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
	for (const name of ['getWalletSendCallsBatchId', 'getWalletSendCallTransactionIdentifier', 'isWalletSendCallsBundleOnStack', 'getTransactionBatchStackState', 'isWalletSendCallsIdInUse', 'addPendingTransactionBatch', 'releasePendingTransactionBatch', 'removeApprovedTransactionBatch', 'getWalletSendCallsBundleForRequester']) {
		assert.match(walletSendCallsBatchIdsSource, new RegExp(`^export (?:const|async function|function) ${ name }\\b`, 'mu'), name)
		for (const otherSource of [walletSendCallsSource, walletSendCallsBindingSource, walletSendCallsConfirmationSource, walletSendCallsRpcSource, walletSendCallsStatusSource]) assert.doesNotMatch(otherSource, new RegExp(`^export (?:const|async function|function) ${ name }\\b`, 'mu'), name)
	}
	assert.deepEqual(importedModules(walletSendCallsBatchIdsSource).filter((path) => path.startsWith('./')), ['./storageVariables.js'])
	for (const recordStore of ['updatePendingTransactionsAndWalletSendCallsBatchIds', 'getPendingTransactionsAndWalletSendCallsBatchIds', 'getWalletSendCallsBatchIds']) {
		for (const otherSource of [walletSendCallsSource, walletSendCallsBindingSource, walletSendCallsRpcSource, walletSendCallsStatusSource]) assert.doesNotMatch(otherSource, new RegExp(recordStore, 'u'), recordStore)
	}
})

test('a wallet_sendCalls bundle exists by one definition, which the id registry, wallet_getCallsStatus and the resolution of an interrupted approval share', () => {
	assert.match(walletSendCallsBatchIdsSource, /^export const isWalletSendCallsBundleOnStack = \(bundleTransactionIdentifiers: readonly bigint\[\], stackTransactionIdentifiers: readonly bigint\[\]\) => bundleTransactionIdentifiers\.every\(/mu)
	// The registry keeps an id in use and the status query reports a bundle by the same predicate, and the resolution decides from the stack state that the predicate classifies.
	assert.match(walletSendCallsBatchIdsSource, /\|\| isWalletSendCallsBundleOnStack\(record\.transactionIdentifiers, /u)
	assert.match(walletSendCallsBatchIdsSource, /if \(isWalletSendCallsBundleOnStack\(batchTransactionIdentifiers, stackTransactionIdentifiers\)\) return 'bundleOnStack'/u)
	assert.match(walletSendCallsBatchIdsSource, /if \(!isWalletSendCallsBundleOnStack\(record\.transactionIdentifiers, getStackTransactionIdentifiers\(await getInterceptorTransactionStack\(\)\)\)\) return undefined/u)
	assert.match(walletSendCallsStatusSource, /await getWalletSendCallsBundleForRequester\(/u)
	assert.doesNotMatch(walletSendCallsStatusSource, /isWalletSendCallsBundleOnStack/u)
	assert.match(walletSendCallsConfirmationSource, /case 'bundleOnStack': return \{ kind: 'finishedFromStack', delivered: await finishApprovedTransactionBatch\(/u)
	assert.doesNotMatch(walletSendCallsBatchIdsSource, /hasTransactionOnStack|isTransactionBatchOnStack/u)
	for (const source of [walletSendCallsStatusSource, walletSendCallsConfirmationSource]) assert.doesNotMatch(source, /isTransactionBatchOnStack|transactionIdentifiers\.every|\.operations\.some\(/u)
})

const appSourceUrl = new URL('../../app/ts/', import.meta.url)
const runtimeImportPattern = /^(?:import|export)\s+(?!type\s)(?:[^'\n]*?\s+from\s+)?'(\.{1,2}\/[^']+)'/gmu
// The app modules that loading a file runs, following its relative imports and re-exports transitively. Type-only imports are erased when the file is loaded, so they are not followed.
async function getRuntimeModuleClosure(entryUrl: URL) {
	const visited = new Set<string>()
	const pending = [entryUrl]
	for (let moduleUrl = pending.pop(); moduleUrl !== undefined; moduleUrl = pending.pop()) {
		if (visited.has(moduleUrl.href)) continue
		visited.add(moduleUrl.href)
		const source = await Bun.file(moduleUrl).text()
		for (const [, importPath] of source.matchAll(runtimeImportPattern)) {
			if (importPath === undefined) continue
			const typeScriptUrl = new URL(importPath.replace(/\.js$/u, '.ts'), moduleUrl)
			pending.push(await Bun.file(typeScriptUrl).exists() ? typeScriptUrl : new URL(importPath.replace(/\.js$/u, '.tsx'), moduleUrl))
		}
	}
	return [...visited].map((href) => href.startsWith(appSourceUrl.href) ? href.slice(appSourceUrl.href.length) : href).sort()
}
// Modules that the pure wire contract must not load: the simulation engine, extension storage, and the stack-backed batch id registry and status query.
const isSimulationOrStorageModule = (modulePath: string) => modulePath.startsWith('simulation/') || /storage/iu.test(modulePath) || ['background/storedSettings.ts', 'background/walletSendCallsBatchIds.ts', 'background/walletSendCallsStatus.ts'].includes(modulePath)

test('walletSendCalls.ts keeps only the EIP-5792 wire contract, and the refusals, the status query and the admission binding have their own modules', async () => {
	// The wire contract imports only types and utilities: no simulation, storage or other background module.
	assert.deepEqual(importedModules(walletSendCallsSource).filter((path) => !path.startsWith('../types/') && !path.startsWith('../utils/')), [])
	const contractClosure = await getRuntimeModuleClosure(new URL('background/walletSendCalls.ts', appSourceUrl))
	assert.deepEqual(contractClosure.filter(isSimulationOrStorageModule), [])
	assert.deepEqual(contractClosure.filter((path) => path.startsWith('background/')), ['background/walletSendCalls.ts'])
	// Its unit tests, which also cover the per-mode refusals, load neither the simulation engine nor storage, transitively.
	const requestTestClosure = await getRuntimeModuleClosure(new URL('../../test/tests/walletSendCallsRequest.test.ts', import.meta.url))
	assert.ok(requestTestClosure.includes('background/walletSendCallsRpc.ts'))
	assert.deepEqual(requestTestClosure.filter(isSimulationOrStorageModule), [])
	const ownerOf = (name: string) => [['walletSendCalls.ts', walletSendCallsSource], ['walletSendCallsRpc.ts', walletSendCallsRpcSource], ['walletSendCallsStatus.ts', walletSendCallsStatusSource], ['walletSendCallsBinding.ts', walletSendCallsBindingSource]]
		.filter(([, source]) => new RegExp(`^export (?:const|async function|function) ${ name }\\b`, 'mu').test(source ?? ''))
		.map(([module]) => module)
	for (const name of ['getSigningModeWalletCallsReply', 'getWalletSendCallsParseFailureReply', 'getWalletSendCallsWithoutInterceptorRpcReply', 'getSimulatedShowCallsStatusReply']) assert.deepEqual(ownerOf(name), ['walletSendCallsRpc.ts'], name)
	assert.deepEqual(ownerOf('getSimulatedCallsStatus'), ['walletSendCallsStatus.ts'])
	for (const name of ['canonicalizeWalletSendCalls', 'doWalletSendCallsMatchSimulatedTransactions', 'getCallsStatusCode', 'getWalletSendCallsTransactionParams']) assert.deepEqual(ownerOf(name), ['walletSendCalls.ts'], name)
	// The refusals are decided without the simulation engine or storage, so the RPC funnel can run them before parsing.
	assert.deepEqual((await getRuntimeModuleClosure(new URL('background/walletSendCallsRpc.ts', appSourceUrl))).filter(isSimulationOrStorageModule), [])
	// The status query is where the simulation engine and the registry are loaded, which also shows the closure follows imports.
	const statusClosure = await getRuntimeModuleClosure(new URL('background/walletSendCallsStatus.ts', appSourceUrl))
	for (const modulePath of ['simulation/services/SimulationModeEthereumClientService.ts', 'background/storageVariables.ts', 'background/walletSendCallsBatchIds.ts']) assert.ok(statusClosure.includes(modulePath), modulePath)
	for (const name of ['lookUpWalletSendCallsAccount', 'getWalletSendCallsBindingError', 'getWalletSendCallsApprovalError', 'isEthereumClientOnBatchChain']) assert.deepEqual(ownerOf(name), ['walletSendCallsBinding.ts'], name)
})

test('the RPC funnel runs the method-specific pre-parse gates before the parse-failure handlers, and names no method itself', () => {
	assert.match(backgroundSource, /^const RPC_PRE_PARSE_GATES: [^\n]* = \[getSigningModeWalletCallsReply\]$/mu)
	const gatesRun = backgroundSource.indexOf('for (const getPreParseReply of RPC_PRE_PARSE_GATES)')
	const parseFailureHandlersRun = backgroundSource.indexOf('for (const getMethodSpecificReply of RPC_PARSE_FAILURE_HANDLERS)')
	assert.ok(gatesRun >= 0 && parseFailureHandlersRun > gatesRun)
	assert.equal(backgroundSource.match(/getSigningModeWalletCallsReply/gu)?.length, 2)
	assert.doesNotMatch(backgroundSource, /wallet_sendCalls batches are simulated before approval/u)
})

test('the batch-free confirmation type is derived from the full union, and the queue is sorted into it exhaustively', () => {
	assert.match(accessRequestTypesSource, /type PendingTransactionOrSignableMessageExceptBatch = Exclude<PendingTransactionOrSignableMessage, \{ readonly type: 'TransactionBatch' \}>/u)
	assert.doesNotMatch(storageVariablesSource, /pending is PendingTransactionOrSignableMessageExceptBatch/u)
})

test('wallet_sendCalls resolves and compares the active account with the shared rule', () => {
	assert.equal(importsFrom(walletSendCallsBindingSource, 'websiteActiveAddress.js'), true)
	assert.match(walletSendCallsBindingSource, /import \{ haveSameActiveAddressSettings \} from '\.\/activeAddressSettings\.js'/u)
	// The approval check is a synchronous gate on a settings snapshot, so it stays off the extension messaging hub, and the active-address settings module it uses depends on nothing but the Settings type and a serializer.
	assert.equal(importsFrom(walletSendCallsBindingSource, 'backgroundUtils.js'), false)
	assert.deepEqual([...activeAddressSettingsSource.matchAll(/from '([^']+)'/gu)].map((match) => match[1]).sort(), ['../types/interceptor-messages.js', '../utils/bigint.js'])
	for (const source of [walletSendCallsSource, walletSendCallsBindingSource, walletSendCallsRpcSource, walletSendCallsStatusSource]) assert.doesNotMatch(source, /getActiveAddressForCurrentSignerState|const haveSameActiveAddressSettings|activeSimulationAddress/u)
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
	// The critical section stays private, and its conditional write reads its inputs itself and decides synchronously, so no caller code runs under the stack's write lock.
	assert.doesNotMatch(storageVariablesSource, /^export async function updateInterceptorTransactionStackOrRefuse\b/mu)
	assert.match(storageVariablesSource, /await updateInterceptorTransactionStackOrRefuse\(getSimulationSettingsSnapshot, \(prevStack, settingsSnapshot\)/u)
	assert.match(storageVariablesSource, /getRefusal: \(currentStack: InterceptorTransactionStack, settingsSnapshot: SimulationSettingsSnapshot\) => Refusal \| undefined/u)
	// storedSettings.ts imports no background module, so storageVariables.ts can read a settings snapshot without an import cycle.
	assert.deepEqual(importedModules(storedSettingsSource).filter((path) => path.startsWith('./')), [])
	assert.equal(storageVariablesSource.match(/setLargeStateValue\('interceptorTransactionStack'/gu)?.length, 1)
	assert.match(storageVariablesSource, /async function updateInterceptorTransactionStackOrRefuse</u)
	for (const wrapper of ['updateInterceptorTransactionStack', 'updateInterceptorTransactionStackUnlessRefused']) {
		const start = storageVariablesSource.search(new RegExp(`export async function ${ wrapper }[<(]`, 'u'))
		assert.ok(start >= 0, wrapper)
		const body = storageVariablesSource.slice(start, storageVariablesSource.indexOf('\n}\n', start))
		assert.match(body, /await updateInterceptorTransactionStackOrRefuse[<(]/u, wrapper)
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

test('both confirmation flows decide whether an account is a simulation-mode Gnosis Safe with one predicate from the shared Safe layer', async () => {
	const safeExecutionRoutingSource = await readSource('safe/safeExecutionRouting.ts')
	const safeTransactionConfirmationSource = await readSource('background/safeTransactionConfirmation.ts')
	const simulationModeSafeAccountSource = await readSource('background/simulationModeSafeAccount.ts')
	assert.match(safeExecutionRoutingSource, /^export async function getSimulationModeSafeAccount\(/mu)
	// The shared Safe layer decides from the address book entries it is given and calls no storage or diagnostics API itself; the background module reads the entries and records a fallback.
	assert.doesNotMatch(safeExecutionRoutingSource, /from '\.\.\/background\//u)
	assert.doesNotMatch(safeExecutionRoutingSource, /\b(?:reportLocalRecovery|reportUnexpectedError|appendErrorDiagnostic|browserStorageLocal\w*|getUserAddressBookEntries\w*)\b|browser\.storage/u)
	assert.match(simulationModeSafeAccountSource, /^export async function isSimulationModeSafeAccount\(/mu)
	for (const flowSource of [safeTransactionConfirmationSource, walletSendCallsConfirmationSource]) {
		assert.doesNotMatch(flowSource, /function isSimulationModeSafeAccount\b/u)
		assert.match(flowSource, /^import \{ isSimulationModeSafeAccount \} from '\.\/simulationModeSafeAccount\.js'$/mu)
	}
})

test('the confirmation window picks what it shows and gates per kind of confirmation at one exhaustive switch', async () => {
	const confirmTransactionPageSource = await readSource('components/pages/ConfirmTransaction.tsx')
	const switchStart = confirmTransactionPageSource.indexOf('export function getConfirmationKindView(')
	assert.ok(switchStart >= 0)
	const kindSwitch = confirmTransactionPageSource.slice(switchStart, confirmTransactionPageSource.indexOf('\n}\n', switchStart))
	assert.match(kindSwitch, /switch \(pending\.type\) \{[\s\S]*default: return assertNever\(pending\)/u)
	// The batch and message kinds are only named where their view is defined and selected, so no inline branch can let a new kind fall through to another kind's rendering or approval.
	const kindLiteralLines = (kind: string) => confirmTransactionPageSource.split('\n').filter((line) => line.includes(`'${ kind }'`))
	for (const [kind, viewName] of [['TransactionBatch', 'getTransactionBatchView'], ['SignableMessage', 'getSignableMessageView']]) {
		const lines = kindLiteralLines(kind)
		assert.equal(lines.length, 2, kind)
		assert.match(lines[0] ?? '', new RegExp(`^function ${ viewName }\\(pending: PendingConfirmationOfKind<'${ kind }'>\\): ConfirmationKindView \\{$`, 'u'), kind)
		assert.match(lines[1] ?? '', new RegExp(`^\\t\\tcase '${ kind }': return ${ viewName }\\(pending\\)$`, 'u'), kind)
	}
})

// The source of a top-level function or arrow function, from its definition to its closing brace.
function definitionSource(source: string, definitionStart: string) {
	const start = source.indexOf(definitionStart)
	assert.ok(start >= 0, definitionStart)
	return source.slice(start, source.indexOf('\n}\n', start))
}

test('every resolution that answers the website with a terminal reply leaves the queue through one ordering helper', () => {
	// The helper queues the reply, removes the request, delivers the reply, and updates the window in a finally, in that order.
	const helper = definitionSource(getConfirmationSupportSource('confirmationWindow.ts'), 'export async function removePendingRequestAndDeliverTerminalReply(')
	const steps = ['await queueTerminalReply(removal.terminalReply)', 'await removal.removeFromQueue()', 'return await attemptQueuedTerminalReplyDelivery(websiteTabConnections, removal.terminalReply)', '} finally {', 'await updateViewAfterPendingRequestRemoved(']
	const stepPositions = steps.map((step) => helper.indexOf(step))
	assert.ok(stepPositions.every((position) => position >= 0), steps.join(', '))
	assert.deepEqual(stepPositions, [...stepPositions].sort((first, second) => first - second))
	// No flow writes the ordering itself.
	for (const flowSource of [confirmTransactionSource, walletSendCallsConfirmationSource]) assert.doesNotMatch(flowSource, /\bqueueTerminalReply\(|attemptQueuedTerminalReplyDelivery\(/u)
	assert.doesNotMatch(walletSendCallsConfirmationSource, /queueTerminalReplyAndAttemptDelivery|updateViewAfterPendingRequestRemoved|releaseTransactionBatchAndUpdateView/u)
	// An approved batch keeps its id, and every rejection of a batch, an unanswered one included, releases it before the website has the rejection.
	assert.match(definitionSource(walletSendCallsConfirmationSource, 'async function finishApprovedTransactionBatch('), /return await removePendingRequestAndDeliverTerminalReply\([^]*removeFromQueue: async \(\) => await removeApprovedTransactionBatch\(pendingBatch\),\n\t\tsimulationStack: 'changed',/u)
	assert.match(definitionSource(walletSendCallsConfirmationSource, 'async function rejectTransactionBatch('), /return await removePendingRequestAndDeliverTerminalReply\([^]*removeFromQueue: async \(\) => await releasePendingTransactionBatch\(pendingBatch\),\n\t\tsimulationStack: 'unchanged',/u)
	assert.match(walletSendCallsConfirmationSource, /\t\tcase 'noResponse':\n\t\tcase 'reject': return await rejectTransactionBatch\(/u)
	assert.match(confirmTransactionSource, /await removePendingRequestAndDeliverTerminalReply\(ethereum, tokenPriceService, websiteTabConnections, \{\n\t\tremovedRequest: pendingTransactionOrMessage,/u)
})

test('a batch holds the confirmation lock only while it is added to the queue, and is simulated after the lock is released', () => {
	const admission = definitionSource(walletSendCallsConfirmationSource, 'export async function admitTransactionBatch(')
	const lockedStart = admission.indexOf('await runWithPendingConfirmationLock(async () => {')
	assert.ok(lockedStart >= 0)
	const locked = admission.slice(lockedStart, admission.indexOf('\n\t})\n', lockedStart))
	for (const lockedStep of ['isWalletSendCallsIdInUse(', 'getPendingTransactionWindow(', 'await addPendingTransactionBatch(pendingBatch)']) assert.ok(locked.includes(lockedStep), lockedStep)
	assert.doesNotMatch(locked, /simulatePendingTransactionBatch|storeTransactionBatchSimulation|updateConfirmTransactionView|tryFocusingTabOrWindow|showAdmittedTransactionBatch/u)
	assert.ok(admission.indexOf('await showAdmittedTransactionBatch(') > lockedStart + locked.length)
	assert.match(definitionSource(walletSendCallsConfirmationSource, 'async function showAdmittedTransactionBatch('), /await storeTransactionBatchSimulation\(pendingBatch\.uniqueRequestIdentifier, await simulatePendingTransactionBatch\(/u)
})

test('the governance vote preview finds a vote per kind of confirmation at one exhaustive switch, and decides its network by one rule', () => {
	const kindSwitch = definitionSource(popupMessageHandlersSource, 'const findGovernanceVoteInPendingRequest = ')
	assert.match(kindSwitch, /switch \(pending\.type\) \{[^]*default: return assertNever\(pending\)/u)
	assert.match(simulationUpdatingSource, /^export const getPreparedGovernanceVote = \(ethereum: EthereumClientService, voteTransaction: WebsiteCreatedEthereumTransaction\): PendingGovernanceVote => \{$/mu)
	const batchLookup = definitionSource(walletSendCallsConfirmationSource, 'export function findGovernanceVoteInTransactionBatch(')
	for (const lookup of [kindSwitch, batchLookup]) {
		assert.match(lookup, /getPreparedGovernanceVote\(ethereum, /u)
		assert.doesNotMatch(lookup, /getChainId\(\)|PreparedForOtherNetwork|isEthereumClientOnBatchChain/u)
	}
	assert.doesNotMatch(definitionSource(popupMessageHandlersSource, 'const findPendingGovernanceVote = '), /pending\.type|getChainId\(\)/u)
})
