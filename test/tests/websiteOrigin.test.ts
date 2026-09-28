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
