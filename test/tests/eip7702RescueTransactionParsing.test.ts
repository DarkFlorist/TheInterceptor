import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import { EthereumAddress } from '../../app/ts/types/wire-types.js'
import { privateKeyToAccount } from '../../app/ts/utils/viem.js'
import { stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { parseSendRawTransaction } from '../../app/ts/utils/sendRawTransactionParsing.js'

const zeroAddress = '0x0000000000000000000000000000000000000000'
const recipientAddress = '0x0000000000000000000000000000000000000002'

describe('EIP-7702 rescue transaction parsing', () => {
	test('parses eth_sendTransaction authorization lists', () => {
		const parsed = SendTransactionParams.parse({
			method: 'eth_sendTransaction',
			params: [{
				type: '0x4',
				from: '0x0000000000000000000000000000000000000001',
				to: recipientAddress,
				value: '0x0',
				authorizationList: [{
					chainId: '0x1',
					address: zeroAddress,
					nonce: '0x5',
					yParity: '0x0',
					r: '0x1',
					s: '0x2',
				}],
			}],
		})

		assert.equal(parsed.params[0].type, '7702')
		const [authorization] = parsed.params[0].authorizationList ?? []
		if (authorization === undefined) throw new Error('Expected authorization to be parsed')
		assert.equal(authorization.address, 0n)
		assert.equal(authorization.nonce, 5n)
		assert.equal(authorization.yParity, 'even')
	})

	test('parses raw EIP-7702 transactions and recovers authorization authority', async () => {
		const sponsor = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001')
		const victim = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000002')
		const clearDelegationAuthorization = await victim.signAuthorization({
			address: zeroAddress,
			chainId: 1,
			nonce: 5,
		})
		const signedTransaction = await sponsor.signTransaction({
			type: 'eip7702',
			chainId: 1,
			nonce: 7,
			maxFeePerGas: 2n,
			maxPriorityFeePerGas: 1n,
			gas: 50_000n,
			to: recipientAddress,
			value: 0n,
			data: '0x',
			authorizationList: [clearDelegationAuthorization],
		})

		const transaction = await parseSendRawTransaction(stringToUint8Array(signedTransaction), 1n)

		assert.equal(transaction.type, '7702')
		if (transaction.type !== '7702') throw new Error('Expected a 7702 transaction')
		assert.equal(transaction.from, EthereumAddress.parse(sponsor.address))
		assert.equal(transaction.nonce, 7n)
		const [authorization] = transaction.authorizationList
		if (authorization === undefined) throw new Error('Expected authorization to be parsed')
		assert.equal(authorization.address, 0n)
		assert.equal(authorization.nonce, 5n)
		assert.equal(authorization.authority, EthereumAddress.parse(victim.address))
	})
})
