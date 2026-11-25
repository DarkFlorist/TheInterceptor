import * as assert from 'node:assert'
import { test } from 'bun:test'
import { buildGnosisSafeMessageApproval, decodeGnosisSafeMessageApproval, matchesGnosisSafeMessageApproval } from '../../app/ts/gnosisSafe/gnosisSafeMessageApproval.js'
import { dataStringWith0xStart, stringToUint8Array } from '../../app/ts/utils/bigint.js'

test('Gnosis Safe message approval construction and recognition bind the full transaction to reviewed text', () => {
	const review = { text: 'Hello', isTypedData: false }
	const approval = buildGnosisSafeMessageApproval(review)
	const digest = 'aa744ba2ca576ec62ca0045eca00ad3917fdf7ffa34fbbae50828a5a69c1580e'
	const expected = '0x85a5affe' + '0'.repeat(62) + '20' + '0'.repeat(62) + '20' + digest
	assert.equal(dataStringWith0xStart(approval.data), expected)
	assert.equal(decodeGnosisSafeMessageApproval(approval), `0x${ digest }`)
	assert.equal(matchesGnosisSafeMessageApproval(approval, review), true)
	assert.equal(matchesGnosisSafeMessageApproval(approval, { ...review, text: 'Different text' }), false)
	for (const changed of [
		{ ...approval, to: 123n },
		{ ...approval, operation: 0n },
		{ ...approval, value: 1n },
		{ ...approval, data: stringToUint8Array(`0xa08519b5${ digest }`) },
		{ ...approval, data: approval.data.slice(0, -1) },
		{ ...approval, data: new Uint8Array([...approval.data, 0]) },
	]) {
		assert.equal(decodeGnosisSafeMessageApproval(changed), undefined)
		assert.equal(matchesGnosisSafeMessageApproval(changed, review), false)
	}
})

test('Gnosis Safe message approval recognizes typed data and rejects a different review interpretation', () => {
	const review = { text: JSON.stringify({ types: { Message: [{ name: 'text', type: 'string' }] }, domain: {}, primaryType: 'Message', message: { text: 'Hello' } }), isTypedData: true }
	const approval = buildGnosisSafeMessageApproval(review)
	assert.equal(matchesGnosisSafeMessageApproval(approval, review), true)
	assert.equal(matchesGnosisSafeMessageApproval(approval, { ...review, isTypedData: false }), false)
	assert.throws(() => buildGnosisSafeMessageApproval({ text: 'Not JSON', isTypedData: true }), /not valid JSON/)
})
