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

function getTargetUrlExtensionId(url: string) {
	const match = /^chrome-extension:\/\/([^/]+)/.exec(url)
	return match?.[1]
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
						rejectPending(new Error(`CDP websocket closed for ${ this.url }`))
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
		const message = JSON.parse(data) as { id?: number, method?: string, params?: unknown, result?: unknown, error?: { message?: string, code?: number } }
		if (message.id !== undefined) {
			const pending = this.pending.get(message.id)
			if (pending === undefined) return
			this.pending.delete(message.id)
			if (message.error !== undefined) {
				pending.reject(new Error(message.error.message ?? `CDP call failed with code ${ message.error.code ?? 'unknown' }`))
				return
			}
			pending.resolve(message.result)
			return
		}
		if (message.method === undefined) return
		const listeners = this.eventListeners.get(message.method)
		if (listeners === undefined) return
		for (const listener of listeners) listener(message.params)
	}

	public async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
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
		socket.send(JSON.stringify({ id, method, params }))
		return await promise
	}

	public on(eventName: string, listener: (params: unknown) => void) {
		const listeners = this.eventListeners.get(eventName) ?? new Set<(params: unknown) => void>()
		listeners.add(listener)
		this.eventListeners.set(eventName, listeners)
	}

	public off(eventName: string, listener: (params: unknown) => void) {
		const listeners = this.eventListeners.get(eventName)
		if (listeners === undefined) return
		listeners.delete(listener)
		if (listeners.size === 0) this.eventListeners.delete(eventName)
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

export async function findChromeBinary() {
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

export async function waitForAnyExtensionServiceWorker(browserDebugPort: number, timeoutMs = 15_000) {
	return await waitForTarget(browserDebugPort, (target) => target.type === 'service_worker' && target.url.startsWith('chrome-extension://'), timeoutMs, 'extension service worker')
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

export async function getExtensionIdFromTargets(browserDebugPort: number) {
	const targets = await readTargets(browserDebugPort)
	const workerTarget = targets.find((target) => target.type === 'service_worker' && target.url.startsWith('chrome-extension://'))
	if (workerTarget !== undefined) {
		const id = getTargetUrlExtensionId(workerTarget.url)
		if (id !== undefined) return id
	}
	const popupTarget = targets.find((target) => target.url.startsWith('chrome-extension://'))
	if (popupTarget !== undefined) {
		const id = getTargetUrlExtensionId(popupTarget.url)
		if (id !== undefined) return id
	}
	return undefined
}

export async function stopAllWorkers(browserConnection: CdpConnection, browserDebugPort: number) {
	const targets = await readTargets(browserDebugPort)
	for (const target of targets) {
		if (target.type !== 'service_worker') continue
		if (!target.url.startsWith('chrome-extension://')) continue
		await closeTarget(browserConnection, target.id).catch(() => undefined)
	}
}

export async function startWorker(browserConnection: CdpConnection, scopeURL: string) {
	await browserConnection.send('ServiceWorker.startWorker', { scopeURL })
}

export async function createTargetPage(browserConnection: CdpConnection, url: string) {
	const result = await browserConnection.send<{ targetId: string }>('Target.createTarget', {
		url,
	})
	await browserConnection.send('Target.activateTarget', { targetId: result.targetId })
	return result.targetId
}

export async function createPopupPage(browserConnection: CdpConnection, popupUrl: string) {
	return await createTargetPage(browserConnection, popupUrl)
}

export async function closeTarget(browserConnection: CdpConnection, targetId: string) {
	await browserConnection.send('Target.closeTarget', { targetId })
}

export async function snapshotPerformance(connection: CdpConnection): Promise<PerformanceMarkSnapshot> {
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
	await waitForCondition(async () => {
		const scripts = await connection.evaluate<readonly RegisteredContentScript[] | undefined>('(async () => await browser.scripting.getRegisteredContentScripts())()').catch(() => undefined)
		if (scripts === undefined) return false
		return expectedIds.every((expectedId) => scripts.some((script) => script.id === expectedId))
	}, timeoutMs, `registered content scripts ${ expectedIds.join(', ') }`)
}

export async function readExtensionLargeStateValue<T = unknown>(connection: CdpConnection, key: 'interceptorTransactionStack' | 'popupVisualisation'): Promise<T | undefined> {
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

export function latestMark(snapshot: PerformanceMarkSnapshot, markName: string) {
	const filtered = snapshot.marks.filter((mark) => mark.name === markName)
	return filtered.at(-1)
}

export function relativeTime(snapshot: PerformanceMarkSnapshot, markName: string) {
	const mark = latestMark(snapshot, markName)
	if (mark === undefined) return undefined
	return mark.startTime
}

export function absoluteTime(snapshot: PerformanceMarkSnapshot, markName: string) {
	const mark = latestMark(snapshot, markName)
	if (mark === undefined) return undefined
	return snapshot.timeOrigin + mark.startTime
}

export function roundToTwoDecimals(value: number) {
	return Math.round(value * 100) / 100
}

export function makeLaunchDelta(launchEpochMs: number, snapshot: PerformanceMarkSnapshot, markName: string) {
	const absolute = absoluteTime(snapshot, markName)
	if (absolute === undefined) return undefined
	return absolute - launchEpochMs
}

export function makePopupUrl(extensionId: string) {
	return `chrome-extension://${ extensionId }/html3/popupV3.html`
}

export function makeBackgroundWorkerUrl(extensionId: string) {
	return `chrome-extension://${ extensionId }/js/backgroundServiceWorker.js`
}

export async function ensureExtensionDirReady(extensionDir = EXTENSION_DIR) {
	try {
		await access(path.join(extensionDir, 'manifest.json'), fsConstants.constants.R_OK)
	} catch {
		throw new Error(`Missing ${ path.join(extensionDir, 'manifest.json') }. Run \`bun run setup-chrome\` before the Chrome benchmark.`)
	}
}

export async function waitForBrowserTargets(browserDebugPort: number) {
	return await readTargets(browserDebugPort)
}

export async function closeChromeSession(session: ChromeSession) {
	const browserClosePromise = session.browserConnection.send('Browser.close').catch(() => undefined)
	await Promise.race([
		browserClosePromise,
		sleep(1_000),
	]).catch(() => undefined)
	session.browserConnection.close()
	killChromeProcessGroup(session.process, 'SIGTERM')
	await Promise.race([
		new Promise<void>((resolve) => {
			session.process.once('exit', () => resolve())
		}),
		sleep(2_000),
	]).catch(() => undefined)
	if (session.process.exitCode === null && session.process.signalCode === null) killChromeProcessGroup(session.process, 'SIGKILL')
	if (session.cleanupProfile) await rm(session.profileDir, { recursive: true, force: true }).catch(() => undefined)
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
