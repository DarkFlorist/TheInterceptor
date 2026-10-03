import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { isValidAbiString } from '../../app/ts/utils/abiRuntime.js'
import { fetchAbiFromBlockExplorer, getEtherscanErrorMessage, mergeProxyAndImplementationAbi } from '../../app/ts/simulation/services/EtherScanAbiFetcher.js'
import { EtherscanGetABIResult, EtherscanSourceCodeResult } from '../../app/ts/types/etherscan.js'
import type { RpcEntries } from '../../app/ts/types/rpc.js'

const contractAddress = 0x1111111111111111111111111111111111111111n
const implementationAddress = '0x2222222222222222222222222222222222222222'

const getRpcEntries = async (): Promise<RpcEntries> => [{
	name: 'Ethereum',
	chainId: 1n,
	httpsRpc: 'https://rpc.example',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
	blockExplorer: {
		apiUrl: 'https://explorer.example/api',
		apiKey: 'api-key',
	},
}]

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
	status,
	headers: { 'Content-Type': 'application/json' },
})

async function withFetchResponses<T>(responses: readonly Response[], action: (requestedUrls: readonly string[]) => Promise<T>) {
	const originalFetch = globalThis.fetch
	const remainingResponses = [...responses]
	const requestedUrls: string[] = []
	globalThis.fetch = async (resource) => {
		requestedUrls.push(resource.toString())
		const response = remainingResponses.shift()
		if (response === undefined) throw new Error('Unexpected extra fetch request')
		return response
	}
	try {
		const result = await action(requestedUrls)
		assert.equal(remainingResponses.length, 0)
		return result
	} finally {
		globalThis.fetch = originalFetch
	}
}

describe('Etherscan ABI fetcher', () => {
	test('preserves the reason returned by a failed source-code request', () => {
		const error = 'Max rate limit reached, please use API Key for higher rate limit'
		const parsed = EtherscanSourceCodeResult.safeParse({
			status: '0',
			message: 'NOTOK',
			result: error,
		})

		assert.equal(parsed.success, true)
		if (!parsed.success) return
		assert.equal(parsed.value.status, 'failure')
		assert.equal(parsed.value.result, error)
		assert.equal(getEtherscanErrorMessage(parsed.value.result), `Etherscan returned an error: ${ error }`)
	})

	test('preserves the reason returned by a failed ABI request', () => {
		const error = 'Invalid API Key'
		const parsed = EtherscanGetABIResult.safeParse({
			status: '0',
			message: 'NOTOK',
			result: error,
		})

		assert.equal(parsed.success, true)
		if (!parsed.success) return
		assert.equal(parsed.value.status, 'failure')
		assert.equal(parsed.value.result, error)
	})

	test('returns the Etherscan failure reason when Sourcify has no match', async () => {
		const error = 'Invalid API Key'
		const result = await withFetchResponses([
			jsonResponse({ status: '0', message: 'NOTOK', result: error }),
			jsonResponse({}, 404),
		], async (requestedUrls) => {
			const fetchResult = await fetchAbiFromBlockExplorer(contractAddress, 1n, getRpcEntries)
			assert.equal(requestedUrls.length, 2)
			assert.equal(requestedUrls[1]?.startsWith('https://repo.sourcify.dev/'), true)
			return fetchResult
		})

		assert.deepEqual(result, {
			success: false,
			error: `Etherscan returned an error: ${ error }`,
		})
	})

	test('uses Sourcify when Etherscan returns a failure', async () => {
		const result = await withFetchResponses([
			jsonResponse({ status: '0', message: 'NOTOK', result: 'Contract source code not verified' }),
			jsonResponse({
				compiler: {},
				language: 'Solidity',
				output: { abi: [] },
				settings: {},
				sources: {},
				version: 1,
			}),
		], async () => await fetchAbiFromBlockExplorer(contractAddress, 1n, getRpcEntries))

		assert.deepEqual(result, {
			success: true,
			abi: '[]',
			contractName: '0x1111111111111111111111111111111111111111',
			address: contractAddress,
		})
	})

	test('returns a proxy implementation ABI failure without making another request', async () => {
		const error = 'Max rate limit reached, please use API Key for higher rate limit'
		const result = await withFetchResponses([
			jsonResponse({
				status: '1',
				message: 'OK',
				result: [{
					ContractName: 'Proxy',
					ABI: '[]',
					Proxy: '1',
					Implementation: implementationAddress,
				}],
			}),
			jsonResponse({ status: '0', message: 'NOTOK', result: error }),
		], async (requestedUrls) => {
			const fetchResult = await fetchAbiFromBlockExplorer(contractAddress, 1n, getRpcEntries)
			assert.equal(requestedUrls.length, 2)
			assert.equal(requestedUrls[1]?.includes('action=getabi'), true)
			return fetchResult
		})

		assert.deepEqual(result, {
			success: false,
			error: `Etherscan returned an error: ${ error }`,
		})
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
