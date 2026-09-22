import * as assert from 'assert'
import { test } from 'bun:test'
import { feeOops } from '../../app/ts/simulation/protectors/feeOops.js'
import type { WebsiteCreatedEthereumTransaction } from '../../app/ts/types/visualizer-types.js'

const nanoeth = 10n ** 9n
const marketPrice = 31n * nanoeth
const ethereum = { getGasPrice: async () => marketPrice }
const transactionFields = { from: 1n, to: 2n, nonce: 0n, gas: 21_000n, value: 0n, input: new Uint8Array(), chainId: 1n }
type FeeRequest = Pick<WebsiteCreatedEthereumTransaction, 'transaction' | 'originalRequestParameters'>

const normalizedLegacy = (gasPrice: bigint): FeeRequest => ({
	transaction: { ...transactionFields, type: '1559', maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice },
	originalRequestParameters: { method: 'eth_sendTransaction', params: [{ gasPrice }] },
})

test('normalized legacy prices warn at ten times the market price, not the priority-fee threshold', async () => {
	assert.equal(await feeOops(normalizedLegacy(marketPrice), ethereum, undefined), undefined)
	assert.equal(await feeOops(normalizedLegacy(marketPrice * 10n - 1n), ethereum, undefined), undefined)
	const warning = await feeOops(normalizedLegacy(marketPrice * 10n), ethereum, undefined)
	assert.match(warning ?? '', /outrageous fee/)
	assert.match(warning ?? '', /310000000000 attoeth\/gas/)
})

test('raw legacy and access-list prices keep the market-price comparison', async () => {
	for (const type of ['legacy', '2930'] as const) {
		for (const gasPrice of [marketPrice, marketPrice * 10n]) {
			const request: FeeRequest = {
				transaction: { ...transactionFields, type, gasPrice },
				originalRequestParameters: { method: 'eth_sendRawTransaction', params: [new Uint8Array()] },
			}
			assert.equal((await feeOops(request, ethereum, undefined)) !== undefined, gasPrice === marketPrice * 10n)
		}
	}
})

test('actual fee-market requests still warn about high priority fees without fetching a legacy estimate', async () => {
	const noEstimate = { getGasPrice: async (): Promise<bigint> => { throw new Error('Unexpected legacy fee estimate') } }
	for (const maxPriorityFeePerGas of [nanoeth, 10n * nanoeth]) {
		const request: FeeRequest = {
			transaction: { ...transactionFields, type: '1559', maxFeePerGas: marketPrice, maxPriorityFeePerGas },
			originalRequestParameters: { method: 'eth_sendTransaction', params: [{ maxFeePerGas: marketPrice, maxPriorityFeePerGas }] },
		}
		assert.equal((await feeOops(request, noEstimate, undefined)) !== undefined, maxPriorityFeePerGas === 10n * nanoeth)
	}
})

test('an external executor paying the fees does not inherit the original legacy price warning', async () => {
	const original = normalizedLegacy(marketPrice * 100n)
	const request: FeeRequest = { ...original, transaction: { ...transactionFields, type: '1559', maxFeePerGas: 0n, maxPriorityFeePerGas: 0n } }
	const noEstimate = { getGasPrice: async (): Promise<bigint> => { throw new Error('A zero-cost proposal does not need a fee estimate') } }
	assert.equal(await feeOops(request, noEstimate, undefined), undefined)
})
