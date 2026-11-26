import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { createFirefoxDocumentRoutes } from '../benchmarks/firefoxHarness.js'

function createConnection() {
	const commands: { method: string, params: Record<string, unknown> }[] = []
	const listeners: ((params: unknown) => void)[] = []
	let nextIntercept = 1
	const connection = {
		on: (method: string, listener: (params: unknown) => void) => { assert.equal(method, 'network.beforeRequestSent'); listeners.push(listener) },
		send: async (method: string, params: Record<string, unknown>) => {
			commands.push({ method, params })
			return method === 'network.addIntercept' ? { intercept: `intercept-${ nextIntercept++ }` } : {}
		},
	}
	return { connection, commands, listeners }
}

test('Firefox document route replacement owns one listener and removes each superseded intercept', async () => {
	const { connection, commands, listeners } = createConnection()
	const failures: unknown[] = []
	const setRoutes = createFirefoxDocumentRoutes(connection, (error) => failures.push(error))
	const url = 'https://fixture.test/'
	await setRoutes([{ url, body: 'decoy' }])
	await setRoutes([{ url, body: 'current' }])
	assert.equal(listeners.length, 1)
	assert.deepEqual(commands.map(({ method }) => method), ['session.subscribe', 'network.addIntercept', 'network.removeIntercept', 'network.addIntercept'])
	assert.deepEqual(commands[2]?.params, { intercept: 'intercept-1' })
	for (const listener of listeners) listener({ isBlocked: true, request: { request: 'request-1', url } })
	const replies = commands.filter(({ method }) => method === 'network.provideResponse')
	assert.equal(replies.length, 1)
	assert.deepEqual(replies[0]?.params.body, { type: 'base64', value: Buffer.from('current').toString('base64') })
	await setRoutes([])
	assert.deepEqual(commands.at(-1), { method: 'network.removeIntercept', params: { intercept: 'intercept-2' } })
	await setRoutes([])
	assert.equal(commands.filter(({ method }) => method === 'network.addIntercept').length, 2)
	assert.deepEqual(failures, [])
})

test('an empty Firefox route table never installs a wildcard interception or subscribes network events', async () => {
	const { connection, commands } = createConnection()
	const setRoutes = createFirefoxDocumentRoutes(connection, (error) => { throw error })
	await setRoutes([])
	assert.deepEqual(commands, [])
})

test('Firefox route replacement propagates setup failures without losing ownership of the old intercept', async () => {
	const { connection, commands } = createConnection()
	const failure = new Error('intercept removal failed')
	let refuseRemoval = true
	const setRoutes = createFirefoxDocumentRoutes({
		...connection,
		send: async (method, params) => {
			if (method === 'network.removeIntercept' && refuseRemoval) throw failure
			return await connection.send(method, params)
		},
	}, (error) => { throw error })
	await setRoutes([{ url: 'https://fixture.test/', body: 'current' }])
	await assert.rejects(setRoutes([]), failure)
	refuseRemoval = false
	await setRoutes([])
	assert.deepEqual(commands.at(-1), { method: 'network.removeIntercept', params: { intercept: 'intercept-1' } })
})
