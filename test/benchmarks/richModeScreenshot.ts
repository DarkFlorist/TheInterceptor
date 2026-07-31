import { mkdir } from 'fs/promises'
import * as path from 'path'
import { launchChromeSession, waitForAnyExtensionServiceWorker, connectTarget, createTargetPage } from './chromeHarness.js'
import type { CdpConnection } from './chromeHarness.js'

const collapsedScreenshotPath = path.resolve('docs/screenshots/rich-mode-collapsed.png')
const availableScreenshotPath = path.resolve('docs/screenshots/rich-mode-token-options.png')
const detectingScreenshotPath = path.resolve('docs/screenshots/rich-mode-detecting-token.png')
const screenshotPath = path.resolve('docs/screenshots/rich-mode-token-balances.png')
const manyBalancesScreenshotPath = path.resolve('docs/screenshots/rich-mode-many-balances.png')
const accountBalancesScreenshotPath = path.resolve('docs/screenshots/rich-mode-account-balances.png')
const manyTokenPickerScreenshotPath = path.resolve('docs/screenshots/rich-mode-token-search.png')
const searchableTokenAddress = `0x${ (0x2000n + 73n).toString(16).padStart(40, '0') }`
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
const searchToken = async (connection: CdpConnection, label: string) => {
	await connection.evaluate(`(() => {
		const input = document.querySelector('[aria-label="Search address-book tokens"]')
		if (!(input instanceof HTMLInputElement)) throw new Error('Rich token search not found')
		input.value = ${ JSON.stringify(label) }
		input.dispatchEvent(new Event('input', { bubbles: true }))
	})()`)
}
const clickTokenResult = async (connection: CdpConnection, label: string) => {
	await waitForCondition(
		connection,
		`token result ${ label }`,
		`Array.from(document.querySelectorAll('[data-rich-token-result]')).some((element) => element.textContent?.includes(${ JSON.stringify(label) }))`,
	)
	await connection.evaluate(`(() => {
		const result = Array.from(document.querySelectorAll('[data-rich-token-result]')).find((element) => element.textContent?.includes(${ JSON.stringify(label) }))
		if (!(result instanceof HTMLElement)) throw new Error(${ JSON.stringify(`Token result not found: ${ label }`) })
		result.click()
	})()`)
}
const addToken = async (connection: CdpConnection, label: string) => {
	await searchToken(connection, label)
	await clickTokenResult(connection, label)
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
	await waitForCondition(popup, 'token picker enabled', `document.querySelector('[aria-label="Choose rich token"]')?.disabled === false`)
	await clickAriaLabel(popup, 'Choose rich token')
	await waitForText(popup, 'USDC')
	await waitForText(popup, 'ITEM #42')
	await searchToken(popup, 'USDC')
	await sleep(250)
	await captureScreenshot(popup, availableScreenshotPath)

	await clickTokenResult(popup, 'USDC')
	await waitForText(popup, 'Preparing USDC')
	await sleep(150)
	await captureScreenshot(popup, detectingScreenshotPath)
	await waitForCondition(
		popup,
		'USDC enabled',
		`document.querySelector(${ JSON.stringify('[aria-label="USDC rich amount"]') }) !== null && document.body?.textContent?.includes('Preparing USDC') === false`,
	)
	await clickAriaLabel(popup, 'Choose rich token')
	await addToken(popup, 'ITEM #42')
	await waitForCondition(
		popup,
		'ITEM #42 enabled',
		`document.querySelector(${ JSON.stringify('[aria-label="ITEM #42 rich amount"]') }) !== null && document.body?.textContent?.includes('Preparing ITEM #42') === false`,
	)
	await sleep(250)
	await captureScreenshot(popup, screenshotPath)

	await popup.evaluate(`(() => {
		const contacts = Array.from({ length: 12 }, (_, index) => {
			const address = '0x' + BigInt(index + 1).toString(16).padStart(40, '0')
			return { type: 'contact', name: 'Rich account ' + (index + 1).toString(), address, entrySource: 'User' }
		})
		const tokenEntries = Array.from({ length: 14 }, (_, index) => {
			const address = '0x' + (0x1000n + BigInt(index)).toString(16).padStart(40, '0')
			return { type: 'ERC20', name: 'Demo Token ' + (index + 1).toString(), address, symbol: 'TOK' + (index + 1).toString(), decimals: '0x12', entrySource: 'User', chainId: '0x1' }
		})
		const richTokens = tokenEntries.map((token, index) => ({
			chainId: '0x1',
			tokenAddress: token.address,
			tokenType: 'ERC20',
			name: token.name,
			symbol: token.symbol,
			decimals: token.decimals,
			amount: '0x3635c9adc5dea00000',
			balanceSlot: '0x' + BigInt(index).toString(16),
		}))
		void chrome.storage.local.set({
			userAddressBookEntriesV3: [...contacts, ...tokenEntries],
			fixedAddressRichList: contacts.map((contact) => ({ address: contact.address, makingRich: true, type: 'UserAdded' })),
			richTokens,
			makeCurrentAddressRich: false,
			richAccountBalances: contacts.map((contact, index) => ({
				chainId: '0x1',
				address: contact.address,
				nativeAmount: '0x' + ((1000n + BigInt(index)) * 10n ** 18n).toString(16),
				tokenBalances: richTokens.map((token) => ({ tokenAddress: token.tokenAddress, amount: '0x' + (BigInt(index + 1) * 1000n * 10n ** 18n).toString(16) }))
			})),
		})
		return true
	})()`)
	await sleep(250)
	await popup.send('Page.reload')
	await waitForText(popup, '(+12 rich addresses)')
	await popup.evaluate(`(() => {
		const richHeader = Array.from(document.querySelectorAll('header')).find((element) => element.textContent?.includes('Make current account rich'))
		if (!(richHeader instanceof HTMLElement)) throw new Error('Rich-mode header not found')
		richHeader.click()
	})()`)
	await waitForText(popup, 'TOK14')
	await sleep(250)
	await captureScreenshot(popup, manyBalancesScreenshotPath)
	await clickAriaLabel(popup, 'Edit balances for Rich account 2')
	await waitForCondition(popup, 'second account balances', `document.querySelector('[aria-label="ETH rich amount for Rich account 2"]')?.value === '1001' && document.querySelector('[aria-label="TOK1 rich amount"]')?.value === '2000'`)
	await sleep(250)
	await captureScreenshot(popup, accountBalancesScreenshotPath)

	await popup.evaluate(`(() => {
		const tokenEntries = Array.from({ length: 80 }, (_, index) => {
			const address = '0x' + (0x2000n + BigInt(index)).toString(16).padStart(40, '0')
			return { type: 'ERC20', name: 'Searchable Token ' + (index + 1).toString(), address, symbol: 'TOK' + (index + 1).toString(), decimals: '0x12', entrySource: 'User', chainId: '0x1' }
		})
		void chrome.storage.local.set({
			userAddressBookEntriesV3: tokenEntries,
			fixedAddressRichList: [],
			richTokens: [],
			makeCurrentAddressRich: true,
			richAccountBalances: [{ chainId: '0x1', address: '0x1111111111111111111111111111111111111111', nativeAmount: '0xad78ebc5ac620000', tokenBalances: [] }]
		})
		return true
	})()`)
	await sleep(250)
	await popup.send('Page.reload')
	await waitForText(popup, 'Make current account rich')
	await popup.evaluate(`(() => {
		const richHeader = Array.from(document.querySelectorAll('header')).find((element) => element.textContent?.includes('Make current account rich'))
		if (!(richHeader instanceof HTMLElement)) throw new Error('Rich-mode header not found')
		richHeader.click()
	})()`)
	await waitForCondition(popup, 'large token picker enabled', `document.querySelector('[aria-label="Choose rich token"]')?.disabled === false`)
	await clickAriaLabel(popup, 'Choose rich token')
	await waitForCondition(popup, '80-token search', `document.querySelector('[aria-label="Search address-book tokens"]')?.getAttribute('placeholder')?.includes('80 address-book tokens') === true`)
	await waitForCondition(popup, 'bounded initial token results', `document.querySelectorAll('[data-rich-token-result]').length === 50`)
	await sleep(250)
	await captureScreenshot(popup, manyTokenPickerScreenshotPath)
	await searchToken(popup, searchableTokenAddress)
	await waitForCondition(popup, 'full-address token search', `document.querySelectorAll('[data-rich-token-result]').length === 1 && document.body?.textContent?.includes('TOK74') === true`)
	popup.close()
} finally {
	await chrome.close()
}
