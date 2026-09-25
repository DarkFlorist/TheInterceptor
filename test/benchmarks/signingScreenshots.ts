import { checkSigningAccessibility, checkSigningZoom, signingKey, waitForSigningFocus } from './signingAccessibility.js'
import { installScreenshotLedger, installScreenshotAccountCamera } from './signingScreenshotFixtures.js'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureExtensionScreenshot } from './screenshotCapture.js'
import { launchChromeSession, waitForInterceptorExtensionServiceWorker, connectTarget, createTargetPage, closeTarget, waitForPerformanceMarks, waitForTargetByUrl } from './chromeHarness.js'
import { DirectSigningRecords } from '../../app/ts/types/directSigning.js'
import { SigningWalletBindings } from '../../app/ts/types/signingWallet.js'
import { serializeTransaction } from '../../app/ts/utils/ethereumTransactions.js'
import { bytesFromHex, bytesToHex, keccak256 } from '../../app/ts/utils/ethereumBytes.js'
import { assembleSignedTransaction, prepareTransactionSigningPayload } from '../../app/ts/signing/exactPayload.js'
import { secp256k1 } from '@noble/curves/secp256k1'
const root = fileURLToPath(new URL('../../', import.meta.url))
const address = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'
const key = bytesFromHex('0x0000000000000000000000000000000000000000000000000000000000000001')
const binding = {
	revision: '11111111-1111-4111-8111-111111111111',
	wallet: {
		type: 'airgap' as const,
		address: BigInt(address),
		label: 'Cold storage · Account 1',
		publicKey: bytesToHex(secp256k1.getPublicKey(key, true)),
		derivationPath: 'm/44\'/60\'/0\'/0/0',
		sourceFingerprint: 0xf23f9fd2
	}
}
const ledgerAddress = '0x2b5ad5c4795c026514f8317c7a215e218dccd6cf'
const ledgerBinding = {
	revision: '22222222-2222-4222-8222-222222222222',
	wallet: {
		type: 'ledger' as const,
		address: BigInt(ledgerAddress),
		label: 'Main device · Account 1',
		publicKey: bytesToHex(secp256k1.getPublicKey(bytesFromHex('0x0000000000000000000000000000000000000000000000000000000000000002'), false)),
		derivationPath: 'm/44\'/60\'/0\'/0/0'
	}
}
const manualAddress = '0x3333333333333333333333333333333333333333'
const data = serializeTransaction({
	type: 'eip1559',
	chainId: 1n,
	nonce: 7n,
	gas: 21000n,
	maxFeePerGas: 30000000000n,
	maxPriorityFeePerGas: 1000000000n,
	to: '0x1111111111111111111111111111111111111111',
	value: 10000000000000000n
})
const record = {
	id: '33333333-3333-4333-8333-333333333333',
	request: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } },
	binding,
	websiteOrigin: 'https://swap.example.test',
	rpcUrl: 'https://rpc.example.invalid',
	input: { method: 'eth_sendTransaction' as const, data, address, chainId: 1n },
	revision: '44444444-4444-4444-8444-444444444444',
	created: Date.now(),
	phase: 'review' as const
}
const payload = prepareTransactionSigningPayload(data, address, 1n)
const signature = secp256k1.sign(bytesFromHex(payload.digest), key)
const bytes = new Uint8Array(65)
bytes.set(signature.toCompactRawBytes())
bytes[64] = signature.recovery + 27
const signed = await assembleSignedTransaction(payload, bytesToHex(bytes))
// Never use a developer's saved Chrome profile for fixtures.
const profileDir = await mkdtemp(join(tmpdir(), 'interceptor-screenshots-'))
const chrome = await launchChromeSession(undefined, { profileDir, cleanupProfile: true })
const connections: Awaited<ReturnType<typeof connectTarget>>[] = []
try {
	const worker = await waitForInterceptorExtensionServiceWorker(chrome.browserDebugPort)
	const origin = worker.url.slice(0, worker.url.indexOf('/js/'))
	const background = await connectTarget(chrome.browserDebugPort, worker.id)
	connections.push(background)
	await waitForPerformanceMarks(background, ['interceptor:background:loaded'], 30000)
	await background.evaluate(
		`browser.storage.local.set(${JSON.stringify({
			openedPageV2: { page: 'Home' },
			selectedSigningAddress: address,
			independentActiveSimulationAddress: ledgerAddress,
			simulationMode: false,
			useSignersAddressAsActiveAddress: false,
			userAddressBookEntriesV3: [
				{ type: 'contact', address, name: 'Cold storage', chainId: 'AllChains', entrySource: 'User', useAsActiveAddress: true },
				{ type: 'contact', address: ledgerAddress, name: 'Savings', chainId: 'AllChains', entrySource: 'User', useAsActiveAddress: true },
				{ type: 'contact', address: manualAddress, name: 'Research', chainId: 'AllChains', entrySource: 'User', useAsActiveAddress: true }
			],
			signingWalletBindings: SigningWalletBindings.serialize([binding, ledgerBinding])
		})})`
	)
	const wait = async (page: typeof background, text: string) => {
		for (let i = 0; i < 150; i++) {
			if (await page.evaluate<boolean>(`document.body?.textContent?.includes(${JSON.stringify(text)}) === true`)) return
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
		throw new Error(`Missing text ${text}: ${await page.evaluate('document.body.textContent')}`)
	}
	const open = async (path: string, text: string) => {
		const id = await createTargetPage(chrome.browserConnection, `${origin}/html3/${path}`)
		const page = await connectTarget(chrome.browserDebugPort, id)
		connections.push(page)
		await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1000, deviceScaleFactor: 1, mobile: false })
		await wait(page, text)
		return { page, id }
	}
	const capture = async (page: typeof background, name: string) => {
		await captureExtensionScreenshot(page, `${root}/docs/images/direct-signing/${name}.png`, name.startsWith('00') ? 'popup' : 'page')
		console.info(name)
	}
	const choose = async (page: typeof background, value: string) => {
		await page.evaluate(
			`(() => {const select = document.querySelector('select'); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change',{bubbles:true}));})()`
		)
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	const click = async (page: typeof background, text: string) =>
		page.evaluate(
			`(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent.includes(${JSON.stringify(text)})); if(!button)throw new Error('Missing button'); button.click(); })()`
		)
	await background.evaluate('browser.action.openPopup()')
	const popupTarget = await waitForTargetByUrl(chrome.browserDebugPort, `${origin}/html3/popupV3.html`, 30000)
	const home = { page: await connectTarget(chrome.browserDebugPort, popupTarget.id), id: popupTarget.id }
	connections.push(home.page)
	await wait(home.page, 'Change wallet')
	console.info(await chrome.browserConnection.send('Browser.getVersion'))
	await capture(home.page, '00-home')
	await home.page.evaluate(
		`(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Change'); if(!button)throw new Error('Missing Change'); button.click(); })()`
	)
	await wait(home.page, 'Choose address')
	await capture(home.page, '00b-address-selector')
	await home.page.evaluate(`document.querySelector('.modal-card-body').scrollTop = document.querySelector('.modal-card-body').scrollHeight`)
	await capture(home.page, '00c-address-selector-manual')
	if (await home.page.evaluate<boolean>(`[...document.querySelectorAll('.signing-address-selector button')].some(button => button.textContent === 'Use in simulation')`)) throw new Error('Address selector must not offer a mode-switch shortcut')
	await click(home.page, 'Close')
	await click(home.page, 'Simulating')
	await wait(home.page, 'Main device')
	for (let attempt = 0; attempt < 150; attempt++) {
		if (await home.page.evaluate<boolean>(`(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Change'); if (!button || button.disabled) return false; button.click(); return true; })()`)) break
		if (attempt === 149) throw new Error('Address controls remained disabled after switching mode')
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	await wait(home.page, 'Choose address')
	await home.page.evaluate(`(() => { const row = [...document.querySelectorAll('.signing-address-selector li')].find(row => row.textContent.includes('Research')); if (!row) throw new Error('Missing Research'); row.querySelector('.card').click(); })()`)

	for (let attempt = 0; attempt < 100; attempt++) {
		const selected = await background.evaluate<{ simulationMode?: boolean, selectedSigningAddress?: string, independentActiveSimulationAddress?: string }>(`browser.storage.local.get(['simulationMode', 'selectedSigningAddress', 'independentActiveSimulationAddress'])`)
		if (selected.simulationMode === true && selected.independentActiveSimulationAddress === manualAddress) {
			if (selected.selectedSigningAddress !== address) throw new Error('Address selection in Simulation mode changed signing address')
			break
		}
		if (attempt === 99) throw new Error('Address selection did not preserve Simulation mode')
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	await wait(home.page, 'No signing wallet')
	await capture(home.page, '00d-simulation-selected')
	await closeTarget(chrome.browserConnection, home.id)
	const setup = await open('signingWalletV3.html', 'Connect Ledger')
	await capture(setup.page, '01-ledger-onboarding')
	await installScreenshotLedger(setup.page)
	await click(setup.page, 'Connect Ledger')
	await wait(setup.page, 'Select an account, then verify')
	await setup.page.evaluate(`document.querySelectorAll('input[type=radio]')[1].click()`)
	await capture(setup.page, '01b-ledger-accounts')
	if (
		!(await setup.page.evaluate<boolean>(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Save address and wallet').disabled`))
	)
		throw new Error('Unverified Ledger account can be saved')
	await click(setup.page, 'Verify selected address on Ledger')
	await wait(setup.page, 'Address verified on Ledger')
	await capture(setup.page, '01c-ledger-verified')

	await choose(setup.page, 'airgap')
	await click(setup.page, 'Scan public account')
	await wait(setup.page, 'Enable camera')
	await capture(setup.page, '02-airgap-import')
	await installScreenshotAccountCamera(setup.page)
	await click(setup.page, 'Enable camera')
	await wait(setup.page, 'Public accounts imported.')
	await capture(setup.page, '02b-airgap-review')
	await click(setup.page, 'Save address and wallet')
	await wait(setup.page, 'You can close this tab')
	await capture(setup.page, '02c-airgap-saved')
	const preserved = await background.evaluate<boolean>(`(async () => {
		const state = await browser.storage.local.get(['userAddressBookEntriesV3', 'selectedSigningAddress', 'independentActiveSimulationAddress', 'simulationMode']);
		return state.userAddressBookEntriesV3.filter(entry => entry.address.toLowerCase() === ${JSON.stringify(address)}).length === 1
			&& state.selectedSigningAddress === ${JSON.stringify(address)} && state.independentActiveSimulationAddress === ${JSON.stringify(manualAddress)} && state.simulationMode === true;
	})()`)
	if (!preserved) throw new Error('Onboarding duplicated the address or changed mode selections')

	// Restore the labeled binding used by the independent signing-request fixtures.
	await background.evaluate(`browser.storage.local.set({signingWalletBindings:${JSON.stringify(SigningWalletBindings.serialize([binding, ledgerBinding]))}})`)

	const edit = await open(`signingWalletV3.html?address=${address}`, 'Remove signing wallet')
	await choose(edit.page, 'airgap')
	await capture(edit.page, '03-change-wallet')
	await background.evaluate(`browser.storage.local.set({directSigningRequestsV1:${JSON.stringify(DirectSigningRecords.serialize([record]))}})`)
	const review = await open(`directSigningV3.html?id=${record.id}`, 'Approve and continue with AirGap Vault')
	await review.page.evaluate(`[...document.querySelectorAll('details')].find(details => details.querySelector('summary')?.textContent === 'Edit fees and advanced nonce').open = true`)
	await capture(review.page, '04-review-transaction')
	await review.page.evaluate(`[...document.querySelectorAll('details')].find(details => details.querySelector('summary')?.textContent === 'Edit fees and advanced nonce').open = false`)
	await review.page.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 820, deviceScaleFactor: 1, mobile: false })
	await capture(review.page, '04b-review-narrow')
	await review.page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1000, deviceScaleFactor: 1, mobile: false })
	await checkSigningZoom(review.page)
	await capture(review.page, '24-review-zoom')
	await review.page.evaluate('(async () => { const tab = await browser.tabs.getCurrent(); await browser.tabs.setZoom(tab.id, 1) })()')

	await closeTarget(chrome.browserConnection, review.id)
	await background.evaluate(
		`browser.storage.local.set({directSigningRequestsV1:${JSON.stringify(DirectSigningRecords.serialize([{ ...record, phase: 'approved' }]))}})`
	)
	const request = await open(`directSigningV3.html?id=${record.id}`, 'Resume with AirGap Vault')
	await click(request.page, 'Resume with AirGap Vault')
	await wait(request.page, 'Scan signed response')
	await click(request.page, 'Pause')
	await capture(request.page, '05-offline-request')
	await click(request.page, 'Scan signed response')
	await wait(request.page, 'Enable camera')
	await capture(request.page, '06-scan-response')
	await request.page.evaluate(`navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Camera permission denied', 'NotAllowedError') }`)
	await click(request.page, 'Enable camera')
	await wait(request.page, 'Camera permission denied')
	await waitForSigningFocus(request.page, '.signing-camera [role=alert]')
	await signingKey(request.page, 'Tab', true)
	await waitForSigningFocus(request.page, '.signing-camera button')
	await capture(request.page, '06b-camera-recovery')
	await closeTarget(chrome.browserConnection, request.id)
	await background.evaluate(
		`browser.storage.local.set({directSigningRequestsV1:${JSON.stringify(DirectSigningRecords.serialize([{ ...record, phase: 'signed', result: signed, transactionHash: keccak256(bytesFromHex(signed)) }]))}})`
	)
	const broadcast = await open(`directSigningV3.html?id=${record.id}`, 'Broadcast transaction')
	await capture(broadcast.page, '07-broadcast-confirmation')
	const broadcastActions = await broadcast.page.evaluate(`([...document.querySelectorAll('button')].map(button => button.textContent))`)
	if (!broadcastActions.includes('Broadcast transaction')) throw new Error('Signed transaction lacks broadcast action')
	await wait(broadcast.page, 'Signature recovered. Review the transaction before broadcasting.')
	await closeTarget(chrome.browserConnection, broadcast.id)
	const ledgerRecord = { ...record, binding: ledgerBinding, input: { ...record.input, address: ledgerAddress } }
	await background.evaluate(`browser.storage.local.set({directSigningRequestsV1:${JSON.stringify(DirectSigningRecords.serialize([ledgerRecord]))}})`)
	const ledgerReview = await open(`directSigningV3.html?id=${record.id}`, 'Compare with your Ledger Nano X')
	await click(ledgerReview.page, 'Next screen')
	await capture(ledgerReview.page, '08-ledger-screen-address')
	for (let index = 0; index < 3; index++) await click(ledgerReview.page, 'Next screen')
	await capture(ledgerReview.page, '09-ledger-screen-fees')
	await closeTarget(chrome.browserConnection, ledgerReview.id)
	const typedRecord = { ...ledgerRecord, input: { ...ledgerRecord.input, method: 'eth_signTypedData_v4' as const, data: JSON.stringify({ types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Message: [{ name: 'contents', type: 'string' }] }, primaryType: 'Message', domain: { name: 'Interceptor', chainId: 1 }, message: { contents: 'Hello Ledger' } }) } }
	await background.evaluate(`browser.storage.local.set({directSigningRequestsV1:${JSON.stringify(DirectSigningRecords.serialize([typedRecord]))}})`)
	const typedReview = await open(`directSigningV3.html?id=${record.id}`, 'Compare with your Ledger Nano X')
	for (let index = 0; index < 4; index++) await click(typedReview.page, 'Next screen')
	await capture(typedReview.page, '10-ledger-typed-hash')
	await typedReview.page.evaluate(`(() => { const panel = document.querySelector('.ledger-preview'); panel.querySelector('details').open = true; const checkbox = panel.querySelector('input'); checkbox.click(); })()`)
	for (let index = 0; index < 6; index++) await click(typedReview.page, 'Next screen')
	await capture(typedReview.page, '11-ledger-typed-fields')
	await closeTarget(chrome.browserConnection, typedReview.id)
	const personalRecord = { ...ledgerRecord, input: { ...ledgerRecord.input, method: 'personal_sign' as const, data: '0x48656c6c6f204c6564676572' } }
	await background.evaluate(`browser.storage.local.set({directSigningRequestsV1:${JSON.stringify(DirectSigningRecords.serialize([personalRecord]))}})`)
	const personalReview = await open(`directSigningV3.html?id=${record.id}`, 'Compare with your Ledger Nano X')
	await click(personalReview.page, 'Next screen')
	await capture(personalReview.page, '12-ledger-personal-message')
	await closeTarget(chrome.browserConnection, personalReview.id)
	const nestedRecord = { ...typedRecord, input: { ...typedRecord.input, data: JSON.stringify({ types: { EIP712Domain: [], Item: [{ name: 'recipient', type: 'address' }, { name: 'amount', type: 'uint256' }], Batch: [{ name: 'items', type: 'Item[]' }] }, primaryType: 'Batch', domain: {}, message: { items: [{ recipient: address, amount: '900719925474099312345' }] } }) } }
	await background.evaluate(`browser.storage.local.set({directSigningRequestsV1:${JSON.stringify(DirectSigningRecords.serialize([nestedRecord]))}})`)
	const nested = await open(`directSigningV3.html?id=${record.id}`, 'Array · 1 item')
	await capture(nested.page, '25a-nested-collapsed')
	await checkSigningAccessibility(nested.page, async (stage) => await capture(nested.page, stage === 'copied' ? '26-copy-success' : '27-copy-error'))
	await nested.page.send('Page.reload')
	await wait(nested.page, 'Array · 1 item')
	await nested.page.evaluate(`document.querySelector('.signing-field-group summary').focus()`)
	await signingKey(nested.page, 'Enter')
	await wait(nested.page, 'Struct · 2 fields')
	await signingKey(nested.page, 'Tab')
	await waitForSigningFocus(nested.page, '.signing-field-group .signing-field-group summary')
	await signingKey(nested.page, ' ')
	await wait(nested.page, '900719925474099312345')
	await capture(nested.page, '25-nested-typed-data')
	await closeTarget(chrome.browserConnection, nested.id)
	for (const method of ['personal_sign', 'eth_signTypedData_v4'] as const) {
		const input = {
			...record.input,
			method,
			data:
				method === 'personal_sign'
					? '0x68656c6c6f'
					: JSON.stringify({
							types: { EIP712Domain: [], Message: [{ name: 'contents', type: 'string' }] },
							primaryType: 'Message',
							domain: {},
							message: { contents: 'Hello' }
						})
		}
		await background.evaluate(
			`browser.storage.local.set({directSigningRequestsV1:${JSON.stringify(DirectSigningRecords.serialize([{ ...record, input, phase: 'signed', result: '0x' + '11'.repeat(65) }]))}})`
		)
		const message = await open(`directSigningV3.html?id=${record.id}`, 'Signature verified · Returned to application')
		const buttons = await message.page.evaluate(`([...document.querySelectorAll('button')].map(button => button.textContent))`)
		if (buttons.some((text: string) => text.includes('Broadcast') || text.includes('Reconcile transaction')))
			throw new Error('Message shows transaction submission action')
		console.info(`Recovered ${method}: message status, no broadcast action`)
		await closeTarget(chrome.browserConnection, message.id)
	}
	console.info('Recovered eth_sendTransaction: transaction status and broadcast action')
	const probe = await open(`directSigningV3.html?id=${record.id}`, 'Signature verified · Returned to application')
	await probe.page.evaluate(`(() => { const image = new Image(); image.id = 'broken-asset-probe'; image.src = 'data:image/png;base64,AA=='; document.body.append(image); })()`)
	let rejectedIcon = false
	try { await captureExtensionScreenshot(probe.page, join(tmpdir(), 'unexpected-signing-capture.png'), 'page') }
	catch (error) { if (!(error instanceof Error) || !error.message.includes('Missing icon:')) throw error; rejectedIcon = true }
	if (!rejectedIcon) throw new Error('Screenshot accepted a missing icon')
	await probe.page.evaluate(`document.getElementById('broken-asset-probe').remove(); document.querySelector('link[href*="interceptor-theme"]').remove()`)
	let rejectedFont = false
	try { await captureExtensionScreenshot(probe.page, join(tmpdir(), 'unexpected-signing-capture.png'), 'page') }
	catch (error) { if (!(error instanceof Error) || !error.message.includes('Required bundled font is not declared')) throw error; rejectedFont = true }
	if (!rejectedFont) throw new Error('Screenshot accepted missing bundled fonts')
	console.info('Capture guards rejected missing icons and fonts')

} finally {
	for (const page of connections) page.close()
	await chrome.close()
	await rm(profileDir, { recursive: true, force: true })
}
