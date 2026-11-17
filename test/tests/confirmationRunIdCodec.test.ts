import * as assert from 'node:assert'
import { test } from 'bun:test'
import { ConfirmationRunId } from '../../app/ts/types/accessRequest.js'

test('confirmation run ids preserve current identities and migrate legacy numeric ids', () => {
	assert.deepEqual(ConfirmationRunId.parse(42), { lifetime: '', sequence: 42 })
	const current = { lifetime: 'background session', sequence: 3 }
	assert.deepEqual(ConfirmationRunId.parse(current), current)
	assert.deepEqual(ConfirmationRunId.serialize(current), current)
})

test('legacy conversion rejects malformed run ids rather than hiding corrupt storage', () => {
	for (const input of ['42', undefined, [], {}, { sequence: 3 }, { lifetime: 'session', sequence: '3' }, { lifetime: 'session', sequence: [] }, false]) {
		assert.equal(ConfirmationRunId.safeParse(input).success, false, JSON.stringify(input))
	}
	assert.equal(ConfirmationRunId.safeParse(JSON.parse('null')).success, false)
})
