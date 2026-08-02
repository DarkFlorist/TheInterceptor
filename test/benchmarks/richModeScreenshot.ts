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
const changeActiveAddressScreenshotPath = path.resolve('docs/screenshots/dialog-change-active-address.png')
const addAddressScreenshotPath = path.resolve('docs/screenshots/dialog-add-address.png')
const searchableTokenAddress = `0x${ (0x2000n + 73n).toString(16).padStart(40, '0') }`
const sleep = async (milliseconds: number) => await new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds))
type DialogRect = { height: number, left: number, top: number, width: number }
const getRichModeDialogRect = async (connection: CdpConnection) => await connection.evaluate<DialogRect | undefined>(`(() => {
	const dialog = document.querySelector('.rich-mode-modal-card')
	if (!(dialog instanceof HTMLElement)) return undefined
	const rect = dialog.getBoundingClientRect()
	return { height: rect.height, left: rect.left, top: rect.top, width: rect.width }
})()`)
const assertSameRichModeDialogRect = (expected: DialogRect | undefined, actual: DialogRect | undefined) => {
	if (expected === undefined || actual === undefined || actual.height !== expected.height || actual.left !== expected.left || actual.top !== expected.top || actual.width !== expected.width) throw new Error(`Rich-mode dialog moved or resized between views: ${ JSON.stringify(expected) } -> ${ JSON.stringify(actual) }`)
}
const getBalanceRowsViewportSize = async (connection: CdpConnection) => await connection.evaluate<{ clientHeight: number, scrollHeight: number } | undefined>(`(() => {
	const list = document.querySelector('.rich-mode-balance-rows')
	return list instanceof HTMLElement ? { clientHeight: list.clientHeight, scrollHeight: list.scrollHeight } : undefined
})()`)
const getAmountEditorRect = async (connection: CdpConnection, ariaLabel: string) => await connection.evaluate<{ left: number, right: number } | undefined>(`(() => {
	const input = document.querySelector(${ JSON.stringify(`[aria-label="${ ariaLabel }"]`) })
	const editor = input?.closest('.rich-mode-amount-with-unit')
	if (!(editor instanceof HTMLElement)) return undefined
	const rect = editor.getBoundingClientRect()
	return { left: rect.left, right: rect.right }
})()`)
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
const clickButtonText = async (connection: CdpConnection, text: string) => {
	await waitForCondition(connection, `button ${ text }`, `Array.from(document.querySelectorAll('button')).some((element) => element.textContent?.trim() === ${ JSON.stringify(text) })`)
	await connection.evaluate(`(() => {
		const element = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === ${ JSON.stringify(text) })
		if (!(element instanceof HTMLButtonElement)) throw new Error(${ JSON.stringify(`Button not found: ${ text }`) })
		element.click()
	})()`)
}
const clickFirstAriaLabelPrefix = async (connection: CdpConnection, ariaLabelPrefix: string) => {
	await waitForCondition(connection, `control starting with ${ ariaLabelPrefix }`, `document.querySelector(${ JSON.stringify(`[aria-label^="${ ariaLabelPrefix }"]`) }) !== null`)
	await connection.evaluate(`(() => {
		const element = document.querySelector(${ JSON.stringify(`[aria-label^="${ ariaLabelPrefix }"]`) })
		if (!(element instanceof HTMLElement)) throw new Error(${ JSON.stringify(`Element not found with aria-label prefix: ${ ariaLabelPrefix }`) })
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
		const richAccountExpander = document.querySelector('[aria-label="Show rich accounts"]')
		if (!(richAccountExpander instanceof HTMLButtonElement)) throw new Error('Rich-account expander not found')
		richAccountExpander.click()
	})()`)
	await clickFirstAriaLabelPrefix(popup, 'Edit balances for ')
	await waitForCondition(popup, 'token picker enabled', `document.querySelector('[aria-label="Select tokens"]')?.disabled === false`)
	await popup.send('Emulation.setDeviceMetricsOverride', {
		width: 520,
		height: 420,
		deviceScaleFactor: 1,
		mobile: false,
	})
	await sleep(250)
	const constrainedBalanceDialogRect = await getRichModeDialogRect(popup)
	if (constrainedBalanceDialogRect === undefined || constrainedBalanceDialogRect.height > 388) throw new Error(`Rich-mode dialog exceeds the constrained viewport: ${ JSON.stringify(constrainedBalanceDialogRect) }`)
	await clickAriaLabel(popup, 'Select tokens')
	await waitForText(popup, 'USDC')
	await sleep(250)
	assertSameRichModeDialogRect(constrainedBalanceDialogRect, await getRichModeDialogRect(popup))
	await waitForCondition(popup, 'constrained token results scroll', `(() => {
		const results = document.querySelector('[aria-label="Matching address-book tokens"]')
		return results instanceof HTMLElement && results.scrollHeight > results.clientHeight
	})()`)
	await clickAriaLabel(popup, 'Back to balances')
	await sleep(250)
	assertSameRichModeDialogRect(constrainedBalanceDialogRect, await getRichModeDialogRect(popup))
	await popup.send('Emulation.setDeviceMetricsOverride', {
		width: 520,
		height: 780,
		deviceScaleFactor: 1,
		mobile: false,
	})
	await sleep(250)
	const balanceDialogRect = await getRichModeDialogRect(popup)
	await clickAriaLabel(popup, 'Select tokens')
	await waitForText(popup, 'USDC')
	await waitForText(popup, 'ITEM #42')
	await sleep(250)
	assertSameRichModeDialogRect(balanceDialogRect, await getRichModeDialogRect(popup))
	await clickTokenResult(popup, 'USDC')
	await clickTokenResult(popup, 'ITEM #42')
	await sleep(250)
	assertSameRichModeDialogRect(balanceDialogRect, await getRichModeDialogRect(popup))
	await captureScreenshot(popup, availableScreenshotPath)

	await clickAriaLabel(popup, 'Add selected tokens')
	await waitForText(popup, 'Preparing USDC')
	await sleep(150)
	assertSameRichModeDialogRect(balanceDialogRect, await getRichModeDialogRect(popup))
	await captureScreenshot(popup, detectingScreenshotPath)
	await waitForCondition(
		popup,
		'USDC enabled',
		`document.querySelector(${ JSON.stringify('[aria-label="USDC rich amount"]') }) !== null && document.body?.textContent?.includes('Preparing USDC') === false`,
	)
	await waitForCondition(
		popup,
		'ITEM #42 enabled',
		`document.querySelector(${ JSON.stringify('[aria-label="ITEM #42 rich amount"]') }) !== null && document.body?.textContent?.includes('Preparing ITEM #42') === false`,
	)
	await sleep(250)
	assertSameRichModeDialogRect(balanceDialogRect, await getRichModeDialogRect(popup))
	const nativeAmountRect = await getAmountEditorRect(popup, 'ETH rich amount for 0x1111111111111111111111111111111111111111')
	const usdcAmountRect = await getAmountEditorRect(popup, 'USDC rich amount')
	if (nativeAmountRect === undefined || usdcAmountRect === undefined || nativeAmountRect.left !== usdcAmountRect.left || nativeAmountRect.right !== usdcAmountRect.right) throw new Error(`Native and token amount editors are not aligned: ${ JSON.stringify(nativeAmountRect) } -> ${ JSON.stringify(usdcAmountRect) }`)
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
				tokenBalances: (index === 0 ? [] : index === 1 ? richTokens : richTokens.slice(0, index % 4 + 1)).map((token) => ({ tokenAddress: token.tokenAddress, amount: '0x' + (BigInt(index + 1) * 1000n * 10n ** 18n).toString(16) }))
			})),
		})
		return true
	})()`)
	await sleep(250)
	await popup.send('Page.reload')
	await waitForText(popup, '12 accounts · 15 assets')
	await popup.evaluate(`(() => {
		const richAccountExpander = document.querySelector('[aria-label="Show rich accounts"]')
		if (!(richAccountExpander instanceof HTMLButtonElement)) throw new Error('Rich-account expander not found')
		richAccountExpander.click()
	})()`)
	await waitForText(popup, 'Rich account 12')
	await waitForCondition(popup, 'rich account search', `document.querySelector('[aria-label="Search rich accounts"]') !== null`)
	await popup.evaluate(`(() => {
		const search = document.querySelector('[aria-label="Search rich accounts"]')
		if (!(search instanceof HTMLInputElement)) throw new Error('Rich account search not found')
		search.value = 'Rich account 12'
		search.dispatchEvent(new InputEvent('input', { bubbles: true }))
	})()`)
	await waitForCondition(popup, 'filtered rich account', `document.querySelectorAll('.rich-mode-account-row').length === 1 && document.body?.textContent?.includes('Rich account 12') === true`)
	await popup.evaluate(`(() => {
		const search = document.querySelector('[aria-label="Search rich accounts"]')
		if (!(search instanceof HTMLInputElement)) throw new Error('Rich account search not found')
		search.value = ''
		search.dispatchEvent(new InputEvent('input', { bubbles: true }))
	})()`)
	await waitForCondition(popup, 'restored rich accounts', `document.querySelectorAll('.rich-mode-account-row').length === 13`)
	await sleep(250)
	await captureScreenshot(popup, manyBalancesScreenshotPath)
	await clickAriaLabel(popup, 'Edit balances for Rich account 2')
	await waitForCondition(popup, 'second account balances', `document.querySelector('[aria-label="ETH rich amount for Rich account 2"]')?.value === '1,001' && document.querySelector('[aria-label="TOK1 rich amount"]')?.value === '2,000'`)
	await sleep(250)
	const denseAccountDialogRect = await getRichModeDialogRect(popup)
	const denseTokenListSize = await getBalanceRowsViewportSize(popup)
	if (denseTokenListSize === undefined || denseTokenListSize.scrollHeight <= denseTokenListSize.clientHeight) throw new Error(`Dense rich-token list does not scroll internally: ${ JSON.stringify(denseTokenListSize) }`)
	await clickAriaLabel(popup, 'Previous rich account')
	await waitForCondition(popup, 'empty first account balances', `document.querySelector('[aria-label="ETH rich amount for Rich account 1"]')?.value === '1,000' && document.querySelector('[aria-label="TOK1 rich amount"]') === null`)
	await sleep(250)
	assertSameRichModeDialogRect(denseAccountDialogRect, await getRichModeDialogRect(popup))
	const emptyTokenListSize = await getBalanceRowsViewportSize(popup)
	if (emptyTokenListSize?.clientHeight !== denseTokenListSize.clientHeight) throw new Error(`Rich-token list viewport resized between dense and empty accounts: ${ JSON.stringify(denseTokenListSize) } -> ${ JSON.stringify(emptyTokenListSize) }`)
	await clickAriaLabel(popup, 'Next rich account')
	await waitForCondition(popup, 'restored dense second account balances', `document.querySelector('[aria-label="ETH rich amount for Rich account 2"]')?.value === '1,001' && document.querySelector('[aria-label="TOK14 rich amount"]')?.value === '2,000'`)
	await sleep(250)
	assertSameRichModeDialogRect(denseAccountDialogRect, await getRichModeDialogRect(popup))
	await clickAriaLabel(popup, 'Next rich account')
	await waitForCondition(popup, 'smaller third account balances', `document.querySelector('[aria-label="ETH rich amount for Rich account 3"]')?.value === '1,002' && document.querySelector('[aria-label="TOK3 rich amount"]')?.value === '3,000' && document.querySelector('[aria-label="TOK4 rich amount"]') === null`)
	await sleep(250)
	assertSameRichModeDialogRect(denseAccountDialogRect, await getRichModeDialogRect(popup))
	await clickAriaLabel(popup, 'Previous rich account')
	await waitForCondition(popup, 'second account balances for screenshot', `document.querySelector('[aria-label="TOK14 rich amount"]')?.value === '2,000'`)
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
		const richAccountExpander = document.querySelector('[aria-label="Show rich accounts"]')
		if (!(richAccountExpander instanceof HTMLButtonElement)) throw new Error('Rich-account expander not found')
		richAccountExpander.click()
	})()`)
	await clickFirstAriaLabelPrefix(popup, 'Edit balances for ')
	await waitForCondition(popup, 'large token picker enabled', `document.querySelector('[aria-label="Select tokens"]')?.disabled === false`)
	await clickAriaLabel(popup, 'Select tokens')
	await waitForCondition(popup, '80-token search', `document.querySelector('[aria-label="Search address-book tokens"]')?.getAttribute('placeholder')?.includes('80 address-book tokens') === true`)
	await waitForCondition(popup, 'bounded initial token results', `document.querySelectorAll('[data-rich-token-result]').length === 50`)
	await waitForCondition(popup, 'scrollable token results', `(() => {
		const results = document.querySelector('[aria-label="Matching address-book tokens"]')
		if (!(results instanceof HTMLElement) || results.scrollHeight <= results.clientHeight) return false
		results.scrollTop = results.scrollHeight
		return results.scrollTop > 0
	})()`)
	await popup.evaluate(`(() => {
		const results = document.querySelector('[aria-label="Matching address-book tokens"]')
		if (results instanceof HTMLElement) results.scrollTop = 0
	})()`)
	await sleep(250)
	await captureScreenshot(popup, manyTokenPickerScreenshotPath)
	await searchToken(popup, searchableTokenAddress)
	await waitForCondition(popup, 'full-address token search', `document.querySelectorAll('[data-rich-token-result]').length === 1 && document.body?.textContent?.includes('TOK74') === true`)

	await clickAriaLabel(popup, 'Back to balances')
	await clickAriaLabel(popup, 'Close balance manager')
	await clickButtonText(popup, 'Change')
	await waitForCondition(popup, 'change active address dialog', `document.querySelector('[aria-label="Change active address"]') !== null`)
	await sleep(250)
	await captureScreenshot(popup, changeActiveAddressScreenshotPath)

	await clickButtonText(popup, 'Add new address')
	await waitForCondition(popup, 'add address dialog', `document.querySelector('[aria-label^="Add New"]') !== null`)
	await sleep(250)
	await captureScreenshot(popup, addAddressScreenshotPath)
	popup.close()
} finally {
	await chrome.close()
}
