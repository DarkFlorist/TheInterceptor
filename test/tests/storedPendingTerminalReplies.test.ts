import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { StoredPendingTerminalReplies } from '../../app/ts/background/pendingTerminalReplies.js'
import { serialize } from '../../app/ts/types/wire-types.js'

// A reply as an older version stored it: a bare reply, here with a bigint connection name and result, which the stored form carries as hex.
const legacyWireReply = { uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 3, connectionName: '0x5' } }, type: 'result', method: 'eth_blockNumber', result: '0x10' }
const currentWireEntry = { reply: { uniqueRequestIdentifier: { requestId: 2, requestSocket: { tabId: 3, connectionName: '0x6' } }, type: 'result', method: 'eth_sendTransaction', error: { code: 4001, message: 'User denied transaction signature.' } }, answeredInstanceId: 'instance-2' }

describe('stored reply outbox', () => {
	// An outbox rewrite while an entry from before instance ids is still queued must store that entry in its wire form, or the next read would fail and reset the outbox.
	test('rewrites an outbox that still holds a pre-upgrade bare reply in its wire form', () => {
		const parsed = StoredPendingTerminalReplies.parse([legacyWireReply, currentWireEntry])
		assert.deepEqual(parsed.map((entry) => entry.answeredInstanceId), [undefined, 'instance-2'])
		const rewritten = serialize(StoredPendingTerminalReplies, parsed)
		assert.deepEqual(JSON.parse(JSON.stringify(rewritten)), [legacyWireReply, currentWireEntry])
		assert.deepEqual(StoredPendingTerminalReplies.parse(rewritten), parsed)
	})
})
