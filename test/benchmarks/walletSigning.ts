import { approveBrowserConfirmation } from './confirmationDriver.js'
import * as assert from 'node:assert/strict'
import { launchBrowserSession, selectedBrowser, waitForBrowserCondition, waitForExtensionPage, approveBrowserRequest } from './browserHarness.js'
import type { BrowserPage } from './browserHarness.js'
import { createSigningWalletScript } from '../fixtures/signingWallet.js'
import { createBrowserSimulationRpc } from '../fixtures/browserSimulationRpc.js'

const address = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'
const transactionHash = '0x1111111111111111111111111111111111111111111111111111111111111111'
const rpc = createBrowserSimulationRpc({ safeAddress: 2n, singletonAddress: 3n, ownerAddress: BigInt(address) })
const html = `<!doctype html><html><body>Shared wallet signing fixture<script>
globalThis.testState={phase:'waiting'};
(async()=>{while(window.ethereum?.isInterceptor!==true)await new Promise(resolve=>setTimeout(resolve,20));testState.phase='requesting-access';testState.accounts=await ethereum.request({method:'eth_requestAccounts'});testState.phase='access-granted'})().catch(error=>{testState.phase='error';testState.error=String(error)});
</script></body></html>`
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
	if (request.method !== 'POST') return new Response(html, { headers: { 'Content-Type': 'text/html' } })
	const value: unknown = await request.json()
	if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'number' || !('method' in value) || typeof value.method !== 'string') throw new Error('Invalid wallet fixture RPC request')
	return Response.json({ jsonrpc: '2.0', id: value.id, result: await rpc.handleRpcRequest({ id: value.id, method: value.method, params: 'params' in value && Array.isArray(value.params) ? value.params : undefined }) })
} })


async function requestTransaction(page: BrowserPage) {
	await page.evaluate(`(() => {
		globalThis.signingResult={status:'pending'};
		ethereum.request({method:'eth_sendTransaction',params:[{from:'${ address }',to:'${ address }',value:'0x0',data:'0x'}]}).then(result=>{globalThis.signingResult={status:'fulfilled',result}},error=>{globalThis.signingResult={status:'rejected',code:error.code,message:String(error)}});
	})()`)
}


type SigningDiagnostics = {
	readonly signingResult: { readonly status: 'pending' | 'fulfilled' | 'rejected', readonly result?: string, readonly code?: number, readonly message?: string }
	readonly selectedSignerRequests: readonly string[]
	readonly aggregateSignerRequests: readonly string[]
}

async function waitForSigningOutcome(page: BrowserPage, expected: 'fulfilled' | 'rejected') {
	let diagnostics: SigningDiagnostics | undefined
	try {
		await waitForBrowserCondition(async () => {
			diagnostics = await page.evaluate<SigningDiagnostics>('({signingResult:globalThis.signingResult,selectedSignerRequests:globalThis.__fakeSignerRequests,aggregateSignerRequests:globalThis.__aggregateSignerRequests})')
			return diagnostics.signingResult.status === 'fulfilled' || diagnostics.signingResult.status === 'rejected'
		}, 'wallet signing terminal outcome')
	} catch (error: unknown) {
		throw new Error(`Wallet signing did not settle. Last observed state: ${ JSON.stringify(diagnostics) }`, { cause: error })
	}
	assert.equal(diagnostics?.signingResult.status, expected, `Unexpected wallet signing outcome: ${ JSON.stringify(diagnostics) }`)
	return diagnostics
}

try {
	const session = await launchBrowserSession(selectedBrowser())
	try {
		await session.addPreloadScript(createSigningWalletScript(address, transactionHash))
		const settings = await session.openExtensionPage('html/popup.html')
		try {
			await settings.evaluate(`(async()=>{await browser.storage.local.set({simulationMode:false});await browser.runtime.sendMessage({method:'popup_changeActiveRpc',data:${ JSON.stringify({ name: 'Local wallet RPC', chainId: '0x1', httpsRpc: server.url.href + 'rpc', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true }) }})})()`)
		} finally { await settings.close() }
		const page = await session.openPage(server.url.href)
		await waitForBrowserCondition(async () => await page.evaluate(`testState.phase === 'requesting-access'`), 'wallet access request')
		const accessPopup = await waitForExtensionPage(session, 'interceptorAccess')
		const accessSelector = 'nav.popup-button-row button.is-primary:not(.is-danger)'
		await waitForBrowserCondition(async () => await accessPopup.evaluate(`document.querySelector(${ JSON.stringify(accessSelector) })?.disabled === false`), 'enabled wallet access button')
		// Reproduce the observed popup update at the driver boundary without machine-dependent message timing: the old two-call helper reads false, then its later click is ignored by the real disabled HTML button.
		assert.equal(await accessPopup.evaluate(`(() => {
			const button = document.querySelector(${ JSON.stringify(accessSelector) });
			const disabled = Object.getOwnPropertyDescriptor(HTMLButtonElement.prototype, 'disabled');
			if (!(button instanceof HTMLButtonElement) || !disabled?.get || !disabled.set) return false;
			let armed = true;
			Object.defineProperty(button, 'disabled', { configurable: true, get() {
				const value = disabled.get.call(button);
				if (!value && armed) {
					armed = false;
					queueMicrotask(() => {
						disabled.set.call(button, true);
						setTimeout(() => { delete button.disabled; disabled.set.call(button, false) }, 300);
					});
				}
				return value;
			}, set(value) { disabled.set.call(button, value) } });
			return true;
		})()`), true, 'Arm the actual popup disabled-click regression')
		await approveBrowserRequest(session, accessPopup, accessSelector)
		await waitForBrowserCondition(async () => await page.evaluate(`testState.phase === 'access-granted'`), 'wallet access approval')
		await requestTransaction(page)
		const confirmation = await waitForExtensionPage(session, 'confirmTransaction')
		await approveBrowserConfirmation(session, confirmation, 'nav.popup-button-row button.dialog-action-button.is-primary:not(.is-danger)')
		await waitForSigningOutcome(page, 'fulfilled')
		assert.equal(await page.evaluate('signingResult.result'), transactionHash)
		assert.equal(await page.evaluate(`__aggregateSignerRequests.includes('eth_sendTransaction')`), false, 'Signing must use the selected EIP-6963 wallet')
		await waitForBrowserCondition(async () => !(await session.pages()).some(({ id }) => id === confirmation.id), 'completed confirmation close')
		await requestTransaction(page)
		await (await waitForExtensionPage(session, 'confirmTransaction')).close()
		await waitForSigningOutcome(page, 'rejected')
		assert.equal(await page.evaluate('signingResult.code'), 4001)
		console.warn(`${ session.browser } wallet signing and closed-popup rejection passed`)
	} finally { await session.close() }
} finally { server.stop(true) }
