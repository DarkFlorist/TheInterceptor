import { mkdir } from 'fs/promises'
import * as path from 'path'
import { launchChromeSession, waitForAnyExtensionServiceWorker, connectTarget, createTargetPage } from './chromeHarness.js'
import type { CdpConnection } from './chromeHarness.js'

const screenshotPath = path.resolve('docs/screenshots/rich-mode-token-balances.png')
const sleep = async (milliseconds: number) => await new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds))
const waitForText = async (connection: CdpConnection, text: string) => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const ready = await connection.evaluate<boolean>(`document.body?.textContent?.includes(${ JSON.stringify(text) }) === true`)
		if (ready === true) return
		await sleep(100)
	}
	throw new Error(`Timed out waiting for popup text: ${ text }`)
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
			richTokens: [
				{
					chainId: '0x1',
					tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
					tokenType: 'ERC20',
					name: 'USD Coin',
					symbol: 'USDC',
					decimals: '0x6',
					amount: '0xe8d4a51000',
					balanceSlot: '0x9'
				},
				{
					chainId: '0x1',
					tokenAddress: '0x495f947276749ce646f68ac8c248420045cb7b5e',
					tokenType: 'ERC1155',
					tokenId: '0x2a',
					name: 'Game Items',
					symbol: 'ITEM',
					decimals: '0x0',
					amount: '0xf4240',
					balanceSlot: '0x0',
					erc1155StorageOrder: 'OwnerThenTokenId'
				}
			]
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
	await popup.evaluate(`(() => {
		const richHeader = Array.from(document.querySelectorAll('header')).find((element) => element.textContent?.includes('Make current account rich'))
		if (!(richHeader instanceof HTMLElement)) throw new Error('Rich-mode header not found')
		richHeader.click()
	})()`)
	await waitForText(popup, 'USDC')
	await waitForText(popup, 'ITEM #42')
	await sleep(250)
	const screenshot = await popup.send<{ data: string }>('Page.captureScreenshot', {
		format: 'png',
		captureBeyondViewport: false,
		fromSurface: true,
	})
	await mkdir(path.dirname(screenshotPath), { recursive: true })
	await Bun.write(screenshotPath, Buffer.from(screenshot.data, 'base64'))
	popup.close()
} finally {
	await chrome.close()
}
