import * as assert from 'assert'
import { test } from 'bun:test'
import { isSafeSignerMethodTranslation } from '../../app/ts/safe/safeSignerMethods.js'

test('Safe translations authorize only transaction execution and owner signatures for admitted methods', () => {
	const permitted = new Set([
		'safe_apps_request:eth_sendTransaction',
		'safe_apps_request:eth_signTypedData_v4',
		'eth_sendTransaction:eth_signTypedData_v4',
		'personal_sign:eth_signTypedData_v4',
	])
	for (const request of ['safe_apps_request', 'eth_sendTransaction', 'personal_sign', 'eth_chainId', 'eth_call', 'eth_accounts', 'eth_sendRawTransaction', 'eth_signTypedData']) {
		for (const signer of ['eth_sendTransaction', 'eth_signTypedData_v4', 'personal_sign', 'eth_sendRawTransaction', 'eth_chainId']) {
			assert.equal(isSafeSignerMethodTranslation(request, signer), permitted.has(`${ request }:${ signer }`), `${ request } -> ${ signer }`)
		}
	}
})
