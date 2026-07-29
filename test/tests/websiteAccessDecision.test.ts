import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { applyInterceptorDisabledDecision, applyWebsiteAccessDecision, isInterceptorDisabledForWebsiteOrigin } from '../../app/ts/background/websiteAccessDecision.js'

const firstAddress = 0x1111111111111111111111111111111111111111n
const secondAddress = 0x2222222222222222222222222222222222222222n

describe('website access legacy rebinding', () => {
	test('reflects and explicitly clears a legacy interceptor-disabled row without migrating its account grant', () => {
		const legacyAccess = [{
			website: { websiteOrigin: 'example.test', icon: undefined, title: 'Legacy disabled site' },
			access: true,
			interceptorDisabled: true,
			addressAccess: [{ address: firstAddress, access: true }],
		}]
		assert.equal(isInterceptorDisabledForWebsiteOrigin(legacyAccess, 'https://example.test'), true)

		const updated = applyInterceptorDisabledDecision(legacyAccess, {
			websiteOrigin: 'https://example.test',
			icon: undefined,
			title: 'Current site',
		}, false)

		assert.equal(updated[0]?.website.websiteOrigin, 'example.test')
		assert.equal(updated[0]?.access, true)
		assert.equal(updated[0]?.interceptorDisabled, false)
		assert.deepEqual(updated[0]?.addressAccess, [{ address: firstAddress, access: true }])
		assert.deepEqual(updated[1], {
			website: { websiteOrigin: 'https://example.test', icon: undefined, title: 'Current site' },
			addressAccess: [],
			interceptorDisabled: false,
		})
		assert.equal(isInterceptorDisabledForWebsiteOrigin(updated, 'https://example.test'), false)
	})

	test('rebinds a legacy test-site grant only after an explicit decision and preserves its settings', () => {
		const previousAccess = [{
			website: { websiteOrigin: 'example.test:8080', icon: undefined, title: 'Legacy test site' },
			access: true,
			interceptorDisabled: false,
			declarativeNetRequestBlockMode: 'block-all' as const,
			addressAccess: [
				{ address: firstAddress, access: true },
				{ address: secondAddress, access: false },
			],
		}]

		const updated = applyWebsiteAccessDecision(previousAccess, {
			websiteOrigin: 'http://example.test:8080',
			icon: undefined,
			title: 'Current test site',
		}, true, firstAddress)

		assert.equal(previousAccess[0]?.website.websiteOrigin, 'example.test:8080')
		assert.equal(updated[0]?.website.websiteOrigin, 'http://example.test:8080')
		assert.equal(updated[0]?.website.title, 'Legacy test site')
		assert.equal(updated[0]?.access, true)
		assert.equal(updated[0]?.interceptorDisabled, false)
		assert.equal(updated[0]?.declarativeNetRequestBlockMode, 'block-all')
		assert.deepEqual(updated[0]?.addressAccess, [
			{ address: firstAddress, access: true },
			{ address: secondAddress, access: false },
		])
	})

	test('does not promote legacy grants when the current origin is denied', () => {
		const updated = applyWebsiteAccessDecision([{
			website: { websiteOrigin: 'example.test', icon: undefined, title: 'Legacy site' },
			access: true,
			declarativeNetRequestBlockMode: 'block-all',
			addressAccess: [
				{ address: firstAddress, access: true },
				{ address: secondAddress, access: false },
			],
		}], {
			websiteOrigin: 'https://example.test',
			icon: undefined,
			title: 'Current site',
		}, false, firstAddress)

		assert.deepEqual(updated, [{
			website: { websiteOrigin: 'https://example.test', icon: undefined, title: 'Legacy site' },
			access: false,
			declarativeNetRequestBlockMode: 'block-all',
			addressAccess: [
				{ address: secondAddress, access: false },
				{ address: firstAddress, access: false },
			],
		}])
	})

	test('binds the legacy file-page marker to only the explicitly approved file', () => {
		const updated = applyWebsiteAccessDecision([{
			website: { websiteOrigin: '', icon: undefined, title: 'Legacy file access' },
			access: true,
			addressAccess: [{ address: firstAddress, access: true }],
		}], {
			websiteOrigin: 'file:///tmp/dapp/index.html',
			icon: undefined,
			title: 'Local dapp',
		}, true, firstAddress)

		assert.equal(updated[0]?.website.websiteOrigin, 'file:///tmp/dapp/index.html')
		assert.deepEqual(updated[0]?.addressAccess, [{ address: firstAddress, access: true }])
	})

	test('preserves an explicit legacy port when rebinding an HTTP test site', () => {
		const updated = applyWebsiteAccessDecision([{
			website: { websiteOrigin: 'example.test:443', icon: undefined, title: 'Legacy unusual port' },
			access: true,
			addressAccess: [{ address: firstAddress, access: true }],
		}], {
			websiteOrigin: 'http://example.test:443',
			icon: undefined,
			title: 'Current unusual port',
		}, true, firstAddress)

		assert.equal(updated[0]?.website.websiteOrigin, 'http://example.test:443')
	})

	test('does not replace an exact scheme-bound entry with a legacy candidate', () => {
		const updated = applyWebsiteAccessDecision([
			{
				website: { websiteOrigin: 'example.test', icon: undefined, title: 'Legacy' },
				access: true,
				addressAccess: [{ address: firstAddress, access: true }],
			},
			{
				website: { websiteOrigin: 'https://example.test', icon: undefined, title: 'Exact' },
				access: false,
				addressAccess: undefined,
			},
		], {
			websiteOrigin: 'https://example.test',
			icon: undefined,
			title: 'Current',
		}, true, secondAddress)

		assert.equal(updated[0]?.website.websiteOrigin, 'example.test')
		assert.equal(updated[1]?.website.websiteOrigin, 'https://example.test')
		assert.deepEqual(updated[1]?.addressAccess, [{ address: secondAddress, access: true }])
	})
})
