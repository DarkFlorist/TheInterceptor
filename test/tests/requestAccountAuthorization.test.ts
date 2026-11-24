import * as assert from 'node:assert'
import { test } from 'bun:test'
import { getRequestAccountAuthorizationFailure, isAccountBoundToAddress, WEBSITE_CONNECTION_INTERRUPTED_MESSAGE } from '../../app/ts/utils/requestAccountAuthorization.js'

const safe = 1n
const executor = 2n

test('unscoped connection approval never becomes address-bound authority', () => {
	assert.equal(getRequestAccountAuthorizationFailure({ approved: true }, { websiteAccount: undefined }), undefined)
	assert.equal(getRequestAccountAuthorizationFailure({ approved: true }, { websiteAccount: safe }), WEBSITE_CONNECTION_INTERRUPTED_MESSAGE)
	assert.equal(isAccountBoundToAddress(undefined, undefined), false)
	assert.equal(isAccountBoundToAddress(undefined, safe), true)
})

test('revocation and an approval rebound to another account both refuse the original request', () => {
	const binding = { websiteAccount: safe, transactionSender: { requested: safe, authorized: safe } }
	assert.equal(getRequestAccountAuthorizationFailure({ approved: true, approvedAddress: safe }, binding), undefined)
	assert.equal(getRequestAccountAuthorizationFailure({ approved: false, approvedAddress: safe }, binding), WEBSITE_CONNECTION_INTERRUPTED_MESSAGE)
	assert.equal(getRequestAccountAuthorizationFailure({ approved: true, approvedAddress: executor }, binding), WEBSITE_CONNECTION_INTERRUPTED_MESSAGE)
})

test('Safe website authority and its prepared executor are checked as separate account roles', () => {
	const binding = { websiteAccount: safe, transactionSender: { requested: executor, authorized: executor } }
	assert.equal(getRequestAccountAuthorizationFailure({ approved: true, approvedAddress: safe }, binding), undefined)
	assert.equal(getRequestAccountAuthorizationFailure({ approved: true, approvedAddress: executor }, binding), WEBSITE_CONNECTION_INTERRUPTED_MESSAGE)
	assert.match(getRequestAccountAuthorizationFailure({ approved: true, approvedAddress: safe }, { ...binding, transactionSender: { requested: safe, authorized: executor } }) ?? '', /reviewed transaction sender/u)
})
