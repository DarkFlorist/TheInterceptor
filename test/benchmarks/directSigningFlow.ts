import { installFlowCamera, installFlowLedger } from './directSigningFlowFixtures.js'
/** Built-page walkthrough with public test keys, scripted HID, synthetic QR camera and local RPC. No physical-device claim. */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { secp256k1 } from '@noble/curves/secp256k1'
import { type DirectSigningRecord, DirectSigningRecords } from '../../app/ts/types/directSigning.js'
import { PendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import { SigningWalletBinding, SigningWalletBindings } from '../../app/ts/types/signingWallet.js'
import { bytesFromHex, bytesToHex, keccak256 } from '../../app/ts/utils/ethereumBytes.js'
import { serializeTransaction } from '../../app/ts/utils/ethereumTransactions.js'
import { prepareDirectPayload } from '../../app/ts/signing/backend.js'
import { captureExtensionScreenshot } from './screenshotCapture.js'
import { launchChromeSession, waitForInterceptorExtensionServiceWorker, waitForPerformanceMarks, connectTarget, createTargetPage, closeTarget, type CdpConnection } from './chromeHarness.js'

const key = bytesFromHex('0x0000000000000000000000000000000000000000000000000000000000000001')
const address = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'
const path = 'm/44\'/60\'/0\'/0/0'
const typed = JSON.stringify({ types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Message: [{ name: 'contents', type: 'string' }] }, primaryType: 'Message', domain: { name: 'Signing walkthrough', chainId: 1 }, message: { contents: 'Approve this readable message' } })
let submittedHash: string | undefined
let sends = 0
let failSubmission = false
let confirmed = false
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
	const body = await request.json()
	let result: unknown
	switch (body.method) {
		case 'eth_chainId': result = '0x1'; break
		case 'eth_getTransactionCount': result = '0x0'; break
		case 'eth_gasPrice': result = '0x1'; break
		case 'eth_getBalance': result = '0xffffffffffffffff'; break
		case 'eth_getTransactionReceipt': result = confirmed ? { transactionHash: submittedHash, blockNumber: '0x1', status: '0x1' } : null; break
		case 'eth_getTransactionByHash': result = submittedHash === undefined ? null : { hash: submittedHash }; break
		case 'eth_sendRawTransaction':
			sends++; submittedHash = keccak256(body.params[0])
			if (failSubmission) return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'Fixture lost the submission response' } })
			result = submittedHash; break
		default: return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `Unexpected fixture RPC ${ body.method }` } })
	}
	return Response.json({ jsonrpc: '2.0', id: body.id, result })
} })
const chrome = await launchChromeSession()
const connections: CdpConnection[] = []
const output = process.env.SIGNING_FLOW_SCREENSHOTS ?? '/tmp/interceptor-signing-flow'
await mkdir(output, { recursive: true })
async function wait(page: CdpConnection, text: string) {
	for (let index = 0; index < 200; index++) {
		if (await page.evaluate<boolean>(`document.body?.textContent?.includes(${ JSON.stringify(text) }) === true`)) return
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	throw new Error(`Missing ${ text }: ${ await page.evaluate('document.body.textContent') }`)
}
async function click(page: CdpConnection, text: string) {
	await page.evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${ JSON.stringify(text) }); if (!button || button.disabled) throw new Error('Missing or disabled ${ text }'); button.click(); })()`)
}

try {
	const worker = await waitForInterceptorExtensionServiceWorker(chrome.browserDebugPort)
	const background = await connectTarget(chrome.browserDebugPort, worker.id); connections.push(background)
	await waitForPerformanceMarks(background, ['interceptor:background:loaded'], 30000)
	const origin = worker.url.slice(0, worker.url.indexOf('/js/'))
	for (const type of ['ledger', 'airgap'] as const) for (const method of ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4'] as const) {
		sends = 0; submittedHash = undefined; confirmed = false; failSubmission = type === 'airgap'
		const binding: SigningWalletBinding = { revision: crypto.randomUUID(), wallet: { type, address: BigInt(address), label: 'Walkthrough public test account', publicKey: bytesToHex(secp256k1.getPublicKey(key, type === 'airgap')), derivationPath: path, ...(type === 'airgap' ? { sourceFingerprint: 0xf23f9fd2 } : {}) } }
		const data = method === 'eth_sendTransaction' ? serializeTransaction({ type: 'eip1559', chainId: 1n, nonce: 0n, gas: 21000n, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n, to: address, value: 1000000000000000n }) : method === 'personal_sign' ? '0x48656c6c6f2066726f6d207468652077616c6b7468726f756768' : typed
		const record: DirectSigningRecord = { id: crypto.randomUUID(), request: { requestId: 1, requestSocket: { tabId: 98765, connectionName: 0n } }, binding, websiteOrigin: 'https://walkthrough.example.test', rpcUrl: `http://127.0.0.1:${ server.port }`, input: { method, data, address, chainId: 1n }, revision: crypto.randomUUID(), created: Date.now(), phase: 'review' }
		// Seed only the pre-existing explanation/request boundary; approval, signing, verification and submission use production handlers.
		const uniqueRequestIdentifier = { requestId: 1, requestSocket: { tabId: 98765, connectionName: '0x0' } }
		const originalRequestParameters = method === 'eth_sendTransaction' ? { method, params: [{ from: address, to: address, value: '0x0' }] } : method === 'personal_sign' ? { method, params: [data, address] } : { method, params: [address, data] }
		const common = { popupOrTabId: { type: 'tab', id: 98765 }, originalRequestParameters, uniqueRequestIdentifier, simulationMode: false, activeAddress: address, created: '0x1', website: { websiteOrigin: record.websiteOrigin }, approvalStatus: { status: 'WaitingForUser' }, transactionOrMessageCreationStatus: 'Simulated', signingWalletBinding: SigningWalletBinding.serialize(binding), signingChainId: '0x1', directSigningReviewRevision: record.revision }
		const transactionToSimulate = { website: common.website, created: common.created, originalRequestParameters, transactionIdentifier: '0x1', success: true, transaction: { type: '0x2', from: address, to: address, chainId: '0x1', nonce: '0x0', gas: '0x5208', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00', value: '0x38d7ea4c68000', input: '0x', accessList: [] } }
		const addressEntry = { type: 'contact', address, name: 'Public test account', chainId: 'AllChains', entrySource: 'User', useAsActiveAddress: true }
		const visualizedPersonalSignRequest = { activeAddress: addressEntry, account: addressEntry, rpcNetwork: { name: 'Local fixture', chainId: '0x1', httpsRpc: record.rpcUrl, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }, simulationMode: false, signerName: 'NoSignerDetected', quarantineReasons: [], quarantine: false, website: common.website, created: common.created, rawMessage: data, stringifiedMessage: data, messageIdentifier: '0x1', method, type: 'NotParsed', message: data }
		const pending = PendingTransactionOrSignableMessage.parse(method === 'eth_sendTransaction' ? { ...common, type: 'Transaction', transactionIdentifier: '0x1', transactionToSimulate, popupVisualisation: { statusCode: 'failed', data: { activeAddress: address, simulationMode: false, simulationStartedTimestamp: '0x1', uniqueRequestIdentifier, transactionToSimulate, signerName: 'NoSignerDetected', error: { code: -32000, message: 'Walkthrough fixture', decodedErrorMessage: 'Walkthrough fixture' }, simulationState: { blockNumber: '0x1', simulationConductedTimestamp: '0x1' } } } } : { ...common, type: 'SignableMessage', visualizedPersonalSignRequest, signedMessageTransaction: { website: common.website, created: common.created, fakeSignedFor: address, activeAddress: address, originalRequestParameters, request: { interceptorRequest: true, usingInterceptorWithoutSigner: true, uniqueRequestIdentifier, ...originalRequestParameters }, simulationMode: false, messageIdentifier: '0x1' } })
		await background.evaluate(`browser.storage.local.set(${ JSON.stringify({ signingWalletBindings: SigningWalletBindings.serialize([binding]), directSigningRequestsV1: DirectSigningRecords.serialize([record]), pendingTransactionsAndMessages: [PendingTransactionOrSignableMessage.serialize(pending)], pendingTerminalReplies: [] }) })`)
		const target = await createTargetPage(chrome.browserConnection, `${ origin }/html3/directSigningV3.html?id=${ record.id }`)
		const page = await connectTarget(chrome.browserDebugPort, target); connections.push(page)
		await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1000, deviceScaleFactor: 1, mobile: false })
		await wait(page, 'Review the exact payload before approving.')
		for (const text of [record.websiteOrigin, address, 'Chain 1', 'Signing mode', type === 'ledger' ? 'Ledger' : 'AirGap']) await wait(page, text)
		await captureExtensionScreenshot(page, `${ output }/${ type }-${ method }-review.png`, 'page')
		const payload = prepareDirectPayload(record.input)
		const signed = secp256k1.sign(bytesFromHex(payload.digest), key)
		const signature = Uint8Array.from([...signed.toCompactRawBytes(), signed.recovery + 27])
		if (type === 'ledger') await installFlowLedger(page, record, signature, method === 'personal_sign' ? 'reject' : method === 'eth_signTypedData_v4' ? 'disconnect' : undefined)
		await click(page, `Approve and continue with ${ type === 'ledger' ? 'Ledger' : 'AirGap Vault' }`)
		if (type === 'ledger' && method === 'personal_sign') {
			await wait(page, 'rejected'); await captureExtensionScreenshot(page, `${ output }/ledger-rejection.png`, 'page'); await click(page, 'Resume with Ledger')
		}
		if (type === 'ledger' && method === 'eth_signTypedData_v4') { await wait(page, 'Ledger disconnected'); await captureExtensionScreenshot(page, `${ output }/ledger-disconnection.png`, 'page'); await click(page, 'Resume with Ledger') }
		if (type === 'airgap') {
			if (method === 'eth_signTypedData_v4') { await page.send('Page.reload'); await wait(page, 'Resume with AirGap Vault'); await click(page, 'Resume with AirGap Vault') }
			await wait(page, 'Scan signed response'); await click(page, 'Pause')
			await captureExtensionScreenshot(page, `${ output }/airgap-${ method }-request.png`, 'page')
			await click(page, 'Scan signed response')
			await installFlowCamera(page, crypto.randomUUID(), signature); await click(page, 'Enable camera')
			await wait(page, 'belongs to another request')
			await captureExtensionScreenshot(page, `${ output }/airgap-response-recovery.png`, 'page')
			await installFlowCamera(page, record.revision, signature); await click(page, 'Enable camera')
		}
		await wait(page, 'Signature verified')
		assert.equal(sends, 0, 'Signing must never broadcast')
		if (method === 'eth_sendTransaction') {
			await captureExtensionScreenshot(page, `${ output }/${ type }-ready-to-broadcast.png`, 'page')
			await click(page, 'Broadcast transaction')
			if (failSubmission) { await wait(page, 'Reconcile transaction by hash'); await captureExtensionScreenshot(page, `${ output }/airgap-submission-recovery.png`, 'page'); await click(page, 'Reconcile transaction by hash') }
			await wait(page, 'Transaction submitted.')
			assert.equal(sends, 1)
			confirmed = true; await click(page, 'Reconcile transaction by hash'); await wait(page, 'Transaction confirmed on the configured RPC.')
		} else {
			await wait(page, 'Returned to application')
			assert.equal(await page.evaluate(`document.body.textContent.includes('Cancel request') || document.body.textContent.includes('Broadcast transaction')`), false)
		}
		await captureExtensionScreenshot(page, `${ output }/${ type }-${ method }-complete.png`, 'page')
		const state = await background.evaluate<{ pendingTransactionsAndMessages: unknown[], pendingTerminalReplies: { method: string, result: string }[] }>(`browser.storage.local.get(['pendingTransactionsAndMessages', 'pendingTerminalReplies'])`)
		assert.equal(state.pendingTransactionsAndMessages.length, 0)
		assert.equal(state.pendingTerminalReplies.length, 1, 'Application reply must be durably queued for its originating socket')
		assert.equal(state.pendingTerminalReplies[0]?.method, method)
		assert.equal(state.pendingTerminalReplies[0]?.result, method === 'eth_sendTransaction' ? submittedHash : bytesToHex(signature))
		await closeTarget(chrome.browserConnection, target)
		console.info(`PASS ${ type } ${ method }: review → approval → verified signature → ${ method === 'eth_sendTransaction' ? 'explicit broadcast → confirmed' : 'durable application reply' }`)
	}
} finally {
	for (const connection of connections) connection.close()
	await chrome.close(); server.stop(true)
}
