import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { createRequestAccessContextResolver, type RequestAccessContext } from '../../app/ts/background/requestAccessContext.js'
import { getSettings } from '../../app/ts/background/settings.js'
import { installBrowserMock } from './backgroundEthAccountsTestHarness.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'

const socket = { tabId: 1, connectionName: 2n }
const request = { method: 'eth_accounts', params: [], uniqueRequestIdentifier: { requestId: 1, requestSocket: socket }, interceptorRequest: true, usingInterceptorWithoutSigner: true }
const connections: WebsiteTabConnections = new Map()

test('unrelated requests never invoke a secondary protocol access owner', async () => {
	installBrowserMock()
	const resolve = createRequestAccessContextResolver([{ method: 'secondary', resolve: async () => { throw new Error('Unrelated owner was invoked') } }])
	const context = await resolve(connections, socket, request, await getSettings(), 'https://app.example', async () => undefined)
	assert.equal(context.accessSocket, socket)
	assert.equal(context.accessOrigin, 'https://app.example')
	assert.equal(context.requireAddressAccess, false)
	assert.equal('isCurrent' in context, false)
})

test('explicit admission denial cannot fall back to ordinary account selection', async () => {
	installBrowserMock()
	const denied: RequestAccessContext = { activeAddress: undefined, accessSocket: socket, accessOrigin: 'https://source.example', requireAddressAccess: true, isCurrent: async () => false }
	const resolve = createRequestAccessContextResolver([{ method: 'secondary', resolve: async () => denied }])
	const context = await resolve(connections, socket, { ...request, method: 'secondary' }, await getSettings(), 'https://app.example', async () => { throw new Error('A denied context must remain denied') })
	assert.equal(context, denied)
	assert.ok(context.requireAddressAccess)
	assert.equal(await context.isCurrent(await getSettings()), false)
})

test('a matched owner may explicitly defer to ordinary address selection', async () => {
	installBrowserMock()
	let called = false
	const resolve = createRequestAccessContextResolver([{ method: request.method, resolve: async () => undefined }])
	await resolve(connections, socket, request, await getSettings(), 'https://app.example', async () => { called = true; return undefined })
	assert.equal(called, true)
})
