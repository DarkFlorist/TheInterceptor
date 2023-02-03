import { ethers } from 'ethers'
import { SimulationModeEthereumClientService } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { describe, runIfRoot, should, run } from '../micro-should.js'
import * as assert from 'assert'
import { EthereumSignedTransactionToSignedTransaction, getV, serializeTransactionToBytes } from '../../app/ts/utils/ethereum.js'
import { bytes32String } from '../../app/ts/utils/bigint.js'

export async function main() {
	describe('SimulationModeEthereumClientService', () => {
		const exampleTransaction = {
			type: '1559' as const,
			from: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
			nonce: 0n,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
			gas: 21000n,
			to: 0xda9dfa130df4de4673b89022ee50ff26f6ea73cfn,
			value: 10n,
			input: new Uint8Array(0),
			chainId: 1n,
		}

		should('mockSignTransaction should have r=0, s=0 and yParity = "even"', async () => {
			const signed = await SimulationModeEthereumClientService.mockSignTransaction(exampleTransaction)
			assert.equal(signed.type, '1559')
			assert.equal(signed.r, 0n)
			assert.equal(signed.s, 0n)
			if (signed.type === '1559') assert.equal(signed.yParity, 'even')
		})

		should('ethers.utils.recoverAddress should fail for mocked transaction', async () => {
			const signed = EthereumSignedTransactionToSignedTransaction(await SimulationModeEthereumClientService.mockSignTransaction(exampleTransaction))
			assert.equal(signed.type, '1559')
			if (signed.type !== '1559') throw new Error('wrong transaction type')
			const digest = serializeTransactionToBytes(signed)
			assert.throws(() => ethers.utils.recoverAddress(digest, {
					r: bytes32String(signed.r),
					s: bytes32String(signed.s),
					v: Number(getV(signed)),
				}),
				'Error: invalid point'
			)
		})
	})
}

await runIfRoot(async  () => {
	await main()
	await run()
}, import.meta)
