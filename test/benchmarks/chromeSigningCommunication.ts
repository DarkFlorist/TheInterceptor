import { installFlowCamera, installFlowLedger } from './directSigningFlowFixtures.js'
import { DirectSigningRecord } from '../../app/ts/types/directSigning.js'
import { prepareDirectPayload } from '../../app/ts/signing/backend.js'
import { bytesFromHex, bytesToHex } from '../../app/ts/utils/ethereumBytes.js'
import { secp256k1 } from '@noble/curves/secp256k1'
import { privateKeyToAccount } from '../../app/ts/utils/ethereumSigning.js'
import { captureExtensionScreenshot } from './screenshotCapture.js'
import { closeTarget, connectTarget, createTargetPage, launchChromeSession, waitForInterceptorExtensionServiceWorker, waitForPerformanceMarks, waitForRegisteredContentScripts, waitForTargetByUrl, waitForTargetGone } from './chromeHarness.js'
import { startChromeCommunicationPageServer } from './chromeCommunicationPageServer.js'
import type { CdpConnection } from './chromeHarness.js'

const ACCESS_APPROVE_BUTTON_SELECTOR = 'nav.popup-button-row button.is-primary:not(.is-danger)'
const CONFIRM_APPROVE_BUTTON_SELECTOR = 'nav.popup-button-row button.dialog-action-button.is-primary:not(.is-danger)'
const account = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001')
const directWallet = process.argv.includes('--ledger') ? 'ledger' : process.argv.includes('--airgap') ? 'airgap' : undefined
const messagesOnly = process.argv.includes('--messages') || directWallet !== undefined
const FAKE_SIGNER_ADDRESS = messagesOnly ? account.address : '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'
const typedMessage = { types: { EIP712Domain: [{ name: 'name', type: 'string' }], Message: [{ name: 'contents', type: 'string' }] }, primaryType: 'Message', domain: { name: 'Browser walkthrough' }, message: { contents: 'Approve this readable message' } }
const personalSignature = await account.signMessage({ message: { raw: '0x48656c6c6f' } })
const typedSignature = await account.signTypedData(typedMessage)
const FAKE_SIGNED_TRANSACTION_HASH = '0x1111111111111111111111111111111111111111111111111111111111111111'

function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function waitForCondition(condition: () => Promise<boolean> | boolean, timeoutMs: number, label: string) {
	const start = Date.now()
	while (true) {
		if (await condition()) return
		if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${ label } after ${ timeoutMs }ms`)
		await sleep(50)
	}
}

function extractExtensionId(url: string) {
	const match = /^chrome-extension:\/\/([^/]+)/.exec(url)
	if (match?.[1] === undefined) throw new Error(`Could not determine extension id from ${ url }`)
	return match[1]
}

async function waitForButtonEnabled(connection: CdpConnection, selector: string, timeoutMs: number) {
	await waitForCondition(async () => await connection.evaluate<boolean>(`(() => {
		const element = document.querySelector(${ JSON.stringify(selector) })
		return element instanceof HTMLButtonElement && element.disabled === false && element.textContent.trim().length > 0 && element.getBoundingClientRect().width > 0 && getComputedStyle(element).visibility !== 'hidden'
	})()`).catch(() => false), timeoutMs, `button ${ selector } to be enabled`).catch(async (error) => { throw new Error(`Confirmation did not become ready: ${ await connection.evaluate('document.body.textContent') }`, { cause: error }) })
}

async function clickButton(connection: CdpConnection, selector: string) {
	await connection.evaluate(`(() => {
		const element = document.querySelector(${ JSON.stringify(selector) })
		if (!(element instanceof HTMLButtonElement)) throw new Error('Could not find button ${ selector }')
		element.click()
	})()`)
}

const fakeSignerPreload = `(() => {
	globalThis.__fakeSignerPreloadStarted = true
	const requests = []
	const aggregateRequests = []
	const listeners = new Map()
	const signer = {
		isMetaMask: true,
		selectedAddress: ${ JSON.stringify(FAKE_SIGNER_ADDRESS) },
		isConnected: () => true,
		request: async ({ method }) => {
			requests.push(method)
			switch (method) {
				case 'eth_chainId': return '0x1'
				case 'eth_accounts':
				case 'eth_requestAccounts': return [${ JSON.stringify(FAKE_SIGNER_ADDRESS) }]
				case 'eth_sendTransaction': return ${ JSON.stringify(FAKE_SIGNED_TRANSACTION_HASH) }
				case 'personal_sign': return ${ JSON.stringify(personalSignature) }
				case 'eth_signTypedData_v4': return ${ JSON.stringify(typedSignature) }
				default: throw Object.assign(new Error('Unsupported fake signer method: ' + method), { code: -32601 })
			}
		},
		on: (event, callback) => {
			listeners.set(event, [...listeners.get(event) ?? [], callback])
			return signer
		},
		removeListener: (event, callback) => {
			listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => candidate !== callback))
			return signer
		},
	}
	globalThis.__fakeSignerRequests = requests
	globalThis.__aggregateSignerRequests = aggregateRequests
	globalThis.ethereum = {
		isBraveWallet: true,
		isConnected: () => true,
		request: async ({ method }) => {
			aggregateRequests.push(method)
			if (method === 'eth_chainId') return '0x1'
			if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [${ JSON.stringify(FAKE_SIGNER_ADDRESS) }]
			return await new Promise(() => undefined)
		},
		on: () => globalThis.ethereum,
		removeListener: () => globalThis.ethereum,
	}
	globalThis.addEventListener('eip6963:requestProvider', () => globalThis.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
		detail: {
			info: { uuid: '44444444-4444-4444-8444-444444444444', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' },
			provider: signer,
		},
	})))
})()`

async function main() {
	const server = await startChromeCommunicationPageServer()
	const chrome = await launchChromeSession()
	let pageTargetId: string | undefined
	let accessTargetId: string | undefined
	let confirmTargetId: string | undefined
	try {
		const workerTarget = await waitForInterceptorExtensionServiceWorker(chrome.browserDebugPort, 30_000)
		const extensionId = extractExtensionId(workerTarget.url)
		const workerConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
		try {
			await waitForPerformanceMarks(workerConnection, ['interceptor:background:loaded'], 30_000)
			await waitForRegisteredContentScripts(workerConnection, ['inpage', 'inpage2'], 30_000)
			await workerConnection.evaluate(`browser.storage.local.set(${ JSON.stringify({ simulationMode: false, selectedSigningAddress: FAKE_SIGNER_ADDRESS, signingWalletBindings: [{ revision: '11111111-1111-4111-8111-111111111111', wallet: directWallet === undefined ? { type: 'browser', address: FAKE_SIGNER_ADDRESS, signerName: 'MetaMask', providerId: 'eip6963:io.metamask', label: 'Browser walkthrough account' } : { type: directWallet, address: FAKE_SIGNER_ADDRESS, publicKey: bytesToHex(secp256k1.getPublicKey(bytesFromHex('0x0000000000000000000000000000000000000000000000000000000000000001'), directWallet === 'airgap')), derivationPath: 'm/44\'/60\'/0\'/0/0', label: 'Public test device', ...(directWallet === 'airgap' ? { sourceFingerprint: 0xf23f9fd2 } : {}) } }] }) })`)
		} finally {
			workerConnection.close()
		}

		pageTargetId = await createTargetPage(chrome.browserConnection, 'about:blank')
		const pageConnection = await connectTarget(chrome.browserDebugPort, pageTargetId)
		try {
			await pageConnection.send('Page.enable')
			if (directWallet === undefined) await pageConnection.send('Page.addScriptToEvaluateOnNewDocument', { source: fakeSignerPreload })
			await pageConnection.send('Page.navigate', { url: server.baseUrl })
			await waitForCondition(async () => await pageConnection.evaluate(`globalThis.__interceptorChromeCommunicationState?.phase === 'requesting-access'`).catch(() => false), 30_000, 'access request')

			const accessTarget = await waitForTargetByUrl(chrome.browserDebugPort, `chrome-extension://${ extensionId }/html3/interceptorAccessV3.html`, 30_000)
			accessTargetId = accessTarget.id
			const accessConnection = await connectTarget(chrome.browserDebugPort, accessTarget.id)
			try {
				await waitForButtonEnabled(accessConnection, ACCESS_APPROVE_BUTTON_SELECTOR, 30_000)
				await clickButton(accessConnection, ACCESS_APPROVE_BUTTON_SELECTOR)
			} finally {
				accessConnection.close()
			}
			try {
				await waitForCondition(async () => await pageConnection.evaluate(`globalThis.__interceptorChromeCommunicationState?.phase === 'access-granted'`).catch(() => false), 30_000, 'access approval')
			} catch (error) {
				const accessState = await pageConnection.evaluate('({ state: globalThis.__interceptorChromeCommunicationState, preloadStarted: globalThis.__fakeSignerPreloadStarted, signerRequests: globalThis.__fakeSignerRequests, aggregateRequests: globalThis.__aggregateSignerRequests, ethereumType: typeof globalThis.ethereum, isBraveWallet: globalThis.ethereum?.isBraveWallet, isMetaMask: globalThis.ethereum?.isMetaMask })')
				throw new Error(`Access approval failed with page state ${ JSON.stringify(accessState) }`, { cause: error })
			}

			if (!messagesOnly) {
				await pageConnection.evaluate(`(() => {
					globalThis.__signingResult = { status: 'pending' }
					globalThis.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: ${ JSON.stringify(FAKE_SIGNER_ADDRESS) }, to: ${ JSON.stringify(FAKE_SIGNER_ADDRESS) }, value: '0x0', data: '0x' }] })
						.then((result) => { globalThis.__signingResult = { status: 'fulfilled', result } })
						.catch((error) => { globalThis.__signingResult = { status: 'rejected', error: error instanceof Error ? error.message : String(error), code: typeof error?.code === 'number' ? error.code : undefined } })
				})()`)

				const confirmTarget = await waitForTargetByUrl(chrome.browserDebugPort, `chrome-extension://${ extensionId }/html3/confirmTransactionV3.html`, 30_000)
				confirmTargetId = confirmTarget.id
				const confirmConnection = await connectTarget(chrome.browserDebugPort, confirmTarget.id)
				try {
					await waitForButtonEnabled(confirmConnection, CONFIRM_APPROVE_BUTTON_SELECTOR, 30_000)
					if (process.env.SIGNING_FLOW_SCREENSHOTS !== undefined) await captureExtensionScreenshot(confirmConnection, `${ process.env.SIGNING_FLOW_SCREENSHOTS }/browser-transaction-review.png`, 'page')
					await clickButton(confirmConnection, CONFIRM_APPROVE_BUTTON_SELECTOR)
				} finally {
					confirmConnection.close()
			}

			await waitForCondition(async () => await pageConnection.evaluate(`globalThis.__fakeSignerRequests?.includes('eth_sendTransaction')`).catch(() => false), 10_000, 'signer eth_sendTransaction request')
			await waitForCondition(async () => await pageConnection.evaluate(`globalThis.__signingResult?.status === 'fulfilled'`).catch(() => false), 10_000, 'signing result')
			const signingResult = await pageConnection.evaluate<{ status?: string, result?: string }>('globalThis.__signingResult')
			if (signingResult.result !== FAKE_SIGNED_TRANSACTION_HASH) throw new Error(`Unexpected signing result: ${ signingResult.result ?? 'missing' }`)
			const aggregateReceivedSigningRequest = await pageConnection.evaluate<boolean>(`globalThis.__aggregateSignerRequests?.includes('eth_sendTransaction')`)
			if (aggregateReceivedSigningRequest) throw new Error('Signing request was sent to Brave instead of its EIP-6963 MetaMask provider')

			await waitForTargetGone(chrome.browserDebugPort, (target) => target.id === confirmTargetId, 10_000, 'completed confirmation popup')
			confirmTargetId = undefined
			}
			for (const method of messagesOnly ? ['personal_sign', 'eth_signTypedData_v4'] as const : []) {
				const params = method === 'personal_sign' ? ['0x48656c6c6f', FAKE_SIGNER_ADDRESS] : [FAKE_SIGNER_ADDRESS, JSON.stringify(typedMessage)]
				await pageConnection.evaluate(`(() => { globalThis.__signingResult = {status:'pending'}; ethereum.request(${ JSON.stringify({ method, params }) }).then(result => { globalThis.__signingResult = {status:'fulfilled', result} }, error => { globalThis.__signingResult = {status:'rejected', error: error.message} }); })()`)
				const target = await waitForTargetByUrl(chrome.browserDebugPort, `chrome-extension://${ extensionId }/html3/confirmTransactionV3.html`, 30000)
				confirmTargetId = target.id
				const confirm = await connectTarget(chrome.browserDebugPort, target.id)
				try {
					await waitForButtonEnabled(confirm, CONFIRM_APPROVE_BUTTON_SELECTOR, 30000)
					if (process.env.SIGNING_FLOW_SCREENSHOTS !== undefined) await captureExtensionScreenshot(confirm, `${ process.env.SIGNING_FLOW_SCREENSHOTS }/${ directWallet ?? 'browser' }-${ method }-application-review.png`, 'page')
					await clickButton(confirm, CONFIRM_APPROVE_BUTTON_SELECTOR)
				} finally { confirm.close() }
				if (directWallet !== undefined) {
					const directTarget = await waitForTargetByUrl(chrome.browserDebugPort, `chrome-extension://${ extensionId }/html3/directSigningV3.html`, 30000)
					const signing = await connectTarget(chrome.browserDebugPort, directTarget.id)
					try {
						await waitForCondition(async () => await signing.evaluate(`document.body?.textContent?.includes('Review the exact payload') === true`), 10000, 'direct review')
						const stored = await signing.evaluate(`(async () => (await browser.runtime.sendMessage({method:'signing_get', id: new URLSearchParams(location.search).get('id')})).record)()`)
						const record = DirectSigningRecord.parse(stored)
						const digest = prepareDirectPayload(record.input).digest
						const signature = secp256k1.sign(bytesFromHex(digest), bytesFromHex('0x0000000000000000000000000000000000000000000000000000000000000001'))
						const bytes = Uint8Array.from([...signature.toCompactRawBytes(), signature.recovery + 27])
						const clickText = async (text: string) => await signing.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${ JSON.stringify(text) }); if (!b || b.disabled) throw new Error('Missing signing action'); b.click(); })()`)
						if (directWallet === 'ledger') await installFlowLedger(signing, record, bytes, undefined)
						await clickText(`Approve and continue with ${ directWallet === 'ledger' ? 'Ledger' : 'AirGap Vault' }`)
						if (directWallet === 'airgap') {
							await waitForCondition(async () => await signing.evaluate(`document.body.textContent.includes('Scan signed response')`), 10000, 'outgoing QR')
							await clickText('Scan signed response'); await installFlowCamera(signing, record.revision, bytes); await clickText('Enable camera')
						}
						await waitForCondition(async () => await signing.evaluate(`document.body.textContent.includes('Returned to application')`), 15000, 'verified direct message')
						if (process.env.SIGNING_FLOW_SCREENSHOTS !== undefined) await captureExtensionScreenshot(signing, `${ process.env.SIGNING_FLOW_SCREENSHOTS }/${ directWallet }-${ method }-application-complete.png`, 'page')
						await clickText('Return to application')
						await waitForCondition(async () => await signing.evaluate(`browser.tabs.query({ active: true }).then(tabs => tabs.some(tab => tab.id === ${ record.request.requestSocket.tabId }))`), 10000, 'return to originating application')
					} finally { signing.close(); await closeTarget(chrome.browserConnection, directTarget.id) }
				}
				await waitForCondition(async () => await pageConnection.evaluate(`globalThis.__signingResult.status !== 'pending'`), 10000, `${ method } result`).catch(async (error) => {
					const diagnostic = await connectTarget(chrome.browserDebugPort, target.id)
					try { throw new Error(`Message stalled: ${ await diagnostic.evaluate('document.body.textContent') }; provider requests: ${ await pageConnection.evaluate('JSON.stringify(globalThis.__fakeSignerRequests)') }`, { cause: error }) }
					finally { diagnostic.close() }
				})
				const result = await pageConnection.evaluate('globalThis.__signingResult.result')
				if (result !== (method === 'personal_sign' ? personalSignature : typedSignature)) throw new Error(`${ method } returned another signature`)
				await waitForTargetGone(chrome.browserDebugPort, (target) => target.id === confirmTargetId, 10000, 'completed message confirmation')
				confirmTargetId = undefined
				console.info(`${ directWallet ?? 'Browser' } ${ method }: reviewed, forwarded and returned to application`)
			}
			if (!messagesOnly) {
				await pageConnection.evaluate(`(() => {
					globalThis.__signingResult = { status: 'pending' }
					globalThis.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: ${ JSON.stringify(FAKE_SIGNER_ADDRESS) }, to: ${ JSON.stringify(FAKE_SIGNER_ADDRESS) }, value: '0x0', data: '0x' }] })
						.then((result) => { globalThis.__signingResult = { status: 'fulfilled', result } })
						.catch((error) => { globalThis.__signingResult = { status: 'rejected', error: error instanceof Error ? error.message : String(error), code: typeof error?.code === 'number' ? error.code : undefined } })
				})()`)
				const confirmationToClose = await waitForTargetByUrl(chrome.browserDebugPort, `chrome-extension://${ extensionId }/html3/confirmTransactionV3.html`, 30_000)
				confirmTargetId = confirmationToClose.id
				await closeTarget(chrome.browserConnection, confirmationToClose.id)
				confirmTargetId = undefined
				await waitForCondition(async () => await pageConnection.evaluate(`globalThis.__signingResult?.status === 'rejected'`).catch(() => false), 10_000, 'closed-popup transaction rejection')
				const rejectedSigningResult = await pageConnection.evaluate<{ status?: string, code?: number }>('globalThis.__signingResult')
				if (rejectedSigningResult.code !== 4001) throw new Error(`Unexpected closed-popup rejection code: ${ rejectedSigningResult.code ?? 'missing' }`)
			}
			console.warn('Interceptor Chrome signing communication test passed.')
		} finally {
			pageConnection.close()
		}
	} finally {
		if (confirmTargetId !== undefined) await closeTarget(chrome.browserConnection, confirmTargetId).catch(() => undefined)
		if (accessTargetId !== undefined) await closeTarget(chrome.browserConnection, accessTargetId).catch(() => undefined)
		if (pageTargetId !== undefined) await closeTarget(chrome.browserConnection, pageTargetId).catch(() => undefined)
		await chrome.close().catch(() => undefined)
		await server.close().catch(() => undefined)
	}
}

await main()
