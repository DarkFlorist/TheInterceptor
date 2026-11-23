import * as assert from 'node:assert'
import { test } from 'bun:test'
import { replyToInterceptedRequest } from '../../app/ts/background/messageSending.js'
import { websiteSocketToString } from '../../app/ts/background/backgroundUtils.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import { createMockPort } from '../harness/browserMock.js'
import { createPerTestRestorer } from '../harness/perTest.js'
import { readProperty } from '../harness/assertions.js'

const { installBrowserMockForTest } = createPerTestRestorer()

test('background forwarding annotates the signer reply mode on the serialized message', () => {
	installBrowserMockForTest()
	const { port, postedMessages } = createMockPort()
	const socket = { tabId: 1, connectionName: 0n }
	const connections: WebsiteTabConnections = new Map([[socket.tabId, { connections: {
		[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
	} }]])
	assert.equal(replyToInterceptedRequest(connections, {
		type: 'forwardToSigner', method: 'personal_sign', params: ['0x', 1n],
		uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
	}), true)
	assert.equal(readProperty(postedMessages[0], 'signerReplyMode'), 'notify')
	assert.equal(replyToInterceptedRequest(connections, {
		type: 'forwardToSigner', method: 'future_forwarded_method', replyWithSignersReply: true, params: [],
		uniqueRequestIdentifier: { requestId: 2, requestSocket: socket },
	}), true)
	assert.equal(readProperty(postedMessages[1], 'signerReplyMode'), 'request')
})
