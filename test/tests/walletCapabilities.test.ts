import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getWalletCapabilities } from '../../app/ts/background/walletCapabilities.js'
import { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { RPCReply } from '../../app/ts/types/interceptor-messages.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { addressString } from '../../app/ts/utils/bigint.js'

const safeAddress = 0x1000000000000000000000000000000000000001n
const activeSigner = 0x2000000000000000000000000000000000000002n
const chainId = 11155111n

describe('wallet_getCapabilities', () => {
	test('advertises the active signer for connected Gnosis Safe execution', () => {
		const request = EthereumJsonRpcRequest.parse({
			method: 'wallet_getCapabilities',
			params: [addressString(safeAddress), [`0x${ chainId.toString(16) }`]],
		})
		if (request.method !== 'wallet_getCapabilities') throw new Error('Unexpected request type')
		const reply = getWalletCapabilities(request, safeAddress, chainId, activeSigner)

		assert.deepEqual(serialize(RPCReply, reply), {
			type: 'result',
			method: 'wallet_getCapabilities',
			result: {
				[`0x${ chainId.toString(16) }`]: {
					gnosisSafeExecution: {
						supported: true,
						version: '1.0.0',
						activeSigner: addressString(activeSigner),
						submissionMethod: 'eth_sendTransaction',
					},
				},
			},
		})
	})

	test('returns no entry when the requested chain is not connected', () => {
		const request = EthereumJsonRpcRequest.parse({
			method: 'wallet_getCapabilities',
			params: [addressString(safeAddress), ['0x1']],
		})
		if (request.method !== 'wallet_getCapabilities') throw new Error('Unexpected request type')

		assert.deepEqual(getWalletCapabilities(request, safeAddress, chainId, activeSigner), {
			type: 'result',
			method: 'wallet_getCapabilities',
			result: {},
		})
	})

	test('rejects capability requests for an account that is not connected', () => {
		const request = EthereumJsonRpcRequest.parse({
			method: 'wallet_getCapabilities',
			params: [addressString(safeAddress)],
		})
		if (request.method !== 'wallet_getCapabilities') throw new Error('Unexpected request type')
		const reply = getWalletCapabilities(request, activeSigner, chainId, activeSigner)

		assert.equal(reply.type, 'result')
		if (reply.type !== 'result' || !('error' in reply)) throw new Error('Expected an unauthorized reply')
		assert.equal(reply.error.code, 4100)
	})
})
