import * as assert from 'node:assert'
import { test } from 'bun:test'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import type { AddressedRequestAccessContext } from '../../app/ts/background/requestAccessContext.js'
import { verifyRequestAccess } from '../../app/ts/background/requestAccessVerification.js'
import { createPort, installBrowserMock, loadModules } from './backgroundEthAccountsTestHarness.js'

const origin = 'https://request-access.example'
const website = { websiteOrigin: origin, title: undefined, icon: undefined }
const address = (value: bigint): AddressBookEntry => ({ type: 'contact', address: value, name: 'Selected account', entrySource: 'User', askForAddressAccess: true })

async function harness() {
	installBrowserMock()
	const modules = await loadModules()
	const socket = { tabId: 1, connectionName: 0n }
	const { port } = createPort(1)
	const connections: WebsiteTabConnections = new Map([[1, { connections: { [modules.websiteSocketToString(socket)]: { socket, port, websiteOrigin: origin, approved: true, wantsToConnect: true } } }]])
	const context: AddressedRequestAccessContext = { activeAddress: address(1n), accessSocket: socket, accessOrigin: origin, requireAddressAccess: false }
	const request = (method: string) => ({ method, interceptorRequest: true, usingInterceptorWithoutSigner: true, uniqueRequestIdentifier: { requestId: 1, requestSocket: socket } })
	return { settings: await modules.getSettings(), socket, connections, context, request }
}

for (const method of ['eth_requestAccounts', 'wallet_requestPermissions', 'eth_call', 'eth_simulateV1']) test(`${ method } can request initial consent but a reroute onto another account never prompts`, async () => {
	const h = await harness()
	const settings = { ...h.settings, websiteAccess: [] }
	const context = { ...h.context, activeAddress: address(2n) }
	assert.equal(verifyRequestAccess(new Map(), h.request(method), context, settings, { kind: 'initial' }), 'askAccess')
	assert.equal(verifyRequestAccess(h.connections, h.request(method), context, settings, { kind: 'reroute', previouslyVerified: h.context }), 'noAccess', 'an approved old connection cannot grant a different account or open fresh consent')
})

for (const method of ['eth_accounts', 'eth_getBalance', 'site_rpc_request']) test(`${ method } uses current native-source address consent on initial admission and reroute`, async () => {
	const h = await harness()
	const context = { ...h.context, requireAddressAccess: true }
	for (const access of [false, true]) {
		const settings = { ...h.settings, websiteAccess: [{ website, access: true, addressAccess: [{ address: context.activeAddress.address, access }] }] }
		const expected = access ? 'hasAccess' : 'noAccess'
		assert.equal(verifyRequestAccess(h.connections, h.request(method), context, settings, { kind: 'initial' }), expected)
		assert.equal(verifyRequestAccess(h.connections, h.request(method), context, settings, { kind: 'reroute', previouslyVerified: context }), expected, 'native authority never reuses an earlier address grant merely because its account is unchanged')
		assert.equal(verifyRequestAccess(h.connections, h.request(method), { ...context, activeAddress: undefined }, settings, { kind: 'initial' }), 'noAccess')
	}
})

test('rerouting ordinary RPC execution onto another account requires that account\'s stored grant', async () => {
	const h = await harness()
	const context = { ...h.context, activeAddress: address(2n) }
	for (const access of [false, true]) {
		const settings = { ...h.settings, websiteAccess: [{ website, access: true, addressAccess: [{ address: 1n, access: true }, { address: 2n, access }] }] }
		assert.equal(verifyRequestAccess(h.connections, h.request('eth_getBalance'), context, settings, { kind: 'reroute', previouslyVerified: h.context }), access ? 'hasAccess' : 'noAccess')
	}
})

test('background routing keeps request authorization in the shared access policy owner', async () => {
	const routing = await Bun.file('app/ts/background/background.ts').text()
	assert.doesNotMatch(routing, /\bverifyAccess\s*\(/u)
	assert.match(routing, /from '\.\/requestAccessVerification\.js'/u)
})
