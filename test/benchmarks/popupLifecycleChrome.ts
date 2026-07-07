import { performance } from 'perf_hooks'
import { BENCHMARK_RPC_REQUESTS_GLOBAL } from '../../app/ts/utils/benchmarking.js'
import { POPUP_PERFORMANCE_MARKS } from '../../app/ts/utils/popupPerformance.js'
import { launchChromeSession, waitForAnyExtensionServiceWorker, waitForServiceWorker, createTargetPage, connectTarget, closeTarget, waitForPerformanceMark, waitForPerformanceMarks, waitForRegisteredContentScripts, readExtensionLargeStateValue, getPerformanceSnapshot, roundToTwoDecimals, absoluteTime, waitForPopupTarget, waitForTargetByUrl, waitForTargetGone, waitForBrowserTargets } from './chromeHarness.js'
import { startTransactionStackPageServer } from './transactionStackPageServer.js'
import type { CdpConnection, ChromeSession, PerformanceMarkSnapshot } from './chromeHarness.js'
import type { BenchmarkRpcRequestSample } from '../../app/ts/utils/benchmarking.js'

type ScenarioName = 'cold' | 'warm' | 'stacked'

type Sample = {
	scenario: ScenarioName
	launchMode: 'real-chrome-extension-page'
	popupLaunchEpochMs: number
	popupScriptStartMs: number
	popupShellPaintMs: number
	popupHomeFirstCommitMs: number
	popupRefreshCompleteMs: number | undefined
	popupRefreshRenderedMs: number | undefined
	workerRefreshStartMs: number
	workerRefreshEndMs: number
	rpcRequests: readonly BenchmarkRpcRequestSample[]
	setupRpcRequests: readonly BenchmarkRpcRequestSample[]
	stackedSetup?: StackedSetupSample
}

type StackedSetupSample = {
	launchEpochMs: number
	pageSnapshot: PerformanceMarkSnapshot
	confirmPopupSnapshot: PerformanceMarkSnapshot
	workerSnapshot: PerformanceMarkSnapshot
}

type Stats = {
	averageMs: number
	medianMs: number
	minMs: number
	maxMs: number
}

type ScenarioStats = {
	name: ScenarioName
	iterations: number
	launchMode: string
	popupScriptStart: Stats
	popupShellPaint: Stats
	popupHomeFirstCommit: Stats
	popupRefreshComplete: Stats | undefined
	popupRefreshRendered: Stats | undefined
	workerRefreshStart: Stats
	workerRefreshEnd: Stats
	rpcTotalRequests: number
	rpcTotalDurationMs: number
	rpcMethods: readonly RpcMethodStats[]
}

type RpcMethodStats = Stats & {
	method: string
	count: number
}

type BenchmarkContext = {
	chrome: ChromeSession
	extensionId: string
	anchorTargetId: string
}

type TransactionStackPageState = {
	phase: 'loading' | 'provider-ready' | 'requesting-access' | 'access-granted' | 'requesting-transaction' | 'submitted' | 'requesting-balance' | 'balance-fetched' | 'error'
	txHash?: string
	balance?: string
	error?: string
}

const BENCHMARK_TRANSACTION_PAGE_STATE_GLOBAL = '__interceptorBenchmarkTxPageState' as const

const POPUP_MARK_NAMES = [
		'interceptor:popup:script-start',
		'interceptor:popup:shell-painted',
		'interceptor:popup:home-first-commit',
] as const

const POPUP_REFRESH_COMPLETE_MARK = 'interceptor:popup:refresh-complete'
const POPUP_REFRESH_RENDERED_MARK = 'interceptor:popup:refresh-rendered'

const WORKER_MARK_NAMES = [
		'interceptor:background:refresh-home-start',
		'interceptor:background:refresh-home-end',
] as const

function stats(values: readonly (number | undefined)[]): Stats | undefined {
	const cleanValues = values.filter((value): value is number => value !== undefined)
	if (cleanValues.length === 0) return undefined
	const sorted = [...cleanValues].sort((a, b) => a - b)
	const total = sorted.reduce((sum, value) => sum + value, 0)
	return {
		averageMs: total / sorted.length,
		medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
		minMs: sorted[0] ?? 0,
		maxMs: sorted.at(-1) ?? 0,
	}
}

function formatStats(label: string, result: Stats | undefined) {
	if (result === undefined) return `${ label }: n/a`
	return `${ label }: avg ${ roundToTwoDecimals(result.averageMs) } ms, median ${ roundToTwoDecimals(result.medianMs) } ms, min/max ${ roundToTwoDecimals(result.minMs) } / ${ roundToTwoDecimals(result.maxMs) } ms`
}

function printStatsGroup(title: string, entries: readonly (readonly [string, Stats | undefined])[]) {
	console.warn(title)
	for (const [label, result] of entries) {
		console.warn(formatStats(`    ${ label }`, result))
	}
}

function requireStats(result: Stats | undefined, label: string) {
	if (result === undefined) throw new Error(`Missing ${ label } statistics`)
	return result
}

function requireRpcMethodStats(result: RpcMethodStats | undefined, label: string) {
	if (result === undefined) throw new Error(`Missing ${ label } rpc statistics`)
	return result
}

function extractExtensionId(url: string) {
	const match = /^chrome-extension:\/\/([^/]+)/.exec(url)
	if (match?.[1] === undefined) throw new Error(`Could not determine extension id from ${ url }`)
	return match[1]
}

function requiredTiming(launchEpochMs: number, snapshot: PerformanceMarkSnapshot, markName: string) {
	const absolute = absoluteTime(snapshot, markName)
	if (absolute === undefined) throw new Error(`Missing performance mark: ${ markName }`)
	const delta = absolute - launchEpochMs
	if (delta < -50) throw new Error(`Performance mark ${ markName } was stale for the measured popup open`)
	return delta
}

function timingFromSnapshot(launchEpochMs: number | undefined, snapshot: PerformanceMarkSnapshot | undefined, markName: string) {
	if (launchEpochMs === undefined || snapshot === undefined) return undefined
	return requiredTiming(launchEpochMs, snapshot, markName)
}

function stackedSetupTiming(setups: readonly StackedSetupSample[], source: 'page' | 'worker' | 'confirm', markName: string) {
	return stats(setups.map((setup) => {
		try {
			const snapshot = source === 'page' ? setup.pageSnapshot : source === 'worker' ? setup.workerSnapshot : setup.confirmPopupSnapshot
			return timingFromSnapshot(setup.launchEpochMs, snapshot, markName)
		} catch {
			return undefined
		}
	}))
}

function stackedSampleTiming(samples: readonly Sample[], selector: (sample: Sample, setup: StackedSetupSample) => number | undefined) {
	return stats(samples.map((sample) => {
		if (sample.stackedSetup === undefined) return undefined
		try {
			return selector(sample, sample.stackedSetup)
		} catch {
			return undefined
		}
	}))
}

function formatRpcMethodStats(label: string, result: RpcMethodStats | undefined) {
	if (result === undefined) return `${ label }: n/a`
	return `${ label }: ${ result.count } call${ result.count === 1 ? '' : 's' }, avg ${ roundToTwoDecimals(result.averageMs) } ms, median ${ roundToTwoDecimals(result.medianMs) } ms, min/max ${ roundToTwoDecimals(result.minMs) } / ${ roundToTwoDecimals(result.maxMs) } ms`
}

function aggregateRpcRequests(rpcRequests: readonly BenchmarkRpcRequestSample[]) {
	const totalRequests = rpcRequests.length
	const totalDurationMs = rpcRequests.reduce((sum, request) => sum + request.durationMs, 0)
	const grouped = new Map<string, number[]>()
	for (const request of rpcRequests) {
		const durations = grouped.get(request.method) ?? []
		durations.push(request.durationMs)
		grouped.set(request.method, durations)
	}
	const methods = [...grouped.entries()].map(([method, durations]) => {
		const result = stats(durations)
		if (result === undefined) throw new Error(`Missing rpc method durations for ${ method }`)
		return {
			method,
			count: durations.length,
			...result,
		}
	})
	return {
		totalRequests,
		totalDurationMs,
		methods,
	}
}

function rpcRequestCollectorExpression() {
	return `(() => globalThis[${ JSON.stringify(BENCHMARK_RPC_REQUESTS_GLOBAL) }] ?? [])()`
}

function rpcRequestCollectorResetExpression() {
	return `(() => {
		globalThis[${ JSON.stringify(BENCHMARK_RPC_REQUESTS_GLOBAL) }] = []
		return true
	})()`
}

async function clearWorkerPerformanceMarks(workerConnection: CdpConnection) {
	await workerConnection.evaluate(`(async () => {
		performance.clearMarks()
		return true
	})()`)
}

async function waitForCondition(condition: () => Promise<boolean> | boolean, timeoutMs: number, label: string) {
	const start = Date.now()
	while (true) {
		if (await condition()) return
		if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${ label } after ${ timeoutMs }ms`)
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 50)
		})
	}
}

async function getTransactionPageState(connection: CdpConnection): Promise<TransactionStackPageState | undefined> {
	const state = await connection.evaluate<TransactionStackPageState | undefined>(`(() => globalThis[${ JSON.stringify(BENCHMARK_TRANSACTION_PAGE_STATE_GLOBAL) }] ?? undefined)()`)
	return state
}

async function waitForTransactionPagePhase(connection: CdpConnection, phase: TransactionStackPageState['phase'], timeoutMs: number) {
	await waitForCondition(async () => {
		const state = await getTransactionPageState(connection)
		if (state?.phase === 'error') throw new Error(`Transaction page failed: ${ state.error ?? 'unknown error' }`)
		return state?.phase === phase
	}, timeoutMs, `transaction page phase ${ phase }`)
}

async function waitForButtonEnabled(connection: CdpConnection, selector: string, timeoutMs: number) {
	const start = Date.now()
	let latestSnapshot = 'No button snapshot captured.'
	while (true) {
		const result = await connection.evaluate<{ enabled: boolean, snapshot: string }>(`(() => {
			const buttons = Array.from(document.querySelectorAll('button')).map((button) => ({
				text: button.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
				className: button.className,
				disabled: button.disabled,
			}))
			const element = document.querySelector(${ JSON.stringify(selector) })
			return {
				enabled: element instanceof HTMLButtonElement && element.disabled === false,
				snapshot: JSON.stringify({
					targetFound: element instanceof HTMLButtonElement,
					buttons,
					bodyText: document.body.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 2000) ?? '',
					performanceMarks: performance.getEntriesByType('mark').map((mark) => mark.name),
				}, undefined, 2),
			}
		})()`).catch((error) => ({
			enabled: false,
			snapshot: `Failed to inspect buttons: ${ error instanceof Error ? error.message : String(error) }`,
		}))
		if (result.enabled) return
		latestSnapshot = result.snapshot
		if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for button ${ selector } to be enabled after ${ timeoutMs }ms\n${ latestSnapshot }`)
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 50)
		})
	}
}

async function clickButton(connection: CdpConnection, selector: string) {
	await connection.evaluate(`(() => {
		const element = document.querySelector(${ JSON.stringify(selector) })
		if (!(element instanceof HTMLButtonElement)) throw new Error('Could not find button ${ selector }')
		element.click()
		return true
	})()`)
}

async function triggerPopupOpen(workerConnection: CdpConnection) {
	await workerConnection.evaluate(`(async () => {
		const openPopup = browser.action.openPopup
		if (typeof openPopup !== 'function') throw new Error('browser.action.openPopup is unavailable')
		await openPopup()
		return true
	})()`, { userGesture: true })
}

async function ensureAnchorTarget(context: BenchmarkContext) {
	const targets = await waitForBrowserTargets(context.chrome.browserDebugPort)
	const existingAnchor = targets.find((target) => target.id === context.anchorTargetId)
	if (existingAnchor === undefined) {
		context.anchorTargetId = await createTargetPage(context.chrome.browserConnection, 'about:blank')
		return
	}
	await context.chrome.browserConnection.send('Target.activateTarget', { targetId: context.anchorTargetId })
}

async function prepareBenchmarkContext(): Promise<BenchmarkContext> {
	const chrome = await launchChromeSession()
	try {
		const initialWorkerTarget = await waitForAnyExtensionServiceWorker(chrome.browserDebugPort, 30_000)
		const extensionId = extractExtensionId(initialWorkerTarget.url)
		const anchorTargetId = await createTargetPage(chrome.browserConnection, 'about:blank')
		const workerConnection = await connectTarget(chrome.browserDebugPort, initialWorkerTarget.id)
		try {
			await waitForPerformanceMarks(workerConnection, ['interceptor:background:loaded'], 30_000)
			await waitForRegisteredContentScripts(workerConnection, ['inpage', 'inpage2'], 30_000)
			await clearWorkerPerformanceMarks(workerConnection)
		} finally {
			workerConnection.close()
		}
		return {
			chrome,
			extensionId,
			anchorTargetId,
		}
	} catch (error) {
		await chrome.close().catch(() => undefined)
		throw error
	}
}

async function openPopupAndCollect(context: BenchmarkContext, scenario: ScenarioName): Promise<Sample> {
	const workerTarget = await waitForServiceWorker(context.chrome.browserDebugPort, context.extensionId, 30_000)
	const workerConnection = await connectTarget(context.chrome.browserDebugPort, workerTarget.id)
	let popupTargetId: string | undefined
	try {
		await ensureAnchorTarget(context)
		await clearWorkerPerformanceMarks(workerConnection)
		await workerConnection.evaluate(rpcRequestCollectorResetExpression())
		const launchEpochMs = performance.timeOrigin + performance.now()
		await triggerPopupOpen(workerConnection)
		const popupTarget = await waitForPopupTarget(context.chrome.browserDebugPort, context.extensionId, 30_000)
		popupTargetId = popupTarget.id
		const popupConnection = await connectTarget(context.chrome.browserDebugPort, popupTargetId)
		try {
			await waitForPerformanceMarks(popupConnection, POPUP_MARK_NAMES, 60_000)
			const popupSnapshot = await getPerformanceSnapshot(popupConnection)
			await waitForPerformanceMarks(workerConnection, WORKER_MARK_NAMES, 60_000)
			const workerSnapshot = await getPerformanceSnapshot(workerConnection)
			let popupRefreshCompleteSnapshot = popupSnapshot
			try {
				await waitForPerformanceMark(popupConnection, POPUP_REFRESH_COMPLETE_MARK, 15_000)
				popupRefreshCompleteSnapshot = await getPerformanceSnapshot(popupConnection)
			} catch (error: unknown) {
				console.warn('Popup benchmark did not observe the refresh-complete performance mark within the timeout.', error)
			}
			let popupRefreshRenderedSnapshot = popupRefreshCompleteSnapshot
			try {
				await waitForPerformanceMark(popupConnection, POPUP_REFRESH_RENDERED_MARK, 15_000)
				popupRefreshRenderedSnapshot = await getPerformanceSnapshot(popupConnection)
			} catch (error: unknown) {
				console.warn('Popup benchmark did not observe the refresh-rendered performance mark within the timeout.', error)
			}
			const popupRefreshCompleteMs = absoluteTime(popupRefreshCompleteSnapshot, POPUP_REFRESH_COMPLETE_MARK) === undefined ? undefined : requiredTiming(launchEpochMs, popupRefreshCompleteSnapshot, POPUP_REFRESH_COMPLETE_MARK)
			const popupRefreshRenderedMs = absoluteTime(popupRefreshRenderedSnapshot, POPUP_REFRESH_RENDERED_MARK) === undefined ? undefined : requiredTiming(launchEpochMs, popupRefreshRenderedSnapshot, POPUP_REFRESH_RENDERED_MARK)
			const rpcRequests = (await workerConnection.evaluate<readonly BenchmarkRpcRequestSample[] | undefined>(rpcRequestCollectorExpression())) ?? []
			return {
				scenario,
				launchMode: 'real-chrome-extension-page',
				popupLaunchEpochMs: launchEpochMs,
				popupScriptStartMs: requiredTiming(launchEpochMs, popupSnapshot, 'interceptor:popup:script-start'),
				popupShellPaintMs: requiredTiming(launchEpochMs, popupSnapshot, 'interceptor:popup:shell-painted'),
				popupHomeFirstCommitMs: requiredTiming(launchEpochMs, popupSnapshot, 'interceptor:popup:home-first-commit'),
				popupRefreshCompleteMs,
				popupRefreshRenderedMs,
				workerRefreshStartMs: requiredTiming(launchEpochMs, workerSnapshot, 'interceptor:background:refresh-home-start'),
				workerRefreshEndMs: requiredTiming(launchEpochMs, workerSnapshot, 'interceptor:background:refresh-home-end'),
				rpcRequests,
				setupRpcRequests: [],
			}
		} finally {
			popupConnection.close()
		}
	} finally {
		if (popupTargetId !== undefined) await closeTarget(context.chrome.browserConnection, popupTargetId).catch(() => undefined)
		workerConnection.close()
	}
}

async function runColdScenario(context: BenchmarkContext) {
	return await openPopupAndCollect(context, 'cold')
}

async function runWarmScenario(context: BenchmarkContext) {
	await openPopupAndCollect(context, 'cold')
	return await openPopupAndCollect(context, 'warm')
}

async function prepareStackedTransaction(context: BenchmarkContext, transactionPageUrl: string) {
	const workerTarget = await waitForServiceWorker(context.chrome.browserDebugPort, context.extensionId, 30_000)
	const workerConnection = await connectTarget(context.chrome.browserDebugPort, workerTarget.id)
	await clearWorkerPerformanceMarks(workerConnection)
	await workerConnection.evaluate(rpcRequestCollectorResetExpression())
	const launchEpochMs = performance.timeOrigin + performance.now()
	const pageTargetId = await createTargetPage(context.chrome.browserConnection, transactionPageUrl)
	const pageConnection = await connectTarget(context.chrome.browserDebugPort, pageTargetId)
	let accessTargetId: string | undefined
	let confirmTargetId: string | undefined
	try {
		await waitForTransactionPagePhase(pageConnection, 'requesting-access', 30_000)
		const accessTarget = await waitForTargetByUrl(context.chrome.browserDebugPort, `chrome-extension://${ context.extensionId }/html3/interceptorAccessV3.html`, 30_000).catch(async (error) => {
			const targets = await waitForBrowserTargets(context.chrome.browserDebugPort)
			const state = await getTransactionPageState(pageConnection)
			throw new Error(`${ error instanceof Error ? error.message : String(error) }\ntransaction page state: ${ JSON.stringify(state) }\ncurrent targets:\n${ targets.map((target) => `- ${ target.type } ${ target.url } (${ target.id })`).join('\n') }`)
		})
		accessTargetId = accessTarget.id
		const accessConnection = await connectTarget(context.chrome.browserDebugPort, accessTarget.id)
		try {
			await waitForButtonEnabled(accessConnection, 'nav.popup-button-row button.is-primary:not(.is-danger)', 30_000)
			await clickButton(accessConnection, 'nav.popup-button-row button.is-primary:not(.is-danger)')
		} finally {
			accessConnection.close()
		}
		await waitForTransactionPagePhase(pageConnection, 'requesting-transaction', 30_000)

		const confirmTarget = await waitForTargetByUrl(context.chrome.browserDebugPort, `chrome-extension://${ context.extensionId }/html3/confirmTransactionV3.html`, 30_000)
		confirmTargetId = confirmTarget.id
		await waitForTargetGone(context.chrome.browserDebugPort, (target) => target.id === accessTargetId, 30_000, 'interceptor access popup to close')
		const confirmConnection = await connectTarget(context.chrome.browserDebugPort, confirmTarget.id)
		try {
			try {
				await waitForButtonEnabled(confirmConnection, 'button.button.is-primary.button-overflow.dialog-button-right', 120_000)
			} catch (error) {
				const pageState = await getTransactionPageState(pageConnection)
				const workerSnapshot = await getPerformanceSnapshot(workerConnection).catch(() => undefined)
				const rpcRequests = await workerConnection.evaluate<readonly BenchmarkRpcRequestSample[] | undefined>(rpcRequestCollectorExpression()).catch(() => undefined)
				const popupVisualisationState = await readExtensionLargeStateValue<unknown>(workerConnection, 'popupVisualisation').catch(() => undefined)
				const pendingTransactionStorage = await workerConnection.evaluate<unknown>(`(async () => (await browser.storage.local.get('pendingTransactionsAndMessages')).pendingTransactionsAndMessages)()`).catch(() => undefined)
				const diagnostics = await workerConnection.evaluate<unknown>(`(async () => (await browser.storage.local.get('interceptorErrorDiagnostics')).interceptorErrorDiagnostics)()`).catch(() => undefined)
				throw new Error(`${ error instanceof Error ? error.message : String(error) }\ntransaction page state: ${ JSON.stringify(pageState) }\nworker performance marks: ${ JSON.stringify(workerSnapshot?.marks ?? []) }\nrpc requests: ${ JSON.stringify(rpcRequests ?? []) }\npopup visualisation state: ${ JSON.stringify(popupVisualisationState) }\npending transaction storage: ${ JSON.stringify(pendingTransactionStorage) }\nerror diagnostics: ${ JSON.stringify(diagnostics) }`)
			}
			const confirmPopupSnapshot = await getPerformanceSnapshot(confirmConnection)
			await clickButton(confirmConnection, 'button.button.is-primary.button-overflow.dialog-button-right')
			await waitForTransactionPagePhase(pageConnection, 'balance-fetched', 60_000)
			const pageSnapshot = await getPerformanceSnapshot(pageConnection)
			const workerSnapshot = await getPerformanceSnapshot(workerConnection)
			const setupRpcRequests = (await workerConnection.evaluate<readonly BenchmarkRpcRequestSample[] | undefined>(rpcRequestCollectorExpression())) ?? []
			const stackLength = ((await readExtensionLargeStateValue<{ readonly operations?: readonly unknown[] }>(workerConnection, 'interceptorTransactionStack'))?.operations?.length) ?? 0
			if (stackLength < 1) throw new Error('Transaction stack was not appended')
			return {
				stackLength,
				setupRpcRequests,
				stackedSetup: {
					launchEpochMs,
					pageSnapshot,
					confirmPopupSnapshot,
					workerSnapshot,
				},
			}
		} finally {
			confirmConnection.close()
		}
	} finally {
		await waitForTargetGone(context.chrome.browserDebugPort, (target) => target.id === confirmTargetId, 30_000, 'confirm transaction popup to close').catch(() => undefined)
		pageConnection.close()
		workerConnection.close()
		if (confirmTargetId !== undefined) await closeTarget(context.chrome.browserConnection, confirmTargetId).catch(() => undefined)
		if (accessTargetId !== undefined) await closeTarget(context.chrome.browserConnection, accessTargetId).catch(() => undefined)
	}
}

async function runStackedScenario(context: BenchmarkContext, transactionPageUrl: string) {
	const { stackLength, setupRpcRequests, stackedSetup } = await prepareStackedTransaction(context, transactionPageUrl)
	console.warn(`  transaction stack prepared with ${ stackLength } operation${ stackLength === 1 ? '' : 's' }`)
	const sample = await openPopupAndCollect(context, 'stacked')
	return { ...sample, setupRpcRequests, stackedSetup }
}

async function runScenarioOnce(scenario: ScenarioName, transactionPageUrl?: string): Promise<Sample> {
	const context = await prepareBenchmarkContext()
	try {
		if (scenario === 'cold') return await runColdScenario(context)
		if (scenario === 'warm') return await runWarmScenario(context)
		if (transactionPageUrl === undefined) throw new Error('Missing transaction page URL for stacked scenario')
		return await runStackedScenario(context, transactionPageUrl)
	} finally {
		await context.chrome.close().catch(() => undefined)
	}
}

async function runScenarioManyTimes(scenario: ScenarioName, iterations: number, transactionPageUrl?: string): Promise<Sample[]> {
	const samples: Sample[] = []
	for (let index = 0; index < iterations; index += 1) {
		samples.push(await runScenarioOnce(scenario, transactionPageUrl))
	}
	return samples
}

async function main() {
	const scenarioFilter = (process.env.BENCH_SCENARIO ?? 'all').toLowerCase()
	const iterations = Number(process.env.BENCH_ITERATIONS ?? '1')
	if (!Number.isFinite(iterations) || iterations <= 0) throw new Error(`Invalid BENCH_ITERATIONS value: ${ process.env.BENCH_ITERATIONS ?? '1' }`)
	const transactionPageServer = scenarioFilter === 'all' || scenarioFilter === 'stacked'
		? await startTransactionStackPageServer()
		: undefined
	try {
		const scenarios: ScenarioName[] = scenarioFilter === 'all'
			? ['cold', 'warm', 'stacked']
			: scenarioFilter === 'cold' || scenarioFilter === 'warm' || scenarioFilter === 'stacked'
				? [scenarioFilter]
				: (() => { throw new Error(`Unknown BENCH_SCENARIO value: ${ scenarioFilter }`) })()

		const runs: { scenario: ScenarioName, samples: Sample[] }[] = []
		for (const scenario of scenarios) {
			const samples = await runScenarioManyTimes(scenario, iterations, transactionPageServer?.baseUrl)
			runs.push({ scenario, samples })
		}

		for (const run of runs) {
			const popupScriptStart = stats(run.samples.map((sample) => sample.popupScriptStartMs))
			const popupShellPaint = stats(run.samples.map((sample) => sample.popupShellPaintMs))
			const popupHomeFirstCommit = stats(run.samples.map((sample) => sample.popupHomeFirstCommitMs))
			const popupRefreshComplete = stats(run.samples.map((sample) => sample.popupRefreshCompleteMs))
			const popupRefreshRendered = stats(run.samples.map((sample) => sample.popupRefreshRenderedMs))
			const workerRefreshStart = stats(run.samples.map((sample) => sample.workerRefreshStartMs))
			const workerRefreshEnd = stats(run.samples.map((sample) => sample.workerRefreshEndMs))
			const rpcRequests = run.samples.flatMap((sample) => sample.rpcRequests)
			const setupRpcRequests = run.samples.flatMap((sample) => sample.setupRpcRequests)
			const stackedSetups = run.samples.flatMap((sample) => sample.stackedSetup === undefined ? [] : [sample.stackedSetup])
			const rpcSummary = aggregateRpcRequests(rpcRequests)
			const rpcMethodStats = rpcSummary.methods
			const setupRpcSummary = aggregateRpcRequests(setupRpcRequests)
			const setupRpcMethodStats = setupRpcSummary.methods

			const summary: ScenarioStats = {
				name: run.scenario,
				iterations: run.samples.length,
				launchMode: run.samples[0]?.launchMode ?? 'real-chrome-extension-page',
				popupScriptStart: requireStats(popupScriptStart, 'popup script start'),
				popupShellPaint: requireStats(popupShellPaint, 'popup shell paint'),
				popupHomeFirstCommit: requireStats(popupHomeFirstCommit, 'popup Home first commit'),
				popupRefreshComplete,
				popupRefreshRendered,
				workerRefreshStart: requireStats(workerRefreshStart, 'worker refresh start'),
				workerRefreshEnd: requireStats(workerRefreshEnd, 'worker refresh end'),
				rpcTotalRequests: rpcSummary.totalRequests,
				rpcTotalDurationMs: rpcSummary.totalDurationMs,
				rpcMethods: rpcMethodStats,
			}
			console.warn(`${ summary.name } (${ summary.iterations } run${ summary.iterations === 1 ? '' : 's' }, ${ summary.launchMode }):`)
			if (stackedSetups.length > 0) {
				console.warn('  note: the next three groups start when the transaction test page loads, before the main popup is opened.')
				printStatsGroup('  send transaction path / page load -> page milestones:', [
					['provider ready', stackedSetupTiming(stackedSetups, 'page', 'interceptor:benchmark:tx:provider-ready')],
					['access request shown', stackedSetupTiming(stackedSetups, 'page', 'interceptor:benchmark:tx:requesting-access')],
					['access granted', stackedSetupTiming(stackedSetups, 'page', 'interceptor:benchmark:tx:access-granted')],
					['transaction request started', stackedSetupTiming(stackedSetups, 'page', 'interceptor:benchmark:tx:requesting-transaction')],
					['transaction submitted', stackedSetupTiming(stackedSetups, 'page', 'interceptor:benchmark:tx:submitted')],
					['balance request started', stackedSetupTiming(stackedSetups, 'page', 'interceptor:benchmark:tx:requesting-balance')],
					['balance fetched', stackedSetupTiming(stackedSetups, 'page', 'interceptor:benchmark:tx:balance-fetched')],
				])
				printStatsGroup('  send transaction path / page load -> confirm popup milestones:', [
					['confirm popup simulation started', stackedSetupTiming(stackedSetups, 'confirm', POPUP_PERFORMANCE_MARKS.confirmTransactionSimulationStarted)],
					['confirm popup simulation ready', stackedSetupTiming(stackedSetups, 'confirm', POPUP_PERFORMANCE_MARKS.confirmTransactionSimulationReady)],
				])
				printStatsGroup('  send transaction path / page load -> background milestones:', [
					['background received transaction request', stackedSetupTiming(stackedSetups, 'worker', 'interceptor:background:transaction-request-received')],
					['confirm popup opened', stackedSetupTiming(stackedSetups, 'worker', 'interceptor:background:transaction-confirm-popup-opened')],
					['background simulation started', stackedSetupTiming(stackedSetups, 'worker', 'interceptor:background:transaction-simulation-start')],
					['background simulation ended', stackedSetupTiming(stackedSetups, 'worker', 'interceptor:background:transaction-simulation-end')],
					['transaction stack appended', stackedSetupTiming(stackedSetups, 'worker', 'interceptor:background:transaction-stack-appended')],
				])
				printStatsGroup('  send transaction path / end-to-end page load -> main popup milestones:', [
					['main popup open requested', stackedSampleTiming(run.samples, (sample, setup) => sample.popupLaunchEpochMs - setup.launchEpochMs)],
					['main popup script start', stackedSampleTiming(run.samples, (sample, setup) => sample.popupLaunchEpochMs - setup.launchEpochMs + sample.popupScriptStartMs)],
					['main popup shell paint', stackedSampleTiming(run.samples, (sample, setup) => sample.popupLaunchEpochMs - setup.launchEpochMs + sample.popupShellPaintMs)],
					['main popup first commit', stackedSampleTiming(run.samples, (sample, setup) => sample.popupLaunchEpochMs - setup.launchEpochMs + sample.popupHomeFirstCommitMs)],
					['main popup rendered with refreshed state', stackedSampleTiming(run.samples, (sample, setup) => {
						const rendered = sample.popupRefreshRenderedMs ?? sample.popupHomeFirstCommitMs
						return sample.popupLaunchEpochMs - setup.launchEpochMs + rendered
					})],
				])
			}
			if (run.scenario === 'stacked') {
				console.warn('  note: the next two groups start later, at main popup open, so they exclude the send-transaction setup path above.')
			}
			printStatsGroup('  main popup only / open path (starts at main popup open):', [
				['script start', summary.popupScriptStart],
				['shell paint', summary.popupShellPaint],
				['Home first commit', summary.popupHomeFirstCommit],
			])
			printStatsGroup('  main popup only / refresh path (same main popup open):', [
				['refresh state applied in popup', summary.popupRefreshComplete],
				['refresh rendered in popup', summary.popupRefreshRendered],
				['background refresh start', summary.workerRefreshStart],
				['background refresh end', summary.workerRefreshEnd],
			])
			if (setupRpcRequests.length > 0) {
				console.warn(`  rpc / setup (${ setupRpcSummary.totalRequests } request${ setupRpcSummary.totalRequests === 1 ? '' : 's' }, ${ roundToTwoDecimals(setupRpcSummary.totalDurationMs) } ms cumulative):`)
				if (setupRpcMethodStats.length === 0) {
					console.warn('    n/a')
				} else {
					for (const methodStats of setupRpcMethodStats) {
						console.warn(formatRpcMethodStats(`    ${ methodStats.method }`, requireRpcMethodStats(methodStats, methodStats.method)))
					}
				}
			}
			console.warn(`  rpc / popup (${ summary.rpcTotalRequests } request${ summary.rpcTotalRequests === 1 ? '' : 's' }, ${ roundToTwoDecimals(summary.rpcTotalDurationMs) } ms cumulative):`)
			if (summary.rpcMethods.length === 0) {
				console.warn('    n/a')
			} else {
				for (const methodStats of summary.rpcMethods) {
					console.warn(formatRpcMethodStats(`    ${ methodStats.method }`, requireRpcMethodStats(methodStats, methodStats.method)))
				}
			}
			if (summary.popupRefreshComplete === undefined) {
				console.warn('  popup refresh state applied was not observed within the benchmark wait window.')
			}
			console.warn('')
		}
	} finally {
		if (transactionPageServer !== undefined) await transactionPageServer.close().catch(() => undefined)
	}
}

await main()
