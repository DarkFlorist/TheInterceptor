import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { createRpcEndpointChainTransport } from '../../app/inpage/ts/rpcReadTransport.js'

const identified = (chain = '0x1') => Response.json({ jsonrpc: '2.0', id: 'interceptor-chain-probe', result: chain })
const request = (url = 'https://rpc.example/', headers: HeadersInit = {}, credentials: RequestCredentials = 'same-origin', signal?: AbortSignal) => {
	const value = new Request(url, { method: 'POST', headers, credentials, mode: 'cors', ...(signal === undefined ? {} : { signal }) })
	// Bun currently exposes include for every Request credential mode; model the browser's actual per-request value explicitly.
	Object.defineProperty(value, 'credentials', { value: credentials })
	return value
}

function deferred<T>() {
	let resolve: (value: T) => void = () => { throw new Error('Deferred resolver was not initialized') }
	let reject: (reason: unknown) => void = () => { throw new Error('Deferred rejection was not initialized') }
	const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
	return { promise, resolve, reject }
}

test('chain identification preserves endpoint credentials and normalizes only the probe transport', async () => {
	const sent: Request[] = []
	const transport = createRpcEndpointChainTransport(async (input, init) => {
		assert.equal(init?.credentials, 'include')
		assert.equal(init?.mode, 'cors')
		assert.equal(init?.cache, 'no-store')
		const outgoing = new Request(input, init)
		sent.push(outgoing)
		assert.deepEqual(await outgoing.json(), { jsonrpc: '2.0', id: 'interceptor-chain-probe', method: 'eth_chainId', params: [] })
		return identified('0X0001')
	})
	const original = request('https://rpc.example/path?key=value', { authorization: 'secret', 'content-length': '123', 'content-type': 'text/plain' }, 'include')
	assert.equal(await transport.identify(original), '0x1')
	assert.equal(sent.length, 1)
	assert.equal(sent[0]?.url, original.url)
	assert.equal(sent[0]?.headers.get('authorization'), 'secret')
	assert.equal(sent[0]?.headers.has('content-length'), false)
	assert.equal(sent[0]?.headers.get('content-type'), 'application/json')
	assert.equal(sent[0]?.credentials, 'include')
	assert.equal(sent[0]?.mode, 'cors')
	assert.equal(sent[0]?.cache, 'no-store')
	assert.equal(original.headers.get('content-length'), '123')
	assert.equal(original.headers.get('content-type'), 'text/plain')
})

test('verified endpoint identity includes normalized headers and credentials', async () => {
	let probes = 0
	const transport = createRpcEndpointChainTransport(async () => { probes++; return identified() })
	await transport.identify(request(undefined, { authorization: 'first', 'content-length': '1' }))
	await transport.identify(request(undefined, { authorization: 'first', 'content-length': '99', 'content-type': 'text/plain' }))
	assert.equal(probes, 1, 'normalized probe headers share a cache entry')
	await transport.identify(request(undefined, { authorization: 'second' }))
	await transport.identify(request(undefined, { authorization: 'second' }, 'include'))
	assert.equal(probes, 3, 'authorization and credential changes identify distinct transports')
})

test('successful probe entries expire at thirty seconds and context clearing forces identification again', async () => {
	let now = 100
	let probes = 0
	const transport = createRpcEndpointChainTransport(async () => { probes++; return identified() }, () => now)
	await transport.identify(request())
	now = 30_099
	await transport.identify(request())
	assert.equal(probes, 1)
	now = 30_100
	await transport.identify(request())
	assert.equal(probes, 2)
	transport.clear()
	await transport.identify(request())
	assert.equal(probes, 3)
})

test('the sixty-four-entry cap preserves insertion order rather than changing behavior to LRU', async () => {
	let probes = 0
	const transport = createRpcEndpointChainTransport(async () => { probes++; return identified() })
	for (let index = 0; index < 64; index++) await transport.identify(request(`https://rpc.example/${ index }`))
	await transport.identify(request('https://rpc.example/0'))
	await transport.identify(request('https://rpc.example/64'))
	assert.equal(probes, 65)
	await transport.identify(request('https://rpc.example/1'))
	assert.equal(probes, 65)
	await transport.identify(request('https://rpc.example/0'))
	assert.equal(probes, 66, 'a cache hit did not move the first entry to the end')
})

test('concurrent readers share the same in-flight identification', async () => {
	const probe = deferred<Response>()
	let probes = 0
	const transport = createRpcEndpointChainTransport(async () => { probes++; return await probe.promise })
	const first = transport.identify(request())
	const second = transport.identify(request())
	assert.equal(probes, 1)
	probe.resolve(identified())
	assert.deepEqual(await Promise.all([first, second]), ['0x1', '0x1'])
})

for (const { label, respond } of [{ label: 'HTTP authorization failure', respond: () => new Response('', { status: 401 }) }, { label: 'invalid JSON', respond: () => new Response('not JSON') }, { label: 'mismatched response ID', respond: () => Response.json({ id: 'other', result: '0x1' }) }, { label: 'invalid chain quantity', respond: () => identified('1') }]) test(`${ label } is not cached across a startup retry`, async () => {
	let probes = 0
	const transport = createRpcEndpointChainTransport(async () => ++probes === 1 ? respond() : identified())
	assert.equal(await transport.identify(request()), undefined)
	assert.equal(await transport.identify(request()), '0x1')
	assert.equal(await transport.identify(request()), '0x1')
	assert.equal(probes, 2)
})

test('known browser probe network failures permit retry, while unknown errors remain failures', async () => {
	for (const failure of [new TypeError('Failed to fetch'), new TypeError('NetworkError when attempting to fetch resource.'), new TypeError('Load failed'), new TypeError('invalid fetch configuration'), new Error('Failed to fetch')]) {
		let probes = 0
		const transport = createRpcEndpointChainTransport(async () => { if (++probes === 1) throw failure; return identified() })
		if (failure instanceof TypeError && failure.message !== 'invalid fetch configuration') assert.equal(await transport.identify(request()), undefined)
		else await assert.rejects(transport.identify(request()), (error: unknown) => error === failure)
		assert.equal(await transport.identify(request()), '0x1')
		assert.equal(probes, 2)
	}
})

test('one caller aborts immediately without forwarding its signal to the shared probe', async () => {
	const probe = deferred<Response>()
	const outgoing: Request[] = []
	const transport = createRpcEndpointChainTransport(async (input, init) => { outgoing.push(new Request(input, init)); return await probe.promise })
	const controller = new AbortController()
	const first = transport.identify(request(undefined, {}, 'same-origin', controller.signal))
	const second = transport.identify(request())
	const reason = new TypeError('Failed to fetch')
	controller.abort(reason)
	await assert.rejects(first, (error: unknown) => error === reason)
	assert.equal(outgoing.length, 1)
	assert.equal(outgoing[0]?.signal.aborted, false)
	probe.resolve(identified())
	assert.equal(await second, '0x1')
})

for (const rejectOldProbe of [false, true]) test(`a stale probe ${ rejectOldProbe ? 'failure' : 'unknown result' } cannot remove a newer cache entry after context clearing`, async () => {
	const old = deferred<Response>()
	let probes = 0
	const transport = createRpcEndpointChainTransport(async () => ++probes === 1 ? await old.promise : identified())
	const first = transport.identify(request())
	transport.clear()
	assert.equal(await transport.identify(request()), '0x1')
	if (rejectOldProbe) old.reject(new TypeError('Failed to fetch'))
	else old.resolve(new Response('', { status: 503 }))
	assert.equal(await first, undefined)
	assert.equal(await transport.identify(request()), '0x1')
	assert.equal(probes, 2)
})


test('an already-aborted caller still observes a probe that rejects later', async () => {
	const moduleUrl = new URL('../../app/inpage/ts/rpcReadTransport.ts', import.meta.url).href
	const program = `
		const { createRpcEndpointChainTransport } = await import(${ JSON.stringify(moduleUrl) });
		const unhandled = [];
		process.on('unhandledRejection', reason => { unhandled.push(reason); });
		let rejectProbe = () => { throw new Error('Probe did not start'); };
		const probe = new Promise((_resolve, reject) => { rejectProbe = reject; });
		const transport = createRpcEndpointChainTransport(async () => await probe);
		const controller = new AbortController();
		const abort = new TypeError('Failed to fetch');
		controller.abort(abort);
		let callerAborted = false;
		try { await transport.identify(new Request('https://rpc.example/', { signal: controller.signal })); }
		catch (error) { if (error !== abort) throw error; callerAborted = true; }
		rejectProbe(new Error('late unexpected probe failure'));
		await new Promise(resolve => setTimeout(resolve, 0));
		console.log(JSON.stringify({ callerAborted, unhandled: unhandled.length }));
	`
	const child = Bun.spawn({ cmd: [process.execPath, '--eval', program], stdout: 'pipe', stderr: 'pipe' })
	const [exitCode, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
	assert.equal(exitCode, 0, error)
	assert.deepEqual(JSON.parse(output), { callerAborted: true, unhandled: 0 })
})

test('an aborted reader does not hide an unexpected shared-probe failure from a live reader', async () => {
	const probe = deferred<Response>()
	const transport = createRpcEndpointChainTransport(async () => await probe.promise)
	const controller = new AbortController()
	const abort = new Error('caller cancelled')
	controller.abort(abort)
	const cancelled = transport.identify(request(undefined, {}, 'same-origin', controller.signal))
	const live = transport.identify(request())
	await assert.rejects(cancelled, (error: unknown) => error === abort)
	const failure = new Error('unexpected transport failure')
	probe.reject(failure)
	await assert.rejects(live, (error: unknown) => error === failure)
})

for (const reject of [false, true]) test(`an abandoned shared probe ${ reject ? 'rejection' : 'undefined result' } still evicts for a later retry`, async () => {
	const probe = deferred<Response>()
	let probes = 0
	const transport = createRpcEndpointChainTransport(async () => ++probes === 1 ? await probe.promise : identified())
	const controller = new AbortController()
	const first = transport.identify(request(undefined, {}, 'same-origin', controller.signal))
	const reason = new Error('caller cancelled')
	controller.abort(reason)
	await assert.rejects(first, (error: unknown) => error === reason)
	if (reject) probe.reject(new TypeError('Failed to fetch'))
	else probe.resolve(new Response('', { status: 401 }))
	// Settle the shared probe and its eviction handler even though it has no live waiters.
	await new Promise((resolve) => setTimeout(resolve, 0))
	assert.equal(await transport.identify(request()), '0x1')
	assert.equal(await transport.identify(request()), '0x1')
	assert.equal(probes, 2)
})
