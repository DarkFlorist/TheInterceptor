import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { PendingAccessRequest } from '../../app/ts/types/accessRequest.js'

const responseModulesPromise = import('../../app/ts/components/pages/interceptorAccessResponse.js')

describe('respondToAccessRequest', () => {
	test('sends the access reply before focusing the requesting tab', async () => {
		const { respondToAccessRequest } = await responseModulesPromise
		const operations: string[] = []
		const accessRequest: PendingAccessRequest = {
			popupOrTabId: { type: 'popup', id: 9 },
			socket: { tabId: 7, connectionName: 0n },
			request: undefined,
			accessRequestId: '0x1 || https://app.sablier.com',
			website: { websiteOrigin: 'https://app.sablier.com', icon: undefined, title: 'Sablier' },
			requestAccessToAddress: {
				name: 'Primary',
				address: 0x1111111111111111111111111111111111111111n,
				askForAddressAccess: true,
				type: 'contact',
				useAsActiveAddress: true,
				entrySource: 'FilledIn',
				chainId: 1n,
			},
			originalRequestAccessToAddress: {
				name: 'Primary',
				address: 0x1111111111111111111111111111111111111111n,
				askForAddressAccess: true,
				type: 'contact',
				useAsActiveAddress: true,
				entrySource: 'FilledIn',
				chainId: 1n,
			},
			associatedAddresses: [],
			signerAccounts: [],
			signerName: 'NoSignerDetected',
			simulationMode: false,
			activeAddress: undefined,
		}

		await respondToAccessRequest(
			accessRequest,
			'Approved',
			1,
			async (message) => {
				operations.push(`send:${ message.method }:${ message.data.userReply }`)
			},
			async (popupOrTabId) => {
				operations.push(`focus:${ popupOrTabId.type }:${ popupOrTabId.id }`)
				return undefined
			},
		)

		assert.deepEqual(operations, [
			'send:popup_interceptorAccess:Approved',
			'focus:tab:7',
		])
	})
})
