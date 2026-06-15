import { mkdir } from 'node:fs/promises'
import { closeTarget, connectTarget, createTargetPage, launchChromeSession, waitForAnyExtensionServiceWorker, waitForPerformanceMarks, waitForRegisteredContentScripts } from './chromeHarness.js'
import { startDispatchEventReloadPageServer } from './dispatchEventReloadPageServer.js'
import type { CdpConnection } from './chromeHarness.js'

type ReproState = {
	phase?: 'booting' | 'reloading' | 'stable' | 'detected-bug'
	reloadCount?: number
	dispatchOwn?: boolean
	dispatchSource?: string
	dispatchNative?: boolean
	dispatchReturned?: boolean
	hasEthereum?: string
	isInterceptor?: boolean
	reason?: string
}

type ScenarioResult = {
	label: string
	state: ReproState | undefined
	navigationCount: number
	uniqueNavigations: readonly string[]
}

const INTERCEPTOR_DIR = new URL('../../app', import.meta.url).pathname
const NOOP_EXTENSION_DIR = '/tmp/interceptor-noop-extension'
const STATE_GLOBAL = '__interceptorDispatchEventReloadState'

function sleep(ms: number) {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms)
	})
}

async function waitForFinalState(connection: CdpConnection, timeoutMs: number) {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		try {
			const state = await connection.evaluate<ReproState | undefined>(`(() => globalThis[${ JSON.stringify(STATE_GLOBAL) }] ?? undefined)()`)
			if (state?.phase === 'stable' || state?.phase === 'detected-bug') return state
		} catch {
			await sleep(100)
			continue
		}
		await sleep(100)
	}
	throw new Error(`Timed out waiting for final repro state after ${ timeoutMs }ms`)
}

async function ensureNoopExtension() {
	await mkdir(NOOP_EXTENSION_DIR, { recursive: true })
	await Bun.write(`${ NOOP_EXTENSION_DIR }/manifest.json`, JSON.stringify({
		manifest_version: 3,
		name: 'noop-interceptor-benchmark',
		version: '1.0.0',
	}, null, 2))
}

async function waitForInterceptorReadiness(browserDebugPort: number) {
	const workerTarget = await waitForAnyExtensionServiceWorker(browserDebugPort, 30_000)
	const workerConnection = await connectTarget(browserDebugPort, workerTarget.id)
	try {
		await waitForPerformanceMarks(workerConnection, ['interceptor:background:loaded'], 30_000)
		await waitForRegisteredContentScripts(workerConnection, ['inpage', 'inpage2'], 30_000)
	} finally {
		workerConnection.close()
	}
}

async function runScenario(label: string, extensionDir: string, pageUrl: string, injectBrokenDispatch = false, waitForInterceptor = false): Promise<ScenarioResult> {
	const chrome = await launchChromeSession(extensionDir)
	let pageTargetId: string | undefined
	try {
		if (waitForInterceptor) await waitForInterceptorReadiness(chrome.browserDebugPort)
		pageTargetId = await createTargetPage(chrome.browserConnection, 'about:blank')
		const connection = await connectTarget(chrome.browserDebugPort, pageTargetId)
		try {
			const navigations: string[] = []
			connection.on('Page.frameNavigated', (params: unknown) => {
				const frameNavigatedParams = params as { frame?: { url?: string } }
				if (frameNavigatedParams.frame?.url !== undefined) navigations.push(frameNavigatedParams.frame.url)
			})

			await connection.send('Page.enable')
			await connection.send('Runtime.enable')

			if (injectBrokenDispatch) {
				await connection.send('Page.addScriptToEvaluateOnNewDocument', {
					source: `(() => {
						const originalDispatchEvent = window.dispatchEvent
						window.dispatchEvent = function (...args) {
							const event = args[0]
							if (event?.type === 'ethereum#initialized') return originalDispatchEvent.apply(this, args)
							originalDispatchEvent.apply(this, args)
							return true
						}
					})()`,
				})
			}

			await connection.send('Page.navigate', { url: pageUrl })
			const state = await waitForFinalState(connection, 15_000)

			return {
				label,
				state,
				navigationCount: navigations.length,
				uniqueNavigations: Array.from(new Set(navigations)),
			}
		} finally {
			connection.close()
		}
	} finally {
		if (pageTargetId !== undefined) await closeTarget(chrome.browserConnection, pageTargetId).catch(() => undefined)
		await chrome.close().catch(() => undefined)
	}
}

async function main() {
	await ensureNoopExtension()
	const server = await startDispatchEventReloadPageServer()
	try {
		const withInterceptor = await runScenario('current-interceptor', INTERCEPTOR_DIR, server.baseUrl, false, true)
		const withoutInterceptor = await runScenario('no-extension', NOOP_EXTENSION_DIR, server.baseUrl)
		const simulatedBrokenDispatch = await runScenario('simulated-broken-dispatch', NOOP_EXTENSION_DIR, server.baseUrl, true)

		console.warn(JSON.stringify({
			withInterceptor,
			withoutInterceptor,
			simulatedBrokenDispatch,
		}, null, 2))
	} finally {
		await server.close().catch(() => undefined)
	}
}

await main()
