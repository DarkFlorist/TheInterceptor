import { mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { createSafeTx } from '../app/ts/safe/safeCore.js'
import { PendingTransactionOrSignableMessage } from '../app/ts/types/accessRequest.js'
import { serialize } from '../app/ts/types/wire-types.js'
import { getSafeTxHash } from '../app/ts/utils/eip712.js'
import { privateKeyToAccount } from '../app/ts/utils/ethereumPrimitives.js'
import { connectTarget, createTargetPage, launchChromeSession, waitForAnyExtensionServiceWorker, waitForTargetByUrl } from '../test/benchmarks/chromeHarness.js'

const outputDirectory = path.resolve(process.env.SAFE_UI_SCREENSHOT_OUTPUT_DIRECTORY ?? path.join(tmpdir(), 'interceptor-safe-wallet-screenshots'))

async function waitForSelector(connection: Awaited<ReturnType<typeof connectTarget>>, selector: string) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const found = await connection.evaluate<boolean>(`document.querySelector(${ JSON.stringify(selector) }) !== null`)
		if (found) return
		await Bun.sleep(50)
	}
	throw new Error(`Timed out waiting for ${ selector }`)
}

async function waitForText(connection: Awaited<ReturnType<typeof connectTarget>>, expectedText: string) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const found = await connection.evaluate<boolean>(`document.body.textContent?.includes(${ JSON.stringify(expectedText) }) === true`)
		if (found) return
		await Bun.sleep(50)
	}
	throw new Error(`Timed out waiting for text: ${ expectedText }`)
}

async function capture(connection: Awaited<ReturnType<typeof connectTarget>>, filename: string, width: number, height: number) {
	await connection.send('Page.enable')
	await connection.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
	await Bun.sleep(250)
	const screenshot = await connection.send<{ data: string }>('Page.captureScreenshot', {
		format: 'png',
		captureBeyondViewport: true,
		fromSurface: true,
	})
	await writeFile(path.join(outputDirectory, filename), Buffer.from(screenshot.data, 'base64'))
}

await mkdir(outputDirectory, { recursive: true })
console.info(`Writing screenshots outside the repository to ${ outputDirectory }`)
console.info('Launching Chromium')
const session = await launchChromeSession()
try {
	console.info('Waiting for extension worker')
	const workerTarget = await waitForAnyExtensionServiceWorker(session.browserDebugPort)
	const extensionId = new URL(workerTarget.url).host

	const addressBookUrl = `chrome-extension://${ extensionId }/html3/addressBookV3.html`
	console.info('Opening address book')
	const addressBookTargetId = await createTargetPage(session.browserConnection, addressBookUrl)
	const addressBookTarget = await waitForTargetByUrl(session.browserDebugPort, addressBookUrl)
	const addressBook = await connectTarget(session.browserDebugPort, addressBookTarget.id)
	await waitForSelector(addressBook, '.address-book-page')
	await addressBook.evaluate(`(() => {
		const safeLink = [...document.querySelectorAll('a')].find((element) => element.textContent?.includes('My Gnosis Safes'))
		if (!(safeLink instanceof HTMLElement)) throw new Error('My Gnosis Safes link was not found')
		safeLink.click()
	})()`)
	await Bun.sleep(400)
	await capture(addressBook, 'safe-address-book.png', 1280, 800)
	await addressBook.evaluate(`(() => {
		const addButton = [...document.querySelectorAll('button')].find((element) => element.textContent?.includes('Add New Gnosis Safe Wallet'))
		if (!(addButton instanceof HTMLElement)) throw new Error('Add New Gnosis Safe Wallet button was not found')
		addButton.click()
	})()`)
	await waitForSelector(addressBook, '.modal.is-active')
	await addressBook.evaluate(`(() => {
		const addSignerButton = [...document.querySelectorAll('.modal.is-active button')].find((element) => element.textContent?.includes('Add Gnosis Safe signer'))
		if (!(addSignerButton instanceof HTMLElement)) throw new Error('Add Gnosis Safe signer button was not found')
		addSignerButton.click()
	})()`)
	await Bun.sleep(100)
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
	await capture(addressBook, 'safe-address-form.png', 1280, 900)
	await addressBook.evaluate(`new Promise((resolve, reject) => {
		chrome.storage.local.set({
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
		}, () => chrome.runtime.lastError === undefined ? resolve(true) : reject(chrome.runtime.lastError))
	})`)
	await session.browserConnection.send('Target.closeTarget', { targetId: addressBookTargetId })

	console.info('Opening Gnosis Safe signing-mode popup')
	const popupUrl = `chrome-extension://${ extensionId }/html3/popupV3.html`
	const popupTargetId = await createTargetPage(session.browserConnection, popupUrl)
	const popupTarget = await waitForTargetByUrl(session.browserDebugPort, popupUrl)
	const popup = await connectTarget(session.browserDebugPort, popupTarget.id)
	await waitForSelector(popup, '.popup-home-card')
	await Bun.sleep(500)
	await capture(popup, 'safe-signing-mode.png', 520, 650)

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
	await popup.evaluate(`new Promise((resolve, reject) => {
		chrome.storage.local.set({
			pendingTransactionsAndMessages: [${ JSON.stringify(serializedPendingTransactions) }],
		}, () => chrome.runtime.lastError === undefined ? resolve(true) : reject(chrome.runtime.lastError))
	})`)
	await session.browserConnection.send('Target.closeTarget', { targetId: popupTargetId })
	const confirmUrl = `chrome-extension://${ extensionId }/html3/confirmTransactionV3.html`
	const confirmTargetId = await createTargetPage(session.browserConnection, confirmUrl)
	const confirmTarget = await waitForTargetByUrl(session.browserDebugPort, confirmUrl)
	const confirm = await connectTarget(session.browserDebugPort, confirmTarget.id)
	await waitForText(confirm, 'wrapped as Gnosis Safe transaction nonce 7')
	await capture(confirm, 'safe-confirm-transaction.png', 800, 900)
	await session.browserConnection.send('Target.closeTarget', { targetId: confirmTargetId })

	const stackUrl = `chrome-extension://${ extensionId }/html3/simulationStackV3.html`
	console.info('Opening simulation stack')
	const stackTargetId = await createTargetPage(session.browserConnection, stackUrl)
	const stackTarget = await waitForTargetByUrl(session.browserDebugPort, stackUrl)
	const stack = await connectTarget(session.browserDebugPort, stackTarget.id)
	await waitForSelector(stack, '.simulation-stack-page-header')
	await capture(stack, 'safe-simulation-stack.png', 1280, 800)
	await stack.evaluate(`(() => {
		const importButton = [...document.querySelectorAll('button')].find((element) => element.textContent?.includes('Import Gnosis Safe'))
		if (!(importButton instanceof HTMLElement)) throw new Error('Import Gnosis Safe button was not found')
		importButton.click()
	})()`)
	await waitForSelector(stack, '.modal.is-active')
	await capture(stack, 'safe-stack-import.png', 1280, 800)
	await session.browserConnection.send('Target.closeTarget', { targetId: stackTargetId })
} finally {
	console.info('Closing Chromium')
	await session.close()
}
