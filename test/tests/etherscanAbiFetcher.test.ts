import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { isValidAbiString } from '../../app/ts/utils/abiRuntime.js'
import { getBlockExplorerContractUrl, mergeProxyAndImplementationAbi } from '../../app/ts/simulation/services/EtherScanAbiFetcher.js'
import { getDefaultBlockExplorer } from '../../app/ts/background/settings.js'

describe('Etherscan ABI fetcher', () => {
	test('does not ship with a default Etherscan API key', () => {
		assert.equal(getDefaultBlockExplorer().apiKey, '')
	})

	test('omits empty API keys from block explorer contract URLs', () => {
		const url = new URL(getBlockExplorerContractUrl(
			{ apiUrl: 'https://api.etherscan.io/v2/api', apiKey: '' },
			'getsourcecode',
			0x1111111111111111111111111111111111111111n,
			1n,
		))

		assert.equal(url.origin + url.pathname, 'https://api.etherscan.io/v2/api')
		assert.equal(url.searchParams.get('chainId'), '1')
		assert.equal(url.searchParams.get('module'), 'contract')
		assert.equal(url.searchParams.get('action'), 'getsourcecode')
		assert.equal(url.searchParams.get('address'), '0x1111111111111111111111111111111111111111')
		assert.equal(url.searchParams.has('apiKey'), false)
	})

	test('includes configured API keys in block explorer contract URLs', () => {
		const url = new URL(getBlockExplorerContractUrl(
			{ apiUrl: 'https://api.etherscan.io/v2/api', apiKey: ' configured-key ' },
			'getabi',
			0x2222222222222222222222222222222222222222n,
			11155111n,
		))

		assert.equal(url.searchParams.get('chainId'), '11155111')
		assert.equal(url.searchParams.get('action'), 'getabi')
		assert.equal(url.searchParams.get('address'), '0x2222222222222222222222222222222222222222')
		assert.equal(url.searchParams.get('apiKey'), 'configured-key')
	})

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
