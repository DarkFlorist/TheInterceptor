import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { MessageToPopup, PopupMessage } from '../../app/ts/types/interceptor-messages.js'
import { PopupMessageReplyRequests, PopupRequestsReplies } from '../../app/ts/types/interceptor-reply-messages.js'
import { SimulateGovernanceContractExecution } from '../../app/ts/types/simulateExecutionRequests.js'
import { SimulateExecutionReply, serializeSimulateExecutionReply } from '../../app/ts/types/simulateExecutionReply.js'

describe('simulate execution request codecs', () => {
	test('shared governance request codec round-trips through popup request and popup message parsing', () => {
		const request = {
			method: 'popup_simulateGovernanceContractExecution' as const,
			data: {
				transactionIdentifier: 5n,
			},
		}

		const serializedRequest = SimulateGovernanceContractExecution.serialize(request)
		const parsedPopupRequest = PopupMessageReplyRequests.parse(serializedRequest)
		const parsedPopupMessage = PopupMessage.parse(serializedRequest)

		assert.deepEqual(parsedPopupRequest, request)
		assert.deepEqual(parsedPopupMessage, request)
	})

	test('shared simulate execution reply serializer produces a popup-broadcast-safe wire payload', () => {
		const reply = {
			method: 'popup_simulateExecutionReply' as const,
			data: {
				success: false as const,
				errorType: 'Other' as const,
				transactionOrMessageIdentifier: 5n,
				errorMessage: 'boom',
			},
		}

		const serializedReply = serializeSimulateExecutionReply(reply)
		const parsedBroadcastMessage = MessageToPopup.parse({ role: 'all' as const, ...serializedReply })
		const parsedReply = SimulateExecutionReply.parse(serializedReply)
		const parsedPopupReply = PopupRequestsReplies.popup_simulateGovernanceContractExecution.parse(serializedReply)

		assert.equal(serializedReply.data.transactionOrMessageIdentifier, '0x5')
		assert.equal(parsedBroadcastMessage.method, 'popup_simulateExecutionReply')
		assert.deepEqual(parsedReply, reply)
		assert.deepEqual(parsedPopupReply, reply)
	})
})
