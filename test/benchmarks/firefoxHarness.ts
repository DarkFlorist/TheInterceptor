import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import * as fsConstants from 'node:fs'
import { createServer } from 'node:net'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_EXTENSION_DIRECTORY = path.join(REPO_ROOT, 'app')

type PendingCommand = {
	resolve: (value: unknown) => void
	reject: (reason: Error) => void
}

export type FirefoxPage = {
	evaluate: <T = unknown>(expression: string) => Promise<T | undefined>
	setViewport: (width: number, height: number) => Promise<void>
	captureScreenshot: () => Promise<string>
	close: () => Promise<void>
}

export type FirefoxSession = {
	browserVersion: string
	openExtensionPage: (pagePath: string) => Promise<FirefoxPage>
	close: () => Promise<void>
}

function sleep(milliseconds: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

async function stopDriverProcess(driverProcess: ReturnType<typeof spawn>) {
	driverProcess.kill('SIGTERM')
	await sleep(250)
	if (driverProcess.exitCode === null && driverProcess.signalCode === null) driverProcess.kill('SIGKILL')
}

function readProperty(value: unknown, property: string) {
	if (typeof value !== 'object' || value === null) return undefined
	return Reflect.get(value, property) as unknown
}

function readStringProperty(value: unknown, property: string) {
	const propertyValue = readProperty(value, property)
	return typeof propertyValue === 'string' ? propertyValue : undefined
}

function protocolErrorMessage(value: unknown) {
	const message = readStringProperty(value, 'message')
	if (message !== undefined) return message
	const error = readProperty(value, 'error')
	const directError = readStringProperty(error, 'message') ?? readStringProperty(error, 'error')
	if (directError !== undefined) return directError
	const nestedValue = readProperty(value, 'value')
	return nestedValue === undefined ? undefined : protocolErrorMessage(nestedValue)
}

async function findAvailablePort() {
	return await new Promise<number>((resolve, reject) => {
		const server = createServer()
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			if (address === null || typeof address === 'string') {
				server.close()
				reject(new Error('Could not allocate a local port for geckodriver.'))
				return
			}
			server.close((error) => error === undefined ? resolve(address.port) : reject(error))
		})
	})
}

async function findGeckodriverBinary() {
	const pathCandidates = (process.env.PATH ?? '')
		.split(path.delimiter)
		.filter((directory) => directory.length > 0)
		.map((directory) => path.join(directory, 'geckodriver'))
	const candidates = [
		process.env.GECKODRIVER_BIN,
		'/usr/local/bin/geckodriver',
		'/usr/bin/geckodriver',
		...pathCandidates,
	].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0)
	for (const candidate of new Set(candidates)) {
		try {
			await access(candidate, fsConstants.constants.X_OK)
			return candidate
		} catch {
			continue
		}
	}
	throw new Error('Could not find geckodriver. Install it or set GECKODRIVER_BIN before running the Firefox screenshot suite.')
}

async function waitForWebDriver(port: number, processOutput: () => string) {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		const response = await fetch(`http://127.0.0.1:${ port }/status`).catch(() => undefined)
		if (response?.ok === true) return
		await sleep(100)
	}
	throw new Error(`Timed out waiting for geckodriver on port ${ port }.${ processOutput() }`)
}

async function createWebDriverSession(port: number) {
	const firefoxOptions: Record<string, unknown> = {
		args: ['-headless'],
		prefs: {
			'browser.shell.checkDefaultBrowser': false,
			'browser.startup.page': 0,
		},
	}
	if (process.env.FIREFOX_BIN !== undefined && process.env.FIREFOX_BIN.length > 0) firefoxOptions.binary = process.env.FIREFOX_BIN
	const response = await fetch(`http://127.0.0.1:${ port }/session`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			capabilities: {
				alwaysMatch: {
					browserName: 'firefox',
					webSocketUrl: true,
					'moz:firefoxOptions': firefoxOptions,
				},
			},
		}),
	})
	const responseBody: unknown = JSON.parse(await response.text())
	if (!response.ok) throw new Error(`Could not start Firefox: ${ protocolErrorMessage(responseBody) ?? response.statusText }`)
	const value = readProperty(responseBody, 'value')
	const sessionId = readStringProperty(value, 'sessionId')
	const capabilities = readProperty(value, 'capabilities')
	const webSocketUrl = readStringProperty(capabilities, 'webSocketUrl')
	const profileDirectory = readStringProperty(capabilities, 'moz:profile')
	const browserVersion = readStringProperty(capabilities, 'browserVersion')
	if (sessionId === undefined || webSocketUrl === undefined || profileDirectory === undefined || browserVersion === undefined) {
		throw new Error('Firefox WebDriver session did not return its session ID, BiDi URL, profile directory, and browser version.')
	}
	return { sessionId, webSocketUrl, profileDirectory, browserVersion }
}

async function connectBidi(webSocketUrl: string) {
	let nextCommandId = 1
	let socket: WebSocket | undefined
	let pendingCommands = new Map<number, PendingCommand>()

	await new Promise<void>((resolve, reject) => {
		const connectingSocket = new WebSocket(webSocketUrl)
		connectingSocket.onopen = () => {
			socket = connectingSocket
			resolve()
		}
		connectingSocket.onerror = () => reject(new Error(`Failed to connect to Firefox WebDriver BiDi at ${ webSocketUrl }.`))
		connectingSocket.onmessage = (event) => {
			if (typeof event.data !== 'string') return
			const message: unknown = JSON.parse(event.data)
			const id = readProperty(message, 'id')
			if (typeof id !== 'number') return
			const pendingCommand = pendingCommands.get(id)
			if (pendingCommand === undefined) return
			pendingCommands.delete(id)
			const type = readStringProperty(message, 'type')
			if (type === 'error') {
				pendingCommand.reject(new Error(protocolErrorMessage(message) ?? `Firefox BiDi command ${ id } failed.`))
				return
			}
			pendingCommand.resolve(readProperty(message, 'result'))
		}
		connectingSocket.onclose = () => {
			const commands = pendingCommands
			pendingCommands = new Map()
			for (const command of commands.values()) command.reject(new Error('Firefox WebDriver BiDi connection closed.'))
			socket = undefined
		}
	})

	return {
		send: async (method: string, params: Record<string, unknown> = {}) => {
			if (socket === undefined) throw new Error('Firefox WebDriver BiDi connection is not open.')
			const id = nextCommandId
			nextCommandId += 1
			const result = new Promise<unknown>((resolve, reject) => pendingCommands.set(id, { resolve, reject }))
			socket.send(JSON.stringify({ id, method, params }))
			return await result
		},
		close: () => {
			socket?.close()
			socket = undefined
		},
	}
}

export function parseExtensionUuidPreference(preferences: string, extensionId: string) {
	const prefix = 'user_pref("extensions.webextensions.uuids", '
	const line = preferences.split('\n').find((candidate) => candidate.startsWith(prefix))
	if (line?.endsWith(');') !== true) return undefined
	let encodedMappings: unknown
	try {
		encodedMappings = JSON.parse(line.slice(prefix.length, -2))
	} catch (error) {
		throw new Error(`Could not parse Firefox extension UUID preference: ${ error instanceof Error ? error.message : String(error) }`)
	}
	if (typeof encodedMappings !== 'string') throw new Error('Firefox extension UUID preference must contain an encoded JSON string.')
	let mappings: unknown
	try {
		mappings = JSON.parse(encodedMappings)
	} catch (error) {
		throw new Error(`Could not parse Firefox extension UUID mapping: ${ error instanceof Error ? error.message : String(error) }`)
	}
	if (typeof mappings !== 'object' || mappings === null || Array.isArray(mappings)) throw new Error('Firefox extension UUID mapping must be an object.')
	return readStringProperty(mappings, extensionId)
}

async function readExtensionUuid(profileDirectory: string, extensionId: string) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const preferences = await readFile(path.join(profileDirectory, 'prefs.js'), 'utf8').catch(() => undefined)
		const uuid = preferences === undefined ? undefined : parseExtensionUuidPreference(preferences, extensionId)
		if (uuid !== undefined) return uuid
		await sleep(50)
	}
	throw new Error(`Firefox did not persist an internal UUID for extension ${ extensionId }.`)
}

function remoteValue<T>(evaluationResult: unknown) {
	if (readStringProperty(evaluationResult, 'type') === 'exception') {
		const exceptionDetails = readProperty(evaluationResult, 'exceptionDetails')
		throw new Error(`${ readStringProperty(exceptionDetails, 'text') ?? 'Firefox script evaluation failed.' } Details: ${ JSON.stringify(exceptionDetails) }`)
	}
	const result = readProperty(evaluationResult, 'result')
	return readProperty(result, 'value') as T | undefined
}

async function ensureExtensionReady(extensionDirectory: string) {
	try {
		await access(path.join(extensionDirectory, 'manifest.json'), fsConstants.constants.R_OK)
	} catch {
		throw new Error(`Missing ${ path.join(extensionDirectory, 'manifest.json') }. Run \`bun run setup-firefox\` before the Firefox screenshot suite.`)
	}
}

export async function launchFirefoxSession(extensionDirectory = DEFAULT_EXTENSION_DIRECTORY): Promise<FirefoxSession> {
	await ensureExtensionReady(extensionDirectory)
	const geckodriverBinary = await findGeckodriverBinary()
	const port = await findAvailablePort()
	const driverProcess = spawn(geckodriverBinary, ['--host', '127.0.0.1', '--port', String(port)], {
		cwd: REPO_ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let stdout = ''
	let stderr = ''
	const appendOutput = (previous: string, chunk: Buffer) => `${ previous }${ chunk.toString('utf8') }`.slice(-8_192)
	driverProcess.stdout.on('data', (chunk: Buffer) => {
		stdout = appendOutput(stdout, chunk)
	})
	driverProcess.stderr.on('data', (chunk: Buffer) => {
		stderr = appendOutput(stderr, chunk)
	})
	const processOutput = () => {
		const output = [stdout, stderr].filter((part) => part.length > 0).join('\n')
		return output.length === 0 ? '' : `\ngeckodriver output:\n${ output }`
	}

	let webDriverSession: Awaited<ReturnType<typeof createWebDriverSession>> | undefined
	let bidi: Awaited<ReturnType<typeof connectBidi>> | undefined
	try {
		await waitForWebDriver(port, processOutput)
		webDriverSession = await createWebDriverSession(port)
		bidi = await connectBidi(webDriverSession.webSocketUrl)
		const installation = await bidi.send('webExtension.install', {
			extensionData: { type: 'path', path: path.resolve(extensionDirectory) },
		})
		const extensionId = readStringProperty(installation, 'extension')
		if (extensionId === undefined) throw new Error('Firefox did not return the installed extension ID.')
		const extensionUuid = await readExtensionUuid(webDriverSession.profileDirectory, extensionId)
		const extensionOrigin = `moz-extension://${ extensionUuid }`
		const activeBidi = bidi
		return {
			browserVersion: webDriverSession.browserVersion,
			openExtensionPage: async (pagePath: string) => {
				const creation = await activeBidi.send('browsingContext.create', { type: 'tab' })
				const context = readStringProperty(creation, 'context')
				if (context === undefined) throw new Error('Firefox did not return a browsing context ID.')
				await activeBidi.send('browsingContext.navigate', {
					context,
					url: `${ extensionOrigin }/${ pagePath }`,
					wait: 'complete',
				})
				return {
					evaluate: async <T = unknown>(expression: string) => remoteValue<T>(await activeBidi.send('script.evaluate', {
						expression,
						target: { context },
						awaitPromise: true,
					})),
					setViewport: async (width: number, height: number) => {
						await activeBidi.send('browsingContext.setViewport', {
							context,
							viewport: { width, height },
							devicePixelRatio: 1,
						})
					},
					captureScreenshot: async () => {
						const screenshot = await activeBidi.send('browsingContext.captureScreenshot', {
							context,
							origin: 'document',
							format: { type: 'image/png' },
						})
						const data = readStringProperty(screenshot, 'data')
						if (data === undefined) throw new Error('Firefox did not return screenshot data.')
						return data
					},
					close: async () => {
						await activeBidi.send('browsingContext.close', { context })
					},
				}
			},
			close: async () => {
				activeBidi.close()
				await fetch(`http://127.0.0.1:${ port }/session/${ webDriverSession.sessionId }`, { method: 'DELETE' }).catch(() => undefined)
				await stopDriverProcess(driverProcess)
			},
		}
	} catch (error) {
		bidi?.close()
		if (webDriverSession !== undefined) {
			await fetch(`http://127.0.0.1:${ port }/session/${ webDriverSession.sessionId }`, { method: 'DELETE' }).catch(() => undefined)
		}
		await stopDriverProcess(driverProcess)
		throw new Error(`${ error instanceof Error ? error.message : String(error) }${ processOutput() }`)
	}
}
