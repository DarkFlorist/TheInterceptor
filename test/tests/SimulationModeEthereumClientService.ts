import { ethers, keccak256 } from 'ethers'
import { describe, runIfRoot, should, run } from '../micro-should.js'
import * as assert from 'assert'
import { EthereumSignedTransactionToSignedTransaction, EthereumUnsignedTransactionToUnsignedTransaction, serializeUnsignedTransactionToBytes } from '../../app/ts/utils/ethereum.js'
import { bytes32String } from '../../app/ts/utils/bigint.js'
import { EthereumSignedTransaction1559, EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import { mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'

export async function main() {
	describe('SimulationModeEthereumClientService', () => {
		const exampleTransaction = {
			type: '1559',
			from: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
			nonce: 0n,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
			gas: 21000n,
			to: 0xda9dfa130df4de4673b89022ee50ff26f6ea73cfn,
			value: 10n,
			input: new Uint8Array(0),
			chainId: 1n,
		} as const

		should('mockSignTransaction should have r=0, s=0 and yParity = "even"', () => {
			const signed = mockSignTransaction(exampleTransaction)
			assert.equal(signed.type, '1559')
			assert.equal(signed.r, 0n)
			assert.equal(signed.s, 0n)
			if (!('yParity' in signed)) throw new Error('yParity missing')
			if (signed.type === '1559') assert.equal(signed.yParity, 'even')
		})

		should('ethers.recoverAddress should fail for mocked transaction', async () => {
			const signed = EthereumSignedTransactionToSignedTransaction(mockSignTransaction(exampleTransaction))
			assert.equal(signed.type, '1559')
			if (signed.type !== '1559') throw new Error('wrong transaction type')
			const unsigned = EthereumUnsignedTransactionToUnsignedTransaction(exampleTransaction)
			const digest = keccak256(serializeUnsignedTransactionToBytes(unsigned))
			assert.throws(() => ethers.recoverAddress(digest, {
					r: bytes32String(signed.r),
					s: bytes32String(signed.s),
					yParity: signed.yParity === 'even' ? 0 : 1,
				}),
				'Error: invalid point'
			)
		})

		should('ethers.recoverAddress works for positive case', () => {
			const validTransaction = {
				'hash': '0xdd0967ea3bf8bb02c40edac86ff849f200587483c6f139e9f73242bdb1ef6284',
				'nonce': '0x15174',
				'blockHash': '0x2d98e688a833144b2990b4c7fcd0dfab924ba74c6933aa7142b12b57683b5623',
				'blockNumber': '0xf17472',
				'transactionIndex': '0x7',
				'from': '0x98db3a41bf8bf4ded2c92a84ec0705689ddeef8b',
				'to': '0x33f71fc6302e2295615c17cc32e30adecf2f26ec',
				'value': '0x3bae8d3cf0a7cd5',
				'gasPrice': '0x2ff19bb49',
				'maxPriorityFeePerGas': '0x9502f900',
				'maxFeePerGas': '0x642021034',
				'gas': '0x15f90',
				'data': '0x',
				'input': '0x',
				'chainId': '0x1',
				'type': '0x2',
				'v': '0x1',
				's': '0x507d8fd16ce7d4e9d4849d93be747e5b1f5a79812870dcf55c342211a620ca2d',
				'r': '0x80ea9fe9b5e38cfcd7ae9c6c338971cb270091014a2e2d16882f6773bba789fc',
				'yParity': '0x1'
            }

			const signed = EthereumSignedTransactionToSignedTransaction(EthereumSignedTransaction1559.parse(validTransaction))
			const unsigned = EthereumUnsignedTransactionToUnsignedTransaction(EthereumUnsignedTransaction.parse(validTransaction))
			assert.equal(signed.type, '1559')
			if (signed.type !== '1559') throw new Error('wrong transaction type')

			const digest = keccak256(serializeUnsignedTransactionToBytes(unsigned))

			const addr = ethers.recoverAddress(digest, {
				r: bytes32String(signed.r),
				s: bytes32String(signed.s),
				yParity: signed.yParity === 'even' ? 0 : 1,
			})
			assert.equal(BigInt(addr), 0x98db3a41bf8bf4ded2c92a84ec0705689ddeef8bn)
		})
	})
}

await runIfRoot(async  () => {
	await main()
	await run()
}, import.meta)
