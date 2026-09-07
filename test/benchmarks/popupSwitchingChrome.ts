import { mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { InterceptorTransactionStack } from '../../app/ts/types/visualizer-types.js'
import { JSON_RPC_ERROR_CODE_RESOURCE_UNAVAILABLE, Multicall3ABI } from '../../app/ts/utils/constants.js'
import { decodeFunctionDataStrict, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { EthSimulateV1Result } from '../../app/ts/types/ethSimulate-types.js'
import { connectTarget, createTargetPage, launchChromeSession, waitForInterceptorExtensionServiceWorker, waitForPerformanceMarks, waitForRegisteredContentScripts } from './chromeHarness.js'
import type { CdpConnection } from './chromeHarness.js'
import { EthereumBlockHeader, serialize } from '../../app/ts/types/wire-types.js'
import { eth_getBlockByNumber_goerli_8443561_false } from '../RPCResponses.js'

function delay(ms: number) { return new Promise<void>((resolve) => setTimeout(resolve, ms)) }
function positiveInteger(value: string | undefined, fallback: number) {
	const result = value === undefined ? fallback : Number(value)
	if (!Number.isSafeInteger(result) || result < 0) throw new Error('Benchmark delays and iteration count must be nonnegative integers')
	return result
}
const rpcDelayMs = positiveInteger(process.env.BENCH_RPC_DELAY_MS, 150)
const walletDelayMs = positiveInteger(process.env.BENCH_WALLET_DELAY_MS, 300)
const iterations = positiveInteger(process.env.BENCH_ITERATIONS, 3)
if (iterations === 0) throw new Error('BENCH_ITERATIONS must be positive')
if (process.env.CHROME_USER_DATA_DIR !== undefined || process.env.INTERCEPTOR_CHROME_PROFILE_DIR !== undefined) throw new Error('Switching benchmarks require an isolated temporary Chrome profile')
const walletA = '0x1000000000000000000000000000000000000001'
const walletB = '0x1000000000000000000000000000000000000002'
const blockResponse: unknown = JSON.parse(eth_getBlockByNumber_goerli_8443561_false)
if (!isRecord(blockResponse) || !isRecord(blockResponse.result)) throw new Error('Invalid block fixture')
const block = EthereumBlockHeader.parse({ ...blockResponse.result, transactions: [] })
if (block === null) throw new Error('Missing fixture block')
const rpcRequests: { method: string, elapsedMs: number }[] = []
const unexpectedMethods = new Set<string>()
let failSimulation = false
let injectedFailures = 0

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function simulationReturnData(call: unknown) {
	if (!isRecord(call)) throw new Error('Invalid fixture call')
	const input = call.input ?? call.data
	if (input === undefined || input === '0x') return new Uint8Array()
	if (typeof input !== 'string' || !input.startsWith('0x82ad56cb')) throw new Error('Unsupported fixture call data')
	const decoded = decodeFunctionDataStrict(Multicall3ABI, Uint8Array.from(Buffer.from(input.slice(2), 'hex')))
	if (decoded.functionName !== 'aggregate3') throw new Error('Expected aggregate balance query')
	const balance = encodeFunctionReturn(Multicall3ABI, 'getEthBalance', [0n])
	const result = encodeFunctionReturn(Multicall3ABI, 'aggregate3', [decoded.args[0].map(() => ({ success: true, returnData: balance }))])
	return Uint8Array.from(Buffer.from(result.slice(2), 'hex'))
}

const pageHtml = await Bun.file(new URL('./chromeCommunicationPage.html', import.meta.url)).text()
const server = Bun.serve({
	port: 0,
	hostname: '127.0.0.1',
	async fetch(request) {
		if (request.method !== 'POST') return new Response(pageHtml, { headers: { 'Content-Type': 'text/html' } })
		const rpc: unknown = await request.json()
		if (!isRecord(rpc) || typeof rpc.method !== 'string') return new Response('Invalid RPC request', { status: 400 })
		const started = performance.now()
		await delay(rpcDelayMs)
		let result: unknown
		switch (rpc.method) {
			case 'eth_chainId': result = new URL(request.url).pathname === '/rpc2' ? '0x2' : '0x1'; break
			case 'eth_blockNumber': result = `0x${ block.number.toString(16) }`; break
			case 'eth_getBlockByNumber': result = serialize(EthereumBlockHeader, { ...block, timestamp: new Date(), transactions: [] }); break
			case 'eth_getBalance':
			case 'eth_getTransactionCount':
			case 'eth_gasPrice':
			case 'eth_maxPriorityFeePerGas': result = '0x0'; break
			case 'eth_getCode': result = '0x'; break
			case 'eth_simulateV1': {
				if (failSimulation) {
					injectedFailures++
					rpcRequests.push({ method: rpc.method, elapsedMs: performance.now() - started })
					return Response.json({ jsonrpc: '2.0', id: rpc.id, error: { code: JSON_RPC_ERROR_CODE_RESOURCE_UNAVAILABLE, message: 'Benchmark RPC simulation failure' } })
				}
				const payload = Array.isArray(rpc.params) ? rpc.params[0] : undefined
				if (!isRecord(payload) || !Array.isArray(payload.blockStateCalls)) throw new Error('Invalid simulation request')
				result = serialize(EthSimulateV1Result, payload.blockStateCalls.map((stateCall: unknown, index: number) => {
					if (!isRecord(stateCall) || !Array.isArray(stateCall.calls)) throw new Error('Invalid simulation calls')
					return { number: block.number + BigInt(index + 1), hash: 0x1234n, timestamp: BigInt(Math.floor(Date.now() / 1000)), gasLimit: 30_000_000n, gasUsed: 0n, baseFeePerGas: 1n,
						calls: stateCall.calls.map((call: unknown) => ({ status: 'success' as const, gasUsed: 21_000n, logs: [], returnData: simulationReturnData(call) })) }
				}))
				break
			}

			case 'eth_getLogs': result = []; break
			default:
				unexpectedMethods.add(rpc.method)
				return Response.json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `Unsupported benchmark RPC: ${ rpc.method }` } })
		}
		rpcRequests.push({ method: rpc.method, elapsedMs: performance.now() - started })
		return Response.json({ jsonrpc: '2.0', id: rpc.id, result }, { headers: { 'Access-Control-Allow-Origin': '*' } })
	},
})
const networkA = { name: 'Benchmark A', chainId: '0x1', httpsRpc: `${ server.url }rpc1`, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
const networkB = { ...networkA, name: 'Benchmark B', httpsRpc: `${ server.url }rpc1-alternate`, primary: false }
const networkC = { ...networkA, name: 'Benchmark chain 2', chainId: '0x2', httpsRpc: `${ server.url }rpc2` }

const fakeSigner = `(() => {
	let chain = '0x1';
	const listeners = new Map();
	globalThis.__benchmarkRejectSwitch = false;
	const signer = {
		isMetaMask: true, selectedAddress: ${ JSON.stringify(walletA) }, isConnected: () => true,
		request: async ({ method, params }) => {
			if (method === 'eth_chainId') return chain;
			if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [${ JSON.stringify(walletA) }];
			if (method !== 'wallet_switchEthereumChain') throw new Error('Unsupported benchmark wallet method: ' + method);
			await new Promise(resolve => setTimeout(resolve, ${ walletDelayMs }));
			if (globalThis.__benchmarkHoldSwitch) await new Promise(resolve => { globalThis.__benchmarkReleaseSwitch = resolve; });
			if (globalThis.__benchmarkRejectSwitch) throw Object.assign(new Error('Benchmark wallet rejected network change'), { code: 4001 });
			chain = params[0].chainId;
			for (const listener of listeners.get('chainChanged') ?? []) listener(chain);
			return null;
		},
		on: (event, listener) => { listeners.set(event, [...listeners.get(event) ?? [], listener]); return signer; },
		removeListener: (event, listener) => { listeners.set(event, (listeners.get(event) ?? []).filter(value => value !== listener)); return signer; }
	};
	globalThis.ethereum = signer;
	globalThis.addEventListener('eip6963:requestProvider', () => globalThis.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
		detail: { info: { uuid: '12345678-1234-4234-8234-123456789abc', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' }, provider: signer }
	})));
})()`

async function waitFor(connection: CdpConnection, expression: string, label: string) {
	const deadline = Date.now() + 30_000
	while (!await connection.evaluate<boolean>(expression)) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${ label }: ${ await connection.evaluate<string>('document.body.textContent') }`)
		await delay(25)
	}
}
const modeButton = (name: string) => `Array.from(document.querySelectorAll('.popup-home-mode-selector button')).find(button => button.textContent.trim() === ${ JSON.stringify(name) })`
const rpcButton = (name: string) => `Array.from(document.querySelectorAll('.popup-home-rpc-selector .dropdown-item')).find(button => button.textContent.trim() === ${ JSON.stringify(name) })`
const ready = `document.querySelector('.popup-home-rpc-selector .dropdown-trigger > button')?.disabled === false && !document.querySelector('.popup-settings-change-status') && !document.querySelector('.popup-home-header-layout [aria-busy="true"]')`

type SwitchSample = {
	name: string
	feedbackFrameMs: number
	selectionFrameMs?: number
	replyMs: number
	persistedMs?: number
	completedFrameMs: number
	ok: boolean
	rpcRequests: number
}

async function measure(popup: CdpConnection, name: string, method: string, click: string, pending: string, selected: string, expectedSuccess = true) {
	await popup.send('Page.bringToFront')
	await waitFor(popup, ready, 'popup ready for switching')
	console.warn(`Measuring ${ name }`)
	const rpcStart = rpcRequests.length
	const sample = await popup.evaluate<Omit<SwitchSample, 'rpcRequests'>>(`(async () => {
		const runtime = browser.runtime;
		const original = runtime.sendMessage;
		const started = performance.now();
		const sample = { name: ${ JSON.stringify(name) } };
		const errorCountBefore = document.querySelectorAll('.error-notification').length;
		let replyReceived = false;
		const storageKey = { popup_changeActiveAddress: 'independentActiveSimulationAddress', popup_enableSimulationMode: 'simulationMode', popup_changeActiveRpc: 'activeRpcNetwork', popup_modifyMakeMeRich: 'makeCurrentAddressRich' }[${ JSON.stringify(method) }];
		const onStorageChange = changes => { if (storageKey in changes && sample.persistedMs === undefined) sample.persistedMs = performance.now() - started; };
		browser.storage.onChanged.addListener(onStorageChange);
		runtime.sendMessage = function(message, ...args) {
			const promise = original.call(runtime, message, ...args);
			if (message.method === ${ JSON.stringify(method) }) promise.then(reply => {
				sample.replyMs = performance.now() - started;
				sample.ok = reply?.ok === true;
				replyReceived = true;
			}, error => { sample.error = String(error); replyReceived = true; });
			return promise;
		};
		try {
			try { ${ click }; } catch (error) { throw new Error(${ JSON.stringify(name) } + ': ' + String(error) + ' ' + document.body.textContent); }
			while (performance.now() - started < 30000) {
				await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Popup stopped rendering frames')), 30000); requestAnimationFrame(() => { clearTimeout(timeout); resolve(); }); });
				if ((${ pending }) && sample.feedbackFrameMs === undefined) sample.feedbackFrameMs = performance.now() - started;
				if ((${ selected }) && sample.selectionFrameMs === undefined) sample.selectionFrameMs = performance.now() - started;
				if (sample.feedbackFrameMs === undefined && (sample.selectionFrameMs !== undefined || document.querySelectorAll('.error-notification').length > errorCountBefore)) sample.feedbackFrameMs = performance.now() - started;
				if (replyReceived && !(${ pending })) {
					sample.completedFrameMs = performance.now() - started;
					return sample;
				}
			}
			throw new Error('Switch timed out: ' + ${ JSON.stringify(name) });
		} finally { runtime.sendMessage = original; browser.storage.onChanged.removeListener(onStorageChange); }
	})()`)
	if (sample.ok !== expectedSuccess) throw new Error(`Unexpected switch outcome: ${ JSON.stringify(sample) }`)
	if (sample.feedbackFrameMs === undefined) throw new Error(`No switching feedback was rendered: ${ JSON.stringify(sample) }`)
	if (expectedSuccess && sample.selectionFrameMs === undefined) throw new Error(`Selected value was not rendered: ${ JSON.stringify(sample) }`)
	if (expectedSuccess && sample.persistedMs === undefined) throw new Error(`Successful switch did not report persistence: ${ JSON.stringify(sample) }`)
	return { ...sample, rpcRequests: rpcRequests.length - rpcStart }
}

async function runIteration() {
	const chrome = await launchChromeSession()
	const connections: CdpConnection[] = []
	try {
		const worker = await waitForInterceptorExtensionServiceWorker(chrome.browserDebugPort, 30_000)
		const workerConnection = await connectTarget(chrome.browserDebugPort, worker.id)
		connections.push(workerConnection)
		await waitForPerformanceMarks(workerConnection, ['interceptor:background:loaded'], 30_000)
		await waitForRegisteredContentScripts(workerConnection, ['inpage', 'inpage2'], 30_000)
		await workerConnection.evaluate(`browser.storage.local.set(${ JSON.stringify({
			simulationMode: true, useSignersAddressAsActiveAddress: false, independentActiveSimulationAddress: walletA,
			makeCurrentAddressRich: false, rpcEntries: [networkA, networkB, networkC],
			websiteAccess: [{ website: { websiteOrigin: server.url.host }, access: true, addressAccess: [walletA, walletB].map(address => ({ address, access: true })) }],
			userAddressBookEntriesV3: [walletA, walletB].map((address, index) => ({ type: 'contact', address, name: `Wallet ${ index === 0 ? 'A' : 'B' }`, entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: false })),
		}) })`)
		const popupUrl = `chrome-extension://${ new URL(worker.url).host }/html3/popupV3.html`
		const popupTarget = await createTargetPage(chrome.browserConnection, popupUrl)
		const popup = await connectTarget(chrome.browserDebugPort, popupTarget)
		connections.push(popup)
		await waitFor(popup, `typeof browser !== 'undefined'`, 'popup runtime')
		await popup.evaluate(`browser.runtime.sendMessage({ method: 'popup_changeActiveRpc', data: ${ JSON.stringify(networkA) } })`)
		const page = await connectTarget(chrome.browserDebugPort, await createTargetPage(chrome.browserConnection, 'about:blank'))
		connections.push(page)
		await page.send('Page.enable')
		await page.send('Page.addScriptToEvaluateOnNewDocument', { source: fakeSigner })
		await page.send('Page.navigate', { url: server.url.toString() })
		await waitFor(page, `globalThis.__interceptorChromeCommunicationState?.phase === 'access-granted'`, 'fixture account access')
		await popup.evaluate(`browser.runtime.sendMessage({ method: 'popup_requestNewHomeData', data: { refreshSignerAccounts: true, includeWebsiteAccessAddressMetadata: false } })`)
		const samples: SwitchSample[] = []
		await waitFor(popup, ready, 'ready popup')
		await popup.evaluate(`Array.from(document.querySelectorAll('.active-address-row button')).find(button => button.textContent.trim() === 'Change').click()`)
		await waitFor(popup, `Array.from(document.querySelectorAll('.modal-card-body .card.hoverable')).some(card => card.textContent.includes('Wallet B'))`, 'wallet selector')
		samples.push(await measure(popup, 'wallet', 'popup_changeActiveAddress', `Array.from(document.querySelectorAll('.modal-card-body .card.hoverable')).find(card => card.textContent.includes('Wallet B')).click()`, `!!document.querySelector('.active-address-row[aria-busy="true"]')`, `document.querySelector('.active-address-row')?.textContent.includes('Wallet B')`))
		samples.push(await measure(popup, 'rich on', 'popup_modifyMakeMeRich', `document.querySelector('input[type="checkbox"]').click()`, `document.body.textContent.includes('Updating balances...')`, `document.querySelector('input[type="checkbox"]')?.checked === true`))
		samples.push(await measure(popup, 'rich off', 'popup_modifyMakeMeRich', `document.querySelector('input[type="checkbox"]').click()`, `document.body.textContent.includes('Updating balances...')`, `document.querySelector('input[type="checkbox"]')?.checked === false`))
		samples.push(await measure(popup, 'RPC endpoint', 'popup_changeActiveRpc', `${ rpcButton(networkB.name) }.click()`, `!!document.querySelector('.popup-home-rpc-selector [role="status"]')`, `document.querySelector('.popup-home-rpc-selector .dropdown-trigger button')?.title === ${ JSON.stringify(networkB.name) }`))
		samples.push(await measure(popup, 'signing', 'popup_enableSimulationMode', `${ modeButton('Signing') }.click()`, `${ modeButton('Signing') }?.getAttribute('aria-busy') === 'true'`, `${ modeButton('Signing') }?.classList.contains('is-outlined') === false`))
		await page.evaluate('globalThis.__benchmarkRejectSwitch = true')
		const beforeRejection = await workerConnection.evaluate(`browser.storage.local.get(['activeRpcNetwork', 'rpcEntries'])`)
		samples.push(await measure(popup, 'wallet RPC rejection', 'popup_changeActiveRpc', `${ rpcButton(networkC.name) }.click()`, `!!document.querySelector('.popup-home-rpc-selector [role="status"]')`, 'false', false))
		const afterRejection = await workerConnection.evaluate(`browser.storage.local.get(['activeRpcNetwork', 'rpcEntries'])`)
		if (JSON.stringify(beforeRejection) !== JSON.stringify(afterRejection)) throw new Error('Rejected switch changed persisted RPC state')
		await page.evaluate('globalThis.__benchmarkRejectSwitch = false')
		samples.push(await measure(popup, 'wallet RPC acceptance', 'popup_changeActiveRpc', `${ rpcButton(networkC.name) }.click()`, `!!document.querySelector('.popup-home-rpc-selector [role="status"]')`, `document.querySelector('.popup-home-rpc-selector .dropdown-trigger button')?.title === ${ JSON.stringify(networkC.name) }`))
		samples.push(await measure(popup, 'simulating', 'popup_enableSimulationMode', `${ modeButton('Simulating') }.click()`, `${ modeButton('Simulating') }?.getAttribute('aria-busy') === 'true'`, `${ modeButton('Simulating') }?.classList.contains('is-outlined') === false`))
		const transaction = { from: BigInt(walletA), to: BigInt(walletB), value: 0n, input: new Uint8Array() }
		const stack: InterceptorTransactionStack = { operations: [{ type: 'Transaction', preSimulationTransaction: {
			signedTransaction: mockSignTransaction({ type: '1559', ...transaction, nonce: 0n, gas: 21_000n, chainId: 2n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
			website: { websiteOrigin: server.url.host }, created: new Date(), originalRequestParameters: { method: 'eth_sendTransaction', params: [{ ...transaction, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }] },
			transactionIdentifier: 1n, simulationOptions: { requiredChainId: 2n, simulateWithZeroBaseFee: false },
		} }] }
		await workerConnection.evaluate(`browser.storage.local.set({ interceptorTransactionStack: ${ JSON.stringify(serialize(InterceptorTransactionStack, stack)) } })`)
		await popup.evaluate(`browser.runtime.sendMessage({ method: 'popup_refreshSimulation' })`)
		await waitFor(popup, `document.body.textContent.includes('Contract Fallback Method')`, 'populated simulation stack')
		samples.push(await measure(popup, 'stacked rich on', 'popup_modifyMakeMeRich', `document.querySelector('input[type="checkbox"]').click()`, `document.body.textContent.includes('Updating balances...')`, `document.querySelector('input[type="checkbox"]')?.checked === true`))
		// Change the input before injecting failure so an earlier successful cached response cannot satisfy the request.
		await workerConnection.evaluate(`browser.storage.local.set({ preSimulationBlockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: '0x9d', deltaUnit: 'Seconds' } })`)
		const failuresBefore = injectedFailures
		failSimulation = true
		try {
			samples.push(await measure(popup, 'stacked rich off with RPC failure', 'popup_modifyMakeMeRich', `document.querySelector('input[type="checkbox"]').click()`, `document.body.textContent.includes('Updating balances...')`, `document.querySelector('input[type="checkbox"]')?.checked === false`))
			if (injectedFailures === failuresBefore) throw new Error('RPC failure scenario did not exercise the fixture')
			await waitFor(popup, `document.body.textContent.includes('Benchmark RPC simulation failure')`, 'visible RPC simulation failure')
		} finally { failSimulation = false }
		await popup.evaluate(`browser.runtime.sendMessage({ method: 'popup_refreshSimulation' })`)
		await waitFor(popup, `!document.body.textContent.includes('Benchmark RPC simulation failure')`, 'RPC recovery')
		await popup.evaluate(`browser.runtime.sendMessage({ method: 'popup_enableSimulationMode', data: false })`)
		const second = await connectTarget(chrome.browserDebugPort, await createTargetPage(chrome.browserConnection, popupUrl))
		connections.push(second)
		await waitFor(second, ready, 'second popup ready')
		await page.evaluate('globalThis.__benchmarkHoldSwitch = true; globalThis.__benchmarkRejectSwitch = true')
		await popup.evaluate(`${ rpcButton(networkA.name) }.click()`)
		await waitFor(page, `typeof globalThis.__benchmarkReleaseSwitch === 'function'`, 'held wallet switch')
		const sharedBusy = `!!document.querySelector('.popup-settings-change-status') && document.querySelector('.active-address-row .media-right > button')?.disabled === true && Array.from(document.querySelectorAll('.popup-home-mode-selector button, .popup-home-rpc-selector .dropdown-trigger button, input[type="checkbox"]')).every(button => button.disabled)`
		await waitFor(second, sharedBusy, 'pending status in second popup')
		const conflict = await second.evaluate<{ ok: boolean }>(`browser.runtime.sendMessage({ method: 'popup_enableSimulationMode', data: true })`)
		if (conflict.ok !== false) throw new Error('Second popup bypassed background coordination')
		await chrome.browserConnection.send('Target.closeTarget', { targetId: popupTarget })
		const reopened = await connectTarget(chrome.browserDebugPort, await createTargetPage(chrome.browserConnection, popupUrl))
		connections.push(reopened)
		await waitFor(reopened, sharedBusy, 'pending status after close and reopen')
		await page.evaluate('globalThis.__benchmarkHoldSwitch = false; globalThis.__benchmarkReleaseSwitch()')
		await waitFor(second, ready, 'second popup released after wallet rejection')
		await waitFor(reopened, ready, 'reopened popup released after wallet rejection')
		if (await reopened.evaluate(`!!document.querySelector('.popup-settings-change-status')`)) throw new Error('Stale pending status after completion')
		return samples
	} finally {
		for (const connection of connections) connection.close()
		await chrome.close()
	}
}
function timingStats(values: number[]) {
	const sorted = values.toSorted((first, second) => first - second)
	return { minMs: sorted[0], medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted.at(-1) }
}

async function main() {
	const samples: SwitchSample[] = []
	for (let iteration = 0; iteration < iterations; iteration++) samples.push(...await runIteration())
	for (const sample of samples.filter(sample => sample.name.startsWith('wallet RPC'))) {
		if (sample.replyMs < walletDelayMs) throw new Error('Wallet switch completed before the fixture wallet replied')
	}
	if (unexpectedMethods.size > 0) throw new Error(`Missing fixture RPC methods: ${ [...unexpectedMethods].join(', ') }`)
	const summaries = [...new Set(samples.map(sample => sample.name))].map(name => {
		const group = samples.filter(sample => sample.name === name)
		return {
			name,
			feedback: timingStats(group.map(sample => sample.feedbackFrameMs)),
			persistence: timingStats(group.flatMap(sample => sample.persistedMs === undefined ? [] : [sample.persistedMs])),
			reply: timingStats(group.map(sample => sample.replyMs)),
			selection: timingStats(group.flatMap(sample => sample.selectionFrameMs === undefined ? [] : [sample.selectionFrameMs])),
			completion: timingStats(group.map(sample => sample.completedFrameMs)),
		}
	})
	process.stdout.write(JSON.stringify({ rpcDelayMs, walletDelayMs, iterations, fixture: 'empty and one-transaction stacks, local RPC including failure/recovery, fake EIP-6963 wallet, concurrent and reopened popups', summaries, samples }, undefined, 2) + '\n')
}
try { await main() } finally { server.stop(true) }
