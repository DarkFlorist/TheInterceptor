import { sendPopupMessageWithReply } from '../../app/ts/background/backgroundUtils.js'
import { createNativeGnosisSafeAppsSourceDisconnected } from '../../app/shared/ts/gnosisSafeAppsBridgeProtocol.js'
import * as assert from 'assert'
import { test } from 'bun:test'
import { installBrowserMock, createEthereumWithGetBlockCounter, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'
import { getSettings } from '../../app/ts/background/settings.js'
import { popupMessageHandler } from '../../app/ts/background/popupMessageRouting.js'
import { PopupReplyOption } from '../../app/ts/types/interceptor-reply-messages.js'
import { relayNativeGnosisSafeAppsRequest } from '../../app/ts/background/nativeGnosisSafeAppsHost.js'
import { NATIVE_GNOSIS_SAFE_APPS_REQUEST } from '../../app/ts/types/popupMessageProtocol.js'
import { PopupMessage } from '../../app/ts/types/interceptor-messages.js'

const request = { id: 'sdk-request', method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } }
const message = { method: NATIVE_GNOSIS_SAFE_APPS_REQUEST, data: { sourceTabId: 12, origin: 'https://app.example', request } }
const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/html/gnosisSafeAppsHost.html?sourceTabId=12' }
const dependencies = {
	extensionId: 'extension-id',
	hostUrls: ['chrome-extension://extension-id/html/gnosisSafeAppsHost.html'],
	getTab: async () => ({ url: 'https://app.example/path' }),
	sendToSource: async (_tab: number, _message: unknown) => ({ id: request.id, success: true, data: { safeAddress: '0x1234' } }),
}

test('the canonical popup message union includes the sender-bound native host relay', () => {
	assert.equal(PopupMessage.safeParse(message).success, true)
	assert.equal(PopupMessage.safeParse({ method: 'not_a_popup_method' }).success, false)
})

test('native host relays through the original website provider without changing its origin or request', async () => {
	const sent: unknown[] = []
	const response = await relayNativeGnosisSafeAppsRequest(message, sender, { ...dependencies, sendToSource: async (tab, envelope) => {
		sent.push({ tab, envelope })
		return await dependencies.sendToSource(tab, envelope)
	} })
	assert.deepEqual(sent, [{ tab: 12, envelope: { method: 'interceptor_native_gnosis_safe_source_request', origin: 'https://app.example', request } }])
	assert.deepEqual(response, { type: 'NativeGnosisSafeAppsRelayReply', ok: true, response: { id: request.id, success: true, data: { safeAddress: '0x1234' } } })
})

test('native host rejects webpage/content-script senders and lookalike extension paths before reading a tab', async () => {
	for (const candidate of [{ id: sender.id, url: 'https://app.example' }, { id: 'other-extension', url: sender.url }, { id: sender.id, url: 'chrome-extension://extension-id/html/gnosisSafeAppsHost.html/evil' }]) {
		const response = await relayNativeGnosisSafeAppsRequest(message, candidate, { ...dependencies, getTab: async () => { throw new Error('Untrusted sender must not read tabs') } })
		assert.equal(response.ok, false)
	}
})

test('native host rejects closed/navigated sources, malformed SDK envelopes and opaque origins without forwarding', async () => {
	let sent = 0
	const source = { ...dependencies, sendToSource: async () => { sent++; return undefined } }
	for (const getTab of [async () => undefined, async () => ({ url: 'https://other.example' })]) await relayNativeGnosisSafeAppsRequest(message, sender, { ...source, getTab })
	for (const origin of ['null', 'chrome-extension://extension-id', 'https://app.example/path']) await relayNativeGnosisSafeAppsRequest({ ...message, data: { ...message.data, origin } }, sender, source)
	await relayNativeGnosisSafeAppsRequest({ ...message, data: { ...message.data, request: { ...request, env: {} } } }, sender, source)
	assert.equal(sent, 0)
})

test('native host refuses mismatched responses and never retries a mutation after disconnection', async () => {
	let calls = 0
	const mutation = { ...message, data: { ...message.data, request: { ...request, method: 'sendTransactions' } } }
	const response = await relayNativeGnosisSafeAppsRequest(mutation, sender, { ...dependencies, sendToSource: async () => { calls++; throw new Error('Could not establish connection. Receiving end does not exist.') } })
	assert.equal(calls, 1)
	assert.equal(response.ok, false)
	const mismatched = await relayNativeGnosisSafeAppsRequest(message, sender, { ...dependencies, sendToSource: async () => ({ id: 'other-request', success: true }) })
	assert.equal(mismatched.ok, false)
})


for (const manifestVersion of [2, 3] as const) test(`MV${ manifestVersion } native host requests use canonical popup dispatch and reply serialization`, async () => {
	installBrowserMock({ manifestVersion })
	const root = `${ manifestVersion === 2 ? 'moz-extension' : 'chrome-extension' }://extension-id/`
	Object.assign(browser.runtime, { id: 'extension-id', getURL: (file: string) => new URL(file, root).href })
	const hostUrl = new URL(manifestVersion === 2 ? 'html/gnosisSafeAppsHost.html' : 'html3/gnosisSafeAppsHostV3.html', root).href
	const calls: unknown[] = []
	let tabReads = 0
	Object.assign(browser.tabs, {
		get: async () => { tabReads++; return { id: 12, active: true, url: 'https://app.example/path' } },
		sendMessage: async (tabId: number, envelope: unknown, options: unknown) => {
			calls.push({ tabId, envelope, options })
			return { id: request.id, success: true, data: { safeAddress: '0x1234' }, bridgeToken: 'private-source-token' }
		},
	})
	const services = createEthereumWithGetBlockCounter({ count: 0 }).simulationServicesOwner
	const settings = await getSettings()
	const dispatch = async (sender?: browser.runtime.MessageSender) => await popupMessageHandler(new Map(), services, message, settings, noopPublishRpcConnectionStatus, sender)
	assert.deepEqual(await dispatch({ id: 'extension-id', url: `${ hostUrl }?sourceTabId=12` }), { type: 'NativeGnosisSafeAppsRelayReply', ok: true, response: { id: request.id, success: true, data: { safeAddress: '0x1234' } } })
	assert.deepEqual(calls, [{ tabId: 12, envelope: { method: 'interceptor_native_gnosis_safe_source_request', origin: 'https://app.example', request }, options: { frameId: 0 } }])
	assert.equal(tabReads, 1)
	for (const sender of [undefined, { id: 'extension-id', url: 'https://app.example/' }, { id: 'other-extension', url: hostUrl }, { id: 'extension-id', url: `${ root }html/settingsView.html` }]) {
		const result = await dispatch(sender)
		assert.equal(typeof result === 'object' && result !== null && 'ok' in result && result.ok, false)
	}
	assert.equal(tabReads, 1, 'untrusted and wrong-page senders never query source tabs')
	assert.equal(calls.length, 1, 'the domain registry preserves the sender boundary before forwarding')
})

test('canonical popup reply parsing distinguishes transport refusals from opaque admitted SDK responses', () => {
	const refusal = { type: 'NativeGnosisSafeAppsRelayReply', ok: false, message: 'Wrong host sender' }
	assert.deepEqual(PopupReplyOption.parse(refusal), refusal)
	const admitted = { type: 'NativeGnosisSafeAppsRelayReply', ok: true, response: { id: request.id, success: false, error: 'denied' } }
	assert.deepEqual(PopupReplyOption.parse(admitted), admitted)
	assert.deepEqual(PopupReplyOption.serialize(PopupReplyOption.parse(admitted)), admitted)
	assert.equal(PopupReplyOption.safeParse({ id: request.id, success: false, error: 'denied' }).success, false)
})


test('native host recognizes a serialized source-disconnection reply by discriminant and request id without replay', async () => {
	let calls = 0
	const mutation = { ...message, data: { ...message.data, request: { ...request, method: 'sendTransactions' } } }
	const reply = await relayNativeGnosisSafeAppsRequest(mutation, sender, { ...dependencies, sendToSource: async () => {
		calls++
		return JSON.parse(JSON.stringify(createNativeGnosisSafeAppsSourceDisconnected(request.id)))
	} })
	assert.equal(calls, 1)
	assert.deepEqual(reply, { type: 'NativeGnosisSafeAppsRelayReply', ok: false, message: 'The original website provider disconnected. Reload the original tab and open the app again.' })
	for (const value of [createNativeGnosisSafeAppsSourceDisconnected('other-request'), { type: 'interceptor_gnosis_safe_apps_source_disconnected' }]) {
		const invalid = await relayNativeGnosisSafeAppsRequest(message, sender, { ...dependencies, sendToSource: async () => value })
		assert.equal(invalid.ok, false)
		assert.ok(!invalid.ok && invalid.message.includes('did not return'))
	}
})

test('native host propagates unexpected source errors instead of classifying application error wording', async () => {
	const error = new Error('The original Gnosis Safe App tab navigated or closed.')
	await assert.rejects(relayNativeGnosisSafeAppsRequest(message, sender, { ...dependencies, sendToSource: async () => { throw error } }), (caught) => caught === error)
})


for (const manifestVersion of [2, 3] as const) test(`MV${ manifestVersion } native relay uses the registered popup request/reply client for admitted SDK replies and refusals`, async () => {
	installBrowserMock({ manifestVersion })
	const root = `${ manifestVersion === 2 ? 'moz-extension' : 'chrome-extension' }://extension-id/`
	Object.assign(browser.runtime, { id: 'extension-id', getURL: (file: string) => new URL(file, root).href })
	const hostUrl = new URL(manifestVersion === 2 ? 'html/gnosisSafeAppsHost.html' : 'html3/gnosisSafeAppsHostV3.html', root).href
	let forwarded = 0
	Object.assign(browser.tabs, {
		get: async () => ({ id: 12, active: true, url: 'https://app.example/path' }),
		sendMessage: async () => { forwarded++; return { id: request.id, success: false, error: 'SDK request denied' } },
	})
	const services = createEthereumWithGetBlockCounter({ count: 0 }).simulationServicesOwner
	const settings = await getSettings()
	Object.assign(browser.runtime, { sendMessage: async (value: unknown) => {
		const reply = await popupMessageHandler(new Map(), services, PopupMessage.parse(value), settings, noopPublishRpcConnectionStatus, { id: 'extension-id', url: hostUrl })
		return PopupReplyOption.serialize(PopupReplyOption.parse(reply))
	} })
	assert.deepEqual(await sendPopupMessageWithReply(message), { type: 'NativeGnosisSafeAppsRelayReply', ok: true, response: { id: request.id, success: false, error: 'SDK request denied' } })
	const refused = await sendPopupMessageWithReply({ ...message, data: { ...message.data, origin: 'https://other.example' } })
	assert.ok(refused !== undefined && !refused.ok)
	assert.match(refused.message, /closed or navigated/)
	assert.equal(forwarded, 1, 'admission refusal never forwards an SDK request')
	Object.assign(browser.runtime, { sendMessage: async () => undefined })
	assert.equal(await sendPopupMessageWithReply(message), undefined, 'missing transport replies retain the shared client contract')
})
