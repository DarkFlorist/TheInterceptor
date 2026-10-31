import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getRequestedSignMessageAccount, SignMessageParams } from '../../app/ts/types/jsonRpc-signing-types.js'

const firstAccount = '0x1111111111111111111111111111111111111111'
const secondAccount = '0x2222222222222222222222222222222222222222'

describe('signing account binding', () => {
	test('extracts the requested signer from every supported parameter ordering', () => {
		const typedData = JSON.stringify({ types: {}, primaryType: 'Message', domain: {}, message: {} })
		const requests = [
			SignMessageParams.parse({ method: 'personal_sign', params: ['hello', firstAccount] }),
			SignMessageParams.parse({ method: 'eth_signTypedData', params: [[], firstAccount] }),
			SignMessageParams.parse({ method: 'eth_signTypedData_v1', params: [firstAccount, typedData] }),
			SignMessageParams.parse({ method: 'eth_signTypedData_v2', params: [firstAccount, typedData] }),
			SignMessageParams.parse({ method: 'eth_signTypedData_v3', params: [firstAccount, typedData] }),
			SignMessageParams.parse({ method: 'eth_signTypedData_v4', params: [firstAccount, typedData] }),
		]

		for (const request of requests) {
			assert.equal(getRequestedSignMessageAccount(request), BigInt(firstAccount))
			assert.notEqual(getRequestedSignMessageAccount(request), BigInt(secondAccount))
		}
	})
})
