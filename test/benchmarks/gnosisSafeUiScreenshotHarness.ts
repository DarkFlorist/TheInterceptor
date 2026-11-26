import { getGnosisSafeUiScreenshotSettings } from './gnosisSafeUiScreenshotSettings.js'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChromeBrowserSession } from './chromeHarness.js'
import { launchFirefoxSession } from './firefoxHarness.js'

export type GnosisSafeUiPageName = 'addressBook' | 'popup' | 'confirmTransaction' | 'simulationStack' | 'settingsView'

export type GnosisSafeUiScreenshotPage = {
	evaluate: <T = unknown>(expression: string) => Promise<T | undefined>
	captureScreenshot: () => Promise<string>
	close: () => Promise<void>
}

export type GnosisSafeUiScreenshotBrowser = {
	name: 'Chromium' | 'Firefox'
	setViewport: (width: number, height: number) => Promise<void>
	version?: string
	openPage: (pageName: GnosisSafeUiPageName, initializationExpression?: string) => Promise<GnosisSafeUiScreenshotPage>
	close: () => Promise<void>
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_EXTENSION_DIRECTORY = path.join(REPO_ROOT, 'app')

async function launchChromiumScreenshotBrowser(extensionDirectory: string | undefined): Promise<GnosisSafeUiScreenshotBrowser> {
	const session = await launchChromeBrowserSession(extensionDirectory)
	return {
		name: 'Chromium',
		version: session.browserVersion,
		setViewport: session.setViewport,
		openPage: async (pageName, initializationExpression) => {
			const page = await session.openExtensionPage(path.posix.join('html3', `${ pageName }V3.html`))
			if (initializationExpression !== undefined) await page.evaluate(initializationExpression)
			return page
		},
		close: session.close,
	}
}

async function launchFirefoxScreenshotBrowser(extensionDirectory: string | undefined): Promise<GnosisSafeUiScreenshotBrowser> {
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
	// Preserve the requested size across intentional profile replacement; each live session delegates geometry to the shared viewport owner.
	let viewport: { width: number, height: number } | undefined
	return {
		name: 'Firefox',
		setViewport: async (width, height) => {
			viewport = { width, height }
			await session?.setViewport(width, height)
			await staticSession?.setViewport(width, height)
		},
		version: browserVersion,
		openPage: async (pageName, initializationExpression) => {
			if (pageName === 'confirmTransaction') {
				await session?.close()
				session = undefined
				await staticSession?.close()
				staticSession = await launchFirefoxSession(staticExtensionDirectory)
				if (viewport !== undefined) await staticSession.setViewport(viewport.width, viewport.height)
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
				if (viewport !== undefined) await session.setViewport(viewport.width, viewport.height)
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

export async function launchGnosisSafeUiScreenshotBrowser() {
	const { browser, extensionDirectory } = getGnosisSafeUiScreenshotSettings()
	if (browser === 'chromium') return await launchChromiumScreenshotBrowser(extensionDirectory)
	return await launchFirefoxScreenshotBrowser(extensionDirectory)
}
