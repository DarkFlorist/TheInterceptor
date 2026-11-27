import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { CdpConnection } from '../benchmarks/chromeHarness.js'

test('flattened CDP commands and event listeners retain their target session', async () => {
	const server = Bun.serve({
		hostname: '127.0.0.1', port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return undefined
			return new Response('Expected a debugger WebSocket', { status: 400 })
		},
		websocket: {
			message(socket, message) {
				const command: unknown = JSON.parse(String(message))
				if (typeof command !== 'object' || command === null || !('id' in command) || !('method' in command)) throw new Error('Invalid CDP command')
				if (command.method === 'Runtime.emitFixtureEvents') {
					for (const sessionId of [undefined, 'child-session', 'unrelated-session']) socket.send(JSON.stringify({
						method: 'Runtime.executionContextCreated', params: { label: sessionId ?? 'root' }, ...(sessionId === undefined ? {} : { sessionId }),
					}))
				}
				socket.send(JSON.stringify({ id: command.id, result: { method: command.method, sessionId: 'sessionId' in command ? command.sessionId : 'root' } }))
			},
		},
	})
	const connection = new CdpConnection(server.url.href.replace('http:', 'ws:'))
	try {
		const rootEvents: unknown[] = []
		const childEvents: unknown[] = []
		const childListener = (event: unknown) => { childEvents.push(event) }
		connection.on('Runtime.executionContextCreated', (event) => { rootEvents.push(event) })
		connection.on('Runtime.executionContextCreated', childListener, 'child-session')
		assert.deepEqual(await connection.send('Page.enable'), { method: 'Page.enable', sessionId: 'root' })
		assert.deepEqual(await connection.send('Page.enable', {}, 'child-session'), { method: 'Page.enable', sessionId: 'child-session' })
		await connection.send('Runtime.emitFixtureEvents')
		assert.deepEqual(rootEvents, [{ label: 'root' }])
		assert.deepEqual(childEvents, [{ label: 'child-session' }])
		connection.off('Runtime.executionContextCreated', childListener, 'child-session')
		await connection.send('Runtime.emitFixtureEvents')
		assert.deepEqual(rootEvents, [{ label: 'root' }, { label: 'root' }])
		assert.deepEqual(childEvents, [{ label: 'child-session' }], 'Removing one child listener leaves root routing intact')
	} finally {
		connection.close()
		await server.stop(true)
	}
})
