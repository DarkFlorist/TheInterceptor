import * as assert from 'assert'
import { test } from 'bun:test'
import { getWebsiteOrigin, getWebsiteOriginForSender, getWebsiteHostname, haveSameHostForNetworkBlocking } from '../../app/ts/utils/websiteOrigin.js'
import { hasAccess, hasAddressAccess } from '../../app/ts/background/websiteAccessPolicy.js'
import { migrateWebsiteAccessOrigins } from '../../app/ts/background/websiteAccessMigration.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'

test('network host projections do not redefine permission identity', () => {
	assert.notEqual(getWebsiteOrigin('https://example.test'), getWebsiteOrigin('http://example.test'))
	assert.equal(haveSameHostForNetworkBlocking('https://example.test/a', 'http://example.test/b'), true)
	assert.equal(haveSameHostForNetworkBlocking('https://example.test', 'https://example.test:8443'), false)
	assert.equal(haveSameHostForNetworkBlocking('https://example.test', 'https://child.example.test'), false)
	assert.equal(haveSameHostForNetworkBlocking('data:text/plain,test', 'data:text/plain,test'), false)
	assert.equal(getWebsiteHostname('https://example.test:8443'), 'example.test')
	assert.equal(getWebsiteHostname('https://[::1]:8443'), '[::1]')
	assert.equal(getWebsiteHostname('example.test'), 'example.test')
	assert.equal(getWebsiteOrigin('example.test'), undefined)
	assert.equal(getWebsiteHostname('file:///tmp/a.html'), undefined)
})

test('permissions distinguish schemes and effective ports', () => {
	const account: AddressBookEntry = { type: 'contact', address: 1n, name: 'Account', entrySource: 'User', chainId: 'AllChains' }
	const permissions = [{ website: { websiteOrigin: 'https://example.test', icon: undefined, title: undefined }, access: true, addressAccess: [{ address: account.address, access: true }] }]
	for (const [url, expected] of [
		['https://example.test:443/path', 'hasAccess'], ['http://example.test', 'askAccess'],
		['https://example.test:8443', 'askAccess'], ['https://child.example.test', 'askAccess'],
	] as const) {
		const origin = getWebsiteOrigin(url)
		assert.ok(origin !== undefined)
		assert.equal(hasAccess(permissions, origin), expected)
		assert.equal(hasAddressAccess(permissions, origin, account), expected)
	}
})

test('uses browser-authenticated frame origins and rejects opaque origins', () => {
	assert.equal(getWebsiteOriginForSender({ url: 'about:blank', origin: 'https://frame.example' }), 'https://frame.example')
	assert.equal(getWebsiteOriginForSender({ url: 'https://frame.example', origin: 'null' }), undefined)
	assert.equal(getWebsiteOriginForSender({ url: 'data:text/html,test' }), undefined)
	assert.equal(getWebsiteOriginForSender({ url: 'about:blank' }), undefined)
	assert.notEqual(getWebsiteOrigin('file:///tmp/a.html'), getWebsiteOrigin('file:///tmp/b.html'))
})

test('legacy hostname permissions require consent again without overwriting explicit origin permissions', () => {
	const legacy = { website: { websiteOrigin: 'legacy.example', icon: undefined, title: 'Legacy' }, access: true, addressAccess: [{ address: 1n, access: true }], interceptorDisabled: true }
	const explicit = { ...legacy, website: { ...legacy.website, websiteOrigin: 'https://explicit.example' } }
	const migrated = migrateWebsiteAccessOrigins([legacy, { ...legacy, website: { ...legacy.website, websiteOrigin: 'explicit.example' } }, explicit])
	assert.equal(migrated.length, 2)
	assert.equal(migrated[0]?.website.websiteOrigin, 'https://legacy.example')
	assert.equal(migrated[0]?.access, undefined)
	assert.equal(migrated[0]?.addressAccess, undefined)
	assert.equal(migrated[0]?.interceptorDisabled, undefined)
	assert.equal(migrated[1], explicit)
	assert.equal(migrateWebsiteAccessOrigins(migrated), migrated)
	assert.equal(hasAccess(migrated, 'https://legacy.example'), 'askAccess')
	assert.equal(hasAccess(migrated, 'http://legacy.example'), 'askAccess')
})


test('canonicalizes explicit stored URLs without losing permissions or disable/block settings', () => {
	for (const [origin, destination] of [
		['https://EXAMPLE.test:443/path?query#fragment', 'https://example.test'],
		['http://example.test:80', 'http://example.test'],
		['https://example.test:8443/path', 'https://example.test:8443'],
		['file:///tmp/test.html?query#fragment', 'file:///tmp/test.html'],
	] as const) {
		const entry = { website: { websiteOrigin: origin, icon: undefined, title: 'Stored' }, access: true, addressAccess: [{ address: 1n, access: false }], interceptorDisabled: true, declarativeNetRequestBlockMode: 'block-all' as const }
		const migrated = migrateWebsiteAccessOrigins([entry])
		assert.deepEqual(migrated, [{ ...entry, website: { ...entry.website, websiteOrigin: destination } }])
		assert.equal(migrateWebsiteAccessOrigins(migrated), migrated)
	}
})

test('canonical permissions take precedence over URL aliases regardless of storage ordering', () => {
	const canonical = { website: { websiteOrigin: 'https://example.test', icon: undefined, title: undefined }, access: false }
	const alias = { ...canonical, website: { ...canonical.website, websiteOrigin: 'https://example.test:443/path' }, access: true }
	assert.deepEqual(migrateWebsiteAccessOrigins([alias, canonical]), [canonical])
	assert.deepEqual(migrateWebsiteAccessOrigins([canonical, alias]), [canonical])
})

test('merges URL aliases without losing distinct grants or protection settings', () => {
	const first = { website: { websiteOrigin: 'https://example.test:443/path', icon: undefined, title: 'Example' }, access: true, addressAccess: [{ address: 1n, access: true }], interceptorDisabled: true }
	const second = { website: { websiteOrigin: 'https://example.test/?ref=1', icon: undefined, title: 'Example' }, addressAccess: [{ address: 2n, access: true }], declarativeNetRequestBlockMode: 'block-all' as const }
	for (const entries of [[first, second], [second, first]]) {
		const migrated = migrateWebsiteAccessOrigins(entries)
		assert.equal(migrated.length, 1)
		assert.equal(migrated[0]?.website.websiteOrigin, 'https://example.test')
		assert.equal(migrated[0]?.access, true)
		assert.deepEqual(new Map(migrated[0]?.addressAccess?.map((entry) => [entry.address, entry.access])), new Map([[1n, true], [2n, true]]))
		assert.equal(migrated[0]?.interceptorDisabled, true)
		assert.equal(migrated[0]?.declarativeNetRequestBlockMode, 'block-all')
		assert.equal(migrateWebsiteAccessOrigins(migrated), migrated)
	}
})

test('alias conflicts preserve denials, enabled interception, and network blocking regardless of order', () => {
	const grant = { website: { websiteOrigin: 'https://example.test/grant', icon: undefined, title: undefined }, access: true, addressAccess: [{ address: 1n, access: true }], interceptorDisabled: true, declarativeNetRequestBlockMode: 'disabled' as const }
	const denial = { ...grant, website: { ...grant.website, websiteOrigin: 'https://example.test/deny' }, access: false, addressAccess: [{ address: 1n, access: false }], interceptorDisabled: false, declarativeNetRequestBlockMode: 'block-all' as const }
	for (const entries of [[grant, denial], [denial, grant]]) {
		assert.deepEqual(migrateWebsiteAccessOrigins(entries), [{ ...denial, website: { ...denial.website, websiteOrigin: 'https://example.test' } }])
	}
})

test('canonical duplicates also merge safely when mixed with migrated aliases', () => {
	const first = { website: { websiteOrigin: 'https://example.test', icon: undefined, title: undefined }, addressAccess: [{ address: 1n, access: true }] }
	const second = { ...first, addressAccess: [{ address: 2n, access: true }] }
	const unrelatedAlias = { ...first, website: { ...first.website, websiteOrigin: 'https://other.test/path' } }
	for (const entries of [[first, second], [first, second, unrelatedAlias]]) {
		const migrated = migrateWebsiteAccessOrigins(entries)
		assert.deepEqual(migrated[0]?.addressAccess, [{ address: 1n, access: true }, { address: 2n, access: true }])
		assert.equal(migrateWebsiteAccessOrigins(migrated), migrated)
	}
})

test('merging imported aliases cannot turn a duplicate account denial into a grant', () => {
	const first = { website: { websiteOrigin: 'https://example.test/path', icon: undefined, title: undefined }, addressAccess: [{ address: 1n, access: false }, { address: 1n, access: true }] }
	const second = { ...first, website: { ...first.website, websiteOrigin: 'https://example.test/?ref=1' }, addressAccess: [{ address: 2n, access: true }] }
	for (const entries of [[first, second], [second, first]]) {
		const migrated = migrateWebsiteAccessOrigins(entries)
		assert.equal(migrated[0]?.addressAccess?.find((entry) => entry.address === 1n)?.access, false)
	}
})

test('explicit URL aliases retain grants and disable settings before or after legacy hostnames', () => {
	const alias = { website: { websiteOrigin: 'https://example.test/path', icon: undefined, title: 'Explicit' }, access: true, addressAccess: [{ address: 1n, access: true }], interceptorDisabled: true, declarativeNetRequestBlockMode: 'block-all' as const }
	const legacy = { ...alias, website: { ...alias.website, websiteOrigin: 'example.test', title: 'Legacy' }, access: false }
	const expected = [{ ...alias, website: { ...alias.website, websiteOrigin: 'https://example.test' } }]
	for (const entries of [[alias, legacy], [legacy, alias], [legacy, alias, legacy], [alias, legacy, alias]]) {
		const migrated = migrateWebsiteAccessOrigins(entries)
		assert.deepEqual(migrated, expected)
		assert.equal(migrateWebsiteAccessOrigins(migrated), migrated)
	}
})

test('missing browser sender metadata cannot authorize a connection', () => {
	assert.equal(getWebsiteOriginForSender(undefined), undefined)
	assert.equal(getWebsiteOriginForSender({}), undefined)
	assert.equal(getWebsiteOriginForSender({ origin: 'https://example.test' }), undefined)
})

test('legacy hostname network blocks survive explicit origin collisions without replacing consent', () => {
	const legacy = { website: { websiteOrigin: 'example.test', icon: undefined, title: 'Legacy' }, access: false, interceptorDisabled: true, declarativeNetRequestBlockMode: 'block-all' as const }
	for (const explicitUrl of ['https://example.test', 'https://example.test:443/path']) {
		const explicit = { website: { ...legacy.website, websiteOrigin: explicitUrl, title: 'Explicit' }, access: true, addressAccess: [{ address: 1n, access: true }], interceptorDisabled: false, declarativeNetRequestBlockMode: 'disabled' as const }
		for (const entries of [[legacy, explicit], [explicit, legacy]]) {
			const migrated = migrateWebsiteAccessOrigins(entries)
			assert.deepEqual(migrated, [{ ...explicit, website: { ...explicit.website, websiteOrigin: 'https://example.test' }, declarativeNetRequestBlockMode: 'block-all' }])
			assert.equal(hasAccess(migrated, 'https://example.test'), 'hasAccess')
			assert.equal(hasAccess(migrated, 'http://example.test'), 'askAccess')
			assert.equal(migrateWebsiteAccessOrigins(migrated), migrated)
		}
	}
})

test('legacy blocks remain hostname scoped across schemes, ports and duplicate legacy records', () => {
	const legacy = { website: { websiteOrigin: 'example.test', icon: undefined, title: undefined }, access: true, interceptorDisabled: true }
	const blockedLegacy = { ...legacy, declarativeNetRequestBlockMode: 'block-all' as const }
	const origins = ['https://example.test', 'http://example.test', 'https://example.test:8443', 'https://other.test']
	const explicit = origins.map((websiteOrigin) => ({ website: { ...legacy.website, websiteOrigin }, access: false }))
	for (const entries of [[legacy, blockedLegacy, ...explicit], [...explicit, blockedLegacy, legacy]]) {
		const migrated = migrateWebsiteAccessOrigins(entries)
		assert.deepEqual(migrated, explicit.map((entry) => entry.website.websiteOrigin === 'https://other.test' ? entry : { ...entry, declarativeNetRequestBlockMode: 'block-all' }))
	}
	for (const entries of [[legacy, blockedLegacy], [blockedLegacy, legacy]]) {
		const migrated = migrateWebsiteAccessOrigins(entries)
		assert.deepEqual(migrated, [{ ...blockedLegacy, website: { ...legacy.website, websiteOrigin: 'https://example.test' }, access: undefined, addressAccess: undefined, interceptorDisabled: undefined }])
	}
})
