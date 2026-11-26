import * as assert from 'node:assert/strict'
import { launchBrowserSession, selectedBrowser, waitForBrowserCondition } from './browserHarness.js'
import { createBrowserSimulationRpc } from '../fixtures/browserSimulationRpc.js'

// Child-PR HTTP interception checks. Native Gnosis Safe SDK hosting has its own shared browser scenario.
const rpcSite = process.argv.find((arg) => arg.startsWith('--rpc-site='))?.slice('--rpc-site='.length) ?? 'generic'
if (!['generic', 'aave', 'lido'].includes(rpcSite) || process.argv.includes('--cow') || process.argv.includes('--lido')) throw new Error('Select --rpc-site=generic, --rpc-site=aave or --rpc-site=lido; native SDK hosting uses its separate browser scenario.')
const safeAddress = '0x1234567890123456789012345678901234567890'
const balanceApiUrl = `https://proxy-app.1inch.com/v2.0/balance/v1.2/1/allowancesAndBalances/0x111111125421ca6dc452d289314280a0f8842a65/${ safeAddress }`
const portfolioApiUrl = 'https://entry-gateway.backend-prod.api.uniswap.org/data.v1.DataApiService/GetPortfolio'
const nativeToken = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const ownerAddress = '0x0000000000000000000000000000000000000001'
const rpc = createBrowserSimulationRpc({ safeAddress: BigInt(safeAddress), singletonAddress: 0x41675c099f32341bf84bfc5382af534df5c7461an, ownerAddress: BigInt(ownerAddress) })
// This owner-wallet fixture answers discovery only. Provider account/chain RPCs authorize HTTP overlays; no SDK metadata or framing emulation is involved.
const pageScript = `(() => {
	if(localStorage.getItem('fixture-signing-mode') !== 'true') return;
	globalThis.fixtureSignerRequests = [];
	const owner = ${ JSON.stringify(ownerAddress) };
	const signer = { isMetaMask: true, selectedAddress: owner, isConnected: () => true,
		request: async ({method}) => { fixtureSignerRequests.push(method); if (method === 'eth_chainId') return '0x1'; if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [owner]; throw new Error('Unexpected signer request: ' + method); },
		on: () => signer, removeListener: () => signer };
	globalThis.ethereum = signer;
	addEventListener('eip6963:requestProvider', () => dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: '55555555-5555-4555-8555-555555555555', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' }, provider: signer } })));
})()`
const html = '<!doctype html><html><head></head><body>Provider HTTP interception fixture</body></html>'
const startupProbes = new Set<string>()
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
	if (request.method === 'OPTIONS') return new Response(undefined, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST' } })
	if (request.method === 'POST') {
		const value: unknown = await request.json()
		if (new URL(request.url).pathname.startsWith('/native')) {
			if (new URL(request.url).pathname === '/native-auth' && typeof value === 'object' && value !== null && 'method' in value && value.method === 'eth_chainId' && !startupProbes.has(request.url)) {
				startupProbes.add(request.url)
				return Response.json({ error: 'Gateway session is not ready yet' }, { status: 401, headers: { 'Access-Control-Allow-Origin': '*' } })
			}
			const reply = (entry: unknown) => {
				if (typeof entry !== 'object' || entry === null || !('id' in entry) || !('method' in entry)) throw new Error('Invalid native RPC fixture request')
				return { jsonrpc: '2.0', id: entry.id, result: entry.method === 'eth_chainId' ? new URL(request.url).pathname.endsWith('other') ? '0x89' : '0x1' : '0x2a' }
			}
			return Response.json(Array.isArray(value) ? value.map(reply) : reply(value), { headers: { 'Access-Control-Allow-Origin': '*' } })
		}
		if (typeof value !== 'object' || value === null || !('method' in value) || typeof value.method !== 'string' || !('id' in value) || typeof value.id !== 'number') throw new Error('Invalid test RPC request')
		const result = await rpc.handleRpcRequest({ method: value.method, id: value.id, params: 'params' in value && Array.isArray(value.params) ? value.params : undefined })
		return Response.json({ jsonrpc: '2.0', id: value.id, result })
	}
	return new Response(html, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } })
} })
const peer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(html, { headers: { 'Content-Type': 'text/html' } }) })
const fixtureOrigin = rpcSite === 'lido' ? 'https://stake.lido.fi' : rpcSite === 'aave' ? 'https://app.aave.com' : server.url.origin
const network = { name: 'Shared local Gnosis Safe test RPC', chainId: '0x1', httpsRpc: `${ server.url.origin }/rpc`, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true }

async function main() {
	const session = await launchBrowserSession(selectedBrowser())
	try {
		// Install the wallet before the provider; a page-owned inline assignment would overwrite the already injected provider in Chrome MAIN-world startup.
		await session.addPreloadScript(`if(/^https?:$/.test(location.protocol)){${ pageScript }}`)
		const routes = [
			...(fixtureOrigin !== server.url.origin ? [
			{ url: `${ fixtureOrigin }/`, body: html },
			{ url: `${ fixtureOrigin }/api/rpc-proxy/`, body: JSON.stringify({ jsonrpc: '2.0', id: 71, result: '0x2a' }), headers: { 'Content-Type': 'application/json' } },
			] : []),
			...(rpcSite === 'generic' ? [{ url: balanceApiUrl, body: JSON.stringify({ [nativeToken]: { balance: '42', allowance: '0' } }), headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }] : []),
			...(rpcSite === 'generic' ? [{ url: portfolioApiUrl, body: JSON.stringify({ portfolio: { balances: [{ token: { chainId: 1, address: '0x0000000000000000000000000000000000000000', decimals: 18 }, amount: { raw: '42', amount: 42 / 10 ** 18 }, priceUsd: 1, valueUsd: 42 / 10 ** 18 }], totalValueUsd: 42 / 10 ** 18 } }), headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': '*' } }] : []),
		]
		if (routes.length > 0) await session.routeResponses(routes)
		const settings = await session.openExtensionPage('html/popup.html')
		try {
			await settings.evaluate(`(async () => {
				await browser.storage.local.set({ safeAppsCompatibilityMode: true, simulationMode: true, useSignersAddressAsActiveAddress: false,
					independentActiveSimulationAddress: '${ safeAddress }', activeSigningSafeAddress: '${ safeAddress }', activeSigningAddress: '${ ownerAddress }',
					signingAddressPreferences: [{ signerAddress: '${ ownerAddress }', selection: 'safe', safeAddress: '${ safeAddress }', chainId: '0x1' }],
					userAddressBookEntriesV3: [{ type: 'safe', name: 'Shared Gnosis Safe', address: '${ safeAddress }', chainId: '0x1', entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: false, safeSignerAddresses: ['${ ownerAddress }'], safeSimulationSignerAddress: '${ ownerAddress }', safeVersion: '1.4.1' }] });
				await browser.runtime.sendMessage({ method: 'popup_changeActiveRpc', data: ${ JSON.stringify(network) } });
			})()`)
			const page = await session.openPage(`${ fixtureOrigin }/`)
			try {
				for (const simulationMode of [true, false]) for (const metamaskCompatibilityMode of [false, true]) {
					await settings.evaluate(`browser.storage.local.set({ simulationMode: ${ simulationMode }, websiteAccess: [{ website: { websiteOrigin: ${ JSON.stringify(new URL(fixtureOrigin).host) } }, access: true, addressAccess: [{ address: '${ safeAddress }', access: true }] }, { website: { websiteOrigin: ${ JSON.stringify(peer.url.host) } }, interceptorDisabled: true }] })`)
					await settings.evaluate(`browser.runtime.sendMessage({method:'popup_ChangeSettings',data:{metamaskCompatibilityMode:${ metamaskCompatibilityMode }}})`)
					await page.evaluate(`localStorage.setItem('fixture-signing-mode', ${ JSON.stringify(String(!simulationMode)) })`)
					await page.reload()
					await waitForBrowserCondition(async () => await page.evaluate('window.ethereum?.isInterceptor === true'), 'HTTP fixture provider')
					assert.equal(await page.evaluate('window.parent === window && window.top === window'), true, 'HTTP overlays must not require a fabricated parent')
					await page.evaluate(`void ethereum.request({method:'eth_requestAccounts'}).then(accounts=>{globalThis.fixtureAccounts=accounts},error=>{globalThis.fixtureAccessError=String(error)})`)
					await waitForBrowserCondition(async () => await page.evaluate(`(() => {if(globalThis.fixtureAccessError) throw new Error(globalThis.fixtureAccessError);return globalThis.fixtureAccounts?.[0]?.toLowerCase() === '${ safeAddress }'})()`), 'preapproved provider Gnosis Safe account')
					if (simulationMode) {
						await waitForBrowserCondition(async () => await page.evaluate(`fetch(${ JSON.stringify(`${ server.url.origin }/native`) }, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:70,method:'eth_chainId',params:[]})}).then(response=>response.headers.get('x-interceptor-simulation') === 'true')`), 'HTTP simulation context publication')
					}
					console.warn(`${ session.browser } ${ rpcSite } RPC reads: ${ simulationMode ? 'simulation' : 'signing' }, compatibility=${ metamaskCompatibilityMode }`)
					const endpoint = `${ server.url.origin }/native`
					const request = { jsonrpc: '2.0', id: 71, method: 'eth_getBalance', params: [safeAddress, 'latest'] }
					const read = (body: unknown, url = endpoint) => `fetch(${ JSON.stringify(url) }, { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${ JSON.stringify(JSON.stringify(body)) } }).then(async response => ({ overlay: response.headers.get('x-interceptor-simulation'), value: await response.json() }))`
					const single = await page.evaluate<{ overlay: string, value: { result: string } }>(read(request))
					assert.equal(single?.overlay, simulationMode ? 'true' : null, 'Only simulation mode overlays site reads')
					assert.equal(single?.value.result, simulationMode ? '0x0' : '0x2a')
					const batch = await page.evaluate<{ overlay: string, value: unknown[] }>(read([request, { jsonrpc: '2.0', id: 72, method: 'eth_blockNumber' }]))
					assert.equal(batch?.overlay, simulationMode ? 'true' : null); assert.equal(batch?.value.length, 2)
					const other = await page.evaluate<{ overlay: string | undefined, value: { result: string } }>(read(request, endpoint + '-other'))
					assert.equal(other?.overlay, null); assert.equal(other?.value.result, '0x2a')
					if (rpcSite === 'generic') {
						const startupEndpoint = `${ server.url.origin }/native-auth?case=${ simulationMode }-${ metamaskCompatibilityMode }`
						const beforeAuthorization = await page.evaluate<{ overlay: string | undefined, value: { result: string } }>(read(request, startupEndpoint))
						assert.equal(beforeAuthorization?.overlay, null)
						assert.equal(beforeAuthorization?.value.result, '0x2a')
						const afterAuthorization = await page.evaluate<{ overlay: string | undefined, value: { result: string } }>(read(request, startupEndpoint))
						assert.equal(afterAuthorization?.overlay, simulationMode ? 'true' : null, 'Failed identification must be retried when gateway authorization becomes ready')
						assert.equal(afterAuthorization?.value.result, simulationMode ? '0x0' : '0x2a')
						const balance = await page.evaluate<{ overlay: string | undefined, value: Record<string, { balance: string }> }>(`fetch(${ JSON.stringify(balanceApiUrl) }).then(async response => ({overlay:response.headers.get('x-interceptor-simulation'),value:await response.json()}))`)
						assert.equal(balance?.overlay, simulationMode ? 'true' : null)
						assert.equal(balance?.value[nativeToken]?.balance, simulationMode ? '0' : '42', 'Vendor REST balances follow the same selected-account context as generic RPC')
						const portfolio = await page.evaluate<{ overlay: string | undefined, value: { portfolio: { balances: { amount: { raw: string } }[], totalValueUsd: number } } }>(`fetch(${ JSON.stringify(portfolioApiUrl) }, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ walletAccount: { platformAddresses: [{ address: ${ JSON.stringify(safeAddress) } }] }, chainIds: [1] }) }).then(async response => ({ overlay: response.headers.get('x-interceptor-simulation'), value: await response.json() }))`)
						assert.equal(portfolio?.overlay, simulationMode ? 'true' : null)
						assert.equal(portfolio?.value.portfolio.balances[0]?.amount.raw, simulationMode ? '0' : '42', 'Indexed API quantities use the selected simulation balance in both browsers')
						assert.equal(portfolio?.value.portfolio.totalValueUsd, simulationMode ? 0 : 42 / 10 ** 18)
					}
					if (rpcSite === 'aave') {
						const proxy = await page.evaluate<{ overlay: string, value: { result: string } }>(read({ chainId: 1, method: request.method, params: request.params }, `${ fixtureOrigin }/api/rpc-proxy/`))
						assert.equal(proxy?.overlay, simulationMode ? 'true' : null); assert.equal(proxy?.value.result, simulationMode ? '0x0' : '0x2a')
					}
					const unapproved = await session.openPage(peer.url.href)
					try {
						assert.equal(await unapproved.evaluate('window.ethereum?.isInterceptor === true'), false, 'A disabled port must not inherit the provider')
					} finally { await unapproved.close() }
					const testRegrant = rpcSite === 'generic' && simulationMode && !metamaskCompatibilityMode
					if (testRegrant) await page.evaluate(`(() => {
						globalThis.fixtureRetainedFetch = window.fetch; globalThis.fixturePageFetchCalls = 0;
						globalThis.fixtureWrappedFetch = async (...args) => { globalThis.fixturePageFetchCalls++; return await globalThis.fixtureRetainedFetch(...args); };
						window.fetch = globalThis.fixtureWrappedFetch;
					})()`)
					await settings.evaluate(`browser.runtime.sendMessage({method:'popup_removeWebsiteAccess',data:{websiteOrigin:${ JSON.stringify(new URL(fixtureOrigin).host) }}})`)
					await waitForBrowserCondition(async () => {
						const response = await page.evaluate<{ overlay: string | undefined, value: { result: string } }>(`fetch(${ JSON.stringify(`${ server.url.origin }/native`) }, { method: 'POST', headers: {'content-type':'application/json'}, body: ${ JSON.stringify(JSON.stringify({ jsonrpc: '2.0', id: 73, method: 'eth_getBalance', params: [safeAddress, 'latest'] })) } }).then(async response => ({overlay: response.headers.get('x-interceptor-simulation'), value: await response.json()}))`)
						return response?.overlay === null && response.value.result === '0x2a'
					}, 'native RPC reads after permission revocation')
					if (testRegrant) {
						await settings.evaluate(`browser.storage.local.set({ websiteAccess: [{ website: { websiteOrigin: ${ JSON.stringify(new URL(fixtureOrigin).host) } }, access: true, addressAccess: [{ address: '${ safeAddress }', access: true }] }] })`)
						await page.evaluate(`ethereum.request({method:'eth_requestAccounts'})`)
						await waitForBrowserCondition(async () => await page.evaluate(`fixtureRetainedFetch(${ JSON.stringify(endpoint) }, {method:'POST',headers:{'content-type':'application/json'},body:${ JSON.stringify(JSON.stringify(request)) }}).then(response=>response.headers.get('x-interceptor-simulation') === 'true')`), 'retained HTTP hook after permission re-grant')
						assert.equal(await page.evaluate('window.fetch === fixtureWrappedFetch'), true, 'Re-grant preserves the existing page wrapper')
						const callsBefore = await page.evaluate<number>('fixturePageFetchCalls')
						assert.ok(callsBefore !== undefined)
						const regranted = await page.evaluate<{ overlay: string, value: { result: string } }>(read(request))
						assert.equal(regranted?.overlay, 'true'); assert.equal(regranted?.value.result, '0x0')
						assert.equal(await page.evaluate<number>('fixturePageFetchCalls'), callsBefore + 1, 'Each application read crosses its wrapper once after re-grant')
						console.warn(`${ session.browser } retained HTTP hook and page instrumentation survived permission re-grant`)
					}
				}
			} finally { await page.close() }
		} finally { await settings.close() }
	} finally { await session.close() }
}
try { await main() } finally { server.stop(true); peer.stop(true) }
