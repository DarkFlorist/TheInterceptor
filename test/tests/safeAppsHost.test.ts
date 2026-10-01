import * as assert from 'assert'
import { test } from 'bun:test'
import SafeAppsSDK from '@safe-global/safe-apps-sdk'
import { safe } from '@wagmi/connectors/safe'
import gnosis from '@web3-onboard/gnosis'
import { installSafeAppsHost } from '../../app/inpage/ts/safeAppsHost.js'
import { createSafeHostHarness } from '../fixtures/safeAppsHostHarness.js'
import { getSafeAppsHostMatchPatterns } from '../../app/ts/utils/safeAppsHosting.js'
import { SafeAppsHostOrigins, parseSafeAppsHostOrigin } from '../../app/ts/types/safeAppsHosting.js'

const safeInfo = { safeAddress: '0x1234567890123456789012345678901234567890', chainId: 1, owners: [], threshold: 1, isReadOnly: false }

for (const origin of ['https://app.example.com', 'https://another.example:8443']) {
	test(`shared host supports the real Safe SDK and Wagmi on ${ origin } without changing timers`, async () => {
		const { fakeWindow, postMessage, restoreGlobals } = createSafeHostHarness({ origin })
		const timer = Reflect.get(fakeWindow, 'setTimeout')
		try {
			installSafeAppsHost()
			assert.equal(Reflect.get(fakeWindow, 'setTimeout'), timer)
			const parent = Reflect.get(fakeWindow, 'parent')
			installSafeAppsHost()
			assert.equal(Reflect.get(fakeWindow, 'parent'), parent)
			fakeWindow.addEventListener('message', (event) => {
				if (!('source' in event) || event.source !== fakeWindow || !('data' in event)) return
				const request: unknown = event.data
				if (typeof request !== 'object' || request === null || !('method' in request) || request.method !== 'getSafeInfo' || !('id' in request)) return
				postMessage({ id: request.id, success: true, data: safeInfo, version: '9.1.0' }, origin)
			})
			const sdk = new SafeAppsSDK()
			assert.deepEqual(await sdk.safe.getInfo(), safeInfo)
			const connector = safe()({ chains: [], emitter: { emit: () => undefined } })
			assert.deepEqual(await connector.getAccounts(), [safeInfo.safeAddress])
			assert.equal(await connector.getChainId(), 1)
			// Web3-Onboard requires a real iframe; parent emulation deliberately leaves self/top unchanged.
			assert.deepEqual(gnosis()(), [])
		} finally { restoreGlobals() }
	})
}

test('shared host leaves existing embedded Safe apps untouched', () => {
	const { fakeWindow, frameWasAppended, restoreGlobals } = createSafeHostHarness({ embedded: true })
	const parent = Reflect.get(fakeWindow, 'parent')
	try {
		installSafeAppsHost()
		assert.equal(frameWasAppended(), false)
		assert.equal(Reflect.get(fakeWindow, 'parent'), parent)
	} finally { restoreGlobals() }
})

test('hosting accepts canonical exact HTTP(S) origins and rejects malformed or overly broad configuration', () => {
	assert.equal(parseSafeAppsHostOrigin('https://EXAMPLE.com/path?query#hash'), 'https://example.com')
	// Real Chrome IPv6 registration is also covered by test:chrome-communication.
	assert.deepEqual(getSafeAppsHostMatchPatterns(['https://example.com', 'http://localhost:1234', 'https://[::1]:8443']), ['https://example.com:443/*', 'http://localhost:1234/*', 'https://[::1]:8443/*'])
	for (const origin of ['https://*.example.com', 'https://*', 'https://%2a.example.com', 'https://%2A', '*://*.example.com', 'file:///tmp/app', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com/', 'https://EXAMPLE.com']) assert.equal(SafeAppsHostOrigins.safeParse([origin]).success, false)
	for (const wildcard of ['https://*.example.com', 'https://*', 'https://%2a.example.com', 'https://%2A']) {
		assert.throws(() => parseSafeAppsHostOrigin(wildcard), /wildcard hosts/)
		assert.throws(() => getSafeAppsHostMatchPatterns([wildcard]))
	}
	assert.equal(SafeAppsHostOrigins.safeParse(['https://example.com', 'https://example.com']).success, false)
	assert.equal(SafeAppsHostOrigins.safeParse(Array.from({ length: 33 }, (_, index) => `https://app${ index }.example`)).success, false)
})

test('shared SDK transport waits for authorization, ignores unrelated responses, and surfaces rejection', async () => {
	const { fakeWindow, origin, emitMessage, restoreGlobals } = createSafeHostHarness({ origin: 'https://safe-app.example' })
	try {
		installSafeAppsHost()
		let requestId: string | undefined
		fakeWindow.addEventListener('message', (event) => {
			if (!('source' in event) || event.source !== fakeWindow || !('data' in event)) return
			const request: unknown = event.data
			if (typeof request === 'object' && request !== null && 'method' in request && request.method === 'getSafeInfo' && 'id' in request && typeof request.id === 'string') requestId = request.id
		})
		const sdk = new SafeAppsSDK()
		let settled = false
		const result = sdk.safe.getInfo()
		void result.then(() => { settled = true }, () => { settled = true })
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.notEqual(requestId, undefined)
		const response = { id: requestId, success: true, data: safeInfo, version: '9.1.0' }
		emitMessage(response, 'https://unrelated.example')
		emitMessage(response, origin, new EventTarget())
		await Promise.resolve()
		assert.equal(settled, false)
		emitMessage({ id: requestId, success: false, error: 'User rejected access.', version: '9.1.0' })
		await assert.rejects(result, /User rejected access/)
	} finally { restoreGlobals() }
})

test('native parent messaging rejects embedded callers before re-posting under the hosted origin', async () => {
	const { fakeWindow, origin, emitParentMessage, restoreGlobals } = createSafeHostHarness()
	try {
		installSafeAppsHost()
		const forwarded: string[] = []
		fakeWindow.addEventListener('message', (event) => {
			if ('source' in event && event.source === fakeWindow && 'data' in event && typeof event.data === 'object' && event.data !== null && 'method' in event.data && 'id' in event.data && typeof event.data.id === 'string') forwarded.push(event.data.id)
		})
		for (const method of ['getSafeInfo', 'getChainInfo', 'rpcCall', 'sendTransactions', 'signMessage']) {
			const request = { id: method, method, env: { sdkVersion: '9.1.0' } }
			emitParentMessage(request, 'https://unapproved.example', new EventTarget())
			emitParentMessage(request, origin, new EventTarget())
		}
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.deepEqual(forwarded, [])
		emitParentMessage({ id: 'top-discovery', method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } })
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.deepEqual(forwarded, ['top-discovery'])
	} finally { restoreGlobals() }
})
