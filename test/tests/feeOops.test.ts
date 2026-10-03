import * as assert from 'assert'
import { test } from 'bun:test'
import { getRequestedTransactionFees } from '../../app/ts/utils/transactionFees.js'
import { getFeeProtectionInput } from '../../app/ts/simulation/feeProtection.js'
import { feeOops } from '../../app/ts/simulation/protectors/feeOops.js'

const nanoeth = 10n ** 9n
const marketPrice = 31n * nanoeth
const ethereum = { getGasPrice: async () => marketPrice }
const transactionFields = { from: 1n, to: 2n, nonce: 0n, gas: 21_000n, value: 0n, input: new Uint8Array(), chainId: 1n }

const normalizedLegacy = (gasPrice: bigint) => getFeeProtectionInput(
	{ ...transactionFields, type: '1559', maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice },
	getRequestedTransactionFees({ gasPrice }),
)

test('normalized legacy prices warn at ten times the market price, not the priority-fee threshold', async () => {
	assert.equal(await feeOops(normalizedLegacy(marketPrice), ethereum, undefined), undefined)
	assert.equal(await feeOops(normalizedLegacy(marketPrice * 10n - 1n), ethereum, undefined), undefined)
	const warning = await feeOops(normalizedLegacy(marketPrice * 10n), ethereum, undefined)
	assert.match(warning ?? '', /outrageous fee/)
	assert.match(warning ?? '', /310000000000 attoeth\/gas/)
})

test('raw legacy and access-list prices keep the market-price comparison without request metadata', async () => {
	for (const type of ['legacy', '2930'] as const) {
		for (const gasPrice of [marketPrice, marketPrice * 10n]) {
			const fees = getFeeProtectionInput({ ...transactionFields, type, gasPrice })
			assert.equal((await feeOops(fees, ethereum, undefined)) !== undefined, gasPrice === marketPrice * 10n)
		}
	}
})

test('actual fee-market requests still warn about high priority fees without fetching a legacy estimate', async () => {
	const noEstimate = { getGasPrice: async (): Promise<bigint> => { throw new Error('Unexpected legacy fee estimate') } }
	for (const maxPriorityFeePerGas of [nanoeth, 10n * nanoeth]) {
		const fees = getFeeProtectionInput({ ...transactionFields, type: '1559', maxFeePerGas: marketPrice, maxPriorityFeePerGas })
		assert.equal((await feeOops(fees, noEstimate, undefined)) !== undefined, maxPriorityFeePerGas === 10n * nanoeth)
	}
})

test('an external executor paying the fees does not inherit the requested legacy price warning', async () => {
	const fees = getFeeProtectionInput({ ...transactionFields, type: '1559', maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }, getRequestedTransactionFees({ gasPrice: marketPrice * 100n }))
	const noEstimate = { getGasPrice: async (): Promise<bigint> => { throw new Error('A zero-cost proposal does not need a fee estimate') } }
	assert.equal(await feeOops(fees, noEstimate, undefined), undefined)
})

test('the shared requested-fee policy preserves zero and explicit prices and supplies fee-check semantics', async () => {
	for (const gasPrice of [0n, marketPrice, marketPrice * 10n]) {
		const policy = getRequestedTransactionFees({ gasPrice, maxFeePerGas: 1n, maxPriorityFeePerGas: 2n })
		assert.equal(policy.adjustForBaseFee, false)
		assert.equal(policy.maxFeePerGas, gasPrice)
		assert.equal(policy.maxPriorityFeePerGas, gasPrice)
		assert.ok(policy.maxFeePerGas !== undefined)
		const fees = getFeeProtectionInput({ ...transactionFields, type: '1559', maxFeePerGas: policy.maxFeePerGas, maxPriorityFeePerGas: policy.maxPriorityFeePerGas }, policy)
		assert.deepEqual(fees, { comparison: 'total-price', pricePerGas: gasPrice })
		assert.equal((await feeOops(fees, ethereum, undefined)) !== undefined, gasPrice >= marketPrice * 10n)
	}
	assert.equal(getRequestedTransactionFees({}).adjustForBaseFee, true)
	assert.equal(getRequestedTransactionFees({ maxFeePerGas: 0n }).adjustForBaseFee, false)
	assert.equal(getRequestedTransactionFees({ maxFeePerGas: marketPrice }).feeModel, 'fee-market')
})
