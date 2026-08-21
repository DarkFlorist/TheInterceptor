import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { Multicall3ABI } from '../../app/ts/utils/constants.js'
import { SAFE_ABI, createSafeTx, safeTxToTypedDataJson } from '../../app/ts/safe/safeCore.js'
import { EIP712Message } from '../../app/ts/types/eip721.js'
import { EthSimulateV1Result } from '../../app/ts/types/ethSimulate-types.js'
import { SafeStackExport, SafeTransactionStacks } from '../../app/ts/types/safeTypes.js'
import { InterceptorTransactionStack } from '../../app/ts/types/visualizer-types.js'
import { EthereumBlockHeader, EthereumQuantity, serialize } from '../../app/ts/types/wire-types.js'
import { encodeFunctionCall, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { addressString, bytes32String, dataStringWith0xStart } from '../../app/ts/utils/bigint.js'
import { getSafeTxHash } from '../../app/ts/utils/eip712.js'
import { privateKeyToAccount } from '../../app/ts/utils/ethereumPrimitives.js'
import { encodeStorageReaderCall, STORAGE_READER_ABI } from '../../app/ts/simulation/storageReader.js'
import { closeTarget, connectTarget, createTargetPage, launchChromeSession, readExtensionLargeStateValue, waitForInterceptorExtensionServiceWorker, waitForPerformanceMarks, waitForRegisteredContentScripts, waitForTargetByUrl, waitForTargetGone } from './chromeHarness.js'
import type { CdpConnection } from './chromeHarness.js'

const ACCESS_APPROVE_BUTTON_SELECTOR = 'nav.popup-button-row button.is-primary:not(.is-danger)'
const CONFIRM_APPROVE_BUTTON_SELECTOR = 'nav.popup-button-row button.dialog-action-button.is-primary:not(.is-danger)'
const SAFE_ADDRESS = 0x1234567890123456789012345678901234567890n
const SAFE_SINGLETON_ADDRESS = 0x41675c099f32341bf84bfc5382af534df5c7461an
const DESTINATION_ADDRESS = 0x9876543210987654321098765432109876543210n
const GET_CODE_CONTRACT = 0x1ce438391307f908756fefe0fe220c0f0d51508an
const GET_CODE_ABI = [{
	type: 'function',
	name: 'at',
	stateMutability: 'view',
	inputs: [{ name: 'target', type: 'address' }],
	outputs: [{ name: 'code', type: 'bytes' }],
}] as const
const OWNER_ACCOUNT = privateKeyToAccount('0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd')
const OWNER_ADDRESS = BigInt(OWNER_ACCOUNT.address)
const SAFE_TX = createSafeTx(1n, SAFE_ADDRESS, {
	to: DESTINATION_ADDRESS,
	value: 0n,
	input: new Uint8Array(),
}, 7n)
const SAFE_TX_HASH = BigInt(getSafeTxHash(SAFE_TX))
const SAFE_TYPED_DATA = safeTxToTypedDataJson(SAFE_TX)
const SAFE_SIGNATURE = await OWNER_ACCOUNT.signTypedData(EIP712Message.parse(SAFE_TYPED_DATA))
const UNSIGNED_STACK = {
	chainId: 1n,
	safeAddress: SAFE_ADDRESS,
	safeVersion: '1.4.1',
	baseNonce: 7n,
	threshold: 2n,
	transactions: [{
		safeTx: SAFE_TX,
		safeTxHash: SAFE_TX_HASH,
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
const UNSIGNED_STACK_JSON = JSON.stringify(SafeStackExport.serialize(UNSIGNED_STACK_EXPORT), undefined, '\t')
const SIGNED_MESSAGE_STACK = {
	operations: [{
		type: 'Message' as const,
		signedMessageTransaction: {
			website: { websiteOrigin: 'https://signed-message.example', icon: undefined, title: 'Signed message' },
			created: new Date('2026-07-28T00:00:00.000Z'),
			activeAddress: SAFE_ADDRESS,
			fakeSignedFor: SAFE_ADDRESS,
			originalRequestParameters: { method: 'personal_sign' as const, params: ['0x68656c6c6f', SAFE_ADDRESS] },
			request: {
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 999, requestSocket: { tabId: 1, connectionName: 0n } },
				method: 'personal_sign' as const,
				params: ['0x68656c6c6f', addressString(SAFE_ADDRESS)],
			},
			simulationMode: true,
			messageIdentifier: 999n,
		},
	}],
}
const STORAGE_READER_CALL = dataStringWith0xStart(encodeStorageReaderCall(0n))
const STORAGE_READER_RESULT = encodeFunctionReturn(STORAGE_READER_ABI, 'readSlot', [bytes32String(SAFE_SINGLETON_ADDRESS)])

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

function makeFakeBlock() {
	return {
		author: 0n,
		difficulty: 0n,
		extraData: new Uint8Array(),
		gasLimit: 30_000_000n,
		gasUsed: 21_000n,
		hash: 0x1234n,
		logsBloom: 0n,
		miner: 0n,
		mixHash: 0n,
		nonce: 0n,
		number: 123n,
		parentHash: 0x1n,
		receiptsRoot: 0n,
		sha3Uncles: 0n,
		stateRoot: 0n,
		timestamp: new Date('2026-07-28T00:00:00.000Z'),
		size: 0n,
		totalDifficulty: 0n,
		uncles: [],
		baseFeePerGas: 1n,
		transactionsRoot: 0n,
		transactions: [],
		withdrawals: [],
		withdrawalsRoot: 0n,
	}
}

function makeFakeEthSimulateResult(calls: readonly unknown[]) {
	const balanceResult = encodeFunctionReturn(Multicall3ABI, 'getEthBalance', [0n])
	const aggregate3Result = encodeFunctionReturn(Multicall3ABI, 'aggregate3', [[{ success: true, returnData: balanceResult }]])
	return {
		number: 123n,
		hash: 0x9876n,
		timestamp: 0x65920080n,
		gasLimit: 30_000_000n,
		gasUsed: 21_000n,
		baseFeePerGas: 1n,
		calls: calls.map((call) => {
			const input = isRecord(call) && typeof call.input === 'string' ? call.input : undefined
			const to = isRecord(call) && typeof call.to === 'string' ? call.to : undefined
			const safeResult = to !== undefined && BigInt(to) === GET_CODE_CONTRACT
				? encodeFunctionReturn(GET_CODE_ABI, 'at', ['0x01'])
				: input === STORAGE_READER_CALL && to !== undefined && BigInt(to) === SAFE_ADDRESS
				? STORAGE_READER_RESULT
				: input !== undefined && to !== undefined && BigInt(to) === SAFE_ADDRESS
				? safeCallResults.get(input)
				: undefined
			const returnData = safeResult ?? aggregate3Result
			return {
				status: 'success' as const,
				gasUsed: 21_000n,
				logs: [],
				returnData: Uint8Array.from(Buffer.from(returnData.slice(2), 'hex')),
			}
		}),
	}
}

const safeStateReadCalls = [
	encodeFunctionCall(SAFE_ABI, 'VERSION', []),
	encodeFunctionCall(SAFE_ABI, 'nonce', []),
	encodeFunctionCall(SAFE_ABI, 'getOwners', []),
	encodeFunctionCall(SAFE_ABI, 'getThreshold', []),
] as const
const safeCallResults = new Map([
	[safeStateReadCalls[0], encodeFunctionReturn(SAFE_ABI, 'VERSION', ['1.4.1'])],
	[safeStateReadCalls[1], encodeFunctionReturn(SAFE_ABI, 'nonce', [7n])],
	[safeStateReadCalls[2], encodeFunctionReturn(SAFE_ABI, 'getOwners', [[addressString(OWNER_ADDRESS)]])],
	[safeStateReadCalls[3], encodeFunctionReturn(SAFE_ABI, 'getThreshold', [2n])],
	[encodeFunctionCall(SAFE_ABI, 'getTransactionHash', [
		addressString(SAFE_TX.message.to),
		SAFE_TX.message.value,
		'0x',
		SAFE_TX.message.operation,
		SAFE_TX.message.safeTxGas,
		SAFE_TX.message.baseGas,
		SAFE_TX.message.gasPrice,
		addressString(SAFE_TX.message.gasToken),
		addressString(SAFE_TX.message.refundReceiver),
		SAFE_TX.message.nonce,
	]), encodeFunctionReturn(SAFE_ABI, 'getTransactionHash', [bytes32String(SAFE_TX_HASH)])],
])

type JsonRpcRequest = {
	readonly id: number
	readonly method: string
	readonly params?: readonly unknown[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function handleRpcRequest(request: JsonRpcRequest) {
	switch (request.method) {
		case 'eth_blockNumber': return serialize(EthereumQuantity, 123n)
		case 'eth_getBlockByNumber': return serialize(EthereumBlockHeader, makeFakeBlock())
		case 'eth_getTransactionCount':
		case 'eth_getBalance':
		case 'eth_gasPrice':
		case 'eth_maxPriorityFeePerGas': return serialize(EthereumQuantity, 0n)
		case 'eth_getCode': {
			const [address] = request.params ?? []
			const isSafeContract = typeof address === 'string' && (BigInt(address) === SAFE_ADDRESS || BigInt(address) === SAFE_SINGLETON_ADDRESS)
			return isSafeContract ? '0x01' : '0x'
		}
		case 'eth_call': {
			const [call] = request.params ?? []
			if (!isRecord(call) || typeof call.data !== 'string') throw new Error('Malformed eth_call')
			return safeCallResults.get(call.data) ?? '0x'
		}
		case 'eth_getLogs': return []
		case 'eth_simulateV1': {
			const [payload] = request.params ?? []
			const blockStateCalls = isRecord(payload) && Array.isArray(payload.blockStateCalls) ? payload.blockStateCalls : []
			return serialize(EthSimulateV1Result, blockStateCalls.map((blockStateCall) =>
				makeFakeEthSimulateResult(isRecord(blockStateCall) && Array.isArray(blockStateCall.calls) ? blockStateCall.calls : [])
			))
		}
		default: throw new Error(`Unsupported test RPC method: ${ request.method }`)
	}
}

const communicationPageHtml = await readFile(new URL('./chromeCommunicationPage.html', import.meta.url), 'utf8')
const sealwortFixtureDirectory = path.resolve('test/fixtures/sealwort')
const sealwortExpectedSafeState = {
	chainId: '0x1',
	singletonAddress: addressString(SAFE_SINGLETON_ADDRESS),
	singletonStorage: bytes32String(SAFE_SINGLETON_ADDRESS),
	calls: safeStateReadCalls.map((data) => {
		const result = safeCallResults.get(data)
		if (result === undefined) throw new Error(`Missing Safe test response for ${ data }`)
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
	name: 'Safe co-signing test RPC',
	chainId: '0x1',
	httpsRpc: `http://127.0.0.1:${ server.port }/rpc`,
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
}

const fakeSignerPreload = `(() => {
	const requests = []
	const signer = {
		isMetaMask: true,
		selectedAddress: ${ JSON.stringify(addressString(OWNER_ADDRESS)) },
		isConnected: () => true,
		request: async ({ method, params }) => {
			requests.push({ method, params })
			switch (method) {
				case 'eth_chainId': return '0x1'
				case 'eth_accounts':
				case 'eth_requestAccounts': return [${ JSON.stringify(addressString(OWNER_ADDRESS)) }]
				case 'eth_signTypedData_v4':
					if (params?.[0]?.toLowerCase() !== ${ JSON.stringify(addressString(OWNER_ADDRESS).toLowerCase()) }) throw new Error('Unexpected Safe signer account')
					if (JSON.stringify(params?.[1]) !== ${ JSON.stringify(JSON.stringify(SAFE_TYPED_DATA)) }) throw new Error('Unexpected Safe typed-data payload')
					return ${ JSON.stringify(SAFE_SIGNATURE) }
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
				useSignersAddressAsActiveAddress: false,
				independentActiveSimulationAddress: addressString(SAFE_ADDRESS),
				activeSigningAddress: addressString(OWNER_ADDRESS),
				activeSigningSafeAddress: addressString(SAFE_ADDRESS),
				signingAddressPreferences: [{ signerAddress: addressString(OWNER_ADDRESS), selection: 'safe', safeAddress: addressString(SAFE_ADDRESS), chainId: '0x1' }],
				activeRpcNetwork: testRpcNetwork,
				userAddressBookEntriesV3: [{
					type: 'safe',
					name: 'Browser Test Safe',
					address: addressString(SAFE_ADDRESS),
					chainId: '0x1',
					entrySource: 'User',
					useAsActiveAddress: true,
					askForAddressAccess: false,
					safeSignerAddresses: [addressString(OWNER_ADDRESS)],
					safeSimulationSignerAddress: addressString(OWNER_ADDRESS),
					safeVersion: '1.4.1',
				}],
			}
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
					await chrome.runtime.sendMessage({
						method: 'popup_changeActiveRpc',
						data: ${ JSON.stringify(testRpcNetwork) },
					})
					return {}
				} catch (error) {
					return { error: error instanceof Error ? error.message : String(error) }
				}
			})()`)
			if (rpcSwitchResult.error !== undefined) throw new Error(`Failed to switch to Safe co-signing test RPC: ${ rpcSwitchResult.error }`)
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
				await waitForCondition(async () => await pageConnection.evaluate(`globalThis.__interceptorChromeCommunicationState?.phase === 'requesting-access'`).catch(() => false), 30_000, 'Safe access request')
			} catch (error) {
				const accessDiagnostics = await pageConnection.evaluate('({ state: globalThis.__interceptorChromeCommunicationState, signerRequests: globalThis.__fakeSafeSignerRequests, url: location.href, body: document.body.textContent })')
				throw new Error(`Safe access request did not open: ${ JSON.stringify(accessDiagnostics) }`, { cause: error })
			}

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
				await waitForCondition(async () => await pageConnection.evaluate(`globalThis.__interceptorChromeCommunicationState?.phase === 'access-granted'`).catch(() => false), 30_000, 'Safe access approval')
			} catch (error) {
				const pageDiagnostics = await pageConnection.evaluate('({ state: globalThis.__interceptorChromeCommunicationState, signerRequests: globalThis.__fakeSafeSignerRequests })')
				throw new Error(`Safe access approval failed: ${ JSON.stringify(pageDiagnostics) }`, { cause: error })
			}
			const grantedAccounts = await pageConnection.evaluate<readonly string[]>('globalThis.__interceptorChromeCommunicationState.accounts')
			if (grantedAccounts[0]?.toLowerCase() !== addressString(SAFE_ADDRESS).toLowerCase()) {
				throw new Error(`Dapp received ${ grantedAccounts[0] ?? 'no account' } instead of the Safe address`)
			}
			const tabStateConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
			try {
				await tabStateConnection.evaluate(`(async () => {
					const tabs = await browser.tabs.query({})
					const pageTab = tabs.find((tab) => tab.url?.startsWith(${ JSON.stringify(`http://127.0.0.1:${ server.port }/`) }))
					if (pageTab?.id === undefined) throw new Error('Safe co-signing page tab was not found')
					const key = 'tabState_' + pageTab.id
					const stored = await browser.storage.local.get(key)
					const current = stored[key]
					if (current === undefined) throw new Error('Safe co-signing tab state was not initialized')
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
					params: [${ JSON.stringify(addressString(SAFE_ADDRESS)) }, ${ JSON.stringify(SAFE_TYPED_DATA) }],
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
				throw new Error(`Safe signer forwarding failed. Page: ${ JSON.stringify(pageDiagnostics) }. Confirmation: ${ JSON.stringify(confirmText) }. RPC: ${ JSON.stringify(rpcRequests) }`, { cause: error })
			}
			const signerRequest = await pageConnection.evaluate<{ method: string, params?: readonly unknown[] }>(`globalThis.__fakeSafeSignerRequests.find(({ method }) => method === 'eth_signTypedData_v4')`)
			if (typeof signerRequest.params?.[0] !== 'string' || signerRequest.params[0].toLowerCase() !== addressString(OWNER_ADDRESS).toLowerCase()) {
				throw new Error('Interceptor did not substitute the wallet-selected Safe owner')
			}
			await waitForCondition(async () => await pageConnection.evaluate(`globalThis.__safeCoSigningResult?.status === 'fulfilled'`).catch(() => false), 10_000, 'Safe co-signature result')
			const signingResult = await pageConnection.evaluate<{ status?: string, result?: string }>('globalThis.__safeCoSigningResult')
			if (signingResult.result !== SAFE_SIGNATURE) throw new Error(`Unexpected Safe co-signature result: ${ signingResult.result ?? 'missing' }`)
			await waitForTargetGone(chrome.browserDebugPort, (target) => target.id === confirmTarget.id, 10_000, 'initial Safe confirmation window')
			confirmTargetId = undefined

			const stackSeedConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
			try {
				await stackSeedConnection.evaluate(`browser.storage.local.set({
					safeTransactionStacks: ${ JSON.stringify(serialize(SafeTransactionStacks, [UNSIGNED_STACK])) },
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
				'Safe co-signer fixture API',
			)
			const sealwortInspectionRpcStart = rpcRequests.length
			await pageConnection.evaluate('globalThis.__sealwortFixture.connect()')
			try {
				await waitForText(pageConnection, addressString(SAFE_ADDRESS))
				await waitForText(pageConnection, 'Safe account inspection complete.')
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
				throw new Error(`Safe co-signer fixture did not connect. Page: ${ JSON.stringify(fixtureDiagnostics) }. Extension: ${ JSON.stringify(extensionDiagnostics) }. RPC: ${ JSON.stringify(rpcRequests.slice(sealwortInspectionRpcStart)) }`, { cause: error })
			}
			const sealwortInspectionRpcRequests = rpcRequests.slice(sealwortInspectionRpcStart)
			const sealwortSimulationRequests = sealwortInspectionRpcRequests.filter((rpcRequest) => rpcRequest.method === 'eth_simulateV1')
			const hasTransactionPreparationSimulation = sealwortSimulationRequests.some((rpcRequest) => {
				const [payload] = rpcRequest.params ?? []
				if (!isRecord(payload) || !Array.isArray(payload.blockStateCalls)) return false
				return payload.blockStateCalls.every((blockStateCall) => isRecord(blockStateCall) && Array.isArray(blockStateCall.calls) && blockStateCall.calls.length === 0)
			})
			if (hasTransactionPreparationSimulation) throw new Error('Sealwort Safe inspection ran transaction preparation for a transaction-free overlay')
			const simulatedStorageLookup = sealwortSimulationRequests.some((rpcRequest) => {
				const [payload] = rpcRequest.params ?? []
				if (!isRecord(payload) || !Array.isArray(payload.blockStateCalls)) return false
				return payload.blockStateCalls.some((blockStateCall) => isRecord(blockStateCall)
					&& Array.isArray(blockStateCall.calls)
					&& blockStateCall.calls.some((call) => isRecord(call) && call.input === STORAGE_READER_CALL))
			})
			if (!simulatedStorageLookup) throw new Error('Sealwort Safe inspection bypassed the simulated storage overlay')
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
				await waitForText(pageConnection, 'Verified 1 Safe transaction(s) against current on-chain state.')
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
				`globalThis.__fakeSafeSignerRequests.filter(({ method }) => method === 'eth_signTypedData_v4')`
			)
			if (safeSignerRequests.length !== 1) {
				throw new Error(`Sealwort forwarded ${ safeSignerRequests.length.toString() } Safe signing requests instead of one`)
			}
			await pageConnection.evaluate('globalThis.__sealwortFixture.download()')
			await waitForText(pageConnection, 'Updated Safe stack downloaded.')
			await waitForCondition(async () => {
				const filenames = await readdir(downloadDirectory)
				return filenames.some((filename) => filename === 'interceptor-safe-stack.json')
			}, 10_000, 'downloaded Safe stack')
			const downloadedStackPath = path.join(downloadDirectory, 'interceptor-safe-stack.json')
			const downloadedStackJson = await readFile(downloadedStackPath, 'utf8')
			const downloadedStack = SafeStackExport.parse(JSON.parse(downloadedStackJson))
			const downloadedSignature = downloadedStack.stacks[0]?.transactions[0]?.signatures[0]
			if (downloadedSignature?.signer !== OWNER_ADDRESS || downloadedSignature.signature !== SAFE_SIGNATURE) {
				throw new Error('Sealwort download did not contain the routed EOA owner signature')
			}

			const preImportStackConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
			const preImportStacks = await readExtensionLargeStateValue<unknown>(preImportStackConnection, 'safeTransactionStacks')
				.finally(() => { preImportStackConnection.close() })
			const parsedPreImportStacks = SafeTransactionStacks.parse(preImportStacks)
			if (parsedPreImportStacks[0]?.transactions[0]?.signatures.length !== 0) {
				throw new Error('Safe co-signing mutated the proposer stack before the returned file was imported')
			}

			const simulationStackTargetId = await createTargetPage(chrome.browserConnection, `chrome-extension://${ extensionId }/html3/simulationStackV3.html`)
			const simulationStackConnection = await connectTarget(chrome.browserDebugPort, simulationStackTargetId)
			try {
				await waitForText(simulationStackConnection, 'Gnosis Safe Stack')
				await clickButton(simulationStackConnection, 'button[aria-label="Import Gnosis Safe stack"]')
				await waitForText(simulationStackConnection, 'Import Interceptor Gnosis Safe Stack')
				await simulationStackConnection.evaluate(`(() => {
					const input = document.querySelector('.simulation-stack-import-input')
					if (!(input instanceof HTMLTextAreaElement)) throw new Error('Safe import textarea was not found')
					input.value = ${ JSON.stringify(downloadedStackJson) }
					input.dispatchEvent(new InputEvent('input', { bubbles: true, data: input.value }))
				})()`)
				await clickButtonWithText(simulationStackConnection, 'Import signatures')
				await waitForCondition(
					async () => await simulationStackConnection.evaluate<boolean>(`document.body.textContent?.includes('Import Interceptor Gnosis Safe Stack') === false`).catch(() => false),
					30_000,
					'Safe import modal to close',
				)
			} finally {
				simulationStackConnection.close()
				await closeTarget(chrome.browserConnection, simulationStackTargetId)
			}

			const stackReadConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
			const importedStacks = await readExtensionLargeStateValue<unknown>(stackReadConnection, 'safeTransactionStacks')
				.finally(() => { stackReadConnection.close() })
			const parsedImportedStacks = SafeTransactionStacks.parse(importedStacks)
			const importedSignature = parsedImportedStacks[0]?.transactions[0]?.signatures[0]
			if (importedSignature?.signer !== OWNER_ADDRESS || importedSignature.signature !== SAFE_SIGNATURE) {
				throw new Error('Interceptor did not merge the downloaded Sealwort owner signature')
			}
			console.warn('Interceptor Chrome Safe co-signing and Sealwort handoff test passed.')
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
