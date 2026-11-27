import { GnosisSafeAppsRequestCommand } from '../../app/ts/types/gnosisSafeApps.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { test } from 'bun:test'
import * as assert from 'node:assert/strict'
import { bindGnosisSafeAppsCommand, admitGnosisSafeAppsPrivateCommand, trackGnosisSafeAppsExecution, settleGnosisSafeAppsExecution } from '../../app/ts/background/gnosisSafeAppsCommandBinding.js'
import { createGnosisSafeAppsRequestHandler } from '../../app/shared/ts/gnosisSafeAppsClient.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import { createPort, installBrowserMock, loadModules } from './backgroundEthAccountsTestHarness.js'

test('public SDK rejects private commands before any background or Ethereum call', async () => {
	let calls = 0
	const handle = createGnosisSafeAppsRequestHandler(async () => { calls++; return undefined }, async () => { calls++; return undefined })
	for (const method of ['execute', 'submitOffChainMessage', 'unknown']) await assert.rejects(handle({ method, params: { kind: 'ethereumRequest', safeRequestContext: { operation: 1 } } }))
	assert.equal(calls, 0)
})

test('raw private wire commands require an unmodified single-use command from the same port', () => {
	const { port } = createPort(7)
	const other = createPort(7).port
	const command = { kind: 'ethereumRequest' as const, method: 'eth_sendTransaction', params: [], safeRequestContext: { operation: 1 as const }, mapResult: 'safeTxHash' as const }
	assert.equal(admitGnosisSafeAppsPrivateCommand(port, { method: 'execute', params: command }), false)
	const bound = serialize(GnosisSafeAppsRequestCommand, bindGnosisSafeAppsCommand(port, command))
	assert.equal(admitGnosisSafeAppsPrivateCommand(other, { method: 'execute', params: bound }), false)
	assert.equal(admitGnosisSafeAppsPrivateCommand(port, { method: 'execute', params: { ...bound, safeRequestContext: { operation: 0 } } }), false)
	assert.equal(admitGnosisSafeAppsPrivateCommand(port, { method: 'execute', params: bound }), true)
	assert.equal(admitGnosisSafeAppsPrivateCommand(port, { method: 'execute', params: bound }), false)
})

test('generated offchain signing command executes and submits its bound message', async () => {
	const { port } = createPort(7)
	const command = bindGnosisSafeAppsCommand(port, { kind: 'ethereumRequest', method: 'eth_signTypedData_v4', params: [], safeRequestContext: { message: { text: 'review me', isTypedData: false } }, mapResult: 'safeMessage', message: 'review me', safeAddress: '0x123', chainId: '1' })
	const methods: string[] = []
	const handle = createGnosisSafeAppsRequestHandler(async (request) => {
		assert.ok(typeof request === 'object' && request !== null && 'method' in request)
		methods.push(String(request.method))
		if (request.method === 'signMessage') return command
		if (request.method === 'execute') trackGnosisSafeAppsExecution(port, 1, request)
		assert.equal(admitGnosisSafeAppsPrivateCommand(port, request), true)
		if (request.method === 'execute') settleGnosisSafeAppsExecution(port, 1, `0x${ '11'.repeat(65) }`)
		return request.method === 'execute' ? `0x${ '11'.repeat(65) }` : { kind: 'result', value: 'submitted' }
	}, async () => { throw new Error('must use reviewed execution') })
	assert.equal(await handle({ method: 'signMessage', params: { message: 'review me' } }), 'submitted')
	assert.deepEqual(methods, ['signMessage', 'execute', 'submitOffChainMessage'])
})

for (const admitted of [true, false]) test(`failed signing releases more than the command cap, admitted=${ admitted }`, () => {
	const { port } = createPort(7)
	for (let requestId = 0; requestId < 150; requestId++) {
		const command = bindGnosisSafeAppsCommand(port, { kind: 'ethereumRequest', method: 'eth_signTypedData_v4', params: [], safeRequestContext: { message: { text: 'reject', isTypedData: false } }, mapResult: 'safeMessage', message: 'reject', safeAddress: '0x123', chainId: '1' })
		const request = { method: 'execute', params: command }
		trackGnosisSafeAppsExecution(port, requestId, request)
		if (admitted) assert.equal(admitGnosisSafeAppsPrivateCommand(port, request), true)
		settleGnosisSafeAppsExecution(port, requestId, undefined)
		assert.equal(admitGnosisSafeAppsPrivateCommand(port, request), false)
	}
})

test('submission waits for successful execution settlement and is single-use', () => {
	const { port } = createPort(7)
	const command = bindGnosisSafeAppsCommand(port, { kind: 'ethereumRequest', method: 'eth_signTypedData_v4', params: [], safeRequestContext: { message: { text: 'retain', isTypedData: false } }, mapResult: 'safeMessage', message: 'retain', safeAddress: '0x123', chainId: '1' })
	const execute = { method: 'execute', params: command }
	const submit = { method: 'submitOffChainMessage', params: { ...command, signature: `0x${ '11'.repeat(65) }` } }
	trackGnosisSafeAppsExecution(port, 1, execute)
	assert.equal(admitGnosisSafeAppsPrivateCommand(port, execute), true)
	assert.equal(admitGnosisSafeAppsPrivateCommand(port, submit), false)
	settleGnosisSafeAppsExecution(port, 1, `0x${ '11'.repeat(65) }`)
	assert.equal(admitGnosisSafeAppsPrivateCommand(createPort(7).port, submit), false)
	assert.equal(admitGnosisSafeAppsPrivateCommand(port, { ...submit, params: { ...submit.params, message: 'changed' } }), false)
	assert.equal(admitGnosisSafeAppsPrivateCommand(port, submit), true)
	assert.equal(admitGnosisSafeAppsPrivateCommand(port, submit), false)
})


test('provider routing settles tracked signer replies and generic transport stays feature-independent', async () => {
	installBrowserMock()
	const modules = await loadModules()
	const { routeProviderReply } = await import('../../app/ts/background/providerReplyRouting.js')
	const { port } = createPort(7)
	const socket = { tabId: 7, connectionName: BigInt(port.name) }
	const connections: WebsiteTabConnections = new Map([[7, { connections: { [modules.websiteSocketToString(socket)]: { socket, port, websiteOrigin: 'app.example', approved: true, wantsToConnect: true } } }]])
	for (const success of [false, true]) {
		const command = bindGnosisSafeAppsCommand(port, { kind: 'ethereumRequest', method: 'eth_signTypedData_v4', params: [], safeRequestContext: { message: { text: 'retain', isTypedData: false } }, mapResult: 'safeMessage', message: 'retain', safeAddress: '0x123', chainId: '1' })
		const execute = { method: 'execute', params: command }
		const submit = { method: 'submitOffChainMessage', params: { ...command, signature: `0x${ '11'.repeat(65) }` } }
		trackGnosisSafeAppsExecution(port, 1, execute)
		assert.equal(admitGnosisSafeAppsPrivateCommand(port, execute), true)
		assert.equal(routeProviderReply(connections, { type: 'result', method: 'signer_reply', uniqueRequestIdentifier: { requestSocket: socket, requestId: 1 }, ...(success ? { result: `0x${ '11'.repeat(65) }` } : { error: { code: 4001, message: 'Rejected' } }) }), true)
		assert.equal(admitGnosisSafeAppsPrivateCommand(port, submit), success)
		assert.equal(admitGnosisSafeAppsPrivateCommand(port, submit), false)
	}
	assert.doesNotMatch(await Bun.file('app/ts/background/messageSending.ts').text(), /gnosisSafeAppsCommandBinding|settleGnosisSafeAppsExecution/)
	assert.doesNotMatch(await Bun.file('app/ts/background/terminalReplyDelivery.ts').text(), /routeProviderReply|gnosisSafeApps/)
	assert.match(await Bun.file('app/ts/background/providerTerminalReplyDelivery.ts').text(), /routeProviderReply/)
})

test('lifecycle releases early exits and thrown preparation failures beyond capacity', async () => {
	const { gnosisSafeAppsCommandLifecycle: lifecycle } = await import('../../app/ts/background/gnosisSafeAppsCommandBinding.js')
	const { port } = createPort(7)
	for (let requestId = 0; requestId < 150; requestId++) {
		const command = lifecycle.bind(port, { kind: 'ethereumRequest', method: 'eth_signTypedData_v4', params: [], safeRequestContext: { message: { text: 'reject', isTypedData: false } }, mapResult: 'safeMessage', message: 'reject', safeAddress: '0x123', chainId: '1' })
		const payload = { method: 'execute', params: command }
		const request = { method: 'safe_apps_request', requestId, params: [payload] }
		if (requestId % 2 === 0) await lifecycle.process(port, request, async () => undefined)
		else await assert.rejects(lifecycle.process(port, request, async () => { throw new Error('preparation failed') }), /preparation failed/)
		assert.equal(lifecycle.admit(port, payload), false)
	}
})

test('lifecycle hands queued approval settlement to the terminal reply without releasing it early', async () => {
	const { gnosisSafeAppsCommandLifecycle: lifecycle } = await import('../../app/ts/background/gnosisSafeAppsCommandBinding.js')
	const { port } = createPort(7)
	const command = lifecycle.bind(port, { kind: 'ethereumRequest', method: 'eth_signTypedData_v4', params: [], safeRequestContext: { message: { text: 'queued', isTypedData: false } }, mapResult: 'safeMessage', message: 'queued', safeAddress: '0x123', chainId: '1' })
	const payload = { method: 'execute', params: command }
	await lifecycle.process(port, { method: 'safe_apps_request', requestId: 1, params: [payload] }, async () => true)
	assert.equal(lifecycle.admit(port, payload), true)
	lifecycle.settle(createPort(7).port, 1, undefined)
	lifecycle.settle(port, 2, undefined)
	lifecycle.settle(port, 1, `0x${ '11'.repeat(65) }`)
	assert.equal(lifecycle.admit(port, { method: 'submitOffChainMessage', params: command }), true)
	assert.equal(lifecycle.admit(port, payload), false)
})

test('application replies enter the domain router and durable transport stays neutral', async () => {
	const files = new Bun.Glob('app/ts/**/*.ts')
	for await (const file of files.scan('.')) {
		if (file.endsWith('/messageSending.ts') || file.endsWith('/providerReplyRouting.ts')) continue
		assert.doesNotMatch(await Bun.file(file).text(), /\breplyToInterceptedRequest(?:AfterManifestV2Reconnect)?\b/, file)
	}
	assert.doesNotMatch(await Bun.file('app/ts/background/terminalReplyDelivery.ts').text(), /from ['"].*(?:gnosis|Gnosis|providerReplyRouting)/)
	assert.doesNotMatch(await Bun.file('app/ts/types/user-interface-types.ts').text(), /nativeSafeRole/)
})
