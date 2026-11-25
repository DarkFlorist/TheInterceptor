import { tmpdir } from 'node:os'
import * as path from 'node:path'

export function getGnosisSafeUiScreenshotSettings(environment: Readonly<Record<string, string | undefined>> = process.env) {
	// Canonical Gnosis Safe names take precedence; retain the original screenshot-tool overrides for existing callers.
	const browser = environment.GNOSIS_SAFE_UI_SCREENSHOT_BROWSER ?? environment.SAFE_UI_SCREENSHOT_BROWSER ?? 'chromium'
	if (browser !== 'chromium' && browser !== 'firefox') throw new Error(`Unsupported GNOSIS_SAFE_UI_SCREENSHOT_BROWSER value: ${ browser }. Expected chromium or firefox.`)
	return {
		browser,
		extensionDirectory: environment.GNOSIS_SAFE_UI_EXTENSION_DIRECTORY ?? environment.SAFE_UI_EXTENSION_DIRECTORY,
		outputDirectory: path.resolve(environment.GNOSIS_SAFE_UI_SCREENSHOT_OUTPUT_DIRECTORY ?? environment.SAFE_UI_SCREENSHOT_OUTPUT_DIRECTORY ?? path.join(tmpdir(), 'interceptor-safe-wallet-screenshots')),
	}
}
