import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserTestTargets } from '../../scripts/test-browsers.mts'
import { launchBrowserSession, selectedBrowser, waitForBrowserCondition } from './browserHarness.js'
import type { BrowserPage } from './browserHarness.js'
import { getHtmlFile } from '../../app/ts/utils/htmlPages.js'

// Live websites are diagnostic evidence, outside deterministic CI. The default always exercises both supported browsers.
if (!process.argv.some((arg) => arg.startsWith('--browser='))) {
	const manifestFile = Bun.file('app/manifest.json')
	const manifest = await manifestFile.exists() ? await manifestFile.text() : await Bun.file('app/manifestV3.json').text()
	const failures: string[] = []
	try {
		for (const target of browserTestTargets) {
			if (await Bun.spawn({ cmd: [process.execPath, 'run', target.build], stdout: 'inherit', stderr: 'inherit' }).exited !== 0) { failures.push(`${ target.engine } build`); continue }
			const exit = await Bun.spawn({ cmd: [process.execPath, import.meta.path, `--browser=${ target.engine }`, ...process.argv.slice(2)], stdout: 'inherit', stderr: 'inherit', env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' } }).exited
			if (exit !== 0) failures.push(target.engine)
		}
	} finally { await Bun.write('app/manifest.json', manifest) }
	if (failures.length > 0) throw new Error(`Live probes failed: ${ failures.join(', ') }`)
	process.exit(0)
}

function observeLiveNativeApp(expectedParentOrigin?: string) {
	if (parent === self) return
	const replies: unknown[] = []
	const actions: string[] = []
	const parentOrigin = expectedParentOrigin ?? browser.runtime.getURL('').replace(/\/$/, '')
	addEventListener('message', (event) => {
		if (event.source !== parent || event.origin !== parentOrigin) return
		if (event.data?.success !== undefined) replies.push({ origin: event.origin, data: event.data })
		if (event.data?.type !== 'native-host-test-action') return
		const elements = [...document.querySelectorAll('button,[role="button"]')]
		let candidate: Element | undefined
		if (event.data.step === 'open') candidate = elements.find((element) => /^(Connect wallet|Connect)$/i.test(element.textContent?.trim() ?? ''))
		if (event.data.step === 'wallet') candidate = elements.find((element) => /The Interceptor|^Interceptor$/i.test(element.textContent?.trim() ?? '') || element.getAttribute('aria-label') === 'Connect The Interceptor')
		// Exercise Lido's ordinary visible consent; this is driver interaction, not website compatibility code.
		if (event.data.step === 'consent' && location.hostname === 'stake.lido.fi' && document.body.innerText.includes('Confirm connection')) {
			const checkbox = document.querySelector('input[type="checkbox"]')
			if (checkbox instanceof HTMLInputElement && !checkbox.checked) checkbox.click()
			candidate = elements.find((element) => element.textContent?.trim() === 'Connect')
		}
		if (candidate instanceof HTMLElement && !(candidate instanceof HTMLButtonElement && candidate.disabled)) { actions.push(candidate.textContent?.trim() ?? ''); candidate.click() }
	})
	setInterval(() => parent.postMessage({ type: 'native-host-test-observation', href: location.href, body: document.body?.innerText.slice(0, 16_000), parentIsSelf: parent === self, selfIsTop: self === top, referrer: document.referrer, replies, actions }, '*'), 1_000)
}

function installReadOnlyOwner(owner: string) {
	if (!/^https?:$/.test(location.protocol)) return
	const signer = { isMetaMask: true, selectedAddress: owner, isConnected: () => true, request: async ({ method }: { method: string }) => {
		if (method === 'eth_chainId') return '0x1'
		if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [owner]
		throw new Error(`Read-only live test cannot sign or broadcast: ${ method }`)
	}, on: () => signer, removeListener: () => signer }
	Reflect.set(window, 'ethereum', signer)
	addEventListener('eip6963:requestProvider', () => dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: '55555555-5555-4555-8555-555555555555', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' }, provider: signer } })))
}

const browser = selectedBrowser()
const output = `${ process.argv.find((arg) => arg.startsWith('--output='))?.slice('--output='.length) ?? '/tmp/native-gnosis-live' }/${ browser }`
const onlySite = process.argv.find((arg) => arg.startsWith('--site='))?.slice('--site='.length)
const safe = '0x849d52316331967b6ff1198e5e32a0eb168d039d'
const owner = '0x964ae5ab627f1d536d5d5796734b7a44ad6531e3'
const sites = [
	{ name: 'aave', url: 'https://app.aave.com' },
	{ name: 'cow', url: 'https://swap.cow.fi' },
	{ name: 'lido', url: 'https://stake.lido.fi' },
	{ name: 'request-finance', url: 'https://app.request.finance' },
	{ name: 'uniswap', url: 'https://app.uniswap.org' },
	{ name: '1inch', url: 'https://1inch.com/swap' },
].filter((site) => onlySite === undefined || onlySite.split(',').includes(site.name))
if (sites.length === 0 || onlySite?.split(',').some((name) => !sites.some((site) => site.name === name))) throw new Error('Unknown live website')
await mkdir(output, { recursive: true })
const copy = await mkdtemp(join(tmpdir(), `native-gnosis-live-${ browser }-`))
await cp(new URL('../../app', import.meta.url), copy, { recursive: true })
const manifest = await Bun.file(join(copy, 'manifest.json')).json()
if (manifest.manifest_version !== (browser === 'chrome' ? 3 : 2)) throw new Error('Build the selected browser first')
if (browser === 'chrome') manifest.content_scripts = [...(manifest.content_scripts ?? []), { matches: ['https://*/*'], js: ['vendor/webextension-polyfill/dist/browser-polyfill.js', 'native-live-observer.js'], all_frames: true, run_at: 'document_start' }]
await Bun.write(join(copy, 'manifest.json'), JSON.stringify(manifest))
await Bun.write(join(copy, 'native-live-observer.js'), `(${ observeLiveNativeApp.toString() })()`)
const results: unknown[] = []
try {
	for (const simulationMode of [true, false]) {
		const session = await launchBrowserSession(browser, copy)
		try {
			await session.addPreloadScript(`(${ installReadOnlyOwner.toString() })(${ JSON.stringify(owner) })`)
			const settings = await session.openExtensionPage('html/settingsView.html')
			// Firefox BiDi preloads reach child MAIN worlds; Chrome OOPIFs need the static observer above. Assertions and observations remain shared.
			if (browser === 'firefox') {
				const extensionOrigin = await settings.evaluate<string>('browser.runtime.getURL("").replace(/\\/$/, "")')
				await session.addPreloadScript(`(${ observeLiveNativeApp.toString() })(${ JSON.stringify(extensionOrigin) })`)
			}
			await settings.evaluate(`browser.storage.local.set(${ JSON.stringify({ simulationMode, safeAppsCompatibilityMode: true, metamaskCompatibilityMode: false, useSignersAddressAsActiveAddress: false, independentActiveSimulationAddress: safe, activeSigningSafeAddress: safe, activeSigningAddress: owner, signingAddressPreferences: [{ signerAddress: owner, selection: 'safe', safeAddress: safe, chainId: '0x1' }], userAddressBookEntriesV3: [{ type: 'safe', name: 'Read-only public test account', address: safe, chainId: '0x1', entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: false, safeSignerAddresses: [owner], safeSimulationSignerAddress: owner, safeVersion: '1.3.0' }], websiteAccess: sites.map((site) => ({ website: { websiteOrigin: new URL(site.url).host }, access: true, addressAccess: [{ address: safe, access: true }] })) }) })`)
			for (const site of sites) {
				let openedSource: BrowserPage | undefined
				try {
					const source = await session.openPage(site.url, 'interactive')
					openedSource = source
					await waitForBrowserCondition(async () => await source.evaluate('window.ethereum?.isInterceptor === true'), 'original website provider')
					await source.evaluate('ethereum.request({method:"eth_accounts"})')
					const sourceTabId = await settings.evaluate<number>(`browser.tabs.query({}).then(tabs=>tabs.find(tab=>tab.url?.startsWith(${ JSON.stringify(site.url) }))?.id)`)
					if (!Number.isSafeInteger(sourceTabId)) throw new Error('Missing original website tab')
					const hostPath = getHtmlFile('gnosisSafeAppsHost', await settings.evaluate<number>('browser.runtime.getManifest().manifest_version'))
					const host = await session.openExtensionPage(`${ hostPath.slice(1) }?${ new URLSearchParams({ sourceTabId: String(sourceTabId), appUrl: site.url }) }`)
					try {
						await host.evaluate(`(() => {globalThis.nativeLiveObservations=[];addEventListener('message',event=>{const child=document.querySelector('iframe');if(event.source===child?.contentWindow&&event.origin===${ JSON.stringify(new URL(site.url).origin) }&&event.data?.type==='native-host-test-observation')nativeLiveObservations.push({origin:event.origin,data:event.data})})})()`)
						await new Promise((resolve) => setTimeout(resolve, 20_000))
						for (const step of ['open', 'wallet', ...(site.name === 'lido' ? ['consent', 'consent'] : [])]) {
							await host.evaluate(`document.querySelector('iframe').contentWindow.postMessage({type:'native-host-test-action',step:${ JSON.stringify(step) }},${ JSON.stringify(new URL(site.url).origin) })`)
							await new Promise((resolve) => setTimeout(resolve, 2_000))
						}
						const observation = await host.evaluate('({hostOrigin:location.origin,status:document.querySelector("[role=status]").textContent,iframeVisible:!document.querySelector("iframe").hidden,observations:globalThis.nativeLiveObservations??[]})')
						const result = { browser, mode: simulationMode ? 'simulation' : 'signing', site: site.name, url: site.url, sourceTabId, observation }
						results.push(result)
						await Bun.write(join(output, `${ site.name }-${ simulationMode ? 'simulation' : 'signing' }.json`), JSON.stringify(result, undefined, 2))
						await Bun.write(join(output, `${ site.name }-${ simulationMode ? 'simulation' : 'signing' }.png`), Buffer.from(await host.captureScreenshot(), 'base64'))
						process.stdout.write(`${ JSON.stringify({ browser, simulationMode, site: site.name }) }\n`)
					} finally { await host.close() }
				} catch (error: unknown) {
					const result = { browser, mode: simulationMode ? 'simulation' : 'signing', site: site.name, url: site.url, error: String(error) }
					results.push(result)
					process.exitCode = 1
					await Bun.write(join(output, `${ site.name }-${ simulationMode ? 'simulation' : 'signing' }.json`), JSON.stringify(result, undefined, 2))
					process.stdout.write(`${ JSON.stringify(result) }\n`)
				} finally { await openedSource?.close() }
			}
		} finally { await session.close() }
	}
	await Bun.write(join(output, 'results.json'), JSON.stringify(results, undefined, 2))
} finally { await rm(copy, { recursive: true, force: true }) }
