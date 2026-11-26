import * as assert from 'node:assert'
import { test } from 'bun:test'

const backgroundSource = await Bun.file(new URL('../../app/ts/background/background.ts', import.meta.url)).text()
const confirmTransactionSource = await Bun.file(new URL('../../app/ts/background/windows/confirmTransaction.ts', import.meta.url)).text()
const popupMessageHandlersSource = await Bun.file(new URL('../../app/ts/background/popupMessageHandlers.ts', import.meta.url)).text()
const activeSettingsSource = await Bun.file(new URL('../../app/ts/background/activeSettings.ts', import.meta.url)).text()
const simulationUpdatingSource = await Bun.file(new URL('../../app/ts/background/simulationUpdating.ts', import.meta.url)).text()
const safeTransactionConfirmationSource = await Bun.file(new URL('../../app/ts/background/gnosisSafeTransactionConfirmation.ts', import.meta.url)).text()
const confirmTransactionComponentSource = await Bun.file(new URL('../../app/ts/components/pages/ConfirmTransaction.tsx', import.meta.url)).text()
const safeSourceDirectory = new URL('../../app/ts/gnosisSafe/', import.meta.url).pathname
const safeSourceFiles: string[] = []
for await (const file of new Bun.Glob('*.ts').scan({ cwd: safeSourceDirectory, absolute: true })) safeSourceFiles.push(file)
const safeSources = await Promise.all(safeSourceFiles.map(async (file) => await Bun.file(file).text()))
const simulationSourceDirectory = new URL('../../app/ts/simulation/', import.meta.url).pathname
const simulationSourceFiles: string[] = []
for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: simulationSourceDirectory, absolute: true })) simulationSourceFiles.push(file)
const simulationSources = await Promise.all(simulationSourceFiles.map(async (file) => await Bun.file(file).text()))

const ownerValidationFactory = /createGnosisSafeOwnerValidator/u
const confirmationDomainImports = /from '\.\.\/\.\.\/gnosisSafe\/gnosisSafe(?:Core|Stack|Simulation|ExecutionSimulation)\.js'/u
const rpcDomainImports = /from '\.\.\/\.\.\/(?:gnosisSafe\/|utils\/transactionGasAccounting\.js)/u
const simulationDomainImports = /from '(?:\.\.\/)+(?:gnosisSafe\/|types\/accessRequest\.js')/u
const admissionLeakage = /GnosisSafeReviewInput|(?:gnosisSafeReview|safeReview)[?:,]/u
const gatewayImports = /from '\.\/gnosisSafeApps(?:Balances|Transactions|Gateway)\.js'|\bfetch\(/u

test('architecture guards detect imports of existing domain modules and admission fields', async () => {
	assert.match(await Bun.file(new URL('../../app/ts/background/gnosisSafeConfirmationPersistence.ts', import.meta.url)).text(), ownerValidationFactory)
	for (const suffix of ['Core', 'Stack', 'Simulation', 'ExecutionSimulation']) {
		const file = `gnosisSafe${ suffix }.js`
		assert.equal(await Bun.file(new URL(`../../app/ts/gnosisSafe/${ file.replace(/\.js$/u, '.ts') }`, import.meta.url)).exists(), true)
		assert.match(`import { value } from '../../gnosisSafe/${ file }'`, confirmationDomainImports)
		assert.match(`import { value } from '../../gnosisSafe/${ file }'`, rpcDomainImports)
		assert.match(`import { value } from '../gnosisSafe/${ file }'`, simulationDomainImports)
	}
	for (const suffix of ['Balances', 'Transactions', 'Gateway']) {
		const file = `gnosisSafeApps${ suffix }.js`
		assert.equal(await Bun.file(new URL(`../../app/ts/background/${ file.replace(/\.js$/u, '.ts') }`, import.meta.url)).exists(), true)
		assert.match(`import { value } from './${ file }'`, gatewayImports)
	}
	for (const input of ['GnosisSafeReviewInput', 'gnosisSafeReview:', 'gnosisSafeReview?', 'gnosisSafeReview,']) assert.match(input, admissionLeakage)
})

test('the general RPC dispatcher delegates Gnosis Safe policy as one decision', () => {
	assert.match(backgroundSource, /import \{ getGnosisSafeModeRpcPolicyReply \} from '\.\.\/gnosisSafe\/gnosisSafeRequestPolicy\.js'/u)
	assert.doesNotMatch(backgroundSource, /GNOSIS_SAFE_MESSAGE_SIGNING_METHODS|isGnosisSafeTransactionCoSignRequest|gnosisSafeModeUnsupportedMethod/u)
	assert.doesNotMatch(backgroundSource, /Gnosis Safe message signing is not supported|Gnosis Safe transaction proposals require/u)
})

test('the confirmation window delegates Gnosis Safe resolution, persistence, and preparation', () => {
	assert.match(confirmTransactionSource, /resolveGnosisSafeConfirmation\(/u)
	assert.match(confirmTransactionSource, /resolveGnosisSafeSignerReply\(/u)
	assert.match(confirmTransactionSource, /prepareGnosisSafeTransactionConfirmation\(/u)
	assert.match(confirmTransactionSource, /safePreparation\.finalize\(/u)
	assert.doesNotMatch(confirmTransactionSource, ownerValidationFactory)
	assert.doesNotMatch(confirmTransactionSource, confirmationDomainImports)
	assert.doesNotMatch(confirmTransactionSource, /persistSignedGnosisSafeTransaction|reconcileGnosisSafeTransactionState/u)
	assert.doesNotMatch(confirmTransactionSource, /safeExecutionSignerRoute|reconciledStoredSafeState/u)
})

test('the Gnosis Safe layer alone decides how a simulated Gnosis Safe execution is formed', async () => {
	const safeExecutionSimulationSource = await Bun.file(new URL('../../app/ts/gnosisSafe/gnosisSafeExecutionSimulation.ts', import.meta.url)).text()
	assert.doesNotMatch(confirmTransactionSource, /executeThroughSafe: true|getSimulatedGnosisSafeCallNonce|'simulated-safe-executor'/u)
	assert.match(confirmTransactionSource, /const executedCallFormation = getExecutedCallFormation\(ethereumClientService, gasPayment, safeOperation\)/u)
	assert.equal(safeExecutionSimulationSource.match(/executeThroughSafe: true/gu)?.length, 1, 'one factory builds the options that forming and estimating share')
	assert.match(safeExecutionSimulationSource, /simulationOptions: createGnosisSafeExecutionSimulationOptions\(ethereum\.getChainId\(\), operation\),\n\t\}/u)
})

test('Gnosis Safe persistence only persists, and the confirmation window shows the stored proposal', async () => {
	const safeConfirmationPersistenceSource = await Bun.file(new URL('../../app/ts/background/gnosisSafeConfirmationPersistence.ts', import.meta.url)).text()
	assert.doesNotMatch(safeConfirmationPersistenceSource, /from '(?:\.\.\/utils\/popupOrTab|\.\/popupVisualisationUpdater|\.\/windows\/[^']+)\.js'/u)
	assert.doesNotMatch(safeConfirmationPersistenceSource, /\b(?:getHtmlFile|openPopupOrTab|updatePopupVisualisationIfNeeded|sendPopupMessageToOpenWindows)\b/u)
	assert.match(confirmTransactionSource, /async function showStoredGnosisSafeProposal\(/u)
})

test('popup message handlers delegate Gnosis Safe stack import and export', () => {
	assert.match(popupMessageHandlersSource, /export \{ importGnosisSafeStack, requestGnosisSafeStackExport, validateGnosisSafeTransactionStackForCurrentContract \} from '\.\/gnosisSafeStackHandlers\.js'/u)
	assert.doesNotMatch(popupMessageHandlersSource, /function validateGnosisSafeTransactionStackForCurrentContract/u)
})

test('Gnosis Safe transaction confirmation owns stored stack reconciliation', () => {
	assert.match(safeTransactionConfirmationSource, /from '\.\/gnosisSafeStackState\.js'/u)
	assert.match(safeTransactionConfirmationSource, /reconcileStoredGnosisSafeState\(/u)
})

test('everything that sends the simulation stack to the node runs its Gnosis Safe executions through the Gnosis Safe', () => {
	assert.match(simulationUpdatingSource, /export const prepareSimulationInputForRpc = [^\n]*\n(?:.*\n){0,4}?\tsimulationInput = await prepareGnosisSafeExecutionsForRpc\(simulationInput, ethereum\)/u)
	assert.match(simulationUpdatingSource, /export const simulateGnosisSafeMetaTransaction = [^\n]*\n(?:.*\n){0,2}?\t\tconst simulationInput = await prepareGnosisSafeExecutionsForRpc\(stackSimulationInput, ethereumClientService\)/u)
	assert.match(popupMessageHandlersSource, /const simulationInput = await prepareGnosisSafeExecutionsForRpc\(await getCurrentSimulationInput\(\), ethereumClientService\)/u)
	assert.match(simulationUpdatingSource, /export const simulateGovernanceContractExecution = [^\n]*\n(?:.*\n){0,30}?\t\tconst simulationInput = await prepareGnosisSafeExecutionsForRpc\(await getCurrentSimulationInput\(\), ethereum\)/u)
})

test('the RPC client enforces the executed-call invariant without Gnosis Safe domain code', async () => {
	const ethereumClientServiceSource = await Bun.file(new URL('../../app/ts/simulation/services/EthereumClientService.ts', import.meta.url)).text()
	assert.doesNotMatch(ethereumClientServiceSource, rpcDomainImports)
	assert.doesNotMatch(ethereumClientServiceSource, /Gnosis Safe|prepareGnosisSafeExecutionsForRpc|runsThroughGnosisSafe/u)
	// The RPC client decides from the minimal input's marker alone, not from the domain predicate or the Gnosis Safe data it reads.
	assert.doesNotMatch(ethereumClientServiceSource, /authorizesExecutedCall|GnosisSafeStackTransaction|safeTransaction|simulationOptions|executeThroughSafe/u)
	assert.match(ethereumClientServiceSource, /transaction\.executedCallAuthorized && transaction\.executedTransaction === undefined/u)
	assert.match(ethereumClientServiceSource, /transaction\.executedTransaction !== undefined && !transaction\.executedCallAuthorized/u)
	assert.match(ethereumClientServiceSource, /executedCallAuthorized: transaction\.executedCallAuthorized,/u)
})

test('the minimal simulation input that crosses into the RPC client carries no Gnosis Safe domain type', async () => {
	const visualizerTypesSource = await Bun.file(new URL('../../app/ts/types/visualizer-types.ts', import.meta.url)).text()
	const minimalDataBlockDefinition = visualizerTypesSource.match(/export const SimulationStateInputMinimalDataBlock = funtypes\.ReadonlyObject\(\{\n(?:.*\n)*?\}\)\n/u)?.[0]
	if (minimalDataBlockDefinition === undefined) throw new Error('SimulationStateInputMinimalDataBlock definition not found')
	assert.match(minimalDataBlockDefinition, /executedCallAuthorized: funtypes\.Boolean,/u)
	assert.doesNotMatch(minimalDataBlockDefinition.split('\n').filter((line) => !/^\s*\/\//u.test(line)).join('\n'), /Gnosis Safe|safeTransaction|simulationOptions|TransactionSimulationOptions|PreSimulationTransaction|SimulationInputTransaction/u)
	const { SimulationStateInputBlock, SimulationStateInputMinimalDataBlock, TransactionSimulationOptions } = await import('../../app/ts/types/visualizer-types.js')
	const { GnosisSafeStackTransaction } = await import('../../app/ts/types/gnosisSafeTypes.js')
	const getReachableRuntypes = (runtype: unknown) => {
		const reachableRuntypes = new Set<unknown>()
		const visit = (value: unknown) => {
			if (!(value instanceof Object) || reachableRuntypes.has(value)) return
			reachableRuntypes.add(value)
			for (const child of Object.values(value)) visit(child)
		}
		visit(runtype)
		return reachableRuntypes
	}
	// The full simulation input block does reach the Gnosis Safe runtypes, so the walk below would find them.
	assert.equal(getReachableRuntypes(SimulationStateInputBlock).has(GnosisSafeStackTransaction), true)
	const reachableRuntypes = getReachableRuntypes(SimulationStateInputMinimalDataBlock)
	assert.equal(reachableRuntypes.has(GnosisSafeStackTransaction), false, 'the minimal block reaches no GnosisSafeStackTransaction runtype')
	assert.equal(reachableRuntypes.has(TransactionSimulationOptions), false, 'the minimal block reaches no TransactionSimulationOptions runtype')
})

test('every decision whether the node runs a transaction as an executed call goes through authorizesExecutedCall', async () => {
	const readers: string[] = []
	for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: new URL('../../app/ts/', import.meta.url).pathname })) {
		const codeLines = (await Bun.file(new URL(`../../app/ts/${ file }`, import.meta.url)).text()).split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line))
		if (codeLines.some((line) => /simulationOptions\??\.executeThroughSafe/u.test(line))) readers.push(file)
	}
	// The import admission removes the field itself, so it reads it directly.
	assert.deepEqual(readers.sort(), ['background/importedSimulationStack.ts', 'types/visualizer-types.ts'])
})

test('simulation stack import applies every imported-stack admission rule from one module', () => {
	assert.match(popupMessageHandlersSource, /const admission = admitImportedSimulationStackOperations\(parsedRequest\.data\.interceptorSimulateStack\.operations\)/u)
	assert.match(popupMessageHandlersSource, /\.\.\.prevStack\.operations, \.\.\.admission\.operations\]/u)
	assert.doesNotMatch(popupMessageHandlersSource, /preSimulationTransaction\.safeTransaction !== undefined|executeThroughSafe/u)
	assert.doesNotMatch(safeTransactionConfirmationSource, /withoutImportedGnosisSafeExecutions/u)
})

test('a Gnosis Safe confirmation and its refreshes take the fee mode from one mapping of the flow kind', async () => {
	const safePendingFlowSource = await Bun.file(new URL('../../app/ts/gnosisSafe/gnosisSafePendingFlow.ts', import.meta.url)).text()
	assert.match(safeTransactionConfirmationSource, /gasPayment: getGnosisSafeTransactionFlowGasPayment\(openedSafeFlow\.kind\)/u)
	assert.match(safePendingFlowSource, /return getGnosisSafeTransactionFlowGasPayment\(getPendingTransactionFlowKind\(pending\)\)/u)
	assert.doesNotMatch(safeTransactionConfirmationSource, /'(?:transaction-sender|external-executor|simulated-safe-executor)'/u)
})

test('a pending transaction records its flow once, as the safeFlow that the confirmation stores and every refresh reads', async () => {
	const accessRequestSource = await Bun.file(new URL('../../app/ts/types/accessRequest.ts', import.meta.url)).text()
	const safePendingFlowSource = await Bun.file(new URL('../../app/ts/gnosisSafe/gnosisSafePendingFlow.ts', import.meta.url)).text()
	const pendingTransactionBaseDefinition = accessRequestSource.match(/const SimulatedPendingTransactionBase = funtypes\.ReadonlyObject\(\{\n(?:.*\n)*?\}\)\n/u)?.[0]
	if (pendingTransactionBaseDefinition === undefined) throw new Error('SimulatedPendingTransactionBase definition not found')
	assert.match(pendingTransactionBaseDefinition, /\tsafeFlow: PendingTransactionGnosisSafeFlow,\n/u)
	// The flow's data lives only in safeFlow, so no other pending field can disagree with it.
	const duplicateFlowField = /safeTransaction|(?:gnosisSafe|safe)Execution|executeThroughSafe|ProposalCreationFailed|unsupportedSafeRequest|\.And\(/u
	assert.doesNotMatch(pendingTransactionBaseDefinition, duplicateFlowField)
	for (const name of ['gnosisSafeExecution', 'safeExecution']) assert.match(`\t${ name }: funtypes.Boolean,`, duplicateFlowField)
	assert.equal(accessRequestSource.match(/export const PendingTransactionGnosisSafeFlow = /gu)?.length, 1)
	assert.match(safePendingFlowSource, /export type GnosisSafeTransactionFlowKind = PendingTransactionGnosisSafeFlow\['kind'\]/u)
	assert.match(safePendingFlowSource, /export const getPendingTransactionFlowKind = \(pending: PendingTransaction\): GnosisSafeTransactionFlowKind => pending\.safeFlow\.kind/u)
	assert.match(safeTransactionConfirmationSource, /readonly safeFlow: PendingTransactionGnosisSafeFlow\n/u)
})

test('a refresh creates a Gnosis Safe proposal whose transaction did not form under the lock that opening a confirmation holds, so it reserves its own Gnosis Safe nonce', () => {
	assert.match(confirmTransactionSource, /const outcome = await pendingConfirmationSemaphore\.execute\(async \(\) => \{\n\t\tconst finalizedSafePreparation = await safePreparation\.finalize\(/u)
	assert.match(confirmTransactionSource, /export const runWithPendingConfirmationLock = async <T>\(work: \(\) => Promise<T>\) => await pendingConfirmationSemaphore\.execute\(work\)/u)
	assert.match(popupMessageHandlersSource, /case 'prepareSafeProposal': return await runWithPendingConfirmationLock\(async \(\) => \{\n\t\t\tconst prepared = await prepareUnformedGnosisSafeProposalAgain\(/u)
})

test('Gnosis Safe confirmation takes its request-shape policy from the Gnosis Safe domain layer', () => {
	assert.match(safeTransactionConfirmationSource, /isGnosisSafeExecutableRequestFromActiveAddress\(transactionParams, activeAddress\)/u)
	assert.match(safeTransactionConfirmationSource, /getGnosisSafeUnsupportedRequestReason\(transactionParams\)/u)
	assert.match(safeTransactionConfirmationSource, /getGnosisSafeUnsupportedFormedTransactionReason\(transactionToSimulate\.transaction\)/u)
	assert.doesNotMatch(safeTransactionConfirmationSource, /'Gnosis Safe wallets do not support/u)
})

test('the Gnosis Safe domain layer does not import background orchestration', () => {
	for (const safeSource of safeSources) assert.doesNotMatch(safeSource, /from '\.\.\/background\//u)
})

test('the simulation layer imports neither the Gnosis Safe layer, which imports it, nor the popup\'s pending request model', () => {
	assert.ok(simulationSources.length > 0)
	for (const simulationSource of simulationSources) assert.doesNotMatch(simulationSource, simulationDomainImports)
})

test('neutral simulation services do not depend on the background installed-service owner', () => {
	for (const simulationSource of simulationSources) assert.doesNotMatch(simulationSource, /from '[^']*background\/simulationServicesOwner\.js'/u)
})

test('general simulation orchestration gets active stack policy from the shared utility layer', () => {
	assert.match(activeSettingsSource, /from '\.\.\/utils\/activeStackContext\.js'/u)
	assert.match(simulationUpdatingSource, /from '\.\.\/utils\/activeStackContext\.js'/u)
	assert.match(activeSettingsSource, /!activeStackContextsEqual\(getActiveStackContext\(previousSettings\), getActiveStackContext\(updatedSettings\)\)/u)
	assert.doesNotMatch(activeSettingsSource, /from '\.\.\/gnosisSafe\/gnosisSafeStack\.js'/u)
	assert.doesNotMatch(activeSettingsSource, /previousSettings\.activeSigningSafeAddress !== updatedSettings\.activeSigningSafeAddress/u)
	assert.doesNotMatch(simulationUpdatingSource, /from '\.\.\/gnosisSafe\/gnosisSafeStack\.js'/u)
	assert.doesNotMatch(simulationUpdatingSource, /if \(!settings\.simulationMode\) break/u)
})

test('the confirmation presentation imports shared Gnosis Safe flow policy from the domain layer', () => {
	assert.match(confirmTransactionComponentSource, /from '\.\.\/\.\.\/gnosisSafe\/gnosisSafePendingFlow\.js'/u)
	assert.doesNotMatch(confirmTransactionComponentSource, /from '\.\.\/\.\.\/background\/gnosisSafePendingFlow\.js'/u)
})


test('shared dispatch and confirmation APIs depend on operation models, not frontend admission types', async () => {
	const simulationHandlers = await Bun.file(new URL('../../app/ts/background/simulationModeHandlers.ts', import.meta.url)).text()
	for (const source of [backgroundSource, simulationHandlers, confirmTransactionSource, safeTransactionConfirmationSource]) {
		assert.doesNotMatch(source, admissionLeakage)
	}
	assert.match(simulationHandlers, /confirmation: TransactionConfirmationRequest/u)
	assert.match(simulationHandlers, /confirmation: MessageConfirmationRequest/u)
})

test('signer ownership and Gnosis Safe Apps eligibility use the same top-frame predicate', async () => {
	const provider = await Bun.file(new URL('../../app/ts/background/providerMessageHandlers.ts', import.meta.url)).text()
	const safeApps = await Bun.file(new URL('../../app/ts/background/gnosisSafeAppsCompatibilityCoordinator.ts', import.meta.url)).text()
	const startup = await Bun.file(new URL('../../app/ts/background/background-startup.ts', import.meta.url)).text()
	for (const source of [provider, safeApps, startup]) {
		assert.match(source, /isTopFramePort/u)
		assert.doesNotMatch(source, /frameId ===/u)
	}
})


test('only the Gnosis Safe message preview replaces a Gnosis Safe\'s code; Gnosis Safe proposals delegate-call through execTransaction', async () => {
	const safeSimulation = await Bun.file(new URL('../../app/ts/gnosisSafe/gnosisSafeSimulation.ts', import.meta.url)).text()
	assert.match(simulationUpdatingSource, /return prepareGnosisSafeDelegateStateOverrides\(/u)
	assert.doesNotMatch(safeSimulation, /prepareGnosisSafeDelegateStateOverrides\(safeAddress, code, block\.stateOverrides\)/u)
	assert.doesNotMatch(simulationUpdatingSource, /code: getGnosisSafeProxyProxy\(\)/u)
})

test('the content-script router delegates Gnosis Safe Apps admission and error mapping to its feature handler', async () => {
	const handler = await Bun.file(new URL('../../app/ts/background/gnosisSafeAppsRequestHandler.ts', import.meta.url)).text()
	assert.match(backgroundSource, /await prepareGnosisSafeAppsRequest\(/u)
	assert.doesNotMatch(backgroundSource, /getGnosisSafeAppsCompatibilityMode|isGnosisSafeAppsConnectionEligible|getGnosisSafeAppsExecution|getGnosisSafeAppsRequestCommand|isGnosisSafeAppsRequestPolicyError/u)
	assert.match(handler, /isGnosisSafeAppsConnectionEligibleForAdmittedAddress\(/u)
	assert.match(handler, /isGnosisSafeAppsRequestPolicyError\(/u)
	assert.doesNotMatch(handler, /handleRPCRequest|openConfirmTransactionDialogFor/u)
})

test('Gnosis Safe Apps request policy receives gateway operations through injected services', async () => {
	const policy = await Bun.file(new URL('../../app/ts/background/gnosisSafeAppsRequestPolicy.ts', import.meta.url)).text()
	assert.doesNotMatch(policy, gatewayImports)
	assert.match(policy, /services\.getBalances\(/u)
	assert.match(policy, /services\.getTransaction\(/u)
	assert.match(policy, /services\.messages\./u)
})

test('Gnosis Safe message approval encoding and review matching have domain owners', async () => {
	const policy = await Bun.file(new URL('../../app/ts/background/gnosisSafeAppsRequestPolicy.ts', import.meta.url)).text()
	const details = await Bun.file(new URL('../../app/ts/components/pages/GnosisSafeProposalDetails.tsx', import.meta.url)).text()
	const delegates = await Bun.file(new URL('../../app/ts/gnosisSafe/gnosisSafeDelegateCalls.ts', import.meta.url)).text()
	assert.match(policy, /buildGnosisSafeMessageApproval\(/u)
	for (const source of [safeTransactionConfirmationSource, details]) assert.match(source, /matchesGnosisSafeMessageApproval\(/u)
	assert.match(delegates, /decodeGnosisSafeMessageApproval\(/u)
	for (const source of [policy, safeTransactionConfirmationSource, details]) assert.doesNotMatch(source, /GNOSIS_SAFE_SIGN_MESSAGE_ABI|getGnosisSafeMessageDigest/u)
})


test('generic account resolution composes effective access contexts without site capability or native transport branches', async () => {
	const resolver = backgroundSource.slice(backgroundSource.indexOf('async function getRequestAddressContext('), backgroundSource.indexOf('async function discoverAccountRequestAddressContext('))
	const admissionComposition = await Bun.file(new URL('../../app/ts/background/requestAccessContext.ts', import.meta.url)).text()
	assert.match(resolver, /resolveRequestAccessContext/u)
	assert.doesNotMatch(resolver, /site_rpc_request|getNativeHostedSiteContext|isTopFramePort/u)
	assert.match(admissionComposition, /createRequestAccessContextResolver/u)
	assert.match(backgroundSource, /createRequestAccessContextResolver\(\[\{ method: 'site_rpc_request', resolve: getSiteReadRequestAccessContext \}\]\)/u)
	assert.doesNotMatch(admissionComposition, /siteReadRequestAdmission|site_rpc_request|isTopFramePort|getNativeHostedSiteContext/u)
})


test('generic routing delegates site token snapshots and reply construction to site admission', () => {
	const route = backgroundSource.slice(backgroundSource.indexOf('async function routeRequest('), backgroundSource.indexOf('async function getAccessContextForReroute('))
	assert.match(route, /await prepareSiteRpcRequest/u)
	assert.doesNotMatch(route, /getSiteSimulationTokens|getSiteSimulationTokenMetadata|getUpdatedSimulationStackSnapshot|identifyAddress/u)
})
