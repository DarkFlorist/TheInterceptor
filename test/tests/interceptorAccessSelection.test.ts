import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getSelectedPendingAccessRequest } from '../../app/ts/components/pages/InterceptorAccess.js'
import type { PendingAccessRequest } from '../../app/ts/types/accessRequest.js'

function createPendingAccessRequest(accessRequestId: string, signerAccount: bigint): PendingAccessRequest {
	return {
		website: {
			websiteOrigin: `https://${accessRequestId}.example`,
			icon: undefined,
			title: `Website ${accessRequestId}`,
		},
		requestAccessToAddress: undefined,
		originalRequestAccessToAddress: undefined,
		associatedAddresses: [],
		signerAccounts: [signerAccount],
		signerName: 'MetaMask',
		simulationMode: false,
		popupOrTabId: {
			id: 1,
			type: 'popup',
		},
		socket: {
			tabId: 1,
			connectionName: 1n,
		},
		request: undefined,
		activeAddress: undefined,
		accessRequestId,
	}
}

describe('InterceptorAccess modal request selection', () => {
	test('uses the accessRequestId-selected request instead of always using the first request', () => {
		const firstRequest = createPendingAccessRequest('first-request', 0x1000000000000000000000000000000000000001n)
		const secondRequest = createPendingAccessRequest('second-request', 0x2000000000000000000000000000000000000002n)

		const selectedRequest = getSelectedPendingAccessRequest([firstRequest, secondRequest], secondRequest.accessRequestId)

		assert.equal(selectedRequest, secondRequest)
	})

	test('falls back to the first request when no accessRequestId is selected', () => {
		const firstRequest = createPendingAccessRequest('first-request', 0x1000000000000000000000000000000000000001n)
		const secondRequest = createPendingAccessRequest('second-request', 0x2000000000000000000000000000000000000002n)

		const selectedRequest = getSelectedPendingAccessRequest([firstRequest, secondRequest], undefined)

		assert.equal(selectedRequest, firstRequest)
	})

	test('returns undefined when the selected request is no longer pending', () => {
		const firstRequest = createPendingAccessRequest('first-request', 0x1000000000000000000000000000000000000001n)

		const selectedRequest = getSelectedPendingAccessRequest([firstRequest], 'missing-request')

		assert.equal(selectedRequest, undefined)
	})
})
