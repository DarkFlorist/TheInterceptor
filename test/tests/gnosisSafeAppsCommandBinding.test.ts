import { GnosisSafeAppsRequestCommand } from '../../app/ts/types/gnosisSafeApps.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { test } from 'bun:test'
import * as assert from 'node:assert/strict'
import { bindGnosisSafeAppsCommand, admitGnosisSafeAppsPrivateCommand } from '../../app/ts/background/gnosisSafeAppsCommandBinding.js'
import { createGnosisSafeAppsRequestHandler } from '../../app/shared/ts/gnosisSafeAppsClient.js'
import { createPort } from './backgroundEthAccountsTestHarness.js'

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
		assert.equal(admitGnosisSafeAppsPrivateCommand(port, request), true)
		return request.method === 'execute' ? `0x${ '11'.repeat(65) }` : { kind: 'result', value: 'submitted' }
	}, async () => { throw new Error('must use reviewed execution') })
	assert.equal(await handle({ method: 'signMessage', params: { message: 'review me' } }), 'submitted')
	assert.deepEqual(methods, ['signMessage', 'execute', 'submitOffChainMessage'])
})
