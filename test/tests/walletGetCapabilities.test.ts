import { describe, expect, test } from 'bun:test'
import { getWalletGetCapabilitiesParseFailureReply } from '../../app/ts/background/walletGetCapabilitiesRpc.js'
import { EthereumJsonRpcRequest, WalletGetCapabilities } from '../../app/ts/types/JsonRpc-types.js'
import { RPCReply } from '../../app/ts/types/interceptor-messages.js'
import { CanonicalEthereumQuantity, serialize } from '../../app/ts/types/wire-types.js'

const account = '0x1111111111111111111111111111111111111111'

describe('wallet_getCapabilities', () => {
	test('uses the reusable canonical Ethereum quantity wire type for chain IDs', () => {
		expect(CanonicalEthereumQuantity.parse('0xA')).toBe(10n)
		expect(CanonicalEthereumQuantity.safeParse('0x01').success).toBeFalse()
		expect(serialize(CanonicalEthereumQuantity, 10n)).toBe('0xa')
	})

	test('accepts an account with an optional chain ID filter', () => {
		expect(WalletGetCapabilities.parse({
			method: 'wallet_getCapabilities',
			params: [account],
		})).toEqual({
			method: 'wallet_getCapabilities',
			params: [BigInt(account)],
		})
		expect(EthereumJsonRpcRequest.parse({
			method: 'wallet_getCapabilities',
			params: [account, ['0x1', '0x2105']],
		})).toEqual({
			method: 'wallet_getCapabilities',
			params: [BigInt(account), [1n, 0x2105n]],
		})
	})

	test('rejects malformed parameters with an invalid-params response', () => {
		for (const params of [
			[],
			['0x1234'],
			[account, '0x1'],
			[account, ['1']],
			[account, ['0x01']],
		]) {
			const request = {
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } },
				method: 'wallet_getCapabilities',
				params,
			}
			expect(EthereumJsonRpcRequest.safeParse(request).success).toBeFalse()
			expect(getWalletGetCapabilitiesParseFailureReply(request)).toEqual({
				type: 'result',
				method: 'wallet_getCapabilities',
				error: { code: -32602, message: 'Invalid wallet_getCapabilities parameters.' },
			})
		}
	})

	test('serializes capability maps in provider replies', () => {
		const reply = {
			type: 'result' as const,
			method: 'wallet_getCapabilities' as const,
			result: {
				'0x2105': {
					atomic: { supported: 'supported' },
					paymasterService: { supported: true },
				},
			},
		}
		expect(RPCReply.parse(reply)).toEqual(reply)
	})

	test('rejects capability replies that do not contain nested capability objects', () => {
		expect(RPCReply.safeParse({
			type: 'result',
			method: 'wallet_getCapabilities',
			result: [],
		}).success).toBeFalse()
		expect(RPCReply.safeParse({
			type: 'result',
			method: 'wallet_getCapabilities',
			result: { '0x1': [] },
		}).success).toBeFalse()
	})

	test('does not interfere with typed-array replies from unrelated RPC methods', () => {
		const reply = {
			type: 'result' as const,
			method: 'eth_call' as const,
			result: new Uint8Array([0x12, 0x34]),
		}
		expect(serialize(RPCReply, reply)).toEqual({
			type: 'result',
			method: 'eth_call',
			result: '0x1234',
		})
	})
})
