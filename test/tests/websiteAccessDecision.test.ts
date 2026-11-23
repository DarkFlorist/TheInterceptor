import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { ContactEntry } from '../../app/ts/types/addressBookTypes.js'
import type { WebsiteAccessArray } from '../../app/ts/types/websiteAccessTypes.js'
import { applyWebsiteAccessDecision } from '../../app/ts/background/websiteAccessMutations.js'
import { withInterceptorDisabledForWebsite } from '../../app/ts/background/websiteAccessMutations.js'
import { findWebsiteAccessEntryForOrigin, hasAccess, hasAddressAccess, isInterceptorDisabledForWebsiteOrigin } from '../../app/ts/background/websiteAccessPolicy.js'

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

		const updated = withInterceptorDisabledForWebsite({
			websiteOrigin: 'https://example.test',
			icon: undefined,
			title: 'Current site',
		}, false)(legacyAccess)

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

	test('rebinds a legacy test-site grant only after an explicit decision, keeping its settings and denials but not its other address grants', () => {
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
			{ address: secondAddress, access: false },
			{ address: firstAddress, access: true },
		])
	})

	test('a page-level approval rebinds a legacy record without the address grants its consent dialog never showed', () => {
		const askingAddress: ContactEntry = { type: 'contact', address: firstAddress, name: 'First', entrySource: 'User', askForAddressAccess: true }
		const previousAccess = [{
			website: { websiteOrigin: 'example.test', icon: undefined, title: 'Legacy site' },
			access: true,
			addressAccess: [
				{ address: firstAddress, access: true },
				{ address: secondAddress, access: true },
			],
		}]

		const updated = applyWebsiteAccessDecision(previousAccess, { websiteOrigin: 'https://example.test', icon: undefined, title: 'Current site' }, true, undefined)

		assert.equal(updated.length, 1)
		assert.equal(updated[0]?.website.websiteOrigin, 'https://example.test')
		assert.equal(updated[0]?.access, true)
		assert.equal(updated[0]?.addressAccess, undefined)
		// The page is approved, but each account that asks for access must be approved again for the exact origin.
		assert.equal(hasAccess(updated, 'https://example.test'), 'hasAccess')
		assert.equal(hasAddressAccess(updated, 'https://example.test', askingAddress), 'askAccess')
	})

	test('a page-level approval keeps a legacy record\'s address denials', () => {
		const updated = applyWebsiteAccessDecision([{
			website: { websiteOrigin: 'example.test' },
			access: true,
			addressAccess: [
				{ address: firstAddress, access: true },
				{ address: secondAddress, access: false },
			],
		}], { websiteOrigin: 'https://example.test' }, true, undefined)

		assert.deepEqual(updated[0]?.addressAccess, [{ address: secondAddress, access: false }])
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

	test.each([['http://example.test', 'example.test:80'], ['https://example.test', 'example.test:443']])('rebinds a legacy default-port row to %s only after explicit approval', (websiteOrigin, legacyOrigin) => {
		const previousAccess = [{
			website: { websiteOrigin: legacyOrigin, title: 'Default-port site' },
			access: true,
			addressAccess: [{ address: firstAddress, access: true }],
		}]
		const updated = applyWebsiteAccessDecision(previousAccess, { websiteOrigin }, true, firstAddress)
		assert.equal(updated.length, 1)
		assert.equal(updated[0]?.website.websiteOrigin, websiteOrigin)
		assert.equal(updated[0]?.website.title, 'Default-port site')
		assert.deepEqual(updated[0]?.addressAccess, previousAccess[0]?.addressAccess)
	})

	test('clears every matching default-port disabled record while preserving other schemes and ports', () => {
		const previousAccess = ['example.test', 'example.test:443', 'example.test:80', 'example.test:8443'].map((websiteOrigin) => ({
			website: { websiteOrigin }, interceptorDisabled: true,
		}))
		const updated = withInterceptorDisabledForWebsite({ websiteOrigin: 'https://example.test' }, false)(previousAccess)
		assert.equal(isInterceptorDisabledForWebsiteOrigin(updated, 'https://example.test'), false)
		assert.equal(updated.find((entry) => entry.website.websiteOrigin === 'example.test:80')?.interceptorDisabled, true)
		assert.equal(updated.find((entry) => entry.website.websiteOrigin === 'example.test:8443')?.interceptorDisabled, true)
	})

	test('disabling an exact origin keeps scheme-ambiguous legacy disabled records for the other scheme', () => {
		const previousAccess = ['example.test', 'example.test:443', 'example.test:80'].map((websiteOrigin) => ({
			website: { websiteOrigin }, interceptorDisabled: true,
		}))
		const updated = withInterceptorDisabledForWebsite({ websiteOrigin: 'https://example.test' }, true)(previousAccess)
		assert.deepEqual(updated.slice(0, 3), previousAccess)
		assert.deepEqual(updated[3], { website: { websiteOrigin: 'https://example.test' }, addressAccess: [], interceptorDisabled: true })
		assert.equal(isInterceptorDisabledForWebsiteOrigin(updated, 'https://example.test'), true)
		assert.equal(isInterceptorDisabledForWebsiteOrigin(updated, 'http://example.test'), true)
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

describe('interceptor-disabled website access policy', () => {
	const address: ContactEntry = { type: 'contact', address: firstAddress, name: 'First', entrySource: 'User', askForAddressAccess: false }

	test('access checks report a disabled origin exactly when the shared predicate does', () => {
		const cases: readonly { readonly websiteAccess: WebsiteAccessArray, readonly disabled: boolean }[] = [
			{ websiteAccess: [{ website: { websiteOrigin: 'https://example.test' }, access: true, interceptorDisabled: true }], disabled: true },
			{ websiteAccess: [{ website: { websiteOrigin: 'example.test' }, access: true, interceptorDisabled: true }], disabled: true },
			// The canonical form merges duplicate exact records, but the policy still treats any disabled one as disabling the origin, as content-script injection does.
			{ websiteAccess: [{ website: { websiteOrigin: 'https://example.test' }, access: true }, { website: { websiteOrigin: 'https://example.test' }, interceptorDisabled: true }], disabled: true },
			{ websiteAccess: [{ website: { websiteOrigin: 'https://example.test' }, access: true, interceptorDisabled: false }], disabled: false },
			{ websiteAccess: [{ website: { websiteOrigin: 'http://example.test' }, access: true, interceptorDisabled: true }], disabled: false },
		]
		for (const { websiteAccess, disabled } of cases) {
			assert.equal(isInterceptorDisabledForWebsiteOrigin(websiteAccess, 'https://example.test'), disabled)
			assert.equal(hasAccess(websiteAccess, 'https://example.test') === 'interceptorDisabled', disabled)
			assert.equal(hasAddressAccess(websiteAccess, 'https://example.test', address) === 'interceptorDisabled', disabled)
		}
	})
})

describe('stored website details lookup', () => {
	test('reads an exact record first and otherwise the legacy record an access decision would rebind', () => {
		const legacy = { website: { websiteOrigin: 'example.test', icon: undefined, title: 'Legacy' }, access: true, addressAccess: [{ address: firstAddress, access: true }] }
		const exact = { website: { websiteOrigin: 'https://example.test', icon: undefined, title: 'Exact' }, access: true, addressAccess: undefined }
		assert.deepEqual(findWebsiteAccessEntryForOrigin([legacy], 'https://example.test'), { kind: 'legacy', entry: legacy, index: 0 })
		assert.deepEqual(findWebsiteAccessEntryForOrigin([legacy, exact], 'https://example.test'), { kind: 'exact', entry: exact, index: 1 })
		assert.equal(findWebsiteAccessEntryForOrigin([legacy], 'https://other.test'), undefined)
		// Reading a legacy record's details never grants access: only an exact record can.
		assert.equal(hasAccess([legacy], 'https://example.test'), 'askAccess')
		// The rebinding decision acts on the same record that the lookup reads, dropping its address grants.
		const rebound = applyWebsiteAccessDecision([legacy], exact.website, true, undefined)
		assert.equal(rebound.length, 1)
		assert.equal(rebound[0]?.website.title, 'Legacy')
		assert.equal(rebound[0]?.addressAccess, undefined)
		assert.equal(rebound[0]?.website.websiteOrigin, 'https://example.test')
	})
})

describe('legacy records deny but never grant', () => {
	const origin = 'https://example.test'
	const asking: ContactEntry = { type: 'contact', address: firstAddress, name: 'First', entrySource: 'User', askForAddressAccess: true }
	const notAsking: ContactEntry = { ...asking, askForAddressAccess: false }
	const exactRecords = {
		none: [],
		grant: [{ website: { websiteOrigin: origin }, access: true, addressAccess: undefined }],
		grantWithAddress: [{ website: { websiteOrigin: origin }, access: true, addressAccess: [{ address: firstAddress, access: true }] }],
		deny: [{ website: { websiteOrigin: origin }, access: false, addressAccess: undefined }],
	} satisfies Record<string, WebsiteAccessArray>
	const legacyRecords = {
		none: [],
		websiteGrant: [{ website: { websiteOrigin: 'example.test' }, access: true, addressAccess: undefined }],
		addressGrant: [{ website: { websiteOrigin: 'example.test' }, access: true, addressAccess: [{ address: firstAddress, access: true }] }],
		websiteDenial: [{ website: { websiteOrigin: 'example.test' }, access: false, addressAccess: undefined }],
		addressDenial: [{ website: { websiteOrigin: 'example.test' }, access: true, addressAccess: [{ address: firstAddress, access: false }] }],
		otherAddressDenial: [{ website: { websiteOrigin: 'example.test' }, addressAccess: [{ address: secondAddress, access: false }] }],
	} satisfies Record<string, WebsiteAccessArray>
	// [exact record, legacy record, hasAccess, hasAddressAccess for an asking account, hasAddressAccess for an account that never asks]
	const cases: readonly (readonly [keyof typeof exactRecords, keyof typeof legacyRecords, string, string, string])[] = [
		['none', 'none', 'askAccess', 'askAccess', 'askAccess'],
		['none', 'websiteGrant', 'askAccess', 'askAccess', 'askAccess'],
		['none', 'addressGrant', 'askAccess', 'askAccess', 'askAccess'],
		['none', 'websiteDenial', 'noAccess', 'noAccess', 'noAccess'],
		['none', 'addressDenial', 'askAccess', 'noAccess', 'noAccess'],
		['none', 'otherAddressDenial', 'askAccess', 'askAccess', 'askAccess'],
		['grant', 'none', 'hasAccess', 'askAccess', 'hasAccess'],
		['grant', 'addressGrant', 'hasAccess', 'askAccess', 'hasAccess'],
		['grant', 'websiteDenial', 'hasAccess', 'askAccess', 'hasAccess'],
		['grant', 'addressDenial', 'hasAccess', 'noAccess', 'noAccess'],
		['grant', 'otherAddressDenial', 'hasAccess', 'askAccess', 'hasAccess'],
		['grantWithAddress', 'none', 'hasAccess', 'hasAccess', 'hasAccess'],
		['grantWithAddress', 'addressDenial', 'hasAccess', 'hasAccess', 'hasAccess'],
		['deny', 'websiteGrant', 'noAccess', 'noAccess', 'noAccess'],
		['deny', 'addressGrant', 'noAccess', 'noAccess', 'noAccess'],
	]
	test.each(cases)('exact %s with legacy %s', (exact, legacy, website, askingAddress, notAskingAddress) => {
		const websiteAccess = [...exactRecords[exact], ...legacyRecords[legacy]]
		assert.equal(hasAccess(websiteAccess, origin), website)
		assert.equal(hasAddressAccess(websiteAccess, origin, asking), askingAddress)
		assert.equal(hasAddressAccess(websiteAccess, origin, notAsking), notAskingAddress)
	})

	test('adding any legacy record never makes an access decision more permissive', () => {
		const rank = { noAccess: 0, interceptorDisabled: 0, askAccess: 1, hasAccess: 2 }
		for (const exact of Object.values(exactRecords)) {
			for (const legacy of Object.values(legacyRecords)) {
				const withLegacy: WebsiteAccessArray = [...exact, ...legacy]
				assert.ok(rank[hasAccess(withLegacy, origin)] <= rank[hasAccess(exact, origin)])
				for (const address of [asking, notAsking]) assert.ok(rank[hasAddressAccess(withLegacy, origin, address)] <= rank[hasAddressAccess(exact, origin, address)])
			}
		}
	})
})
