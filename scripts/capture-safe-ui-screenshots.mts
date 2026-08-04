import { mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { createSafeTx } from '../app/ts/safe/safeCore.js'
import { PendingTransactionOrSignableMessage } from '../app/ts/types/accessRequest.js'
import { serialize } from '../app/ts/types/wire-types.js'
import { getSafeTxHash } from '../app/ts/utils/eip712.js'
import { privateKeyToAccount } from '../app/ts/utils/ethereumPrimitives.js'
import { launchSafeUiScreenshotBrowser, SafeUiScreenshotPage } from '../test/benchmarks/safeUiScreenshotHarness.js'

const outputDirectory = path.resolve(process.env.SAFE_UI_SCREENSHOT_OUTPUT_DIRECTORY ?? path.join(tmpdir(), 'interceptor-safe-wallet-screenshots'))

const viewports = [
	{ name: 'ultra-narrow', width: 220, height: 700 },
	{ name: 'narrow', width: 320, height: 700 },
	{ name: 'popup', width: 520, height: 700 },
	{ name: 'medium', width: 800, height: 900 },
	{ name: 'wide', width: 1280, height: 900 },
] as const

let capturedScenarioCount = 0

async function waitForSelector(connection: SafeUiScreenshotPage, selector: string) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const found = await connection.evaluate<boolean>(`document.querySelector(${ JSON.stringify(selector) }) !== null`)
		if (found) return
		await Bun.sleep(50)
	}
	throw new Error(`Timed out waiting for ${ selector }`)
}

async function waitForText(connection: SafeUiScreenshotPage, expectedText: string) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const found = await connection.evaluate<boolean>(`document.body.textContent?.includes(${ JSON.stringify(expectedText) }) === true`)
		if (found) return
		await Bun.sleep(50)
	}
	const bodyText = await connection.evaluate<string>('document.body.textContent ?? ""')
	throw new Error(`Timed out waiting for text: ${ expectedText }. Page text: ${ bodyText ?? '' }`)
}

async function prepareForDeterministicCapture(connection: SafeUiScreenshotPage) {
	await connection.evaluate(`(async () => {
		await document.fonts.ready
		let style = document.querySelector('#css-visual-regression-overrides')
		if (!(style instanceof HTMLStyleElement)) {
			style = document.createElement('style')
			style.id = 'css-visual-regression-overrides'
			style.textContent = '* { animation: none !important; caret-color: transparent !important; transition: none !important; }'
			document.head.append(style)
		}
	})()`)
}

async function capture(connection: SafeUiScreenshotPage, filename: string, width: number, height: number) {
	await connection.setViewport(width, height)
	await prepareForDeterministicCapture(connection)
	await Bun.sleep(250)
	const screenshot = await connection.captureScreenshot()
	await writeFile(path.join(outputDirectory, filename), Buffer.from(screenshot, 'base64'))
}

async function captureScenario(connection: SafeUiScreenshotPage, scenarioName: string) {
	capturedScenarioCount += 1
	const scenarioNumber = capturedScenarioCount.toString().padStart(2, '0')
	for (const viewport of viewports) {
		await capture(connection, `${ scenarioNumber }-${ scenarioName}--${ viewport.name }.png`, viewport.width, viewport.height)
	}
}

await mkdir(outputDirectory, { recursive: true })
console.info(`Writing screenshots outside the repository to ${ outputDirectory }`)
const browser = await launchSafeUiScreenshotBrowser()
console.info(`Launched ${ browser.name }${ browser.version === undefined ? '' : ` ${ browser.version }` }`)
try {
	console.info('Opening address book')
	const addressBook = await browser.openPage('addressBook')
	await waitForSelector(addressBook, '.address-book-page')
	await addressBook.evaluate(`(() => {
		const safeLink = [...document.querySelectorAll('a')].find((element) => element.textContent?.includes('My Gnosis Safes'))
		if (!(safeLink instanceof HTMLElement)) throw new Error('My Gnosis Safes link was not found')
		safeLink.click()
	})()`)
	await Bun.sleep(400)
	await captureScenario(addressBook, 'safe-address-book')
	await addressBook.evaluate(`(() => {
		const addButton = [...document.querySelectorAll('button')].find((element) => element.textContent?.includes('Add New Gnosis Safe Wallet'))
		if (!(addButton instanceof HTMLElement)) throw new Error('Add New Gnosis Safe Wallet button was not found')
		addButton.click()
	})()`)
	await waitForSelector(addressBook, '.modal.is-active')
	await captureScenario(addressBook, 'safe-address-form-empty')
	await addressBook.evaluate(`(() => {
		const addSignerButton = [...document.querySelectorAll('.modal.is-active button')].find((element) => element.textContent?.includes('Add Gnosis Safe signer'))
		if (!(addSignerButton instanceof HTMLElement)) throw new Error('Add Gnosis Safe signer button was not found')
		addSignerButton.click()
	})()`)
	await Bun.sleep(100)
	await captureScenario(addressBook, 'safe-address-form-with-signer')
	await addressBook.evaluate(`(() => {
		const inputs = [...document.querySelectorAll('.modal.is-active input[type="text"]')]
		const values = ['Treasury Safe', '0x1234567890123456789012345678901234567890', '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd']
		for (const [index, value] of values.entries()) {
			const input = inputs[index]
			if (!(input instanceof HTMLInputElement)) continue
			input.value = value
			input.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }))
		}
	})()`)
	await captureScenario(addressBook, 'safe-address-form-filled')
	const setSafeAddressFixture = `browser.storage.local.set({
			activeSimulationAddress: '0x1234567890123456789012345678901234567890',
			simulationMode: false,
			useSignersAddressAsActiveAddress: false,
			openedPageV2: { page: 'Home' },
			userAddressBookEntriesV3: [{
				type: 'safe',
				name: 'Treasury Safe',
				address: '0x1234567890123456789012345678901234567890',
				chainId: '0x1',
				entrySource: 'FilledIn',
				askForAddressAccess: true,
				useAsActiveAddress: true,
				safeSignerAddress: '0xfedcbafedcbafedcbafedcbafedcbafedcbafedc',
				safeSignerAddresses: [
					'0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
					'0xfedcbafedcbafedcbafedcbafedcbafedcbafedc',
				],
				safeVersion: '1.4.1',
			}],
		})`
	await addressBook.evaluate(setSafeAddressFixture)
	await addressBook.close()

	console.info('Opening Gnosis Safe signing-mode popup')
	const popup = await browser.openPage('popup')
	await waitForSelector(popup, '.popup-home-card')
	await waitForText(popup, 'Treasury Safe')
	await waitForText(popup, 'Gnosis Safe signers')
	await Bun.sleep(500)
	await captureScenario(popup, 'safe-signing-mode')

	console.info('Opening Gnosis Safe transaction confirmation')
	const safeAddress = 0x1234567890123456789012345678901234567890n
	const ownerAccount = privateKeyToAccount('0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd')
	const ownerAddress = BigInt(ownerAccount.address)
	const destinationAddress = 0x9876543210987654321098765432109876543210n
	const created = new Date('2026-07-28T00:00:00.000Z')
	const uniqueRequestIdentifier = { requestId: 42, requestSocket: { tabId: 7, connectionName: 0n } }
	const originalRequestParameters = {
		method: 'eth_sendTransaction' as const,
		params: [{
			from: safeAddress,
			to: destinationAddress,
			value: 500000000000000000n,
			gas: 21_000n,
			maxFeePerGas: 2_000_000_000n,
			maxPriorityFeePerGas: 1_000_000_000n,
			input: new Uint8Array(),
		}],
	}
	const failedTransaction = {
		website: { websiteOrigin: 'https://app.uniswap.org', icon: undefined, title: 'Uniswap' },
		created,
		originalRequestParameters,
		transactionIdentifier: 42n,
		success: false as const,
		error: { code: -32000, message: 'Screenshot fixture intentionally skips RPC simulation.' },
	}
	const safeTx = createSafeTx(1n, safeAddress, {
		to: destinationAddress,
		value: 500000000000000000n,
		input: new Uint8Array(),
	}, 7n)
	const pendingSafeTransaction: PendingTransactionOrSignableMessage = {
		type: 'Transaction',
		popupOrTabId: { type: 'popup', id: 1 },
		originalRequestParameters,
		uniqueRequestIdentifier,
		simulationMode: false,
		activeAddress: safeAddress,
		created,
		transactionIdentifier: 42n,
		website: failedTransaction.website,
		approvalStatus: { status: 'WaitingForUser' },
		popupVisualisation: {
			statusCode: 'failed',
			data: {
				activeAddress: safeAddress,
				simulationMode: false,
				simulationStartedTimestamp: created,
				uniqueRequestIdentifier,
				transactionToSimulate: failedTransaction,
				signerName: 'MetaMask',
				error: {
					code: -32000,
					message: 'Screenshot fixture intentionally skips RPC simulation.',
					decodedErrorMessage: 'Screenshot fixture intentionally skips RPC simulation.',
				},
				simulationState: {
					blockNumber: 21_000_000n,
					simulationConductedTimestamp: created,
				},
			},
		},
		transactionOrMessageCreationStatus: 'FailedToSimulate',
		transactionToSimulate: failedTransaction,
		safeTransaction: {
			safeAddress,
			safeSignerAddress: ownerAddress,
			safeVersion: '1.4.1',
			threshold: 2n,
			safeTxHash: BigInt(getSafeTxHash(safeTx)),
			safeTx,
		},
	}
	const serializedPendingTransactions = serialize(PendingTransactionOrSignableMessage, pendingSafeTransaction)
	const setPendingTransactionFixture = `browser.storage.local.set({
			pendingTransactionsAndMessages: [${ JSON.stringify(serializedPendingTransactions) }],
		})`
	await popup.evaluate(setPendingTransactionFixture)
	await popup.close()
	const confirm = await browser.openPage('confirmTransaction', `(async () => {
		await ${ setSafeAddressFixture }
		await ${ setPendingTransactionFixture }
	})()`)
	await waitForText(confirm, 'wrapped as Gnosis Safe transaction nonce 7')
	await waitForText(confirm, 'Gas estimation error')
	await captureScenario(confirm, 'safe-confirm-transaction')
	await confirm.close()

	console.info('Opening simulation stack')
	const stack = await browser.openPage('simulationStack')
	await waitForSelector(stack, '.simulation-stack-page-header')
	await captureScenario(stack, 'safe-simulation-stack')
	await stack.evaluate(`(() => {
		const importButton = [...document.querySelectorAll('button')].find((element) => element.textContent?.includes('Import Gnosis Safe'))
		if (!(importButton instanceof HTMLElement)) throw new Error('Import Gnosis Safe button was not found')
		importButton.click()
	})()`)
	await waitForSelector(stack, '.modal.is-active')
	await captureScenario(stack, 'safe-stack-import-empty')
	await stack.evaluate(`(() => {
		const textarea = document.querySelector('.modal.is-active textarea')
		if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Gnosis Safe stack textarea was not found')
		textarea.value = '{ "version": "1", "transactions": [] }'
		textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: textarea.value }))
	})()`)
	await captureScenario(stack, 'safe-stack-import-filled')
	await stack.close()

	console.info('Opening settings import and export page')
	const settings = await browser.openPage('settingsView')
	await waitForSelector(settings, '.window-header')
	await captureScenario(settings, 'settings-import-export')
	await settings.close()

	const expectedScreenshotCount = 50
	const screenshotCount = capturedScenarioCount * viewports.length
	if (screenshotCount !== expectedScreenshotCount) throw new Error(`Expected ${ expectedScreenshotCount } screenshots, captured ${ screenshotCount }`)
	console.info(`Captured ${ screenshotCount } deterministic screenshots`)
} finally {
	console.info(`Closing ${ browser.name }`)
	await browser.close()
}
