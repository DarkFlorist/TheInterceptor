import { createBrowserSimulationRpc, type JsonRpcRequest } from '../fixtures/browserSimulationRpc.js'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { GNOSIS_SAFE_ABI, createGnosisSafeTx, gnosisSafeTxToTypedDataJson } from '../../app/ts/gnosisSafe/gnosisSafeCore.js'
import { EIP712Message } from '../../app/ts/types/eip721.js'
import { GnosisSafeStackExport, GnosisSafeTransactionStacks } from '../../app/ts/types/gnosisSafeTypes.js'
import { InterceptorTransactionStack } from '../../app/ts/types/visualizer-types.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { encodeFunctionCall, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { addressString, bytes32String, dataStringWith0xStart } from '../../app/ts/utils/bigint.js'
import { getGnosisSafeTxHash } from '../../app/ts/utils/eip712.js'
import { privateKeyToAccount } from '../../app/ts/utils/ethereumPrimitives.js'
import { encodeStorageReaderCall } from '../../app/ts/simulation/storageReader.js'
import { closeTarget, connectTarget, createTargetPage, launchChromeSession, readExtensionLargeStateValue, waitForInterceptorExtensionServiceWorker, waitForPerformanceMarks, waitForRegisteredContentScripts, waitForTargetByUrl, waitForTargetGone } from './chromeHarness.js'
import type { CdpConnection } from './chromeHarness.js'

// Native Gnosis Safe Apps hosting uses the shared browser runner with a real extension-owned iframe. This benchmark owns ordinary EIP-1193 co-signing and stack handoff only.
if (process.argv.length > 2) throw new Error('This co-signing benchmark accepts no flags. Use bun run test:browser:native-hosting for real Gnosis Safe Apps hosting.')
const ACCESS_APPROVE_BUTTON_SELECTOR = 'nav.popup-button-row button.is-primary:not(.is-danger)'
const CONFIRM_APPROVE_BUTTON_SELECTOR = 'nav.popup-button-row button.dialog-action-button.is-primary:not(.is-danger)'
const GNOSIS_SAFE_ADDRESS = 0x1234567890123456789012345678901234567890n
const GNOSIS_SAFE_SINGLETON_ADDRESS = 0x41675c099f32341bf84bfc5382af534df5c7461an
const DESTINATION_ADDRESS = 0x9876543210987654321098765432109876543210n
const OWNER_ACCOUNT = privateKeyToAccount('0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd')
const OWNER_ADDRESS = BigInt(OWNER_ACCOUNT.address)
const GNOSIS_SAFE_TX = createGnosisSafeTx(1n, GNOSIS_SAFE_ADDRESS, {
	to: DESTINATION_ADDRESS,
	value: 0n,
	input: new Uint8Array(),
}, 7n)
const GNOSIS_SAFE_TX_HASH = BigInt(getGnosisSafeTxHash(GNOSIS_SAFE_TX))
const GNOSIS_SAFE_TYPED_DATA = gnosisSafeTxToTypedDataJson(GNOSIS_SAFE_TX)
const GNOSIS_SAFE_SIGNATURE = await OWNER_ACCOUNT.signTypedData(EIP712Message.parse(GNOSIS_SAFE_TYPED_DATA))
const UNSIGNED_STACK = {
	chainId: 1n,
	safeAddress: GNOSIS_SAFE_ADDRESS,
	safeVersion: '1.4.1',
	baseNonce: 7n,
	threshold: 2n,
	transactions: [{
		safeTx: GNOSIS_SAFE_TX,
		safeTxHash: GNOSIS_SAFE_TX_HASH,
		created: new Date('2026-07-28T00:00:00.000Z'),
		websiteOrigin: 'http://safe-cosigning.test',
		transactionIdentifier: 1n,
		signatures: [],
	}],
}
const UNSIGNED_STACK_EXPORT = {
	name: 'Interceptor Safe Stack' as const,
	version: '1.0.0' as const,
	stacks: [UNSIGNED_STACK],
}
const UNSIGNED_STACK_JSON = JSON.stringify(GnosisSafeStackExport.serialize(UNSIGNED_STACK_EXPORT), undefined, '\t')
const SIGNED_MESSAGE_STACK = {
	operations: [{
		type: 'Message' as const,
		signedMessageTransaction: {
			website: { websiteOrigin: 'https://signed-message.example', icon: undefined, title: 'Signed message' },
			created: new Date('2026-07-28T00:00:00.000Z'),
			activeAddress: GNOSIS_SAFE_ADDRESS,
			fakeSignedFor: GNOSIS_SAFE_ADDRESS,
			originalRequestParameters: { method: 'personal_sign' as const, params: ['0x68656c6c6f', GNOSIS_SAFE_ADDRESS] },
			request: {
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 999, requestSocket: { tabId: 1, connectionName: 0n } },
				method: 'personal_sign' as const,
				params: ['0x68656c6c6f', addressString(GNOSIS_SAFE_ADDRESS)],
			},
			simulationMode: true,
			messageIdentifier: 999n,
		},
	}],
}
const STORAGE_READER_CALL = dataStringWith0xStart(encodeStorageReaderCall(0n))

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
	})()`).catch(() => false), timeoutMs, `button ${ selector } to be enabled`).catch(async (error: unknown) => {
		const body = await connection.evaluate('document.body.textContent')
		throw new Error(`Button ${ selector } did not become enabled: ${ body }`, { cause: error })
	})
}

async function clickButton(connection: CdpConnection, selector: string) {
	await connection.evaluate(`(() => {
		const element = document.querySelector(${ JSON.stringify(selector) })
		if (!(element instanceof HTMLButtonElement)) throw new Error('Could not find button ${ selector }')
		element.click()
	})()`)
}

async function clickButtonWithText(connection: CdpConnection, text: string) {
	await connection.evaluate(`(() => {
		const element = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes(${ JSON.stringify(text) }))
		if (!(element instanceof HTMLButtonElement)) throw new Error('Could not find button containing ${ text }')
		if (element.disabled) throw new Error('Button containing ${ text } is disabled')
		element.click()
	})()`)
}

async function waitForText(connection: CdpConnection, text: string, timeoutMs = 30_000) {
	await waitForCondition(
		async () => await connection.evaluate<boolean>(`document.body.textContent?.includes(${ JSON.stringify(text) }) === true`).catch(() => false),
		timeoutMs,
		`text ${ text }`,
	)
}

async function setFileInput(connection: CdpConnection, selector: string, filePath: string) {
	const document = await connection.send<{ root: { nodeId: number } }>('DOM.getDocument')
	const input = await connection.send<{ nodeId: number }>('DOM.querySelector', {
		nodeId: document.root.nodeId,
		selector,
	})
	if (input.nodeId === 0) throw new Error(`Could not find file input ${ selector }`)
	await connection.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [filePath] })
}

const { handleRpcRequest, safeStateReadCalls, safeCallResults } = createBrowserSimulationRpc({ safeAddress: GNOSIS_SAFE_ADDRESS, singletonAddress: GNOSIS_SAFE_SINGLETON_ADDRESS, ownerAddress: OWNER_ADDRESS, extraCallResults: [
	[encodeFunctionCall(GNOSIS_SAFE_ABI, 'getTransactionHash', [
		addressString(GNOSIS_SAFE_TX.message.to),
		GNOSIS_SAFE_TX.message.value,
		'0x',
		GNOSIS_SAFE_TX.message.operation,
		GNOSIS_SAFE_TX.message.safeTxGas,
		GNOSIS_SAFE_TX.message.baseGas,
		GNOSIS_SAFE_TX.message.gasPrice,
		addressString(GNOSIS_SAFE_TX.message.gasToken),
		addressString(GNOSIS_SAFE_TX.message.refundReceiver),
		GNOSIS_SAFE_TX.message.nonce,
	]), encodeFunctionReturn(GNOSIS_SAFE_ABI, 'getTransactionHash', [bytes32String(GNOSIS_SAFE_TX_HASH)])],
] })

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}


const communicationPageHtml = await readFile(new URL('./chromeCommunicationPage.html', import.meta.url), 'utf8')
const sealwortFixtureDirectory = path.resolve('test/fixtures/sealwort')
const sealwortExpectedSafeState = {
	chainId: '0x1',
	singletonAddress: addressString(GNOSIS_SAFE_SINGLETON_ADDRESS),
	singletonStorage: bytes32String(GNOSIS_SAFE_SINGLETON_ADDRESS),
	calls: safeStateReadCalls.map((data) => {
		const result = safeCallResults.get(data)
		if (result === undefined) throw new Error(`Missing Gnosis Safe test response for ${ data }`)
		return { data, result }
	}),
}
const rpcRequests: JsonRpcRequest[] = []
const server = Bun.serve({
	port: 0,
	hostname: '127.0.0.1',
	async fetch(request) {
		const url = new URL(request.url)
		if (request.method === 'POST' && url.pathname === '/rpc') {
			const rpcRequest = await request.json() as JsonRpcRequest
			rpcRequests.push(rpcRequest)
			try {
				return Response.json({ jsonrpc: '2.0', id: rpcRequest.id, result: await handleRpcRequest(rpcRequest) }, {
					headers: { 'Access-Control-Allow-Origin': '*' },
				})
			} catch (error) {
				return Response.json({
					jsonrpc: '2.0',
					id: rpcRequest.id,
					error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
				}, { headers: { 'Access-Control-Allow-Origin': '*' } })
			}
		}
		if (url.pathname === '/favicon.ico') return new Response(undefined, { status: 204 })
		if (url.pathname === '/sealwort' || url.pathname.startsWith('/sealwort/')) {
			if (url.pathname === '/sealwort/expected-safe-state.json') {
				return Response.json(sealwortExpectedSafeState, { headers: { 'Cache-Control': 'no-store' } })
			}
			const relativePath = url.pathname === '/sealwort' || url.pathname === '/sealwort/'
				? 'index.html'
				: url.pathname.slice('/sealwort/'.length)
			const file = Bun.file(path.join(sealwortFixtureDirectory, relativePath))
			if (!await file.exists()) return new Response('Not found', { status: 404 })
			return new Response(file, {
				headers: {
					'Cache-Control': 'no-store',
					'Content-Type': relativePath.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
				},
			})
		}
		return new Response(communicationPageHtml, {
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store',
			},
		})
	},
})
const testRpcNetwork = {
	name: 'Gnosis Safe co-signing test RPC',
	chainId: '0x1',
	httpsRpc: `http://127.0.0.1:${ server.port }/rpc`,
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
}

const fakeSignerPreload = `(() => {
	const requests = []
	let authorized = true
	const signer = {
		isMetaMask: true,
		selectedAddress: ${ JSON.stringify(addressString(OWNER_ADDRESS)) },
		isConnected: () => true,
		request: async ({ method, params }) => {
			requests.push({ method, params })
			switch (method) {
				case 'eth_chainId': return sessionStorage.getItem('fake-signer-block-chain') === 'true' ? new Promise(() => {}) : '0x1'
				case 'eth_accounts': return authorized ? [${ JSON.stringify(addressString(OWNER_ADDRESS)) }] : []
				case 'eth_requestAccounts': authorized = true; sessionStorage.setItem('fake-signer-authorized', 'true'); return [${ JSON.stringify(addressString(OWNER_ADDRESS)) }]
				case 'eth_signTypedData_v4':
					if (params?.[0]?.toLowerCase() !== ${ JSON.stringify(addressString(OWNER_ADDRESS).toLowerCase()) }) throw new Error('Unexpected Gnosis Safe signer account')
					if (JSON.stringify(params?.[1]) !== ${ JSON.stringify(JSON.stringify(GNOSIS_SAFE_TYPED_DATA)) }) throw new Error('Unexpected Gnosis Safe typed-data payload')
					return ${ JSON.stringify(GNOSIS_SAFE_SIGNATURE) }
				default: throw Object.assign(new Error('Unsupported fake signer method: ' + method), { code: -32601 })
			}
		},
		on: () => signer,
		removeListener: () => signer,
	}
	globalThis.__fakeSafeSignerRequests = requests
	globalThis.ethereum = signer
	globalThis.addEventListener('eip6963:requestProvider', () => globalThis.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
		detail: {
			info: { uuid: '55555555-5555-4555-8555-555555555555', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' },
			provider: signer,
		},
	})))
})()`

async function main() {
	const handoffDirectory = await mkdtemp(path.join(os.tmpdir(), 'interceptor-safe-handoff-'))
	const unsignedStackPath = path.join(handoffDirectory, 'unsigned-safe-stack.json')
	const downloadDirectory = path.join(handoffDirectory, 'downloads')
	await Bun.write(unsignedStackPath, UNSIGNED_STACK_JSON)
	await mkdir(downloadDirectory)
	const chrome = await launchChromeSession().catch(async (error) => {
		server.stop(true)
		await rm(handoffDirectory, { recursive: true, force: true })
		throw error
	})
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
			const storedSettings = {
				simulationMode: false,
				safeAppsCompatibilityMode: false,
				useSignersAddressAsActiveAddress: false,
				independentActiveSimulationAddress: addressString(GNOSIS_SAFE_ADDRESS),
				activeSigningAddress: addressString(OWNER_ADDRESS),
				activeSigningSafeAddress: addressString(GNOSIS_SAFE_ADDRESS),
				signingAddressPreferences: [{ signerAddress: addressString(OWNER_ADDRESS), selection: 'safe', safeAddress: addressString(GNOSIS_SAFE_ADDRESS), chainId: '0x1' }],
				userAddressBookEntriesV3: [{
					type: 'safe',
					name: 'Browser Test Gnosis Safe',
					address: addressString(GNOSIS_SAFE_ADDRESS),
					chainId: '0x1',
					entrySource: 'User',
					useAsActiveAddress: true,
					askForAddressAccess: false,
					safeSignerAddresses: [addressString(OWNER_ADDRESS)],
					safeSimulationSignerAddress: addressString(OWNER_ADDRESS),
					safeVersion: '1.4.1',
				}],
			}
			// Install the test RPC through the popup command below so persisted settings and live services change together.
			await workerConnection.evaluate(`browser.storage.local.set(${ JSON.stringify(storedSettings) })`)

		} finally {
			workerConnection.close()
		}
		const rpcSwitchTargetId = await createTargetPage(chrome.browserConnection, `chrome-extension://${ extensionId }/html3/popupV3.html`)
		const rpcSwitchConnection = await connectTarget(chrome.browserDebugPort, rpcSwitchTargetId)
		try {
			await waitForCondition(
				async () => await rpcSwitchConnection.evaluate<boolean>(`typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function'`).catch(() => false),
				10_000,
				'extension popup runtime',
			)
			const rpcSwitchResult = await rpcSwitchConnection.evaluate<{ error?: string }>(`(async () => {
				try {
					const reply = await chrome.runtime.sendMessage({
						method: 'popup_changeActiveRpc',
						data: ${ JSON.stringify(testRpcNetwork) },
					})
					if (reply?.ok !== true) throw new Error(reply?.message ?? 'Missing RPC switch acknowledgment')
					return {}
				} catch (error) {
					return { error: error instanceof Error ? error.message : String(error) }
				}
			})()`)
			if (rpcSwitchResult.error !== undefined) throw new Error(`Failed to switch to Gnosis Safe co-signing test RPC: ${ rpcSwitchResult.error }`)
		} finally {
			rpcSwitchConnection.close()
			await closeTarget(chrome.browserConnection, rpcSwitchTargetId)
		}

		pageTargetId = await createTargetPage(chrome.browserConnection, 'about:blank')
		const pageConnection = await connectTarget(chrome.browserDebugPort, pageTargetId)
		try {
			await pageConnection.send('Page.enable')
			await pageConnection.send('Page.addScriptToEvaluateOnNewDocument', { source: fakeSignerPreload })
			await pageConnection.send('Page.navigate', { url: `http://127.0.0.1:${ server.port }/` })
			try {
				await waitForCondition(async () => await pageConnection.evaluate(`globalThis.__interceptorChromeCommunicationState?.phase === 'requesting-access'`).catch(() => false), 30_000, 'Gnosis Safe access request')
			} catch (error) {
				const accessDiagnostics = await pageConnection.evaluate('({ state: globalThis.__interceptorChromeCommunicationState, signerRequests: globalThis.__fakeSafeSignerRequests, url: location.href, body: document.body.textContent })')
				throw new Error(`Gnosis Safe access request did not open: ${ JSON.stringify(accessDiagnostics) }`, { cause: error })
			}

			const accessTarget = await waitForTargetByUrl(chrome.browserDebugPort, `chrome-extension://${ extensionId }/html3/interceptorAccessV3.html`, 30_000).catch(async (error: unknown) => {
				const diagnostics = await pageConnection.evaluate('({ state: globalThis.__interceptorChromeCommunicationState, signerRequests: globalThis.__fakeSafeSignerRequests, ordinaryError: globalThis.__ordinarySafeAccessError, providerAtAccess: globalThis.__ordinarySafeAccessProvider, providerIsInterceptor: window.ethereum?.isInterceptor })')
				throw new Error(`Gnosis Safe access popup did not open: ${ JSON.stringify(diagnostics) }`, { cause: error })
			})
			accessTargetId = accessTarget.id
			const accessConnection = await connectTarget(chrome.browserDebugPort, accessTarget.id)
			try {
				await waitForButtonEnabled(accessConnection, ACCESS_APPROVE_BUTTON_SELECTOR, 30_000)
				await clickButton(accessConnection, ACCESS_APPROVE_BUTTON_SELECTOR)
			} finally {
				accessConnection.close()
			}

			try {
				await waitForCondition(async () => await pageConnection.evaluate(`globalThis.__interceptorChromeCommunicationState?.phase === 'access-granted'`).catch(() => false), 30_000, 'Gnosis Safe access approval')
			} catch (error) {
				const pageDiagnostics = await pageConnection.evaluate('({ state: globalThis.__interceptorChromeCommunicationState, signerRequests: globalThis.__fakeSafeSignerRequests })')
				throw new Error(`Gnosis Safe access approval failed: ${ JSON.stringify(pageDiagnostics) }`, { cause: error })
			}
			const grantedAccounts = await pageConnection.evaluate<readonly string[]>('globalThis.__interceptorChromeCommunicationState.accounts')
			if (grantedAccounts[0]?.toLowerCase() !== addressString(GNOSIS_SAFE_ADDRESS).toLowerCase()) {
				throw new Error(`Dapp received ${ grantedAccounts[0] ?? 'no account' } instead of the Gnosis Safe address`)
			}
			const tabStateConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
			try {
				await tabStateConnection.evaluate(`(async () => {
					const tabs = await browser.tabs.query({})
					const pageTab = tabs.find((tab) => tab.url?.startsWith(${ JSON.stringify(`http://127.0.0.1:${ server.port }/`) }))
					if (pageTab?.id === undefined) throw new Error('Gnosis Safe co-signing page tab was not found')
					const key = 'tabState_' + pageTab.id
					const stored = await browser.storage.local.get(key)
					const current = stored[key]
					if (current === undefined) throw new Error('Gnosis Safe co-signing tab state was not initialized')
					await browser.storage.local.set({ [key]: {
						...current,
						signerConnected: true,
						signerName: 'MetaMask',
						signerAccounts: [${ JSON.stringify(addressString(OWNER_ADDRESS)) }],
						signerChain: '0x1',
						activeSigningAddress: ${ JSON.stringify(addressString(OWNER_ADDRESS)) },
					} })
				})()`)
			} finally {
				tabStateConnection.close()
			}

			await pageConnection.evaluate(`(() => {
				globalThis.__safeCoSigningResult = { status: 'pending' }
				globalThis.ethereum.request({
					method: 'eth_signTypedData_v4',
					params: [${ JSON.stringify(addressString(GNOSIS_SAFE_ADDRESS)) }, ${ JSON.stringify(GNOSIS_SAFE_TYPED_DATA) }],
				})
					.then((result) => { globalThis.__safeCoSigningResult = { status: 'fulfilled', result } })
					.catch((error) => { globalThis.__safeCoSigningResult = { status: 'rejected', error: error instanceof Error ? error.message : String(error) } })
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

			try {
				await waitForCondition(async () => await pageConnection.evaluate(`globalThis.__fakeSafeSignerRequests?.some(({ method }) => method === 'eth_signTypedData_v4')`).catch(() => false), 10_000, 'configured EOA signer request')
			} catch (error) {
				const pageDiagnostics = await pageConnection.evaluate('({ result: globalThis.__safeCoSigningResult, signerRequests: globalThis.__fakeSafeSignerRequests })')
				const confirmDiagnosticsConnection = await connectTarget(chrome.browserDebugPort, confirmTarget.id)
				const confirmText = await confirmDiagnosticsConnection.evaluate('document.body.textContent')
				confirmDiagnosticsConnection.close()
				throw new Error(`Gnosis Safe signer forwarding failed. Page: ${ JSON.stringify(pageDiagnostics) }. Confirmation: ${ JSON.stringify(confirmText) }. RPC: ${ JSON.stringify(rpcRequests) }`, { cause: error })
			}
			const signerRequest = await pageConnection.evaluate<{ method: string, params?: readonly unknown[] }>(`globalThis.__fakeSafeSignerRequests.find(({ method }) => method === 'eth_signTypedData_v4')`)
			if (typeof signerRequest.params?.[0] !== 'string' || signerRequest.params[0].toLowerCase() !== addressString(OWNER_ADDRESS).toLowerCase()) {
				throw new Error(`Interceptor did not substitute the wallet-selected Gnosis Safe owner: expected ${ addressString(OWNER_ADDRESS) }, received ${ JSON.stringify(signerRequest.params?.[0]) }`)
			}
			await waitForCondition(async () => await pageConnection.evaluate(`globalThis.__safeCoSigningResult?.status === 'fulfilled'`).catch(() => false), 10_000, 'Gnosis Safe co-signature result')
			const signingResult = await pageConnection.evaluate<{ status?: string, result?: string }>('globalThis.__safeCoSigningResult')
			if (signingResult.result !== GNOSIS_SAFE_SIGNATURE) throw new Error(`Unexpected Gnosis Safe co-signature result: ${ signingResult.result ?? 'missing' }`)
			await waitForTargetGone(chrome.browserDebugPort, (target) => target.id === confirmTarget.id, 10_000, 'initial Gnosis Safe confirmation window')
			confirmTargetId = undefined

			const stackSeedConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
			try {
				await stackSeedConnection.evaluate(`browser.storage.local.set({
					safeTransactionStacks: ${ JSON.stringify(serialize(GnosisSafeTransactionStacks, [UNSIGNED_STACK])) },
					interceptorTransactionStack: ${ JSON.stringify(serialize(InterceptorTransactionStack, SIGNED_MESSAGE_STACK)) },
				})`)
			} finally {
				stackSeedConnection.close()
			}

			await chrome.browserConnection.send('Browser.setDownloadBehavior', {
				behavior: 'allow',
				downloadPath: downloadDirectory,
				eventsEnabled: true,
			})
			await pageConnection.send('Page.navigate', { url: `http://127.0.0.1:${ server.port }/sealwort/` })
			await waitForText(pageConnection, 'Review. Verify. Sign. Return.')
			await waitForCondition(
				async () => await pageConnection.evaluate<boolean>('typeof globalThis.__sealwortFixture?.connect === "function"').catch(() => false),
				10_000,
				'Gnosis Safe co-signer fixture API',
			)
			const sealwortInspectionRpcStart = rpcRequests.length
			await pageConnection.evaluate('globalThis.__sealwortFixture.connect()')
			try {
				await waitForText(pageConnection, addressString(GNOSIS_SAFE_ADDRESS))
				await waitForText(pageConnection, 'Gnosis Safe account inspection complete.')
			} catch (error) {
				const fixtureDiagnostics = await pageConnection.evaluate(`(async () => ({
					text: document.body.textContent,
					html: document.documentElement.outerHTML,
					loaded: globalThis.__sealwortFixtureLoaded,
					resources: performance.getEntriesByType('resource').map(({ name }) => name),
					script: await fetch('./main.js').then(async (response) => ({ status: response.status, type: response.headers.get('content-type'), text: await response.text() })),
				}))()`)
				const failureDiagnosticsConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
				const extensionDiagnostics = await failureDiagnosticsConnection.evaluate(`browser.storage.local.get(['latestUnexpectedError', 'interceptorErrorDiagnostics'])`)
				failureDiagnosticsConnection.close()
				throw new Error(`Gnosis Safe co-signer fixture did not connect. Page: ${ JSON.stringify(fixtureDiagnostics) }. Extension: ${ JSON.stringify(extensionDiagnostics) }. RPC: ${ JSON.stringify(rpcRequests.slice(sealwortInspectionRpcStart)) }`, { cause: error })
			}
			const sealwortInspectionRpcRequests = rpcRequests.slice(sealwortInspectionRpcStart)
			const sealwortSimulationRequests = sealwortInspectionRpcRequests.filter((rpcRequest) => rpcRequest.method === 'eth_simulateV1')
			const hasTransactionPreparationSimulation = sealwortSimulationRequests.some((rpcRequest) => {
				const [payload] = rpcRequest.params ?? []
				if (!isRecord(payload) || !Array.isArray(payload.blockStateCalls)) return false
				return payload.blockStateCalls.every((blockStateCall) => isRecord(blockStateCall) && Array.isArray(blockStateCall.calls) && blockStateCall.calls.length === 0)
			})
			if (hasTransactionPreparationSimulation) throw new Error('Sealwort Gnosis Safe inspection ran transaction preparation for a transaction-free overlay')
			const simulatedStorageLookup = sealwortSimulationRequests.some((rpcRequest) => {
				const [payload] = rpcRequest.params ?? []
				if (!isRecord(payload) || !Array.isArray(payload.blockStateCalls)) return false
				return payload.blockStateCalls.some((blockStateCall) => isRecord(blockStateCall)
					&& Array.isArray(blockStateCall.calls)
					&& blockStateCall.calls.some((call) => isRecord(call) && call.input === STORAGE_READER_CALL))
			})
			// SIGNED_MESSAGE_STACK belongs to simulation mode; Gnosis Safe signing inspection must not replay that unrelated overlay.
			const liveStorageLookup = sealwortInspectionRpcRequests.some((request) => request.method === 'eth_getStorageAt' && request.params?.[0] === addressString(GNOSIS_SAFE_ADDRESS) && request.params?.[1] === '0x0')
			if (!liveStorageLookup || simulatedStorageLookup) throw new Error('Gnosis Safe signing inspection did not isolate the simulation-mode message stack')
			const sealwortSignerStateConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
			try {
				await sealwortSignerStateConnection.evaluate(`(async () => {
					const tabs = await browser.tabs.query({})
					const pageTab = tabs.find((tab) => tab.url?.startsWith(${ JSON.stringify(`http://127.0.0.1:${ server.port }/sealwort/`) }))
					if (pageTab?.id === undefined) throw new Error('Sealwort tab was not found')
					const key = 'tabState_' + pageTab.id
					const stored = await browser.storage.local.get(key)
					const current = stored[key]
					if (current === undefined) throw new Error('Sealwort tab state was not initialized')
					await browser.storage.local.set({ [key]: {
						...current,
						signerConnected: true,
						signerName: 'MetaMask',
						signerAccounts: [${ JSON.stringify(addressString(OWNER_ADDRESS)) }],
						signerChain: '0x1',
						activeSigningAddress: ${ JSON.stringify(addressString(OWNER_ADDRESS)) },
					} })
				})()`)
			} finally {
				sealwortSignerStateConnection.close()
			}
			await setFileInput(pageConnection, '.file-input', unsignedStackPath)
			await pageConnection.evaluate('globalThis.__sealwortFixture.importSelectedFile()')
			await waitForText(pageConnection, 'Verify the transactions against current on-chain state before signing.')
			const unexpectedConsoleEntries: unknown[] = []
			const unexpectedErrorConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
			unexpectedErrorConnection.on('Runtime.consoleAPICalled', (event) => { unexpectedConsoleEntries.push(event) })
			await unexpectedErrorConnection.send('Runtime.enable')
			try {
				await pageConnection.evaluate('globalThis.__sealwortFixture.verify()')
			} catch (error) {
				const unexpectedError = await unexpectedErrorConnection.evaluate(`browser.storage.local.get('latestUnexpectedError')`)
				throw new Error(`Sealwort verification request failed. Unexpected error: ${ JSON.stringify(unexpectedError) }. Console: ${ JSON.stringify(unexpectedConsoleEntries) }`, { cause: error })
			} finally {
				unexpectedErrorConnection.close()
			}
			try {
				await waitForText(pageConnection, 'Verified 1 Gnosis Safe transaction(s) against current on-chain state.')
			} catch (error) {
				const sealwortDiagnostics = await pageConnection.evaluate('({ text: document.body.textContent, signerRequests: globalThis.__fakeSafeSignerRequests })')
				throw new Error(`Sealwort verification failed. Page: ${ JSON.stringify(sealwortDiagnostics) }. RPC: ${ JSON.stringify(rpcRequests) }`, { cause: error })
			}
			await waitForText(pageConnection, 'Interceptor signer route')
			await pageConnection.evaluate(`(() => {
				globalThis.__sealwortFixture.sign().catch((error) => {
					document.querySelector('#status').textContent = error instanceof Error ? error.message : String(error)
				})
			})()`)

			const sealwortConfirmTarget = await waitForTargetByUrl(chrome.browserDebugPort, `chrome-extension://${ extensionId }/html3/confirmTransactionV3.html`, 30_000)
			confirmTargetId = sealwortConfirmTarget.id
			const sealwortConfirmConnection = await connectTarget(chrome.browserDebugPort, sealwortConfirmTarget.id)
			try {
				await waitForButtonEnabled(sealwortConfirmConnection, CONFIRM_APPROVE_BUTTON_SELECTOR, 30_000)
				await clickButton(sealwortConfirmConnection, CONFIRM_APPROVE_BUTTON_SELECTOR)
			} finally {
				sealwortConfirmConnection.close()
			}
			try {
				await waitForText(pageConnection, 'Signature from')
			} catch (error) {
				const sealwortDiagnostics = await pageConnection.evaluate('({ text: document.body.textContent, signerRequests: globalThis.__fakeSafeSignerRequests })')
				throw new Error(`Sealwort signing failed. Page: ${ JSON.stringify(sealwortDiagnostics) }. RPC: ${ JSON.stringify(rpcRequests) }`, { cause: error })
			}
			await waitForText(pageConnection, 'Signature added')
			const safeSignerRequests = await pageConnection.evaluate<readonly { method: string, params?: readonly unknown[] }[]>(
				`(globalThis.__fakeSafeSignerRequests ?? []).filter(({ method }) => method === 'eth_signTypedData_v4')`
			)
			if (safeSignerRequests.length !== 1) {
				throw new Error(`Sealwort forwarded ${ safeSignerRequests.length.toString() } Gnosis Safe signing requests instead of one`)
			}
			await pageConnection.evaluate('globalThis.__sealwortFixture.download()')
			await waitForText(pageConnection, 'Updated Gnosis Safe stack downloaded.')
			await waitForCondition(async () => {
				const filenames = await readdir(downloadDirectory)
				return filenames.some((filename) => filename === 'interceptor-safe-stack.json')
			}, 10_000, 'downloaded Gnosis Safe stack')
			const downloadedStackPath = path.join(downloadDirectory, 'interceptor-safe-stack.json')
			const downloadedStackJson = await readFile(downloadedStackPath, 'utf8')
			const downloadedStack = GnosisSafeStackExport.parse(JSON.parse(downloadedStackJson))
			const downloadedSignature = downloadedStack.stacks[0]?.transactions[0]?.signatures[0]
			if (downloadedSignature?.signer !== OWNER_ADDRESS || downloadedSignature.signature !== GNOSIS_SAFE_SIGNATURE) {
				throw new Error('Sealwort download did not contain the routed EOA owner signature')
			}

			const preImportStackConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
			const preImportStacks = await readExtensionLargeStateValue<unknown>(preImportStackConnection, 'safeTransactionStacks')
				.finally(() => { preImportStackConnection.close() })
			const parsedPreImportStacks = GnosisSafeTransactionStacks.parse(preImportStacks)
			if (parsedPreImportStacks[0]?.transactions[0]?.signatures.length !== 0) {
				throw new Error('Gnosis Safe co-signing mutated the proposer stack before the returned file was imported')
			}

			const simulationStackTargetId = await createTargetPage(chrome.browserConnection, `chrome-extension://${ extensionId }/html3/simulationStackV3.html`)
			const simulationStackConnection = await connectTarget(chrome.browserDebugPort, simulationStackTargetId)
			try {
				await waitForText(simulationStackConnection, 'Gnosis Safe Stack')
				await clickButton(simulationStackConnection, 'button[aria-label="Import Gnosis Safe stack"]')
				await waitForText(simulationStackConnection, 'Import Interceptor Gnosis Safe Stack')
				await simulationStackConnection.evaluate(`(() => {
					const input = document.querySelector('.simulation-stack-import-input')
					if (!(input instanceof HTMLTextAreaElement)) throw new Error('Gnosis Safe import textarea was not found')
					input.value = ${ JSON.stringify(downloadedStackJson) }
					input.dispatchEvent(new InputEvent('input', { bubbles: true, data: input.value }))
				})()`)
				await clickButtonWithText(simulationStackConnection, 'Import signatures')
				await waitForCondition(
					async () => await simulationStackConnection.evaluate<boolean>(`document.body.textContent?.includes('Import Interceptor Gnosis Safe Stack') === false`).catch(() => false),
					30_000,
					'Gnosis Safe import modal to close',
				)
			} finally {
				simulationStackConnection.close()
				await closeTarget(chrome.browserConnection, simulationStackTargetId)
			}

			const stackReadConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
			const importedStacks = await readExtensionLargeStateValue<unknown>(stackReadConnection, 'safeTransactionStacks')
				.finally(() => { stackReadConnection.close() })
			const parsedImportedStacks = GnosisSafeTransactionStacks.parse(importedStacks)
			const importedSignature = parsedImportedStacks[0]?.transactions[0]?.signatures[0]
			if (importedSignature?.signer !== OWNER_ADDRESS || importedSignature.signature !== GNOSIS_SAFE_SIGNATURE) {
				throw new Error('Interceptor did not merge the downloaded Sealwort owner signature')
			}
			console.warn('Interceptor Chrome Gnosis Safe co-signing and Sealwort handoff test passed.')
		} finally {
			pageConnection.close()
		}
	} finally {
		if (confirmTargetId !== undefined) await closeTarget(chrome.browserConnection, confirmTargetId).catch(() => undefined)
		if (accessTargetId !== undefined) await closeTarget(chrome.browserConnection, accessTargetId).catch(() => undefined)
		if (pageTargetId !== undefined) await closeTarget(chrome.browserConnection, pageTargetId).catch(() => undefined)
		await chrome.close().catch(() => undefined)
		server.stop(true)
		await rm(handoffDirectory, { recursive: true, force: true })
	}
}

await main()
