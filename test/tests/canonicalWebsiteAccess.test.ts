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
		// The restrictive value of every field is in the first record, so each rule's result differs from the second record's value.
		const first: WebsiteAccess = { website: { websiteOrigin: 'https://example.test', title: 'First' }, access: false, interceptorDisabled: true, declarativeNetRequestBlockMode: 'block-all', addressAccess: [{ address: 1n, access: false }] }
		const second: WebsiteAccess = { website: { websiteOrigin: 'https://example.test', icon: 'data:image/png;base64,Y2FjaGVk' }, access: true, interceptorDisabled: false, declarativeNetRequestBlockMode: 'disabled', addressAccess: [{ address: 1n, access: true }] }
		const [merged] = toCanonicalWebsiteAccess([first, second])
		if (merged === undefined) throw new Error('Expected one merged record')
		assert.deepEqual(merged.website, websiteAccessMergeRules.website(first.website, second.website))
		assert.deepEqual(merged.addressAccess, websiteAccessMergeRules.addressAccess(first.addressAccess, second.addressAccess))
		assert.equal(merged.access, websiteAccessMergeRules.access(first.access, second.access))
		assert.equal(merged.interceptorDisabled, websiteAccessMergeRules.interceptorDisabled(first.interceptorDisabled, second.interceptorDisabled))
		assert.equal(merged.declarativeNetRequestBlockMode, websiteAccessMergeRules.declarativeNetRequestBlockMode(first.declarativeNetRequestBlockMode, second.declarativeNetRequestBlockMode))
		// Every rule's result differs from "later record wins" on these records, so skipping any rule fails this test.
		assert.notDeepEqual(merged.website, second.website)
		assert.notDeepEqual(merged.addressAccess, second.addressAccess)
		assert.notEqual(merged.access, second.access)
		assert.notEqual(merged.interceptorDisabled, second.interceptorDisabled)
		assert.notEqual(merged.declarativeNetRequestBlockMode, second.declarativeNetRequestBlockMode)
	})
})
