import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import { getSafeAppsChainInfo, getSafeAppsRequestCommand, isSafeAppsRequestPolicyError } from '../../app/ts/background/safeAppsRequestPolicy.js'
import { InterceptorMessageToInpage } from '../../app/ts/types/interceptor-messages.js'
import { serialize } from '../../app/ts/types/wire-types.js'

const activeAddress = 0x1111111111111111111111111111111111111111n
const safeState = {
	version: '1.4.1',
	nonce: 7n,
	owners: [0x3333333333333333333333333333333333333333n, 0x4444444444444444444444444444444444444444n],
	threshold: 2n,
}
const getSafeState = async () => safeState
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

	test('constructs protocol responses from privileged network and Safe state', async () => {
		assert.deepEqual(await getSafeAppsRequestCommand({ method: 'getEnvironmentInfo' }, 'https://app.example', activeAddress, rpcNetwork, getSafeState), {
			kind: 'result',
			value: { origin: 'https://app.example' },
		})
		assert.deepEqual(await getSafeAppsRequestCommand({ method: 'getChainInfo' }, 'https://app.example', activeAddress, rpcNetwork, getSafeState), {
			kind: 'result',
			value: {
				chainName: 'Polygon',
				chainId: '137',
				shortName: 'Polygon',
				nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18, logoUri: 'https://example.test/pol.svg' },
				blockExplorerUriTemplate: { address: '', txHash: '', api: 'https://api.polygonscan.com/api' },
			},
		})
		assert.deepEqual(await getSafeAppsRequestCommand({ method: 'getSafeInfo' }, 'https://app.example', activeAddress, rpcNetwork, getSafeState), {
			kind: 'result',
			value: {
				safeAddress: '0x1111111111111111111111111111111111111111',
				chainId: 137,
				owners: ['0x3333333333333333333333333333333333333333', '0x4444444444444444444444444444444444444444'],
				threshold: 2,
				isReadOnly: false,
				nonce: 7,
				implementation: '0x0000000000000000000000000000000000000000',
				modules: [],
				fallbackHandler: '0x0000000000000000000000000000000000000000',
				guard: '0x0000000000000000000000000000000000000000',
				version: '1.4.1',
				network: 'CHAIN_137',
			},
		})
	})

	test('allows only the supported RPC surface and normalizes SDK aliases', async () => {
		assert.deepEqual(await getSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'eth_getPastLogs', params: [{ fromBlock: 'latest' }] } }, 'https://app.example', activeAddress, rpcNetwork, getSafeState), {
			kind: 'ethereumRequest',
			method: 'eth_getLogs',
			params: [{ fromBlock: 'latest' }],
			mapResult: 'passthrough',
		})
		assert.deepEqual(await getSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'eth_getBlockByNumber', params: ['latest'] } }, 'https://app.example', activeAddress, rpcNetwork, getSafeState), {
			kind: 'ethereumRequest',
			method: 'eth_getBlockByNumber',
			params: ['latest', false],
			mapResult: 'passthrough',
		})
		assert.deepEqual(await getSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'eth_getPermissions', params: [] } }, 'https://app.example', activeAddress, rpcNetwork, getSafeState), {
			kind: 'result',
			value: [],
		})
		await assert.rejects(
			async () => await getSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'eth_requestPermissions', params: [{ requestAddressBook: {} }] } }, 'https://app.example', activeAddress, rpcNetwork, getSafeState),
			(error: unknown) => isSafeAppsRequestPolicyError(error) && /does not support the requestAddressBook permission/.test(error.message),
		)
		await assert.rejects(
			async () => await getSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'eth_sendRawTransaction', params: [] } }, 'https://app.example', activeAddress, rpcNetwork, getSafeState),
			(error: unknown) => isSafeAppsRequestPolicyError(error) && /Unsupported Safe Apps RPC call/.test(error.message),
		)
		assert.equal(isSafeAppsRequestPolicyError(new Error('unexpected storage failure')), false)
	})

	test('validates and maps a single CALL transaction from the active Safe', async () => {
		const transaction = { to: '0x2222222222222222222222222222222222222222', value: '15', data: '0x1234' }
		assert.deepEqual(await getSafeAppsRequestCommand({ method: 'sendTransactions', params: { txs: [transaction], params: { safeTxGas: 21000 } } }, 'https://app.example', activeAddress, rpcNetwork, getSafeState), {
			kind: 'ethereumRequest',
			method: 'eth_sendTransaction',
			params: [{ from: '0x1111111111111111111111111111111111111111', to: transaction.to, value: '0xf', data: transaction.data, gas: '0x5208' }],
			mapResult: 'safeTxHash',
		})
		await assert.rejects(async () => await getSafeAppsRequestCommand({ method: 'sendTransactions', params: { txs: [transaction, transaction] } }, 'https://app.example', activeAddress, rpcNetwork, getSafeState), /Safe batches require atomic MultiSend support/)
		await assert.rejects(async () => await getSafeAppsRequestCommand({ method: 'sendTransactions', params: { txs: [{ ...transaction, operation: 1 }] } }, 'https://app.example', activeAddress, rpcNetwork, getSafeState), /delegate calls are not supported/)
	})

	test('rejects Safe metadata that cannot be represented by the Safe SDK', async () => {
		await assert.rejects(async () => await getSafeAppsRequestCommand({ method: 'getSafeInfo' }, 'https://app.example', activeAddress, { ...rpcNetwork, chainId: BigInt(Number.MAX_SAFE_INTEGER) + 1n }, getSafeState), /chain ID is too large/)
		await assert.rejects(async () => await getSafeAppsRequestCommand({ method: 'getSafeInfo' }, 'https://app.example', activeAddress, rpcNetwork, async () => ({ ...safeState, nonce: BigInt(Number.MAX_SAFE_INTEGER) + 1n })), /nonce is too large/)
	})
})
