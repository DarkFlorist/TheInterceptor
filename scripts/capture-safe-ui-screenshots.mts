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
	const clippedAddress = await connection.evaluate<string>(`(() => {
		const addresses = document.querySelectorAll('.modal.is-active .address-editor-address-input, .modal.is-active .address-editor-readonly-address')
		for (const address of addresses) {
			if (!(address instanceof HTMLElement)) continue
			const isClipped = address.scrollWidth > address.clientWidth + 1 || address.scrollHeight > address.clientHeight + 1
			if (isClipped) {
				return \`\${ address.className }: client=\${ address.clientWidth }x\${ address.clientHeight }, scroll=\${ address.scrollWidth }x\${ address.scrollHeight }\`
			}
		}
		return ''
	})()`)
	if (clippedAddress !== '') throw new Error(`Address input is clipped in ${ filename }: ${ clippedAddress }`)
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
		const originalSendMessage = browser.runtime.sendMessage.bind(browser.runtime)
		browser.runtime.sendMessage = async (message) => message?.method === 'popup_requestIdentifyAddress'
			? { method: 'popup_requestIdentifyAddress', data: { chainId: message.data.chainId, addressBookEntry: undefined } }
			: await originalSendMessage(message)
	})()`)
	const addressTypes = [
		{ type: 'contact', address: '0x1111111111111111111111111111111111111111' },
		{ type: 'contract', address: '0x2222222222222222222222222222222222222222' },
		{ type: 'ERC20', address: '0x3333333333333333333333333333333333333333' },
		{ type: 'ERC721', address: '0x4444444444444444444444444444444444444444' },
		{ type: 'ERC1155', address: '0x5555555555555555555555555555555555555555' },
	] as const
	for (const { type: addressType, address } of addressTypes) {
		await addressBook.evaluate(`(() => {
			const typeButton = [...document.querySelectorAll('.modal.is-active button')].find((element) => element.getAttribute('aria-label')?.startsWith('Address type:'))
			if (!(typeButton instanceof HTMLElement)) throw new Error('Address type dropdown was not found')
			typeButton.click()
		})()`)
		await Bun.sleep(50)
		await addressBook.evaluate(`(() => {
			const typeOption = [...document.querySelectorAll('.modal.is-active .dropdown-item')].find((element) => element.textContent?.trim() === ${ JSON.stringify(addressType) })
			if (!(typeOption instanceof HTMLElement)) throw new Error(${ JSON.stringify(`${ addressType } option was not found`) })
			typeOption.click()
		})()`)
		await Bun.sleep(100)
		await addressBook.evaluate(`(() => {
			const nameInput = document.querySelector('.modal.is-active .address-editor-name-field input')
			const addressInput = document.querySelector('.modal.is-active .address-editor-address-input')
			if (nameInput instanceof HTMLInputElement) {
				nameInput.value = 'Example ${ addressType }'
				nameInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: nameInput.value }))
			}
			if (addressInput instanceof HTMLTextAreaElement) {
				addressInput.value = ${ JSON.stringify(address) }
				addressInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: addressInput.value }))
			}
			const fields = [...document.querySelectorAll('.modal.is-active .address-editor-field')]
			const setField = (label, value) => {
				const field = fields.find((candidate) => candidate.querySelector(':scope > span')?.textContent?.trim() === label)
				const input = field?.querySelector('input')
				if (!(input instanceof HTMLInputElement)) return
				input.value = value
				input.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }))
			}
			setField('Symbol', ${ JSON.stringify(addressType) }.toUpperCase())
			setField('Decimals', '18')
		})()`)
		await Bun.sleep(100)
		await captureScenario(addressBook, `address-form-${ addressType.toLowerCase() }`)
	}
	const setSafeAddressFixture = `browser.storage.local.set({
			independentActiveSimulationAddress: '0x1234567890123456789012345678901234567890',
			activeSigningSafeAddress: '0x1234567890123456789012345678901234567890',
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
				safeSimulationSignerAddress: '0xfedcbafedcbafedcbafedcbafedcbafedcbafedc',
				safeSignerAddresses: [
					'0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
					'0xfedcbafedcbafedcbafedcbafedcbafedcbafedc',
				],
				safeVersion: '1.4.1',
			}],
		})`
	await addressBook.evaluate(setSafeAddressFixture)
	await addressBook.evaluate(`browser.storage.local.set({ simulationMode: true })`)
	await addressBook.close()

	const openSafeEditorFixture = `(() => {
		const originalSendMessage = browser.runtime.sendMessage.bind(browser.runtime)
		browser.runtime.sendMessage = async (message) => {
			if (message?.method === 'popup_requestIdentifyAddress') return {
				method: 'popup_requestIdentifyAddress',
				data: {
					chainId: '0x1',
					addressBookEntry: undefined,
				},
			}
			if (message?.method === 'popup_requestSafeContractState') return {
				method: 'popup_requestSafeContractState',
				data: {
					chainId: '0x1',
					result: {
						ok: true,
						owners: ['0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', '0xfedcbafedcbafedcbafedcbafedcbafedcbafedc'],
						ownerAddressBookEntries: [
							{ type: 'contact', name: 'Alice Hardware Wallet', address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', entrySource: 'User', askForAddressAccess: true, useAsActiveAddress: true, chainId: '0x1' },
							{ type: 'contact', name: 'Operations Signer', address: '0xfedcbafedcbafedcbafedcbafedcbafedcbafedc', entrySource: 'User', askForAddressAccess: true, useAsActiveAddress: true, chainId: '0x1' },
						],
						version: '1.4.1',
					},
				},
			}
			return await originalSendMessage(message)
		}
		const safeLink = [...document.querySelectorAll('a')].find((element) => element.textContent?.includes('My Gnosis Safes'))
		if (!(safeLink instanceof HTMLElement)) throw new Error('My Gnosis Safes link was not found')
		safeLink.click()
	})()`

	console.info('Opening compact Gnosis Safe editor')
	const safeEditor = await browser.openPage('addressBook')
	await waitForSelector(safeEditor, '.address-book-page')
	await safeEditor.evaluate(openSafeEditorFixture)
	await waitForText(safeEditor, 'Treasury Safe')
	await safeEditor.evaluate(`(() => {
		const editButton = [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === 'Edit')
		if (!(editButton instanceof HTMLElement)) throw new Error('Gnosis Safe Edit button was not found')
		editButton.click()
	})()`)
	await waitForText(safeEditor, 'Refresh owners')
	await captureScenario(safeEditor, 'safe-owner-retrieval')
	await safeEditor.evaluate(`(() => {
		browser.runtime.sendMessage = async (message) => {
			if (message?.method === 'popup_addOrModifyAddressBookEntry') return await new Promise(() => undefined)
			return undefined
		}
		const modifyButton = [...document.querySelectorAll('.modal.is-active button')].find((element) => element.textContent?.trim() === 'Save changes')
		if (!(modifyButton instanceof HTMLElement)) throw new Error('Save changes button was not found')
		modifyButton.click()
	})()`)
	await waitForText(safeEditor, 'Saving...')
	await captureScenario(safeEditor, 'safe-modify-pending')
	await safeEditor.close()

	const refreshEditor = await browser.openPage('addressBook')
	await waitForSelector(refreshEditor, '.address-book-page')
	await refreshEditor.evaluate(openSafeEditorFixture)
	await waitForText(refreshEditor, 'Treasury Safe')
	await refreshEditor.evaluate(`(() => {
		const editButton = [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === 'Edit')
		if (!(editButton instanceof HTMLElement)) throw new Error('Gnosis Safe Edit button was not found')
		editButton.click()
	})()`)
	await waitForText(refreshEditor, 'Refresh owners')
	await refreshEditor.evaluate(`(() => {
		browser.runtime.sendMessage = async (message) => {
			if (message?.method === 'popup_requestIdentifyAddress') return { method: 'popup_requestIdentifyAddress', data: { chainId: '0x1', addressBookEntry: undefined } }
			if (message?.method === 'popup_requestSafeContractState') return await new Promise(() => undefined)
			return undefined
		}
		const refreshButton = [...document.querySelectorAll('.modal.is-active button')].find((element) => element.textContent?.includes('Refresh owners'))
		if (!(refreshButton instanceof HTMLElement)) throw new Error('Refresh owners button was not found')
		refreshButton.click()
	})()`)
	await waitForText(refreshEditor, 'Refreshing...')
	await captureScenario(refreshEditor, 'safe-owner-refresh-pending')
	await refreshEditor.close()

	console.info('Opening Gnosis Safe simulation-mode popup')
	const popup = await browser.openPage('popup')
	await waitForSelector(popup, '.popup-home-card')
	await waitForText(popup, 'Treasury Safe')
	await waitForText(popup, 'Safe signer in simulation')
	await Bun.sleep(500)
	await captureScenario(popup, 'safe-simulation-mode')
	await popup.evaluate(`browser.storage.local.set({ simulationMode: false }).then(() => location.reload())`)
	await waitForSelector(popup, '.popup-home-card')
	await waitForText(popup, 'Treasury Safe')
	await waitForText(popup, 'Connect a browser wallet to sign with the selected address.')
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

	const expectedScreenshotCount = 85
	const screenshotCount = capturedScenarioCount * viewports.length
	if (screenshotCount !== expectedScreenshotCount) throw new Error(`Expected ${ expectedScreenshotCount } screenshots, captured ${ screenshotCount }`)
	console.info(`Captured ${ screenshotCount } deterministic screenshots`)
} finally {
	console.info(`Closing ${ browser.name }`)
	await browser.close()
}
