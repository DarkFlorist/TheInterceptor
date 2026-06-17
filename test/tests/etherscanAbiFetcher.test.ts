import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { isValidAbiString } from '../../app/ts/utils/abiRuntime.js'
import { mergeProxyAndImplementationAbi } from '../../app/ts/simulation/services/EtherScanAbiFetcher.js'

describe('Etherscan ABI fetcher', () => {
	test('keeps proxy ABI events when merging with implementation ABI', () => {
		const proxyAbi = JSON.stringify([
			{
				type: 'event',
				name: 'TransferWithConversionAndReference',
				inputs: [
					{ indexed: false, name: 'amount', type: 'uint256' },
					{ indexed: false, name: 'currency', type: 'address' },
					{ indexed: true, name: 'paymentReference', type: 'bytes' },
					{ indexed: false, name: 'feeAmount', type: 'uint256' },
					{ indexed: false, name: 'maxRateTimespan', type: 'uint256' },
				],
				anonymous: false,
			},
		])
		const implementationAbi = JSON.stringify([
			{
				type: 'event',
				name: 'TransferWithReferenceAndFee',
				inputs: [
					{ indexed: false, name: 'tokenAddress', type: 'address' },
					{ indexed: false, name: 'to', type: 'address' },
					{ indexed: false, name: 'amount', type: 'uint256' },
					{ indexed: true, name: 'paymentReference', type: 'bytes' },
					{ indexed: false, name: 'feeAmount', type: 'uint256' },
					{ indexed: false, name: 'feeAddress', type: 'address' },
				],
				anonymous: false,
			},
		])

		const mergedAbi = mergeProxyAndImplementationAbi(proxyAbi, implementationAbi)

		assert.equal(isValidAbiString(mergedAbi), true)
		assert.equal(mergedAbi.includes('TransferWithConversionAndReference'), true)
		assert.equal(mergedAbi.includes('TransferWithReferenceAndFee'), true)
	})

	test('falls back to implementation ABI when proxy ABI is invalid', () => {
		const invalidProxyAbi = JSON.stringify([
			{
				name: 'MissingType',
				inputs: [],
			},
		])
		const implementationAbi = JSON.stringify([
			{
				type: 'event',
				name: 'TransferWithReferenceAndFee',
				inputs: [
					{ indexed: false, name: 'tokenAddress', type: 'address' },
					{ indexed: false, name: 'to', type: 'address' },
					{ indexed: false, name: 'amount', type: 'uint256' },
					{ indexed: true, name: 'paymentReference', type: 'bytes' },
					{ indexed: false, name: 'feeAmount', type: 'uint256' },
					{ indexed: false, name: 'feeAddress', type: 'address' },
				],
				anonymous: false,
			},
		])

		const mergedAbi = mergeProxyAndImplementationAbi(invalidProxyAbi, implementationAbi)

		assert.equal(isValidAbiString(mergedAbi), true)
		assert.equal(mergedAbi, implementationAbi)
	})
})
