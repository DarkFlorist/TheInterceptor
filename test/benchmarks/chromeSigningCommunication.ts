import { closeTarget, connectTarget, createTargetPage, launchChromeSession, waitForAnyExtensionServiceWorker, waitForPerformanceMarks, waitForRegisteredContentScripts, waitForTargetByUrl, waitForTargetGone } from './chromeHarness.js'
import { startChromeCommunicationPageServer } from './chromeCommunicationPageServer.js'
import type { CdpConnection } from './chromeHarness.js'

const ACCESS_APPROVE_BUTTON_SELECTOR = 'nav.popup-button-row button.is-primary:not(.is-danger)'
const CONFIRM_APPROVE_BUTTON_SELECTOR = 'nav.popup-button-row button.dialog-button-right'
const FAKE_SIGNER_ADDRESS = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'
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
		return element instanceof HTMLButtonElement && element.disabled === false
	})()`).catch(() => false), timeoutMs, `button ${ selector } to be enabled`)
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
		const workerTarget = await waitForAnyExtensionServiceWorker(chrome.browserDebugPort, 30_000)
		const extensionId = extractExtensionId(workerTarget.url)
		const workerConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
		try {
			await waitForPerformanceMarks(workerConnection, ['interceptor:background:loaded'], 30_000)
			await waitForRegisteredContentScripts(workerConnection, ['inpage', 'inpage2'], 30_000)
			await workerConnection.evaluate('browser.storage.local.set({ simulationMode: false })')
		} finally {
			workerConnection.close()
		}

		pageTargetId = await createTargetPage(chrome.browserConnection, 'about:blank')
		const pageConnection = await connectTarget(chrome.browserDebugPort, pageTargetId)
		try {
			await pageConnection.send('Page.enable')
			await pageConnection.send('Page.addScriptToEvaluateOnNewDocument', { source: fakeSignerPreload })
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
