import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { WebsiteAccess } from '../../app/ts/types/websiteAccessTypes.js'
import { type FieldMergeRules, mergeRecordsByFieldRules, toCanonicalWebsiteAccess, websiteAccessMergeRules } from '../../app/ts/utils/canonicalWebsiteAccess.js'

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

	test('a newly added rule takes effect without touching the merge, instead of the later record winning', () => {
		type FutureRecord = { readonly keptName: string, readonly strictestLimit?: number }
		// A rule table as it would look after adding strictestLimit, whose rule keeps the smaller limit.
		const rules: FieldMergeRules<FutureRecord> = {
			keptName: (first) => first,
			strictestLimit: (first, second) => first === undefined || second === undefined ? first ?? second : Math.min(first, second),
		}
		const olderRecord = { keptName: 'older', strictestLimit: 1, unknownSetting: 'older' }
		const newerRecord = { keptName: 'newer', strictestLimit: 5, unknownSetting: 'newer' }

		assert.deepEqual(mergeRecordsByFieldRules(rules, olderRecord, newerRecord), { keptName: 'older', strictestLimit: 1, unknownSetting: 'newer' })
	})

	test('every website access field merges by its rule', () => {
		const first: WebsiteAccess = { website: { websiteOrigin: 'https://example.test', title: 'First' }, access: true, interceptorDisabled: true, declarativeNetRequestBlockMode: 'disabled', addressAccess: [{ address: 1n, access: true }] }
		const second: WebsiteAccess = { website: { websiteOrigin: 'https://example.test', icon: 'data:image/png;base64,Y2FjaGVk' }, access: false, interceptorDisabled: false, declarativeNetRequestBlockMode: 'block-all', addressAccess: [{ address: 1n, access: false }] }
		const [merged] = toCanonicalWebsiteAccess([first, second])
		if (merged === undefined) throw new Error('Expected one merged record')
		assert.deepEqual(merged.website, websiteAccessMergeRules.website(first.website, second.website))
		assert.deepEqual(merged.addressAccess, websiteAccessMergeRules.addressAccess(first.addressAccess, second.addressAccess))
		assert.equal(merged.access, websiteAccessMergeRules.access(first.access, second.access))
		assert.equal(merged.interceptorDisabled, websiteAccessMergeRules.interceptorDisabled(first.interceptorDisabled, second.interceptorDisabled))
		assert.equal(merged.declarativeNetRequestBlockMode, websiteAccessMergeRules.declarativeNetRequestBlockMode(first.declarativeNetRequestBlockMode, second.declarativeNetRequestBlockMode))
		// Each rule differs from "later record wins" on these records, so applying a rule is observable.
		assert.notEqual(merged.interceptorDisabled, second.interceptorDisabled)
		assert.notEqual(merged.website.title, second.website.title)
	})
})
