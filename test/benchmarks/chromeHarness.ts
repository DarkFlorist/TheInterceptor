import { chromeEvaluationFailure } from './chromeEvaluationFailure.js'
import type { ViewportDriverPage, ViewportDriverSession } from './browserViewport.js'
import { browserEvaluationExpression, parseBrowserEvaluationValue } from './browserEvaluation.js'
import { prepareDocumentResponse } from './documentRoutes.js'
import { withBrowserCommandTimeout as bounded } from './browserCommandTimeout.js'
import { withBrowserFixtureSetup } from './browserFixtureSetup.js'
import { waitForBrowserCondition } from './browserHarnessUtils.js'
import type { BrowserSession, DocumentRoute } from './browserTypes.js'
import { spawn } from 'child_process'
import { access, mkdir, mkdtemp, readFile, rm } from 'fs/promises'
import * as fsConstants from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'

export type TargetInfo = {
	id: string
	type: string
	url: string
	title: string
	webSocketDebuggerUrl?: string
}

export type PerformanceMarkSnapshot = {
	timeOrigin: number
	marks: readonly {
		name: string
		startTime: number
		duration: number
		entryType: string
	}[]
}

export type ChromeSession = {
	profileDir: string
	process: ReturnType<typeof spawnChrome>
	browserDebugPort: number
	browserWebSocketUrl: string
	browserConnection: CdpConnection
	cleanupProfile: boolean
	close: () => Promise<void>
}

export type LaunchChromeOptions = {
	profileDir?: string
	cleanupProfile?: boolean
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const EXTENSION_DIR = path.join(REPO_ROOT, 'app')

function sleep(ms: number) {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms)
	})
}

function normalizeTargetInfo(target: Partial<TargetInfo> & { targetId?: string, id?: string }): TargetInfo | undefined {
	const id = target.targetId ?? target.id
	if (id === undefined) return undefined
	const url = target.url ?? ''
	const title = target.title ?? ''
	const normalized: TargetInfo = {
		id,
		type: target.type ?? 'other',
		url,
		title,
	}
	if (target.webSocketDebuggerUrl !== undefined) {
		return {
			...normalized,
			webSocketDebuggerUrl: target.webSocketDebuggerUrl,
		}
	}
	return normalized
}

async function waitForCondition(condition: () => Promise<boolean> | boolean, timeoutMs: number, label: string) {
	const start = Date.now()
	while (true) {
		if (await condition()) return
		if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${ label } after ${ timeoutMs }ms`)
		await sleep(50)
	}
}

export class CdpConnection {
	private socket: WebSocket | undefined
	private nextId = 1
	private pending = new Map<number, {
		resolve: (value: unknown) => void
		reject: (reason: Error) => void
	}>()
	private eventListeners = new Map<string, Set<(params: unknown) => void>>()

	public constructor(public readonly url: string) {}

	public async connect() {
		if (this.socket !== undefined) return
		await new Promise<void>((resolve, reject) => {
			const socket = new WebSocket(this.url)
			socket.onopen = () => {
				this.socket = socket
				socket.onmessage = (event) => this.handleMessage(event)
				socket.onerror = () => {
					reject(new Error(`Failed to connect to CDP websocket ${ this.url }`))
				}
				socket.onclose = () => {
					const pending = this.pending
					this.pending = new Map()
					for (const { reject: rejectPending } of pending.values()) {
						rejectPending(chromeEvaluationFailure(new Error(`CDP websocket closed for ${ this.url }`)))
					}
					this.socket = undefined
				}
				resolve()
			}
			socket.onerror = () => {
				reject(new Error(`Failed to open CDP websocket ${ this.url }`))
			}
		})
	}

	private handleMessage(event: MessageEvent) {
		const data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)
		const message = JSON.parse(data) as { id?: number, sessionId?: string, method?: string, params?: unknown, result?: unknown, error?: { message?: string, code?: number } }
		if (message.id !== undefined) {
			const pending = this.pending.get(message.id)
			if (pending === undefined) return
			this.pending.delete(message.id)
			if (message.error !== undefined) {
				pending.reject(chromeEvaluationFailure(new Error(message.error.message ?? `CDP call failed with code ${ message.error.code ?? 'unknown' }`)))
				return
			}
			pending.resolve(message.result)
			return
		}
		if (message.method === undefined) return
		const listeners = this.eventListeners.get(this.eventKey(message.method, message.sessionId))
		if (listeners === undefined) return
		for (const listener of listeners) listener(message.params)
	}

	public async send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
		await this.connect()
		const socket = this.socket
		if (socket === undefined) throw new Error(`CDP websocket ${ this.url } is not connected`)
		const id = this.nextId
		this.nextId += 1
		const promise = new Promise<T>((resolve, reject) => {
			this.pending.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
			})
		})
		socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
		return await promise
	}

	private eventKey(eventName: string, sessionId?: string) { return `${ sessionId ?? '' }:${ eventName }` }

	public on(eventName: string, listener: (params: unknown) => void, sessionId?: string) {
		const key = this.eventKey(eventName, sessionId)
		const listeners = this.eventListeners.get(key) ?? new Set<(params: unknown) => void>()
		listeners.add(listener)
		this.eventListeners.set(key, listeners)
	}

	public off(eventName: string, listener: (params: unknown) => void, sessionId?: string) {
		const key = this.eventKey(eventName, sessionId)
		const listeners = this.eventListeners.get(key)
		if (listeners === undefined) return
		listeners.delete(listener)
		if (listeners.size === 0) this.eventListeners.delete(key)
	}

	public async evaluate<T = unknown>(expression: string, options: { awaitPromise?: boolean, userGesture?: boolean } = {}) {
		const result = await this.send<{
			result: { value?: T, type?: string, description?: string, unserializableValue?: string }
			exceptionDetails?: { text?: string, exception?: { description?: string } }
		}>('Runtime.evaluate', {
			expression,
			awaitPromise: options.awaitPromise ?? true,
			returnByValue: true,
			userGesture: options.userGesture ?? false,
		})
		if (result.exceptionDetails !== undefined) {
			throw new Error(result.exceptionDetails.text ?? result.exceptionDetails.exception?.description ?? 'Runtime.evaluate failed')
		}
		return result.result.value
	}

	public close() {
		this.socket?.close()
		this.socket = undefined
	}
}

async function readTargets(browserDebugPort: number) {
	const response = await fetch(`http://127.0.0.1:${ browserDebugPort }/json/list`)
	if (!response.ok) throw new Error(`Failed to query Chrome targets on port ${ browserDebugPort }: ${ response.status } ${ response.statusText }`)
	const parsed = await response.json() as readonly (TargetInfo & { targetId?: string })[]
	return parsed.map((target) => normalizeTargetInfo(target)).filter((target): target is TargetInfo => target !== undefined)
}

async function readVersion(browserDebugPort: number) {
	const response = await fetch(`http://127.0.0.1:${ browserDebugPort }/json/version`)
	if (!response.ok) throw new Error(`Failed to query Chrome version on port ${ browserDebugPort }: ${ response.status } ${ response.statusText }`)
	return await response.json() as { webSocketDebuggerUrl?: string }
}

async function waitForTarget(browserDebugPort: number, predicate: (target: TargetInfo) => boolean, timeoutMs: number, label: string) {
	await waitForCondition(async () => (await readTargets(browserDebugPort)).some(predicate), timeoutMs, label)
	const targets = await readTargets(browserDebugPort)
	const target = targets.find(predicate)
	if (target === undefined) throw new Error(`Target not found: ${ label }`)
	return target
}

export async function waitForTargetGone(browserDebugPort: number, predicate: (target: TargetInfo) => boolean, timeoutMs: number, label: string) {
	await waitForCondition(async () => (await readTargets(browserDebugPort)).some(predicate) === false, timeoutMs, label)
}

async function waitForDevToolsActivePort(profileDir: string, timeoutMs: number) {
	const portFile = path.join(profileDir, 'DevToolsActivePort')
	await waitForCondition(async () => await access(portFile).then(() => true).catch(() => false), timeoutMs, 'DevToolsActivePort file')
	const contents = await readFile(portFile, 'utf8')
	const [portLine] = contents.trim().split('\n')
	const browserDebugPort = Number(portLine)
	if (!Number.isFinite(browserDebugPort)) throw new Error(`Chrome wrote an invalid remote debugging port: ${ portLine }`)
	return browserDebugPort
}

async function findChromeBinary() {
	const envCandidates = [
		process.env.CHROME_BIN,
		process.env.GOOGLE_CHROME_BIN,
		process.env.CHROME_PATH,
		process.env.CHROMIUM_PATH,
		process.env.CHROMIUM_BIN,
	].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0)
	const pathCandidates = [
		'/usr/bin/google-chrome',
		'/usr/bin/google-chrome-stable',
		'/usr/bin/chromium',
		'/usr/bin/chromium-browser',
		'/snap/bin/chromium',
		'/opt/google/chrome/chrome',
	]
	for (const candidate of [...envCandidates, ...pathCandidates]) {
		try {
			await access(candidate, fsConstants.constants.X_OK)
			return candidate
		} catch {
			continue
		}
	}
	throw new Error('Could not find a Chrome/Chromium binary. Run `bun run install-chrome` on Debian/Ubuntu or set CHROME_BIN, then rerun the benchmark.')
}

function buildChromeArgs(profileDir: string, extensionDir: string) {
	return [
		`--user-data-dir=${ profileDir }`,
		'--remote-debugging-port=0',
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-background-networking',
		'--disable-background-timer-throttling',
		'--disable-backgrounding-occluded-windows',
		'--disable-breakpad',
		'--disable-client-side-phishing-detection',
		'--disable-component-update',
		'--disable-default-apps',
		'--disable-dev-shm-usage',
		'--disable-features=Translate,BackForwardCache,ImprovedCookieControls,MediaRouter',
		'--disable-gpu',
		'--disable-popup-blocking',
		'--disable-renderer-backgrounding',
		'--disable-sync',
		'--force-color-profile=srgb',
		'--metrics-recording-only',
		'--mute-audio',
		'--no-sandbox',
		'--password-store=basic',
		'--use-mock-keychain',
		`--disable-extensions-except=${ extensionDir }`,
		`--load-extension=${ extensionDir }`,
		'about:blank',
	]
}

function spawnChrome(binary: string, profileDir: string, extensionDir: string) {
	const args = buildChromeArgs(profileDir, extensionDir)
	const useXvfb = process.env.DISPLAY === undefined || process.env.DISPLAY.length === 0
	const command = useXvfb ? 'xvfb-run' : binary
	const commandArgs = useXvfb
		? ['-a', '-s', '-screen 0 1280x900x24', binary, ...args]
		: args
	const child = spawn(command, commandArgs, {
		cwd: REPO_ROOT,
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			CHROME_LOG_FILE: process.env.CHROME_LOG_FILE ?? '',
		},
	})
	return child
}

function killChromeProcessGroup(chromeProcess: ReturnType<typeof spawnChrome>, signal: NodeJS.Signals) {
	if (chromeProcess.pid === undefined) {
		chromeProcess.kill(signal)
		return
	}
	try {
		globalThis.process.kill(-chromeProcess.pid, signal)
	} catch {
		chromeProcess.kill(signal)
	}
}

export async function connectTarget(browserDebugPort: number, targetId: string) {
	const target = await waitForTarget(browserDebugPort, (item) => item.id === targetId, 15_000, `target ${ targetId }`)
	if (target.webSocketDebuggerUrl === undefined) throw new Error(`Target ${ targetId } does not expose a websocket debugger URL`)
	const connection = new CdpConnection(target.webSocketDebuggerUrl)
	await connection.connect()
	return connection
}

export async function waitForInterceptorExtensionServiceWorker(browserDebugPort: number, timeoutMs = 15_000) {
	return await waitForTarget(
		browserDebugPort,
		(target) => target.type === 'service_worker'
			&& target.url.startsWith('chrome-extension://')
			&& target.url.endsWith('/js/backgroundServiceWorker.js'),
		timeoutMs,
		'Interceptor extension service worker',
	)
}

export async function waitForTargetByUrl(browserDebugPort: number, urlPrefix: string, timeoutMs = 15_000) {
	return await waitForTarget(browserDebugPort, (target) => target.url.startsWith(urlPrefix), timeoutMs, `target url ${ urlPrefix }`)
}

export async function waitForServiceWorker(browserDebugPort: number, extensionId: string, timeoutMs = 15_000) {
	return await waitForTarget(browserDebugPort, (target) => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${ extensionId }/`), timeoutMs, `service worker for extension ${ extensionId }`)
}

export async function waitForPopupTarget(browserDebugPort: number, extensionId: string, timeoutMs = 15_000) {
	return await waitForTarget(browserDebugPort, (target) => target.url.startsWith(`chrome-extension://${ extensionId }/html3/popupV3.html`), timeoutMs, `popup target for extension ${ extensionId }`)
}

async function startWorker(browserConnection: CdpConnection, scopeURL: string) {
	await browserConnection.send('ServiceWorker.startWorker', { scopeURL })
}

export async function createTargetPage(browserConnection: CdpConnection, url: string) {
	const result = await browserConnection.send<{ targetId: string }>('Target.createTarget', {
		url,
	})
	await browserConnection.send('Target.activateTarget', { targetId: result.targetId })
	return result.targetId
}

export async function closeTarget(browserConnection: CdpConnection, targetId: string) {
	await browserConnection.send('Target.closeTarget', { targetId })
}

async function snapshotPerformance(connection: CdpConnection): Promise<PerformanceMarkSnapshot> {
	const snapshot = await connection.evaluate<PerformanceMarkSnapshot>(`(() => {
		const marks = performance.getEntriesByType('mark').map((entry) => ({
			name: entry.name,
			startTime: entry.startTime,
			duration: entry.duration,
			entryType: entry.entryType,
		}))
		return { timeOrigin: performance.timeOrigin, marks }
	})()`)
	if (snapshot === undefined) throw new Error('Failed to snapshot performance marks')
	return snapshot
}

export async function waitForPerformanceMark(connection: CdpConnection, markName: string, timeoutMs = 30_000) {
	await waitForCondition(async () => {
		const snapshot = await snapshotPerformance(connection)
		return snapshot.marks.some((mark) => mark.name === markName)
	}, timeoutMs, `performance mark ${ markName }`)
}

export async function waitForPerformanceMarks(connection: CdpConnection, markNames: readonly string[], timeoutMs = 30_000) {
	const missing = new Set(markNames)
	await waitForCondition(async () => {
		const snapshot = await snapshotPerformance(connection)
		for (const mark of snapshot.marks) missing.delete(mark.name)
		return missing.size === 0
	}, timeoutMs, `performance marks ${ markNames.join(', ') }`)
}

export async function waitForRegisteredContentScripts(connection: CdpConnection, expectedIds: readonly string[], timeoutMs = 30_000) {
	type RegisteredContentScript = { readonly id?: string }
	await connection.send('Runtime.enable')
	// The target is discoverable before Chrome creates its extension API realm. Awaiting an API call in that transient realm can otherwise hang until the worker stops.
	await waitForCondition(async () => await connection.evaluate<boolean>(`typeof browser !== 'undefined' && typeof browser.scripting !== 'undefined'`, { awaitPromise: false }) === true, timeoutMs, 'extension worker APIs')
	await waitForCondition(async () => {
		const scripts = await connection.evaluate<readonly RegisteredContentScript[] | undefined>('(async () => await browser.scripting.getRegisteredContentScripts())()').catch(() => undefined)
		if (scripts === undefined) return false
		return expectedIds.every((expectedId) => scripts.some((script) => script.id === expectedId))
	}, timeoutMs, `registered content scripts ${ expectedIds.join(', ') }`)
}

export async function readExtensionLargeStateValue<T = unknown>(connection: CdpConnection, key: 'interceptorTransactionStack' | 'popupVisualisation' | 'safeTransactionStacks'): Promise<T | undefined> {
	return await connection.evaluate<T | undefined>(`(async () => {
		const key = ${ JSON.stringify(key) }
		if (typeof indexedDB !== 'undefined') {
			const indexedDbValue = await new Promise((resolve, reject) => {
				const request = indexedDB.open('interceptorLargeState', 1)
				request.onerror = () => reject(request.error ?? new Error('Failed to open large state IndexedDB database'))
				request.onupgradeneeded = () => {
					const db = request.result
					if (!db.objectStoreNames.contains('largeState')) db.createObjectStore('largeState')
				}
				request.onsuccess = () => {
					const db = request.result
					const transaction = db.transaction('largeState', 'readonly')
					const store = transaction.objectStore('largeState')
					const getRequest = store.get(key)
					getRequest.onerror = () => reject(getRequest.error ?? new Error('Failed to read large state value'))
					getRequest.onsuccess = () => resolve(getRequest.result)
				}
			}).catch(() => undefined)
			if (indexedDbValue !== undefined) return indexedDbValue
		}
		const legacyLocalValue = await browser.storage.local.get(key)
		return Object.prototype.hasOwnProperty.call(legacyLocalValue, key) ? legacyLocalValue[key] : undefined
	})()`)
}

export async function getPerformanceSnapshot(connection: CdpConnection): Promise<PerformanceMarkSnapshot> {
	return await snapshotPerformance(connection)
}

function latestMark(snapshot: PerformanceMarkSnapshot, markName: string) {
	const filtered = snapshot.marks.filter((mark) => mark.name === markName)
	return filtered.at(-1)
}

export function absoluteTime(snapshot: PerformanceMarkSnapshot, markName: string) {
	const mark = latestMark(snapshot, markName)
	if (mark === undefined) return undefined
	return snapshot.timeOrigin + mark.startTime
}

export function roundToTwoDecimals(value: number) {
	return Math.round(value * 100) / 100
}

async function ensureExtensionDirReady(extensionDir = EXTENSION_DIR) {
	try {
		await access(path.join(extensionDir, 'manifest.json'), fsConstants.constants.R_OK)
	} catch {
		throw new Error(`Missing ${ path.join(extensionDir, 'manifest.json') }. Run \`bun run setup-chrome\` before the Chrome benchmark.`)
	}
}

export async function waitForBrowserTargets(browserDebugPort: number) {
	return await readTargets(browserDebugPort)
}

export async function launchChromeSession(extensionDir = EXTENSION_DIR, options: LaunchChromeOptions = {}): Promise<ChromeSession> {
	await ensureExtensionDirReady(extensionDir)
	const chromeBinary = await findChromeBinary()
	const explicitProfileDir = options.profileDir ?? globalThis.process.env.INTERCEPTOR_CHROME_PROFILE_DIR ?? globalThis.process.env.CHROME_USER_DATA_DIR
	const profileDir = explicitProfileDir ?? await mkdtemp(path.join(os.tmpdir(), 'interceptor-chrome-profile-'))
	const cleanupProfile = options.cleanupProfile ?? explicitProfileDir === undefined
	if (explicitProfileDir !== undefined) await mkdir(profileDir, { recursive: true })
	const process = spawnChrome(chromeBinary, profileDir, extensionDir)
	let stdout = ''
	let stderr = ''
	const capture = (chunk: Buffer, buffer: string) => {
		const text = chunk.toString('utf8')
		const combined = `${ buffer }${ text }`
		return combined.length > 8_192 ? combined.slice(-8_192) : combined
	}
	process.stdout.on('data', (chunk: Buffer) => {
		stdout = capture(chunk, stdout)
	})
	process.stderr.on('data', (chunk: Buffer) => {
		stderr = capture(chunk, stderr)
	})
	const browserDebugPort = await waitForDevToolsActivePort(profileDir, 30_000).catch(async (error) => {
		killChromeProcessGroup(process, 'SIGTERM')
		await sleep(1_000)
		if (process.exitCode === null && process.signalCode === null) killChromeProcessGroup(process, 'SIGKILL')
		if (cleanupProfile) await rm(profileDir, { recursive: true, force: true }).catch(() => undefined)
		const extra = [`stdout:\n${ stdout }`, `stderr:\n${ stderr }`].filter((line) => line.length > 0).join('\n')
		throw new Error(`${ error instanceof Error ? error.message : String(error) }${ extra.length > 0 ? `\n${ extra }` : '' }`)
	})
	const browserVersion = await readVersion(browserDebugPort)
	if (browserVersion.webSocketDebuggerUrl === undefined) throw new Error('Chrome did not expose a browser websocket debugger URL')
	const browserConnection = new CdpConnection(browserVersion.webSocketDebuggerUrl)
	await browserConnection.connect()
	return {
		profileDir,
		process,
		browserDebugPort,
		browserWebSocketUrl: browserVersion.webSocketDebuggerUrl,
		browserConnection,
		cleanupProfile,
		close: async () => {
			const browserClosePromise = browserConnection.send('Browser.close').catch(() => undefined)
			await Promise.race([
				browserClosePromise,
				sleep(1_000),
			]).catch(() => undefined)
			browserConnection.close()
			killChromeProcessGroup(process, 'SIGTERM')
			await sleep(500)
			if (process.exitCode === null && process.signalCode === null) killChromeProcessGroup(process, 'SIGKILL')
			if (cleanupProfile) await rm(profileDir, { recursive: true, force: true }).catch(() => undefined)
		},
	}
}

// A popup can disappear after Chrome enumerates it but before its debugger socket opens. Skip only that proven lifecycle race; transport errors for a still-open page remain failures.
export async function connectStillOpenChromePages<Target extends { readonly id: string }, Page extends object>(targets: readonly Target[], connect: (target: Target) => Promise<Page>, isStillOpen: (targetId: string) => Promise<boolean>) {
	const pages = await Promise.all(targets.map(async (target) => {
		try {
			return await connect(target)
		} catch (error: unknown) {
			if (!(error instanceof Error) || !(/^Failed to (?:open|connect to) CDP websocket /.test(error.message) || error.message === `Target not found: target ${ target.id }` || error.message.startsWith(`Timed out waiting for target ${ target.id } after `))) throw error
			if (await isStillOpen(target.id)) throw error
			return undefined
		}
	}))
	return pages.flatMap((page) => page === undefined ? [] : [page])
}

export async function launchChromeBrowserSession(extensionDirectory?: string): Promise<BrowserSession> {
	const chrome = await launchChromeSession(extensionDirectory)
	try {
		const worker = await waitForInterceptorExtensionServiceWorker(chrome.browserDebugPort, 30_000)
		const extensionUrl = new URL(worker.url)
		const extensionOrigin = `${ extensionUrl.protocol }//${ extensionUrl.host }`
		const workerPage = await connectTarget(chrome.browserDebugPort, worker.id)
		try { await bounded(waitForRegisteredContentScripts(workerPage, ['inpage', 'inpage2']), 'Chrome content script registration') } finally { workerPage.close() }
		const version = await chrome.browserConnection.send<{ product: string }>('Browser.getVersion')
		const preloads: string[] = []
		let routes: readonly DocumentRoute[] = []
		let fixtureFailure: unknown
		const connections = new Map<string, CdpConnection>()
		type FixtureTarget = Pick<CdpConnection, 'send' | 'on' | 'off'>
		const appliedPreloads = new Map<FixtureTarget, number>()
		const interceptedConnections = new Set<FixtureTarget>()
		const activeInterceptions = new Set<FixtureTarget>()
		const frameAwareTargets = new Set<FixtureTarget>()
		const childTargets = new Map<string, { readonly connection: FixtureTarget, readonly root: CdpConnection }>()
		const frameFixtureCleanups = new Map<FixtureTarget, () => void>()
		const clearFixtureTarget = (connection: FixtureTarget) => {
			frameFixtureCleanups.get(connection)?.()
			frameFixtureCleanups.delete(connection)
			appliedPreloads.delete(connection); interceptedConnections.delete(connection); activeInterceptions.delete(connection); frameAwareTargets.delete(connection)
		}
		const disableInterception = async (connection: FixtureTarget) => {
			if (!activeInterceptions.has(connection)) return
			await connection.send('Fetch.disable')
			activeInterceptions.delete(connection)
		}
		const prepareFixtures = async (connection: FixtureTarget, root: CdpConnection, isChild = false): Promise<void> => {
			await connection.send('Page.enable')
			for (const source of preloads.slice(appliedPreloads.get(connection) ?? 0)) await connection.send('Page.addScriptToEvaluateOnNewDocument', { source, ...(isChild ? { runImmediately: true } : {}) })
			appliedPreloads.set(connection, preloads.length)
			// Cross-process iframes have independent CDP targets. Pause their startup until the same fixture setup is installed, including nested frames.
			if (!frameAwareTargets.has(connection)) {
				frameAwareTargets.add(connection)
				const attached = (value: unknown) => {
					if (typeof value !== 'object' || value === null || !('sessionId' in value) || typeof value.sessionId !== 'string') { fixtureFailure = new Error('Invalid Chrome iframe attachment'); return }
					const sessionId = value.sessionId
					const child: FixtureTarget = {
						send: async <T = unknown>(method: string, params: Record<string, unknown> = {}) => await root.send<T>(method, params, sessionId),
						on: (eventName, listener) => { root.on(eventName, listener, sessionId) },
						off: (eventName, listener) => { root.off(eventName, listener, sessionId) },
					}
					childTargets.set(sessionId, { connection: child, root })
					void (async () => {
						try { await prepareFixtures(child, root, true) } catch (error: unknown) {
							// Navigation may detach an iframe during its setup. A still-attached target must expose fixture failures to the scenario.
							if (childTargets.has(sessionId)) fixtureFailure = error
						} finally {
							try { await child.send('Runtime.runIfWaitingForDebugger') } catch (error: unknown) { if (childTargets.has(sessionId)) fixtureFailure = error }
						}
					})()
				}
				const detached = (value: unknown) => {
					if (typeof value !== 'object' || value === null || !('sessionId' in value) || typeof value.sessionId !== 'string') { fixtureFailure = new Error('Invalid Chrome iframe detachment'); return }
					const child = childTargets.get(value.sessionId)?.connection
					childTargets.delete(value.sessionId)
					if (child !== undefined) clearFixtureTarget(child)
				}
				connection.on('Target.attachedToTarget', attached)
				connection.on('Target.detachedFromTarget', detached)
				frameFixtureCleanups.set(connection, () => { connection.off('Target.attachedToTarget', attached); connection.off('Target.detachedFromTarget', detached) })
				await connection.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe', exclude: false }, { exclude: true }] })
			}
			if (routes.length === 0) { await disableInterception(connection); return }
			if (!interceptedConnections.has(connection)) {
				connection.on('Fetch.requestPaused', (value: unknown) => {
					if (typeof value !== 'object' || value === null || !('requestId' in value) || typeof value.requestId !== 'string') { fixtureFailure = new Error('Invalid Chrome intercepted request'); return }
					const request = 'request' in value ? value.request : undefined
					const requestUrl = typeof request === 'object' && request !== null && 'url' in request ? request.url : undefined
					const prepared = prepareDocumentResponse(routes, requestUrl)
					const response = prepared === undefined ? connection.send('Fetch.continueRequest', { requestId: value.requestId }) : connection.send('Fetch.fulfillRequest', { requestId: value.requestId, responseCode: prepared.statusCode, responseHeaders: prepared.headers, body: prepared.bodyBase64 })
					void response.catch((error: unknown) => { fixtureFailure = error })
				})
				interceptedConnections.add(connection)
			}
			await connection.send('Fetch.enable', { patterns: routes.map(({ url }) => ({ urlPattern: url, requestStage: 'Request' })) })
			activeInterceptions.add(connection)
		}
		const checkRoutes = () => { if (fixtureFailure !== undefined) throw new Error('Chrome fixture setup failed', { cause: fixtureFailure }) }
		const wrapPage = async (id: string, url: string): Promise<ViewportDriverPage> => {
			let connection = connections.get(id)
			if (connection === undefined) { connection = await connectTarget(chrome.browserDebugPort, id); connections.set(id, connection) }
			const active = connection
			return {
				id, url,
				evaluate: async <T = unknown>(expression: string, timeoutMs?: number) => { checkRoutes(); return parseBrowserEvaluationValue<T>(await bounded(active.evaluate<unknown>(browserEvaluationExpression(expression)), 'Chrome evaluation', timeoutMs)) },
				navigate: async (nextUrl, wait = 'complete') => {
					checkRoutes()
					await prepareFixtures(active, active)
					const token = crypto.randomUUID()
					await bounded(active.evaluate(`globalThis.__interceptorTestNavigationToken = ${ JSON.stringify(token) }`), 'Chrome navigation sentinel')
					await bounded(active.send('Page.navigate', { url: nextUrl }), 'Chrome navigation')
					await waitForBrowserCondition(async () => await bounded(active.evaluate(`globalThis.__interceptorTestNavigationToken !== ${ JSON.stringify(token) } && ${ wait === 'complete' ? `document.readyState === 'complete'` : `document.readyState !== 'loading'` }`), 'Chrome document readiness'), 'Chrome document load')
				},
				reload: async () => {
					checkRoutes()
					await prepareFixtures(active, active)
					const token = crypto.randomUUID()
					await bounded(active.evaluate(`globalThis.__interceptorTestNavigationToken = ${ JSON.stringify(token) }`), 'Chrome navigation sentinel')
					await bounded(active.send('Page.reload'), 'Chrome reload')
					await waitForBrowserCondition(async () => await bounded(active.evaluate(`globalThis.__interceptorTestNavigationToken !== ${ JSON.stringify(token) } && document.readyState === 'complete'`), 'Chrome reload readiness'), 'Chrome reload')
				},
				setViewport: async (width, height) => { await active.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }) },
				captureScreenshot: async () => (await active.send<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true })).data,
				close: async () => {
					if ((await waitForBrowserTargets(chrome.browserDebugPort)).some((target) => target.id === id)) await closeTarget(chrome.browserConnection, id)
					for (const [sessionId, child] of childTargets) if (child.root === active) { childTargets.delete(sessionId); clearFixtureTarget(child.connection) }
					clearFixtureTarget(active)
					active.close(); connections.delete(id)
				},
			}
		}
		const openPage: ViewportDriverSession['openPage'] = async (url, wait, prepare) => {
			const id = await createTargetPage(chrome.browserConnection, 'about:blank')
			const page = await wrapPage(id, 'about:blank')
			await prepare(page)
			await page.navigate(url, wait)
			return await wrapPage(id, url)
		}
		return withBrowserFixtureSetup({ browser: 'chrome', browserVersion: version.product, openPage, openExtensionPage: (path, prepare) => openPage(`${ extensionOrigin }/${ path }`, 'complete', prepare), pages: async () => await connectStillOpenChromePages((await waitForBrowserTargets(chrome.browserDebugPort)).filter((target) => target.type === 'page'), async (target) => await wrapPage(target.id, target.url), async (id) => (await waitForBrowserTargets(chrome.browserDebugPort)).some((target) => target.id === id)), addPreloadScript: async (source) => { preloads.push(source) }, routeResponses: async (value) => {
			// setPermission takes Permissions API descriptor names, unlike grantPermissions and its camelCase PermissionType enum. HTTPS fixtures need these grants for loopback RPC.
			for (const origin of new Set(value.map(({ url }) => new URL(url).origin))) for (const name of ['local-network-access', 'loopback-network']) await chrome.browserConnection.send('Browser.setPermission', { permission: { name }, setting: 'granted', origin })
			routes = value
			if (routes.length === 0) for (const connection of activeInterceptions) await disableInterception(connection)
		}, close: async () => { for (const child of childTargets.values()) clearFixtureTarget(child.connection); childTargets.clear(); for (const connection of connections.values()) { clearFixtureTarget(connection); connection.close() }; await chrome.close() } })
	} catch (error: unknown) { await chrome.close(); throw error }
}
