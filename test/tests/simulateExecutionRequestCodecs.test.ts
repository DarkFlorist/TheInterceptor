import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { PopupMessage } from '../../app/ts/types/interceptor-messages.js'
import { PopupMessageReplyRequests } from '../../app/ts/types/interceptor-reply-messages.js'
import { SimulateGovernanceContractExecution } from '../../app/ts/types/simulateExecutionRequests.js'

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
})
