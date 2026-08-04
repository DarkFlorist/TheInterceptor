import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTarget, connectTarget, createTargetPage, launchChromeSession, waitForInterceptorExtensionServiceWorker, waitForTargetByUrl } from './chromeHarness.js'
import { launchFirefoxSession } from './firefoxHarness.js'

export type SafeUiPageName = 'addressBook' | 'popup' | 'confirmTransaction' | 'simulationStack' | 'settingsView'

export type SafeUiScreenshotPage = {
	evaluate: <T = unknown>(expression: string) => Promise<T | undefined>
	setViewport: (width: number, height: number) => Promise<void>
	captureScreenshot: () => Promise<string>
	close: () => Promise<void>
}

export type SafeUiScreenshotBrowser = {
	name: 'Chromium' | 'Firefox'
	version?: string
	openPage: (pageName: SafeUiPageName, initializationExpression?: string) => Promise<SafeUiScreenshotPage>
	close: () => Promise<void>
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_EXTENSION_DIRECTORY = path.join(REPO_ROOT, 'app')

async function launchChromiumScreenshotBrowser(extensionDirectory: string | undefined): Promise<SafeUiScreenshotBrowser> {
	const session = extensionDirectory === undefined ? await launchChromeSession() : await launchChromeSession(extensionDirectory)
	const workerTarget = await waitForInterceptorExtensionServiceWorker(session.browserDebugPort)
	const extensionId = new URL(workerTarget.url).host
	return {
		name: 'Chromium',
		openPage: async (pageName, initializationExpression) => {
			const pageUrl = `chrome-extension://${ extensionId }/html3/${ pageName }V3.html`
			const targetId = await createTargetPage(session.browserConnection, pageUrl)
			const target = await waitForTargetByUrl(session.browserDebugPort, pageUrl)
			const connection = await connectTarget(session.browserDebugPort, target.id)
			if (initializationExpression !== undefined) await connection.evaluate(initializationExpression)
			return {
				evaluate: async <T = unknown>(expression: string) => await connection.evaluate<T>(expression),
				setViewport: async (width: number, height: number) => {
					await connection.send('Page.enable')
					await connection.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
				},
				captureScreenshot: async () => {
					const screenshot = await connection.send<{ data: string }>('Page.captureScreenshot', {
						format: 'png',
						captureBeyondViewport: true,
						fromSurface: true,
					})
					return screenshot.data
				},
				close: async () => {
					connection.close()
					await closeTarget(session.browserConnection, targetId)
				},
			}
		},
		close: session.close,
	}
}

async function launchFirefoxScreenshotBrowser(extensionDirectory: string | undefined): Promise<SafeUiScreenshotBrowser> {
	const sourceExtensionDirectory = extensionDirectory ?? DEFAULT_EXTENSION_DIRECTORY
	const staticExtensionDirectory = await mkdtemp(path.join(os.tmpdir(), 'interceptor-firefox-visual-extension-'))
	try {
		await cp(sourceExtensionDirectory, staticExtensionDirectory, { recursive: true })
		const manifestPath = path.join(staticExtensionDirectory, 'manifest.json')
		const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
		if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) throw new Error('Firefox extension manifest must be an object.')
		Reflect.deleteProperty(manifest, 'background')
		await writeFile(manifestPath, JSON.stringify(manifest))
	} catch (error) {
		await rm(staticExtensionDirectory, { recursive: true, force: true })
		throw error
	}
	let session: Awaited<ReturnType<typeof launchFirefoxSession>> | undefined = await launchFirefoxSession(sourceExtensionDirectory).catch(async (error) => {
		await rm(staticExtensionDirectory, { recursive: true, force: true })
		throw error
	})
	let staticSession: Awaited<ReturnType<typeof launchFirefoxSession>> | undefined
	const browserVersion = session.browserVersion
	return {
		name: 'Firefox',
		version: browserVersion,
		openPage: async (pageName, initializationExpression) => {
			if (pageName === 'confirmTransaction') {
				await session?.close()
				session = undefined
				staticSession = await launchFirefoxSession(staticExtensionDirectory)
				if (initializationExpression !== undefined) {
					const bootstrapPage = await staticSession.openExtensionPage('html/popup.html')
					await bootstrapPage.evaluate(initializationExpression)
					await bootstrapPage.close()
				}
				return await staticSession.openExtensionPage(path.posix.join('html', `${ pageName }.html`))
			}
			if (session === undefined) {
				await staticSession?.close()
				staticSession = undefined
				session = await launchFirefoxSession(sourceExtensionDirectory)
			}
			const page = await session.openExtensionPage(path.posix.join('html', `${ pageName }.html`))
			if (initializationExpression !== undefined) await page.evaluate(initializationExpression)
			return page
		},
		close: async () => {
			await staticSession?.close()
			await session?.close()
			await rm(staticExtensionDirectory, { recursive: true, force: true })
		},
	}
}

export async function launchSafeUiScreenshotBrowser() {
	const extensionDirectory = process.env.SAFE_UI_EXTENSION_DIRECTORY
	const requestedBrowser = process.env.SAFE_UI_SCREENSHOT_BROWSER ?? 'chromium'
	if (requestedBrowser === 'chromium') return await launchChromiumScreenshotBrowser(extensionDirectory)
	if (requestedBrowser === 'firefox') return await launchFirefoxScreenshotBrowser(extensionDirectory)
	throw new Error(`Unsupported SAFE_UI_SCREENSHOT_BROWSER value: ${ requestedBrowser }. Expected chromium or firefox.`)
}
