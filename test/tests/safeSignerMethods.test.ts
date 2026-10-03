import * as assert from 'assert'
import { test } from 'bun:test'
import { getSafeSignerAuthorizedRequestMethods } from '../../app/ts/safe/safeSignerMethods.js'

test('only the matching Safe confirmation flow authorizes method translation', () => {
	for (const method of ['eth_sendTransaction', 'eth_signTypedData_v4', 'personal_sign', 'eth_sendRawTransaction', 'eth_chainId']) {
		assert.equal(getSafeSignerAuthorizedRequestMethods(undefined, method), undefined)
		assert.deepEqual(getSafeSignerAuthorizedRequestMethods('directExecution', method), method === 'eth_sendTransaction' ? ['safe_apps_request'] : undefined)
		assert.deepEqual(getSafeSignerAuthorizedRequestMethods('proposal', method), method === 'eth_signTypedData_v4' ? ['safe_apps_request', 'eth_sendTransaction'] : undefined)
		assert.deepEqual(getSafeSignerAuthorizedRequestMethods('messageCoSign', method), method === 'eth_signTypedData_v4' ? ['safe_apps_request', 'personal_sign'] : undefined)
	}
})
