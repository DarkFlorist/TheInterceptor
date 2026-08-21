import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import { getSafeAppsChainInfo, getSafeAppsRequestCommand, isSafeAppsRequestPolicyError } from '../../app/ts/background/safeAppsRequestPolicy.js'
import { InterceptorMessageToInpage } from '../../app/ts/types/interceptor-messages.js'
import { serialize } from '../../app/ts/types/wire-types.js'

const activeAddress = 0x1111111111111111111111111111111111111111n
const rpcNetwork: RpcNetwork = {
	name: 'Polygon',
	chainId: 137n,
	httpsRpc: 'https://polygon.example',
	currencyName: 'POL',
	currencyTicker: 'POL',
	currencyLogoUri: 'https://example.test/pol.svg',
	blockExplorer: { apiUrl: 'https://api.polygonscan.com/api', apiKey: '' },
	primary: false,
	minimized: false,
}

describe('Safe Apps compatibility policy', () => {
	test('preserves Safe Apps errors at the background-to-inpage wire boundary', () => {
		assert.deepEqual(serialize(InterceptorMessageToInpage, {
			interceptorApproved: true,
			requestId: 7,
			bridgeRequestSettled: true,
			type: 'result',
			method: 'safe_apps_request',
			error: { code: -32602, message: 'Unsupported Safe Apps permission request.' },
		}), {
			interceptorApproved: true,
			requestId: 7,
			bridgeRequestSettled: true,
			type: 'result',
			method: 'safe_apps_request',
			error: { code: -32602, message: 'Unsupported Safe Apps permission request.' },
		})
	})

	test('omits unavailable optional chain metadata', () => {
		const networkWithoutOptionalMetadata: RpcNetwork = {
			name: 'Local',
			chainId: 31337n,
			httpsRpc: 'http://localhost:8545',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: false,
			minimized: false,
		}
		assert.deepEqual(getSafeAppsChainInfo(networkWithoutOptionalMetadata), {
			chainId: '31337',
			name: 'Local',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
		})
	})

	test('constructs synthetic protocol responses from privileged state', () => {
		assert.deepEqual(getSafeAppsRequestCommand({ method: 'getEnvironmentInfo' }, 'https://app.example', activeAddress, rpcNetwork), {
			kind: 'result',
			value: { origin: 'https://app.example' },
		})
		assert.deepEqual(getSafeAppsRequestCommand({ method: 'getChainInfo' }, 'https://app.example', activeAddress, rpcNetwork), {
			kind: 'result',
			value: {
				chainName: 'Polygon',
				chainId: '137',
				shortName: 'Polygon',
				nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18, logoUri: 'https://example.test/pol.svg' },
				blockExplorerUriTemplate: { address: '', txHash: '', api: 'https://api.polygonscan.com/api' },
			},
		})
	})

	test('allows only the supported RPC surface and normalizes SDK aliases', () => {
		assert.deepEqual(getSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'eth_getPastLogs', params: [{ fromBlock: 'latest' }] } }, 'https://app.example', activeAddress, rpcNetwork), {
			kind: 'ethereumRequest',
			method: 'eth_getLogs',
			params: [{ fromBlock: 'latest' }],
			mapResult: 'passthrough',
		})
		assert.deepEqual(getSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'eth_getBlockByNumber', params: ['latest'] } }, 'https://app.example', activeAddress, rpcNetwork), {
			kind: 'ethereumRequest',
			method: 'eth_getBlockByNumber',
			params: ['latest', false],
			mapResult: 'passthrough',
		})
		assert.deepEqual(getSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'eth_getPermissions', params: [] } }, 'https://app.example', activeAddress, rpcNetwork), {
			kind: 'result',
			value: [],
		})
		assert.throws(
			() => getSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'eth_requestPermissions', params: [{ requestAddressBook: {} }] } }, 'https://app.example', activeAddress, rpcNetwork),
			(error: unknown) => isSafeAppsRequestPolicyError(error) && /does not support the requestAddressBook permission/.test(error.message),
		)
		assert.throws(
			() => getSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'eth_sendRawTransaction', params: [] } }, 'https://app.example', activeAddress, rpcNetwork),
			(error: unknown) => isSafeAppsRequestPolicyError(error) && /Unsupported Safe Apps RPC call/.test(error.message),
		)
		assert.equal(isSafeAppsRequestPolicyError(new Error('unexpected storage failure')), false)
	})

	test('validates and maps a single CALL transaction', () => {
		const transaction = { to: '0x2222222222222222222222222222222222222222', value: '15', data: '0x1234' }
		assert.deepEqual(getSafeAppsRequestCommand({ method: 'sendTransactions', params: { txs: [transaction], params: { safeTxGas: 21000 } } }, 'https://app.example', activeAddress, rpcNetwork), {
			kind: 'ethereumRequest',
			method: 'eth_sendTransaction',
			params: [{ from: '0x1111111111111111111111111111111111111111', to: transaction.to, value: '0xf', data: transaction.data, gas: '0x5208' }],
			mapResult: 'safeTxHash',
		})
		assert.throws(() => getSafeAppsRequestCommand({ method: 'sendTransactions', params: { txs: [transaction, transaction] } }, 'https://app.example', activeAddress, rpcNetwork), /Safe batches require atomic MultiSend support/)
		assert.throws(() => getSafeAppsRequestCommand({ method: 'sendTransactions', params: { txs: [{ ...transaction, operation: 1 }] } }, 'https://app.example', activeAddress, rpcNetwork), /delegate calls are not supported/)
	})

	test('rejects chain IDs that cannot be represented by the Safe SDK', () => {
		assert.throws(() => getSafeAppsRequestCommand({ method: 'getSafeInfo' }, 'https://app.example', activeAddress, { ...rpcNetwork, chainId: BigInt(Number.MAX_SAFE_INTEGER) + 1n }), /chain ID is too large/)
	})
})
