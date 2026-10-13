import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { parseTransaction, serializeTransaction } from '../../app/ts/utils/ethereumPrimitives.js'
import { checksumDeadAddress, lowercaseBeefAddress, lowercaseDeadAddress } from './ethereumPrimitivesFixtures.js'

const unsignedEip1559Transaction = {
	type: 'eip1559',
	chainId: 1,
	nonce: 7,
	maxFeePerGas: 20_000_000_000n,
	maxPriorityFeePerGas: 1_500_000_000n,
	gas: 21_000n,
	to: checksumDeadAddress,
	value: 123_456_789n,
	data: '0x',
	accessList: [],
} as const
const transactionSignature = {
	r: '0x1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100',
	s: '0x2f2e2d2c2b2a292827262524232221201f1e1d1c1b1a19181716151413121110',
	yParity: 1,
} as const

describe('local Ethereum primitive helpers', () => {
	test('matches reference EIP-1559 serialize and parse vectors used by raw transaction approval', () => {
		const serializedUnsigned = serializeTransaction(unsignedEip1559Transaction)
		assert.equal(serializedUnsigned, '0x02ec01078459682f008504a817c80082520894000000000000000000000000000000000000dead84075bcd1580c0')
		assert.equal(
			serializeTransaction(unsignedEip1559Transaction, transactionSignature),
			'0x02f86f01078459682f008504a817c80082520894000000000000000000000000000000000000dead84075bcd1580c001a01f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100a02f2e2d2c2b2a292827262524232221201f1e1d1c1b1a19181716151413121110',
		)
		assert.equal(
			serializeTransaction(unsignedEip1559Transaction, { r: transactionSignature.r, s: transactionSignature.s, v: 0n }),
			'0x02f86f01078459682f008504a817c80082520894000000000000000000000000000000000000dead84075bcd1580c080a01f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100a02f2e2d2c2b2a292827262524232221201f1e1d1c1b1a19181716151413121110',
		)
		assert.equal(
			serializeTransaction(unsignedEip1559Transaction, { r: transactionSignature.r, s: transactionSignature.s, v: 1n }),
			'0x02f86f01078459682f008504a817c80082520894000000000000000000000000000000000000dead84075bcd1580c001a01f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100a02f2e2d2c2b2a292827262524232221201f1e1d1c1b1a19181716151413121110',
		)
		assert.deepStrictEqual(
			parseTransaction(serializeTransaction(unsignedEip1559Transaction, transactionSignature)),
			{
				r: transactionSignature.r,
				s: transactionSignature.s,
				v: 28n,
				yParity: 1,
				chainId: 1n,
				type: 'eip1559',
				to: lowercaseDeadAddress,
				gas: 21_000n,
				nonce: 7n,
				value: 123_456_789n,
				maxFeePerGas: 20_000_000_000n,
				maxPriorityFeePerGas: 1_500_000_000n,
			},
		)

		const signedTransactionWithAccessList = '0x02f8aa01078459682f008504a817c80082753094000000000000000000000000000000000000dead84075bcd15821234f838f794000000000000000000000000000000000000beefe1a0111111111111111111111111111111111111111111111111111111111111111101a01f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100a02f2e2d2c2b2a292827262524232221201f1e1d1c1b1a19181716151413121110'
		assert.deepStrictEqual(parseTransaction(signedTransactionWithAccessList), {
			r: transactionSignature.r,
			s: transactionSignature.s,
			v: 28n,
			yParity: 1,
			chainId: 1n,
			type: 'eip1559',
			to: lowercaseDeadAddress,
			gas: 30_000n,
			data: '0x1234',
			nonce: 7n,
			value: 123_456_789n,
			maxFeePerGas: 20_000_000_000n,
			maxPriorityFeePerGas: 1_500_000_000n,
			accessList: [{
				address: lowercaseBeefAddress,
				storageKeys: ['0x1111111111111111111111111111111111111111111111111111111111111111'],
			}],
		})
		const serializedContractCreation = serializeTransaction({
			type: 'eip1559',
			chainId: 1n,
			nonce: 0n,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
			gas: 100_000n,
			data: '0x60006000',
			accessList: [],
		})
		assert.equal(serializedContractCreation, '0x02d001800101830186a080808460006000c0')
		assert.deepStrictEqual(parseTransaction(serializedContractCreation), {
			chainId: 1n,
			type: 'eip1559',
			gas: 100_000n,
			data: '0x60006000',
			nonce: 0n,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
		})
	})
})
