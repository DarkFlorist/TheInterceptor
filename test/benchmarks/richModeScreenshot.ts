import { mkdir } from 'fs/promises'
import * as path from 'path'
import { launchChromeSession, waitForAnyExtensionServiceWorker, connectTarget, createTargetPage } from './chromeHarness.js'
import type { CdpConnection } from './chromeHarness.js'

const collapsedScreenshotPath = path.resolve('docs/screenshots/rich-mode-collapsed.png')
const availableScreenshotPath = path.resolve('docs/screenshots/rich-mode-token-options.png')
const detectingScreenshotPath = path.resolve('docs/screenshots/rich-mode-detecting-token.png')
const screenshotPath = path.resolve('docs/screenshots/rich-mode-token-balances.png')
const sleep = async (milliseconds: number) => await new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds))
const waitForCondition = async (connection: CdpConnection, description: string, expression: string) => {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		const ready = await connection.evaluate<boolean>(expression)
		if (ready === true) return
		await sleep(100)
	}
	throw new Error(`Timed out waiting for popup state: ${ description }`)
}
const waitForText = async (connection: CdpConnection, text: string) => await waitForCondition(
	connection,
	`text ${ text }`,
	`document.body?.textContent?.includes(${ JSON.stringify(text) }) === true`,
)
const captureScreenshot = async (connection: CdpConnection, outputPath: string) => {
	const screenshot = await connection.send<{ data: string }>('Page.captureScreenshot', {
		format: 'png',
		captureBeyondViewport: false,
		fromSurface: true,
	})
	await mkdir(path.dirname(outputPath), { recursive: true })
	await Bun.write(outputPath, Buffer.from(screenshot.data, 'base64'))
}
const clickAriaLabel = async (connection: CdpConnection, ariaLabel: string) => {
	await connection.evaluate(`(() => {
		const element = document.querySelector(${ JSON.stringify(`[aria-label="${ ariaLabel }"]`) })
		if (!(element instanceof HTMLElement)) throw new Error(${ JSON.stringify(`Element not found: ${ ariaLabel }`) })
		element.click()
	})()`)
}
const chooseToken = async (connection: CdpConnection, label: string) => {
	await connection.evaluate(`(() => {
		const select = document.querySelector('[aria-label="Choose address-book token"]')
		if (!(select instanceof HTMLSelectElement)) throw new Error('Rich token picker not found')
		const option = Array.from(select.options).find((entry) => entry.textContent === ${ JSON.stringify(label) })
		if (option === undefined) throw new Error(${ JSON.stringify(`Token option not found: ${ label }`) })
		select.value = option.value
		select.dispatchEvent(new Event('change', { bubbles: true }))
	})()`)
}
const addToken = async (connection: CdpConnection, label: string) => {
	await chooseToken(connection, label)
	await clickAriaLabel(connection, 'Add selected rich token')
}

const chrome = await launchChromeSession()
try {
	const workerTarget = await waitForAnyExtensionServiceWorker(chrome.browserDebugPort)
	const extensionId = new URL(workerTarget.url).hostname
	const popupTargetId = await createTargetPage(chrome.browserConnection, `chrome-extension://${ extensionId }/html3/popupV3.html`)
	const popup = await connectTarget(chrome.browserDebugPort, popupTargetId)
	await popup.send('Page.enable')
	await popup.evaluate(`(() => {
		void chrome.storage.local.set({
			simulationMode: true,
			makeCurrentAddressRich: true,
			richNativeAmount: '0xad78ebc5ac620000',
			activeSimulationAddress: '0x1111111111111111111111111111111111111111',
			userAddressBookEntriesV3: [
				{
					type: 'ERC20',
					name: 'USD Coin',
					address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
					symbol: 'USDC',
					decimals: '0x6',
					entrySource: 'User',
					chainId: '0x1'
				},
				{
					type: 'ERC1155',
					name: 'Game Items',
					address: '0x495f947276749ce646f68ac8c248420045cb7b5e',
					symbol: 'ITEM',
					entrySource: 'User',
					chainId: '0x1',
					watchedTokenIds: ['0x2a']
				}
			],
			richTokens: []
		})
		return true
	})()`)
	await sleep(500)
	await popup.send('Page.reload')
	await popup.send('Emulation.setDeviceMetricsOverride', {
		width: 520,
		height: 780,
		deviceScaleFactor: 1,
		mobile: false,
	})
	await waitForText(popup, 'Make current account rich')
	await captureScreenshot(popup, collapsedScreenshotPath)
	await popup.evaluate(`(() => {
		const richHeader = Array.from(document.querySelectorAll('header')).find((element) => element.textContent?.includes('Make current account rich'))
		if (!(richHeader instanceof HTMLElement)) throw new Error('Rich-mode header not found')
		richHeader.click()
	})()`)
	await waitForText(popup, 'USDC')
	await waitForText(popup, 'ITEM #42')
	await chooseToken(popup, 'USDC')
	await sleep(250)
	await captureScreenshot(popup, availableScreenshotPath)

	await clickAriaLabel(popup, 'Add selected rich token')
	await waitForText(popup, 'Preparing USDC for simulation')
	await sleep(150)
	await captureScreenshot(popup, detectingScreenshotPath)
	await waitForCondition(
		popup,
		'USDC enabled',
		`document.querySelector(${ JSON.stringify('[aria-label="USDC rich amount"]') }) !== null && document.body?.textContent?.includes('Preparing USDC for simulation') === false`,
	)
	await addToken(popup, 'ITEM #42')
	await waitForCondition(
		popup,
		'ITEM #42 enabled',
		`document.querySelector(${ JSON.stringify('[aria-label="ITEM #42 rich amount"]') }) !== null && document.body?.textContent?.includes('Preparing ITEM #42 for simulation') === false`,
	)
	await sleep(250)
	await captureScreenshot(popup, screenshotPath)
	popup.close()
} finally {
	await chrome.close()
}
