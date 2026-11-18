import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { isAnsweredWithoutInterceptorRpc } from '../../app/ts/background/interceptorRpcRequirement.js'

describe('methods answered without the Interceptor RPC', () => {
	test('covers account-only and locally computed methods, and nothing that needs chain state', () => {
		for (const method of ['eth_accounts', 'eth_requestAccounts', 'wallet_getPermissions', 'personal_ecRecover']) assert.equal(isAnsweredWithoutInterceptorRpc(method), true, method)
		for (const method of ['eth_call', 'eth_sendTransaction', 'personal_sign', 'eth_chainId']) assert.equal(isAnsweredWithoutInterceptorRpc(method), false, method)
	})
})
