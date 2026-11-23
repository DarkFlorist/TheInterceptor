import * as assert from 'node:assert'
import { test } from 'bun:test'
import { advanceReviewRevisionIfCurrent, captureConfirmationReview, getReviewRevision } from '../../app/ts/background/confirmationReviewRevisions.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'

const request = { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } }

test('revision advancement rejects stale and future expectations without overwriting the current review', () => {
	const connections: WebsiteTabConnections = new Map()
	const confirmation = captureConfirmationReview(connections, { method: 'popup_confirmDialog', data: { uniqueRequestIdentifier: request, action: 'accept' } })
	assert.equal(confirmation.data.action === 'accept' && confirmation.data.reviewedRevision, 0)
	assert.equal(advanceReviewRevisionIfCurrent(connections, request, 0), true)
	assert.equal(advanceReviewRevisionIfCurrent(connections, request, 1), true)
	assert.equal(advanceReviewRevisionIfCurrent(connections, request, 0), false)
	assert.equal(advanceReviewRevisionIfCurrent(connections, request, 3), false)
	assert.equal(getReviewRevision(connections, request), 2)
	assert.equal(confirmation.data.action === 'accept' && confirmation.data.reviewedRevision, 0)
})
