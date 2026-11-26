import { NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING } from '../../app/ts/utils/nativeGnosisSafeAppsHostTiming.js'
import { GNOSIS_SAFE_APPS_SOURCE_DISCOVERY_TIMEOUT_MS } from '../../app/shared/ts/gnosisSafeAppsProtocol.js'
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
const ownerAddress = '0x0000000000000000000000000000000000000001'
const httpInterception = process.argv.includes('--http-interception')
const rpc = createBrowserSimulationRpc({ safeAddress: BigInt(safeAddress), singletonAddress: 0x41675c099f32341bf84bfc5382af534df5c7461an, ownerAddress: BigInt(ownerAddress) })
const fixtureScript = `(() => {
	if (parent === self) return;
	const originalParent = parent;
	const originalSetTimeout = setTimeout;
	const originalClearTimeout = clearTimeout;
	const expectedParentOrigin = new URLSearchParams(location.search).get('parentOrigin');
	const {request,replies,deliveries,timings} = (${ createNativeGnosisSafeAppsFixtureClient.toString() })(expectedParentOrigin);
	const results = {};
	const report = () => parent.postMessage({type:'native-host-fixture',results,replies,deliveries,timings,native:{parentIsSelf:parent===self,selfIsTop:self===top,parentUnchanged:parent===originalParent,timersUnchanged:setTimeout===originalSetTimeout&&clearTimeout===originalClearTimeout,referrer:document.referrer}},'*');
	addEventListener('message',event=>{if(event.source===parent&&event.origin===expectedParentOrigin&&typeof event.data?.success==='boolean')queueMicrotask(report)});
	if(location.pathname==='/strict-parent') {
		const nativeParentOrigin=location.ancestorOrigins?.[0]||(document.referrer?new URL(document.referrer).origin:undefined);
		results.strictParentAccepted=nativeParentOrigin==='https://app.safe.global';report();return;
	}
	addEventListener('message',event=>{
		if(event.source!==parent||event.origin!==expectedParentOrigin||event.data?.type!=='native-host-fixture-command')return;
		const {name,method,params}=event.data;
		if(method==='__setDraft'||method==='__readDraft') {
			const draft=document.querySelector('#draft-note');
			if(!(draft instanceof HTMLInputElement)){results[name]={error:'Draft input missing'};report();return;}
			if(method==='__setDraft')draft.value=params.value;
			results[name]={value:draft.value};report();return;
		}
		if(method==='__nativeHttpBalance') {
			void fetch('/native-site-rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:42,method:'eth_getBalance',params:[${ JSON.stringify(safeAddress) },'latest']})}).then(async response=>{results[name]={overlay:response.headers.get('x-interceptor-simulation'),value:await response.json()};report()},error=>{results[name]={error:String(error)};report()});return;
		}
		void request(method,params).then(reply=>{results[name]=reply;report()},error=>{results[name]={error:String(error)};report()});
	});
	void Promise.all([request('getSafeInfo',undefined,1000),request('getChainInfo'),request('getEnvironmentInfo')]).then(([info,chain,environment])=>{results.info=info;results.chain=chain;results.environment=environment;report()},error=>{results.error=String(error);report()});
})()`
const html = `<!doctype html><title>Native Gnosis Safe App fixture</title><body><h2>Native Gnosis Safe App fixture</h2><p><label>Unfinished app draft<br><input id="draft-note" size="64" autocomplete="off"></label></p><script>${ fixtureScript }</script></body>`
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
	const url = new URL(request.url)
	if (request.method === 'OPTIONS') return new Response(undefined, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST' } })
	if (request.method === 'POST') {
		const value: unknown = await request.json()
		if (url.pathname === '/native-site-rpc') {
			if (typeof value !== 'object' || value === null || !('method' in value) || typeof value.method !== 'string' || !('id' in value) || (typeof value.id !== 'number' && typeof value.id !== 'string')) throw new Error('Invalid native site RPC fixture request')
			return Response.json({ jsonrpc: '2.0', id: value.id, result: value.method === 'eth_chainId' ? '0x1' : '0x2a' }, { headers: { 'Access-Control-Allow-Origin': '*' } })
		}
		if (typeof value !== 'object' || value === null || !('method' in value) || typeof value.method !== 'string' || !('id' in value) || typeof value.id !== 'number') throw new Error('Invalid native host test RPC request')
		return Response.json({ jsonrpc: '2.0', id: value.id, result: await rpc.handleRpcRequest({ id: value.id, method: value.method, params: 'params' in value && Array.isArray(value.params) ? value.params : undefined }) }, { headers: { 'Access-Control-Allow-Origin': '*' } })
	}
	return new Response(html, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', ...(url.pathname === '/denied-frame' ? { 'Content-Security-Policy': 'frame-ancestors \'none\'', 'X-Frame-Options': 'DENY' } : {}) } })
} })

const network = { name: 'Native host local RPC', chainId: '0x1', httpsRpc: `${ server.url.origin }/rpc`, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true }
const extensionDirectory = process.argv.find((arg) => arg.startsWith('--extension-source='))?.slice('--extension-source='.length)
let stage = 'launching browser'

async function hostForSource(session: BrowserSession, settings: BrowserPage, source: BrowserPage, appUrl: string) {
	const sourceTabId = await settings.evaluate<number>(`browser.tabs.query({}).then(tabs=>tabs.find(tab=>typeof tab.url==='string'&&tab.url.startsWith(${ JSON.stringify(`${ server.url.origin }/`) })&&new URL(tab.url).pathname===${ JSON.stringify(new URL(appUrl).pathname) })?.id)`)
	assert.equal(typeof sourceTabId, 'number', 'Find the original real website tab')
	await waitForBrowserCondition(async () => await source.evaluate('window.ethereum?.isInterceptor === true'), 'original tab provider')
	assert.deepEqual(await source.evaluate(`ethereum.request({method:'eth_requestAccounts'})`), [safeAddress])
	stage = 'opening extension host'
	const hostPath = getHtmlFile('gnosisSafeAppsHost', await settings.evaluate<number>('browser.runtime.getManifest().manifest_version'))
	const launch = await settings.evaluate(`browser.runtime.sendMessage({method:'popup_openGnosisSafeApp',data:{sourceTabId:${ sourceTabId }}})`)
	assert.deepEqual(launch, { type: 'OpenGnosisSafeAppReply', ok: true })
	const host = await waitForExtensionPage(session, `${ hostPath }?${ new URLSearchParams({ sourceTabId: String(sourceTabId), appUrl }) }`)
	await host.evaluate(`(() => {
		globalThis.nativeHostFixture=[];
		addEventListener('message',event=>{const child=document.querySelector('iframe');if(event.source===child?.contentWindow&&event.origin===${ JSON.stringify(server.url.origin) }&&event.data?.type==='native-host-fixture')globalThis.nativeHostFixture.push(event.data)});
	})()`)
	await waitForBrowserCondition(async () => await host.evaluate('document.querySelector("iframe")?.hidden === false'), 'prepared native iframe')
	if (new URL(appUrl).pathname === '/') await waitForBrowserCondition(async () => await host.evaluate('document.querySelector("[role=status]")?.textContent?.includes("handshake received")'), 'native child SDK handshake')
	return host
}

async function command(host: BrowserPage, name: string, method: string, params?: unknown) {
	await host.evaluate(`document.querySelector('iframe').contentWindow.postMessage({type:'native-host-fixture-command',name:${ JSON.stringify(name) },method:${ JSON.stringify(method) },params:${ JSON.stringify(params) ?? 'undefined' }},${ JSON.stringify(server.url.origin) })`)
}

async function verifyMetadataRefreshPreservesApp(session: BrowserSession, host: BrowserPage) {
	const draft = 'Keep this unfinished app draft across metadata refresh.'
	const refreshError = 'Wallet information temporarily unavailable (browser regression).'
	const { outputDirectory } = getGnosisSafeUiScreenshotSettings()
	await mkdir(outputDirectory, { recursive: true })
	await session.setViewport(1280, 900)
	await command(host, 'draftBeforeRefresh', '__setDraft', { value: draft })
	await waitForBrowserCondition(async () => await host.evaluate(`nativeHostFixture.at(-1)?.results.draftBeforeRefresh?.value===${ JSON.stringify(draft) }`), 'native app draft before metadata refresh')
	await host.evaluate(`(() => {
		const frame = document.querySelector('iframe');
		if (!(frame instanceof HTMLIFrameElement)) throw new Error('Missing native app iframe');
		globalThis.nativeRefreshRegression = {frame,generation:frame.dataset.hostGeneration,window:frame.contentWindow};
		const originalSend = browser.runtime.sendMessage;
		globalThis.restoreNativeRefreshTransport = () => { browser.runtime.sendMessage = originalSend; };
		browser.runtime.sendMessage = async (message, ...args) => {
			if (message?.method === 'popup_nativeGnosisSafeAppsRequest' && message.data?.request?.method === 'getSafeInfo') return {type:'NativeGnosisSafeAppsRelayReply',ok:true,response:{id:message.data.request.id,success:false,error:${ JSON.stringify(refreshError) }}};
			return await originalSend.call(browser.runtime, message, ...args);
		};
	})()`)
	const assertPreserved = async (name: string) => {
		assert.equal(await host.evaluate(`(() => {
			const frame = document.querySelector('iframe');
			const before = globalThis.nativeRefreshRegression;
			return frame === before.frame && frame.hidden === false && frame.dataset.hostGeneration === before.generation && frame.contentWindow === before.window;
		})()`), true, 'Metadata refresh must retain the exact visible iframe, generation and window')
		await command(host, name, '__readDraft')
		await waitForBrowserCondition(async () => await host.evaluate(`nativeHostFixture.at(-1)?.results.${ name } !== undefined`), 'native app draft after metadata refresh')
		assert.equal(await host.evaluate(`nativeHostFixture.at(-1)?.results.${ name }?.value`), draft, 'The unfinished app draft must survive metadata refresh')
	}
	try {
		await waitForBrowserCondition(async () => await host.evaluate(`document.querySelector('[role=status]')?.textContent===${ JSON.stringify(refreshError) }`), 'controlled periodic metadata refresh error', NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING.metadataRefreshIntervalMs + GNOSIS_SAFE_APPS_SOURCE_DISCOVERY_TIMEOUT_MS)
		await assertPreserved('draftDuringRefreshError')
		await Bun.write(path.join(outputDirectory, `${ session.browser }-native-refresh-error.png`), Buffer.from(await host.captureScreenshot(), 'base64'))
	} finally {
		await host.evaluate('(() => { globalThis.restoreNativeRefreshTransport(); delete globalThis.restoreNativeRefreshTransport; })()')
	}
	await waitForBrowserCondition(async () => await host.evaluate(`document.querySelector('[role=status]')?.textContent?.includes('Wallet information refreshed')`), 'periodic metadata refresh recovery', NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING.metadataRefreshIntervalMs + GNOSIS_SAFE_APPS_SOURCE_DISCOVERY_TIMEOUT_MS)
	await assertPreserved('draftAfterRefreshRecovery')
	await Bun.write(path.join(outputDirectory, `${ session.browser }-native-refresh-recovered.png`), Buffer.from(await host.captureScreenshot(), 'base64'))
	await host.evaluate('delete globalThis.nativeRefreshRegression')
	console.warn(`${ session.browser } native metadata refresh preserved the app frame and draft through failure and recovery; screenshots: ${ outputDirectory }`)
}

try {
	const session = await launchBrowserSession(selectedBrowser(), extensionDirectory)
	try {
		await session.addPreloadScript(createSigningWalletScript(ownerAddress, `0x${ '11'.repeat(32) }`))
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
			for (const simulationMode of [true, false]) {
				stage = `opening source website in ${ simulationMode ? 'simulation' : 'signing' } mode`
				await settings.evaluate(`browser.storage.local.set({simulationMode:${ simulationMode },websiteAccess:${ JSON.stringify(grants) }})`)
				const source = await session.openPage(appUrl)
				try {
					const host = await hostForSource(session, settings, source, appUrl)
					try {
						await command(host, 'probe', 'getSafeInfo')
						await command(host, 'chainProbe', 'getChainInfo')
						await command(host, 'environmentProbe', 'getEnvironmentInfo')
						await waitForBrowserCondition(async () => await host.evaluate('nativeHostFixture.at(-1)?.results.environmentProbe?.success===true'), 'native SDK requests')
						const observed = await host.evaluate<{ results: { probe: { data: { safeAddress: string } }, chainProbe: { data: { chainId: string } }, environmentProbe: { data: { origin: string } } }, native: { parentIsSelf: boolean, selfIsTop: boolean, parentUnchanged: boolean, timersUnchanged: boolean, referrer: string }, replies: { origin: string, sourceIsParent: boolean }[] }>('nativeHostFixture.at(-1)')
						assert.equal(observed.results.probe.data.safeAddress.toLowerCase(), safeAddress)
						assert.equal(observed.results.chainProbe.data.chainId, '1')
						assert.equal(observed.results.environmentProbe.data.origin, server.url.host)
						assert.equal(observed.native.parentIsSelf, false)
						assert.equal(observed.native.selfIsTop, false)
						assert.equal(observed.native.parentUnchanged, true)
						assert.equal(observed.native.timersUnchanged, true)
						assert.ok(observed.native.referrer === '' || observed.native.referrer.startsWith(extensionOrigin), 'Native referrer is empty or the real extension host, never a synthetic website')
						assert.ok(observed.replies.every((reply) => reply.origin === extensionOrigin && reply.sourceIsParent))
						assert.equal(await source.evaluate('parent===self&&top===self&&window.__interceptorSafeAppsHostEmulatedParent!==true'), true)
						const mismatchedOrigin = await host.evaluate<{ ok: boolean }>(`browser.runtime.sendMessage({method:'popup_nativeGnosisSafeAppsRequest',data:{sourceTabId:Number(new URLSearchParams(location.search).get('sourceTabId')),origin:'https://different.example',request:{id:'wrong-origin',method:'getSafeInfo',env:{sdkVersion:'9.1.0'}}}})`)
						assert.equal(mismatchedOrigin.ok, false, 'The host cannot borrow its source tab for another origin')
						if (httpInterception) {
							let probe = 0
							await waitForBrowserCondition(async () => {
								const name = `httpBalance${ probe++ }`
								await command(host, name, '__nativeHttpBalance')
								await waitForBrowserCondition(async () => await host.evaluate(`nativeHostFixture.at(-1)?.results.${ name } !== undefined`), 'native child HTTP reply')
								const response = await host.evaluate<{ overlay?: string, value?: { result?: string } }>(`nativeHostFixture.at(-1)?.results.${ name }`)
								return response.overlay === (simulationMode ? 'true' : null) && response.value?.result === (simulationMode ? '0x0' : '0x2a')
							}, 'origin-verified native iframe HTTP simulation overlay')
							console.warn(`${ session.browser } native iframe HTTP read passed: ${ simulationMode ? 'simulation' : 'signing' }`)
						}
						if (!httpInterception && simulationMode) {
							stage = 'preserving the native app through metadata refresh failure and recovery'
							await verifyMetadataRefreshPreservesApp(session, host)
						}
						if (!httpInterception && simulationMode && !process.argv.includes('--skip-transactions')) {
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
								// Reopening from the popup must focus the same host without unloading an admitted operation or its unfinished app input.
								await host.evaluate('(() => { const frame=document.querySelector("iframe"); globalThis.pendingLaunchGuard={frame,window:frame.contentWindow}; })()')
								const sourceTabId = await host.evaluate<number>('Number(new URLSearchParams(location.search).get("sourceTabId"))')
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
							assert.equal(await source.evaluate('__fakeSignerRequests.includes("eth_sendTransaction")||__aggregateSignerRequests.includes("eth_sendTransaction")'), false, 'Simulation never broadcasts through the owner wallet')
							console.warn(`${ session.browser } native host two-transaction simulation stack passed`)
						}
						stage = 'revoking app permissions'
						await settings.evaluate('browser.storage.local.set({websiteAccess:[]})')
						await waitForBrowserCondition(async () => await host.evaluate('document.querySelector("iframe")?.hidden===true'), 'revocation hides native app and clears prepared metadata')
						assert.equal(await host.evaluate('document.querySelector("iframe")?.src'), 'about:blank')
						console.warn(`${ session.browser } native extension-host SDK, origin and revocation passed: ${ simulationMode ? 'simulation' : 'signing' }`)
					} catch (error: unknown) {
						const diagnostics = await Promise.allSettled([
							host.evaluate('({status:document.querySelector("[role=status]")?.textContent,lastContextChange:document.querySelector("[role=status]")?.dataset.lastContextChange,fixture:globalThis.nativeHostFixture,pendingRetryGuard:globalThis.pendingRetryGuard,frameUrl:document.querySelector("iframe")?.src,frameHidden:document.querySelector("iframe")?.hidden})'),
							session.pages().then(async (pages) => await Promise.all(pages.filter((page) => /confirmTransaction|interceptorAccess/.test(page.url)).map(async (page) => ({ url: page.url, body: await page.evaluate('document.body.innerText') })))),
						])
						await Bun.write(`/tmp/native-host-failure-${ session.browser }.json`, JSON.stringify({ stage, error: String(error), diagnostics: diagnostics.map((result) => result.status === 'fulfilled' ? result.value : { diagnosticError: String(result.reason) }) }, undefined, 2))
						throw error
					} finally { await host.close() }
				} finally { await source.close() }
				await settings.evaluate(`browser.storage.local.set({websiteAccess:${ JSON.stringify(grants) }})`)
				for (const path of httpInterception ? [] : ['/strict-parent', '/denied-frame']) {
					const unsupportedUrl = `${ server.url.origin }${ path }?${ new URLSearchParams({ parentOrigin: extensionOrigin }) }`
					const source = await session.openPage(unsupportedUrl)
					try {
						const host = await hostForSource(session, settings, source, unsupportedUrl)
						try {
							await waitForBrowserCondition(async () => await host.evaluate('document.querySelector("[role=status]")?.textContent?.startsWith("No Gnosis Safe App handshake received")'), 'honest native-policy unsupported state', 2 * NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING.handshakeTimeoutMs)
							assert.equal(await host.evaluate('parent===self&&top===self&&window.__interceptorSafeAppsHostEmulatedParent!==true'), true)
							console.warn(`${ session.browser } native host preserves ${ path } restriction: ${ simulationMode ? 'simulation' : 'signing' }`)
						} finally { await host.close() }
					} finally { await source.close() }
				}
			}
		} finally { await settings.close() }
	} finally { await session.close() }
} catch (error: unknown) {
	throw new Error(`Native Gnosis Safe Apps browser check failed while ${ stage }`, { cause: error })
} finally { await server.stop(true) }
