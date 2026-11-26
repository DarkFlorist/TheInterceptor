import { EIP712Message } from '../../app/ts/types/eip721.js'
import { createGnosisSafeTx, gnosisSafeTxToTypedDataJson, GNOSIS_SAFE_ABI } from '../../app/ts/gnosisSafe/gnosisSafeCore.js'
import { privateKeyToAccount } from '../../app/ts/utils/ethereumPrimitives.js'
import { getGnosisSafeTxHash } from '../../app/ts/utils/eip712.js'
import { encodeFunctionCall, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { addressString, bytes32String } from '../../app/ts/utils/bigint.js'
import { NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING } from '../../app/ts/utils/nativeGnosisSafeAppsHostTiming.js'
import { mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import { getGnosisSafeUiScreenshotSettings } from './gnosisSafeUiScreenshotSettings.js'
import { approveBrowserConfirmation } from './confirmationDriver.js'
import * as assert from 'node:assert/strict'
import { launchBrowserSession, selectedBrowser, waitForBrowserCondition, waitForExtensionPage } from './browserHarness.js'
import type { BrowserPage, BrowserSession } from './browserHarness.js'
import { createBrowserSimulationRpc } from '../fixtures/browserSimulationRpc.js'
import { createSigningWalletScript } from '../fixtures/signingWallet.js'
import { createNativeGnosisSafeAppsFixtureClient } from '../fixtures/nativeGnosisSafeAppsClient.js'
import { getHtmlFile } from '../../app/ts/utils/htmlPages.js'

const safeAddress = '0x1234567890123456789012345678901234567890'
const owner = privateKeyToAccount('0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd')
const ownerAddress = owner.address.toLowerCase()
const signingTransaction = createGnosisSafeTx(1n, BigInt(safeAddress), { to: BigInt(ownerAddress), value: 0n, input: new Uint8Array() }, 7n)
const signingHash = getGnosisSafeTxHash(signingTransaction)
const typedDataSignature = await owner.signTypedData(EIP712Message.parse(gnosisSafeTxToTypedDataJson(signingTransaction)))
const rpc = createBrowserSimulationRpc({ safeAddress: BigInt(safeAddress), singletonAddress: 0x41675c099f32341bf84bfc5382af534df5c7461an, ownerAddress: BigInt(ownerAddress), extraCallResults: [[encodeFunctionCall(GNOSIS_SAFE_ABI, 'getTransactionHash', [ownerAddress, 0n, '0x', 0n, 0n, 0n, 0n, addressString(0n), addressString(0n), 7n]), encodeFunctionReturn(GNOSIS_SAFE_ABI, 'getTransactionHash', [bytes32String(BigInt(signingHash))])]] })
const fixtureScript = `(() => {
	if (parent === self) return;
	const originalParent = parent;
	const originalSetTimeout = setTimeout;
	const originalClearTimeout = clearTimeout;
	const expectedParentOrigin = new URLSearchParams(location.search).get('parentOrigin');
	const {request,replies,deliveries,timings} = (${ createNativeGnosisSafeAppsFixtureClient.toString() })(expectedParentOrigin);
	const results = {};
	const report = () => parent.postMessage({type:'native-host-fixture',results,replies,deliveries,timings,native:{parentIsSelf:parent===self,selfIsTop:self===top,parentUnchanged:parent===originalParent,timersUnchanged:setTimeout===originalSetTimeout&&clearTimeout===originalClearTimeout,referrer:document.referrer,walletPreload:globalThis.__fakeSignerPreloadStarted===true}},'*');
	addEventListener('message',event=>{if(event.source===parent&&event.origin===expectedParentOrigin&&typeof event.data?.success==='boolean')queueMicrotask(report)});
	if(location.pathname==='/strict-parent') {
		const nativeParentOrigin=location.ancestorOrigins?.[0]||(document.referrer?new URL(document.referrer).origin:undefined);
		results.strictParentAccepted=nativeParentOrigin==='https://app.safe.global';report();return;
	}
	addEventListener('message',event=>{
		if(event.source!==parent||event.origin!==expectedParentOrigin||event.data?.type!=='native-host-fixture-command')return;
		const {name,method,params}=event.data;
		if(method==='__navigate') {location.href=params.url;return;}
		if(method==='__readSignerRequests') {results[name]={wallet:globalThis.__fakeSignerRequests??[],aggregate:globalThis.__aggregateSignerRequests??[],preloaded:globalThis.__fakeSignerPreloadStarted===true};report();return;}
		if(method==='__setDraft'||method==='__readDraft') {
			const draft=document.querySelector('#draft-note');
			if(!(draft instanceof HTMLInputElement)){results[name]={error:'Draft input missing'};report();return;}
			if(method==='__setDraft')draft.value=params.value;
			results[name]={value:draft.value};report();return;
		}
		void request(method,params).then(reply=>{results[name]=reply;report()},error=>{results[name]={error:String(error)};report()});
	});
	void Promise.all([request('getSafeInfo',undefined,1000),request('getChainInfo'),request('getEnvironmentInfo')]).then(([info,chain,environment])=>{results.info=info;results.chain=chain;results.environment=environment;const status=document.querySelector('#connection-status');if(status)status.textContent=info.success?'Connected Gnosis Safe: '+info.data.safeAddress+' · chain '+info.data.chainId:'Connection failed: '+String(info.error);report()},error=>{results.error=String(error);report()});
})()`
const html = `<!doctype html><meta charset="utf-8"><title>Native Gnosis Safe App fixture</title><body><h2>Native Gnosis Safe App fixture</h2><p id="connection-status">Connecting…</p><p><label>Unfinished app draft<br><input id="draft-note" size="64" autocomplete="off"></label></p><script>${ fixtureScript }</script></body>`
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
	const url = new URL(request.url)
	if (request.method === 'OPTIONS') return new Response(undefined, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST' } })
	if (request.method === 'POST') {
		const value: unknown = await request.json()
		if (typeof value !== 'object' || value === null || !('method' in value) || typeof value.method !== 'string' || !('id' in value) || typeof value.id !== 'number') throw new Error('Invalid native host test RPC request')
		return Response.json({ jsonrpc: '2.0', id: value.id, result: await rpc.handleRpcRequest({ id: value.id, method: value.method, params: 'params' in value && Array.isArray(value.params) ? value.params : undefined }) }, { headers: { 'Access-Control-Allow-Origin': '*' } })
	}
	return new Response(html, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', ...(url.pathname === '/denied-frame' ? { 'Content-Security-Policy': 'frame-ancestors \'none\'', 'X-Frame-Options': 'DENY' } : {}) } })
} })

const network = { name: 'Native host local RPC', chainId: '0x1', httpsRpc: `${ server.url.origin }/rpc`, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true }
const extensionDirectory = process.argv.find((arg) => arg.startsWith('--extension-source='))?.slice('--extension-source='.length)
let stage = 'launching browser'

async function observeHostFixture(host: BrowserPage) {
	await host.evaluate(`(() => {
		globalThis.nativeHostFixture=[];
		addEventListener('message',event=>{const child=document.querySelector('iframe');if(event.source===child?.contentWindow&&event.origin===${ JSON.stringify(server.url.origin) }&&event.data?.type==='native-host-fixture')globalThis.nativeHostFixture.push(event.data)});
	})()`)
}

async function replaceWebsiteWithHost(session: BrowserSession, settings: BrowserPage, source: BrowserPage, appUrl: string) {
	const sourceTabId = await settings.evaluate<number>(`browser.tabs.query({}).then(tabs=>tabs.find(tab=>typeof tab.url==='string'&&tab.url.startsWith(${ JSON.stringify(`${ server.url.origin }/`) })&&new URL(tab.url).pathname===${ JSON.stringify(new URL(appUrl).pathname) })?.id)`)
	assert.equal(typeof sourceTabId, 'number', 'Find the website tab to replace')
	const tabCount = await settings.evaluate<number>('browser.tabs.query({}).then(tabs=>tabs.length)')
	stage = 'replacing website tab with the extension host'
	const hostPath = getHtmlFile('gnosisSafeAppsHost', await settings.evaluate<number>('browser.runtime.getManifest().manifest_version'))
	const launch = await settings.evaluate(`browser.runtime.sendMessage({method:'popup_openGnosisSafeApp',data:{sourceTabId:${ sourceTabId }}})`)
	assert.deepEqual(launch, { type: 'OpenGnosisSafeAppReply', ok: true })
	const host = await waitForExtensionPage(session, `${ hostPath }?${ new URLSearchParams({ hostTabId: String(sourceTabId), appUrl }) }`)
	assert.equal(host.id, source.id, 'Open as Gnosis Safe App replaces the existing browser tab')
	assert.equal(await settings.evaluate('browser.tabs.query({}).then(tabs=>tabs.length)'), tabCount, 'Launching does not open an extra tab')
	assert.equal(await host.evaluate('browser.tabs.getCurrent().then(tab=>tab.id)'), sourceTabId, 'The host retains the original browser tab ID')
	await observeHostFixture(host)
	await waitForBrowserCondition(async () => await host.evaluate('document.querySelector("iframe")?.hidden === false'), 'native iframe loads without the original website provider')
	if (new URL(appUrl).pathname === '/') await waitForBrowserCondition(async () => await host.evaluate('document.querySelector("iframe")?.dataset.hostLoaded==="true"'), 'native app document load')
	assert.deepEqual(await host.evaluate(`(() => {
		const frame = document.querySelector('iframe');
		if (!(frame instanceof HTMLIFrameElement)) throw new Error('Missing app frame');
		const rect = frame.getBoundingClientRect();
		const style = getComputedStyle(frame);
		return {fillsViewport:rect.left===0&&rect.top===0&&rect.width===innerWidth&&rect.height===innerHeight,border:style.borderWidth,padding:style.padding,largeHeader:document.querySelector('h1')!==null};
	})()`), { fillsViewport: true, border: '0px', padding: '0px', largeHeader: false }, 'The embedded app fills the viewport without a host header or frame decoration')
	return host
}

async function command(host: BrowserPage, name: string, method: string, params?: unknown) {
	await host.evaluate(`document.querySelector('iframe').contentWindow.postMessage({type:'native-host-fixture-command',name:${ JSON.stringify(name) },method:${ JSON.stringify(method) },params:${ JSON.stringify(params) ?? 'undefined' }},${ JSON.stringify(server.url.origin) })`)
}

async function captureHost(session: BrowserSession, host: BrowserPage, name: string) {
	const { outputDirectory } = getGnosisSafeUiScreenshotSettings()
	await mkdir(outputDirectory, { recursive: true })
	await session.setViewport(1280, 900)
	await Bun.write(path.join(outputDirectory, `${ session.browser }-native-host-${ name }.png`), Buffer.from(await host.captureScreenshot(), 'base64'))
}

async function verifyMetadataRefreshPreservesApp(host: BrowserPage) {
	const draft = 'Keep this unfinished app draft across metadata refresh.'
	await command(host, 'draftBeforeRefresh', '__setDraft', { value: draft })
	await waitForBrowserCondition(async () => await host.evaluate(`nativeHostFixture.at(-1)?.results.draftBeforeRefresh?.value===${ JSON.stringify(draft) }`), 'native app draft before metadata refresh')
	await host.evaluate(`(() => {
		const frame = document.querySelector('iframe');
		if (!(frame instanceof HTMLIFrameElement)) throw new Error('Missing native app iframe');
		globalThis.nativeRefreshRegression = {frame,generation:frame.dataset.hostGeneration,window:frame.contentWindow,started:performance.now()};
	})()`)
	await waitForBrowserCondition(async () => await host.evaluate(`performance.now()-globalThis.nativeRefreshRegression.started>${ NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING.metadataRefreshIntervalMs + 500 }`), 'periodic metadata refresh interval')
	assert.equal(await host.evaluate(`(() => {
		const frame = document.querySelector('iframe');
		const before = globalThis.nativeRefreshRegression;
		return frame === before.frame && frame.hidden === false && frame.dataset.hostGeneration === before.generation && frame.contentWindow === before.window;
	})()`), true, 'Periodic metadata refresh retains the exact app frame and window')
	await command(host, 'draftAfterRefresh', '__readDraft')
	await waitForBrowserCondition(async () => await host.evaluate('nativeHostFixture.at(-1)?.results.draftAfterRefresh!==undefined'), 'native app draft after metadata refresh')
	assert.equal(await host.evaluate('nativeHostFixture.at(-1)?.results.draftAfterRefresh?.value'), draft, 'Periodic background metadata refresh preserves unfinished app input')
	await host.evaluate('delete globalThis.nativeRefreshRegression')
}

try {
	const session = await launchBrowserSession(selectedBrowser(), extensionDirectory)
	try {
		await session.addPreloadScript(createSigningWalletScript(ownerAddress, `0x${ '11'.repeat(32) }`, typedDataSignature))
		stage = 'opening settings controller'
		const settings = await session.openExtensionPage('html/settingsView.html')
		try {
			const extensionOrigin = await settings.evaluate<string>('browser.runtime.getURL("").replace(/\\/$/, "")')
			const appUrl = `${ server.url.origin }/?${ new URLSearchParams({ parentOrigin: extensionOrigin }) }`
			const grants = [{ website: { websiteOrigin: server.url.host }, access: true, addressAccess: [{ address: safeAddress, access: true }] }]
			await settings.evaluate(`(async () => {
				await browser.storage.local.set({safeAppsCompatibilityMode:true,simulationMode:true,useSignersAddressAsActiveAddress:false,independentActiveSimulationAddress:'${ safeAddress }',activeSigningSafeAddress:'${ safeAddress }',activeSigningAddress:'${ ownerAddress }',signingAddressPreferences:[{signerAddress:'${ ownerAddress }',selection:'safe',safeAddress:'${ safeAddress }',chainId:'0x1'}],userAddressBookEntriesV3:[{type:'safe',name:'Native host Gnosis Safe',address:'${ safeAddress }',chainId:'0x1',entrySource:'User',useAsActiveAddress:true,askForAddressAccess:false,safeSignerAddresses:['${ ownerAddress }'],safeSimulationSignerAddress:'${ ownerAddress }',safeVersion:'1.4.1'}],websiteAccess:${ JSON.stringify(grants) }});
				await browser.runtime.sendMessage({method:'popup_changeActiveRpc',data:${ JSON.stringify(network) }});
			})()`)
			for (const simulationMode of process.argv.includes('--signing-only') ? [false] : [true, false]) {
				stage = `opening website in ${ simulationMode ? 'simulation' : 'signing' } mode`
				await settings.evaluate(`browser.storage.local.set({simulationMode:${ simulationMode },websiteAccess:${ JSON.stringify(grants) }})`)
				const source = await session.openPage(appUrl)
				try {
					const host = await replaceWebsiteWithHost(session, settings, source, appUrl)
					try {
						await command(host, 'probe', 'getSafeInfo')
						await command(host, 'chainProbe', 'getChainInfo')
						await command(host, 'environmentProbe', 'getEnvironmentInfo')
						await waitForBrowserCondition(async () => {
							const replies = await host.evaluate<Readonly<Record<string, { readonly success?: boolean, readonly error?: unknown }>>>('nativeHostFixture.at(-1)?.results')
							const discoveryNames = ['probe', 'chainProbe', 'environmentProbe']
							for (const name of discoveryNames) {
								const reply = replies?.[name]
								if (reply?.success === false || reply?.error !== undefined) throw new Error(`SDK discovery ${ name } failed: ${ JSON.stringify(reply) }; host: ${ await host.evaluate(`document.querySelector('[role=status]')?.textContent`) }`)
							}
							return discoveryNames.every((name) => replies?.[name]?.success === true)
						}, 'all native SDK discovery requests')
						const observed = await host.evaluate<{ results: { probe: { data: { safeAddress: string } }, chainProbe: { data: { chainId: string } }, environmentProbe: { data: { origin: string } } }, native: { parentIsSelf: boolean, selfIsTop: boolean, parentUnchanged: boolean, timersUnchanged: boolean, referrer: string }, replies: { origin: string, sourceIsParent: boolean }[] }>('nativeHostFixture.at(-1)')
						assert.ok(observed.results.probe?.data, `Safe metadata failed: ${ JSON.stringify(observed) }`)
						assert.equal(observed.results.probe.data.safeAddress.toLowerCase(), safeAddress)
						assert.equal(observed.results.chainProbe.data.chainId, '1')
						assert.equal(observed.results.environmentProbe.data.origin, server.url.host)
						assert.equal(observed.native.parentIsSelf, false)
						assert.equal(observed.native.selfIsTop, false)
						assert.equal(observed.native.parentUnchanged, true)
						assert.equal(observed.native.timersUnchanged, true)
						assert.ok(observed.native.referrer === '' || observed.native.referrer.startsWith(extensionOrigin), 'Native referrer is empty or the real extension host, never a synthetic website')
						assert.ok(observed.replies.every((reply) => reply.origin === extensionOrigin && reply.sourceIsParent))
						await host.evaluate(`window.dispatchEvent(new MessageEvent('message',{source:document.querySelector('iframe').contentWindow,origin:'https://different.example',data:{id:'wrong-origin',method:'getSafeInfo',env:{sdkVersion:'9.1.0'}}}))`)
						await command(host, 'afterWrongOrigin', 'getSafeInfo')
						await waitForBrowserCondition(async () => await host.evaluate('nativeHostFixture.at(-1)?.results.afterWrongOrigin?.success===true'), 'valid SDK request after wrong-origin message')
						assert.equal(await host.evaluate('nativeHostFixture.at(-1)?.deliveries.some(delivery=>delivery.reply?.id==="wrong-origin")'), false, 'Only the actual app origin receives SDK responses')
						if (simulationMode) {
							stage = 'preserving the native app through periodic background metadata refresh'
							await verifyMetadataRefreshPreservesApp(host)
						}
						await captureHost(session, host, simulationMode ? 'simulation' : 'signing')
						if (simulationMode && !process.argv.includes('--skip-transactions')) {
							stage = 'approving two simulation transactions'
							for (let index = 0; index < 2; index++) {
								stage = `approving simulation transaction ${ index }`
								await command(host, `transaction${ index }`, 'sendTransactions', { txs: [{ to: ownerAddress, value: '0', data: '0x' }] })
								await waitForBrowserCondition(async () => {
									const reply = await host.evaluate<{ success?: boolean, error?: unknown } | undefined>(`nativeHostFixture.at(-1)?.results.transaction${ index }`)
									if (reply !== undefined && reply.success !== true) throw new Error(`Native host transaction ${ index } rejected before confirmation after context changes ${ await host.evaluate('document.querySelector("[role=status]")?.dataset.lastContextChange') }: ${ JSON.stringify(reply) }`)
									return (await session.pages()).some((page) => page.url.includes('confirmTransaction'))
								}, 'native app transaction confirmation or explicit rejection')
								const confirmation = await waitForExtensionPage(session, 'confirmTransaction')
								assert.equal(await host.evaluate(`(() => {const retry=[...document.querySelectorAll('button')].find(button=>button.textContent==='Retry connection');globalThis.pendingRetryGuard=true;if(!retry?.disabled)return false;retry.dispatchEvent(new MouseEvent('click',{bubbles:true}));return true})()`), true, 'Retry is disabled while a transaction awaits approval')
								assert.equal(await host.evaluate('globalThis.pendingRetryGuard'), true, 'Programmatic Retry cannot reload away a pending mutation')
								assert.equal(await host.evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent==='Open website directly')?.disabled`), true, 'Direct navigation is also disabled while an approval is pending')
								// Launching again in the same tab must retain an admitted operation and unfinished app input.
								await host.evaluate('(() => { const frame=document.querySelector("iframe"); globalThis.pendingLaunchGuard={frame,window:frame.contentWindow}; })()')
								const sourceTabId = await host.evaluate<number>('Number(new URLSearchParams(location.search).get("hostTabId"))')
								assert.deepEqual(await settings.evaluate(`browser.runtime.sendMessage({method:'popup_openGnosisSafeApp',data:{sourceTabId:${ sourceTabId }}})`), { type: 'OpenGnosisSafeAppReply', ok: true })
								assert.equal(await host.evaluate('(() => { const frame=document.querySelector("iframe"); return frame===globalThis.pendingLaunchGuard?.frame&&frame.contentWindow===globalThis.pendingLaunchGuard.window&&globalThis.pendingRetryGuard===true; })()'), true, 'Relaunch preserves the original pending app frame and window')
								if (index === 0) await confirmation.evaluate(`(() => {
									const send = browser.runtime.sendMessage.bind(browser.runtime);
									let armed = true;
									browser.runtime.sendMessage = async (message, ...args) => {
										if (armed && message?.method === 'popup_confirmDialog' && message.data?.action === 'accept') {
											armed = false;
											// Wait for publication before forwarding the stale accept: every simulation gets a new confirmationRunId, including cached results within the same second.
											let removeReviewListener;
											const changedReview = new Promise((resolve, reject) => {
												const timeout = setTimeout(() => { removeReviewListener(); reject(new Error('The forced confirmation refresh did not publish a changed review')); }, 45000);
												const listener = update => {
													if (update?.method !== 'popup_update_confirm_transaction_dialog_pending_transactions') return;
													const pending = update.data.pendingTransactionAndSignableMessages.find(pending => {
														const expected = message.data.uniqueRequestIdentifier;
														const actual = pending.uniqueRequestIdentifier;
														return actual.requestId === expected.requestId && actual.requestSocket.tabId === expected.requestSocket.tabId && actual.requestSocket.connectionName === expected.requestSocket.connectionName;
													});
													if (typeof pending?.reviewedResultId !== 'string' || pending.reviewedResultId === message.data.reviewedResultId) return;
													removeReviewListener();
													resolve();
												};
												removeReviewListener = () => { clearTimeout(timeout); browser.runtime.onMessage.removeListener(listener); };
												browser.runtime.onMessage.addListener(listener);
											});
											try { await Promise.all([send({method:'popup_refreshConfirmTransactionDialogSimulation'}), changedReview]); }
											finally { removeReviewListener(); }
										}
										return await send(message, ...args);
									};
								})()`)
								const reapprovals = await approveBrowserConfirmation(session, confirmation, 'nav.popup-button-row button.dialog-action-button.is-primary:not(.is-danger)')
								if (index === 0) assert.ok(reapprovals >= 1, 'The real stale-review rejection must require a fresh UI approval')
								await waitForBrowserCondition(async () => {
									const reply = await host.evaluate<{ success?: boolean, error?: unknown } | undefined>(`nativeHostFixture.at(-1)?.results.transaction${ index }`)
									if (reply !== undefined && reply.success !== true) throw new Error(`Native host transaction ${ index } returned a terminal failure after approval: ${ JSON.stringify(reply) }`)
									return reply?.success === true
								}, 'native host simulation transaction')
							}
							const stack = await settings.evaluate<{ ok: boolean, ethSimulateV1InputString?: string }>('browser.runtime.sendMessage({method:"popup_requestInterceptorSimulationInput"})')
							assert.equal(stack.ok, true)
							assert.equal(typeof stack.ethSimulateV1InputString, 'string')
							const exported: unknown = JSON.parse(stack.ethSimulateV1InputString ?? '')
							if (typeof exported !== 'object' || exported === null || !('interceptorSimulateStack' in exported) || typeof exported.interceptorSimulateStack !== 'object' || exported.interceptorSimulateStack === null || !('operations' in exported.interceptorSimulateStack) || !Array.isArray(exported.interceptorSimulateStack.operations)) throw new Error('The native-host transaction stack export was malformed')
							const transactions: unknown[] = exported.interceptorSimulateStack.operations.filter((operation: unknown) => typeof operation === 'object' && operation !== null && 'type' in operation && operation.type === 'Transaction')
							assert.equal(transactions.length, 2, 'Two separately approved app requests create a two-transaction simulation stack')
							for (const transaction of transactions) {
								if (typeof transaction !== 'object' || transaction === null || !('preSimulationTransaction' in transaction) || typeof transaction.preSimulationTransaction !== 'object' || transaction.preSimulationTransaction === null || !('website' in transaction.preSimulationTransaction) || typeof transaction.preSimulationTransaction.website !== 'object' || transaction.preSimulationTransaction.website === null || !('websiteOrigin' in transaction.preSimulationTransaction.website)) throw new Error('A simulated native-host request lost its website identity')
								assert.equal(transaction.preSimulationTransaction.website.websiteOrigin, server.url.host, 'Transaction approvals and stack attribution use the app origin, not the extension host')
							}
							await command(host, 'simulationSignerRequests', '__readSignerRequests')
							await waitForBrowserCondition(async () => await host.evaluate('nativeHostFixture.at(-1)?.results.simulationSignerRequests!==undefined'), 'hosted signer request diagnostics')
							const signerRequests = await host.evaluate<{ wallet: string[], aggregate: string[] }>('nativeHostFixture.at(-1)?.results.simulationSignerRequests')
							assert.equal(signerRequests?.wallet.includes('eth_sendTransaction') || signerRequests?.aggregate.includes('eth_sendTransaction'), false, 'Simulation never broadcasts through the hosted owner wallet')
							console.warn(`${ session.browser } native host two-transaction simulation stack passed`)
						}
						if (!simulationMode && !process.argv.includes('--skip-transactions')) {
							stage = 'approving an app transaction through the hosted wallet bridge'
							await command(host, 'signingTransaction', 'sendTransactions', { txs: [{ to: ownerAddress, value: '0', data: '0x' }] })
							await waitForBrowserCondition(async () => {
								const reply = await host.evaluate<{ success?: boolean, error?: unknown } | undefined>('nativeHostFixture.at(-1)?.results.signingTransaction')
								if (reply !== undefined && reply.success !== true) throw new Error(`Hosted signing request failed before confirmation: ${ JSON.stringify(reply) }`)
								return (await session.pages()).some((page) => page.url.includes('confirmTransaction'))
							}, 'hosted signing approval')
							const confirmation = await waitForExtensionPage(session, 'confirmTransaction')
							await approveBrowserConfirmation(session, confirmation, 'nav.popup-button-row button.dialog-action-button.is-primary:not(.is-danger)')
							await waitForBrowserCondition(async () => {
								const reply = await host.evaluate<{ success?: boolean, error?: unknown } | undefined>('nativeHostFixture.at(-1)?.results.signingTransaction')
								if (reply !== undefined && reply.success !== true) throw new Error(`Hosted wallet signing returned a failure: ${ JSON.stringify(reply) }`)
								return reply?.success === true
							}, 'hosted wallet signing result')
							await command(host, 'signingWalletRequests', '__readSignerRequests')
							await waitForBrowserCondition(async () => await host.evaluate('nativeHostFixture.at(-1)?.results.signingWalletRequests!==undefined'), 'hosted wallet signing diagnostics')
							assert.equal(await host.evaluate('nativeHostFixture.at(-1)?.results.signingWalletRequests.wallet.includes("eth_signTypedData_v4")'), true, 'Approved signing reaches the authenticated hosted wallet bridge')
							console.warn(`${ session.browser } native host wallet signing passed`)
						}
						if (simulationMode) {
							stage = 'rejecting an app iframe that navigates to another origin'
							const otherOrigin = new URL(appUrl)
							otherOrigin.hostname = 'localhost'
							await host.evaluate(`(() => {
								globalThis.otherOriginFixture=[];
								addEventListener('message',event=>{if(event.source===document.querySelector('iframe')?.contentWindow&&event.origin===${ JSON.stringify(otherOrigin.origin) }&&event.data?.type==='native-host-fixture')globalThis.otherOriginFixture.push(event.data)});
							})()`)
							await command(host, 'navigateOtherOrigin', '__navigate', { url: otherOrigin.href })
							await waitForBrowserCondition(async () => await host.evaluate('otherOriginFixture.at(-1)?.results.error!==undefined'), 'wrong-origin iframe discovery expires without an SDK response')
							assert.equal(await host.evaluate('otherOriginFixture.at(-1)?.deliveries.length'), 0, 'A navigated child cannot borrow the launched app origin permissions')
						}
						stage = 'restoring the background session after host reload'
						const hostTabId = await host.evaluate<number>('browser.tabs.getCurrent().then(tab=>tab.id)')
						await host.reload()
						await observeHostFixture(host)
						await waitForBrowserCondition(async () => await host.evaluate('document.querySelector("[role=status]")?.textContent?.includes("handshake received")'), 'native session reconnects after reload without a source tab')
						await command(host, 'afterReload', 'getSafeInfo')
						await waitForBrowserCondition(async () => await host.evaluate('nativeHostFixture.at(-1)?.results.afterReload?.success===true'), 'native SDK request after host reload')
						assert.equal(await host.evaluate('browser.tabs.getCurrent().then(tab=>tab.id)'), hostTabId, 'Reload retains the host session tab')
						stage = 'revoking app permissions'
						await host.evaluate('globalThis.revocationFrame=document.querySelector("iframe")')
						await settings.evaluate('browser.storage.local.set({websiteAccess:[]})')
						await waitForBrowserCondition(async () => await host.evaluate('document.querySelector("[role=status]")?.dataset.lastContextChange?.includes("websiteAccess")'), 'background publishes app permission revocation')
						await command(host, 'revokedInfo', 'getSafeInfo')
						await waitForBrowserCondition(async () => await host.evaluate('nativeHostFixture.at(-1)?.results.revokedInfo?.success===false'), 'revoked app metadata request is denied')
						assert.equal(await host.evaluate('document.querySelector("iframe")===globalThis.revocationFrame&&document.querySelector("iframe").hidden===false'), true, 'Permission revocation retains app input while denying new requests')
						if (simulationMode) await captureHost(session, host, 'access-revoked')
						console.warn(`${ session.browser } native extension-host SDK, origin and revocation passed: ${ simulationMode ? 'simulation' : 'signing' }`)
					} catch (error: unknown) {
						const diagnostics = await Promise.allSettled([
							settings.evaluate('browser.runtime.sendMessage({method:"popup_requestLatestUnexpectedError"})'),
							host.evaluate('({status:document.querySelector("[role=status]")?.textContent,lastContextChange:document.querySelector("[role=status]")?.dataset.lastContextChange,fixture:globalThis.nativeHostFixture,pendingRetryGuard:globalThis.pendingRetryGuard,frameUrl:document.querySelector("iframe")?.src,frameHidden:document.querySelector("iframe")?.hidden})'),
							session.pages().then(async (pages) => await Promise.all(pages.filter((page) => /confirmTransaction|interceptorAccess/.test(page.url)).map(async (page) => ({ url: page.url, body: await page.evaluate('document.body.innerText') })))),
						])
						await Bun.write(`/tmp/native-host-failure-${ session.browser }.json`, JSON.stringify({ stage, error: String(error), diagnostics: diagnostics.map((result) => result.status === 'fulfilled' ? result.value : { diagnosticError: String(result.reason) }) }, undefined, 2))
						throw error
					}
				} finally { await source.close() }
				await settings.evaluate(`browser.storage.local.set({websiteAccess:${ JSON.stringify(grants) }})`)
				for (const path of ['/strict-parent', '/denied-frame']) {
					const unsupportedUrl = `${ server.url.origin }${ path }?${ new URLSearchParams({ parentOrigin: extensionOrigin }) }`
					const source = await session.openPage(unsupportedUrl)
					try {
						const host = await replaceWebsiteWithHost(session, settings, source, unsupportedUrl)
						await waitForBrowserCondition(async () => await host.evaluate('document.querySelector("[role=status]")?.textContent?.startsWith("No Gnosis Safe App handshake received")'), 'honest native-policy unsupported state', 2 * NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING.handshakeTimeoutMs)
						assert.equal(await host.evaluate('parent===self&&top===self&&window.__interceptorSafeAppsHostEmulatedParent!==true'), true)
						assert.equal(await host.evaluate('/retry|open.*website/i.test(document.querySelector("[role=status]")?.textContent??"")'), true, 'Unsupported app errors explain an action the user can take')
						if (simulationMode) await captureHost(session, host, path === '/strict-parent' ? 'unsupported-origin' : 'blocked-frame')
						console.warn(`${ session.browser } native host preserves ${ path } restriction: ${ simulationMode ? 'simulation' : 'signing' }`)
					} finally { await source.close() }
				}
			}
		} finally { await settings.close() }
	} finally { await session.close() }
} catch (error: unknown) {
	throw new Error(`Native Gnosis Safe Apps browser check failed while ${ stage }`, { cause: error })
} finally { await server.stop(true) }
