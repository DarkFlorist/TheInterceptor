import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { toCanonicalWebsiteAccess } from '../../app/ts/utils/canonicalWebsiteAccess.js'

describe('canonical website access', () => {
	test('merging two records for one origin keeps a field the merge rules do not know, such as one stored by a newer release', () => {
		const olderRecord = { website: { websiteOrigin: 'https://example.test' }, access: true, addressAccess: undefined, futurePerSiteSetting: 'older' }
		const newerRecord = { website: { websiteOrigin: 'https://example.test/' }, access: false, addressAccess: undefined, futurePerSiteSetting: 'newer' }

		const merged = toCanonicalWebsiteAccess([olderRecord, newerRecord])

		assert.deepEqual(merged, [{ website: { websiteOrigin: 'https://example.test' }, access: false, addressAccess: undefined, futurePerSiteSetting: 'newer' }])
	})

	test('merging keeps the more restrictive value of every known field', () => {
		const merged = toCanonicalWebsiteAccess([
			{ website: { websiteOrigin: 'https://example.test', title: 'First' }, access: true, interceptorDisabled: true, declarativeNetRequestBlockMode: 'block-all', addressAccess: [{ address: 1n, access: true }, { address: 2n, access: true }] },
			{ website: { websiteOrigin: 'https://example.test', title: 'Second' }, access: false, interceptorDisabled: false, declarativeNetRequestBlockMode: 'disabled', addressAccess: [{ address: 2n, access: false }] },
		])

		assert.deepEqual(merged, [{
			website: { websiteOrigin: 'https://example.test', title: 'First' },
			access: false,
			interceptorDisabled: true,
			declarativeNetRequestBlockMode: 'block-all',
			addressAccess: [{ address: 1n, access: true }, { address: 2n, access: false }],
		}])
	})
})
