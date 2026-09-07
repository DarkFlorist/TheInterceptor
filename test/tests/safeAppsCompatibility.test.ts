import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import { getSafeAppsChainInfo, getSafeAppsRequestCommand, isSafeAppsRequestPolicyError } from '../../app/ts/background/safeAppsRequestPolicy.js'
import { InterceptorMessageToInpage } from '../../app/ts/types/interceptor-messages.js'
import { decodeSafeBatch, SAFE_MULTI_SEND_CALL_ONLY } from '../../app/ts/safe/safeDelegateCalls.js'
import { addressString, stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
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

	test('rejects non-finite numbers before serializing RPC diagnostics', async () => {
		for (const value of [NaN, Infinity, -Infinity]) {
			await assert.rejects(
				async () => await getSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'unsupported_method', params: [value] } }, 'https://app.example', activeAddress, rpcNetwork, getSafeState),
				(error: unknown) => isSafeAppsRequestPolicyError(error) && error.message === 'Safe Apps request params must be JSON-compatible.',
			)
		}
	})

	test('includes the supplied RPC call params in policy errors', async () => {
		const cases = [
			{ params: undefined, reason: 'Unsupported Safe Apps RPC call.' },
			{ params: { params: ['latest'] }, reason: 'Unsupported Safe Apps RPC call.' },
			{ params: { call: 'unsupported_method', params: [{ address: '0x1234' }] }, reason: 'Unsupported Safe Apps RPC call.' },
			{ params: { call: 'eth_call', params: {} }, reason: 'Safe Apps RPC params must be an array.' },
		]
		for (const { params, reason } of cases) {
			await assert.rejects(
				async () => await getSafeAppsRequestCommand({ method: 'rpcCall', ...(params === undefined ? {} : { params }) }, 'https://app.example', activeAddress, rpcNetwork, getSafeState),
				(error: unknown) => isSafeAppsRequestPolicyError(error) && error.message === `${ reason } Received params: ${ JSON.stringify(params) }`,
			)
		}
	})

	test('validates and maps a single CALL transaction from the active Safe', async () => {
		const transaction = { to: '0x2222222222222222222222222222222222222222', value: '15', data: '0x1234' }
		assert.deepEqual(await getSafeAppsRequestCommand({ method: 'sendTransactions', params: { txs: [transaction], params: { safeTxGas: 21000 } } }, 'https://app.example', activeAddress, rpcNetwork, getSafeState), {
			kind: 'ethereumRequest',
			method: 'eth_sendTransaction',
			params: [{ from: '0x1111111111111111111111111111111111111111', to: transaction.to, value: '0xf', data: transaction.data, gas: '0x5208' }],
			mapResult: 'safeTxHash',
		})
		const batch = await getSafeAppsRequestCommand({ method: 'sendTransactions', params: { txs: [transaction, { ...transaction, value: '20' }] } }, 'https://app.example', activeAddress, rpcNetwork, getSafeState)
		if (batch.kind !== 'ethereumRequest') throw new Error('Missing batch command')
		const request = SendTransactionParams.parse({ method: batch.method, params: batch.params })
		assert.equal(request.params[0].to, SAFE_MULTI_SEND_CALL_ONLY)
		assert.equal(batch.safeRequestContext?.operation, 1)
		assert.equal(request.params[0].value, 0n)
		assert.deepEqual(decodeSafeBatch(request.params[0].data ?? new Uint8Array()), [
			{ to: BigInt(transaction.to), value: 15n, data: stringToUint8Array(transaction.data) },
			{ to: BigInt(transaction.to), value: 20n, data: stringToUint8Array(transaction.data) },
		])
		await assert.rejects(async () => await getSafeAppsRequestCommand({ method: 'sendTransactions', params: { txs: [{ ...transaction, operation: 1 }] } }, 'https://app.example', activeAddress, rpcNetwork, getSafeState), /delegate calls are not supported/)
	})

	test('accepts structured-cloned SDK requests with explicitly undefined transaction options', async () => {
		const transaction = { to: '0x2222222222222222222222222222222222222222', value: '0', data: '0x' }
		for (const txs of [[transaction], [transaction, transaction]]) {
			const sdkRequest = structuredClone({ method: 'sendTransactions', params: { txs, params: undefined } })
			assert.equal(Object.hasOwn(sdkRequest.params, 'params'), true)
			assert.deepEqual(
				await getSafeAppsRequestCommand(sdkRequest, 'app.example', activeAddress, rpcNetwork, getSafeState),
				await getSafeAppsRequestCommand({ method: 'sendTransactions', params: { txs } }, 'app.example', activeAddress, rpcNetwork, getSafeState),
			)
			assert.equal(Object.hasOwn(sdkRequest.params, 'params'), true)
		}
		for (const params of [
			{ txs: [undefined], params: undefined },
			{ txs: [{ ...transaction, value: undefined }], params: undefined },
			{ txs: [transaction], params: undefined, unknown: undefined },
		]) await assert.rejects(getSafeAppsRequestCommand({ method: 'sendTransactions', params }, 'app.example', activeAddress, rpcNetwork, getSafeState), /JSON-compatible/)
	})

	test('rejects malformed Safe Apps shapes at the shared runtype boundaries', async () => {
		await assert.rejects(
			async () => await getSafeAppsRequestCommand({ method: 'sendTransactions', params: { txs: [{ to: 1, value: '0', data: '0x' }] } }, 'https://app.example', activeAddress, rpcNetwork, getSafeState),
			/Safe transaction fields must be strings/,
		)
		await assert.rejects(
			async () => await getSafeAppsRequestCommand({ method: 'sendTransactions', params: { txs: [{ to: '0x2222222222222222222222222222222222222222', value: '0', data: '0x' }], params: { safeTxGas: '21000' } } }, 'https://app.example', activeAddress, rpcNetwork, getSafeState),
			/Safe transaction gas must be a non-negative safe integer/,
		)
		await assert.rejects(
			async () => await getSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'eth_call', params: {} } }, 'https://app.example', activeAddress, rpcNetwork, getSafeState),
			/Safe Apps RPC params must be an array/,
		)
		await assert.rejects(
			async () => await getSafeAppsRequestCommand({ method: 'wallet_requestPermissions', params: [undefined] }, 'https://app.example', activeAddress, rpcNetwork, getSafeState),
			/Safe Apps request params must be JSON-compatible/,
		)
	})

	test('rejects Safe metadata that cannot be represented by the Safe SDK', async () => {
		await assert.rejects(async () => await getSafeAppsRequestCommand({ method: 'getSafeInfo' }, 'https://app.example', activeAddress, { ...rpcNetwork, chainId: BigInt(Number.MAX_SAFE_INTEGER) + 1n }, getSafeState), /chain ID is too large/)
		await assert.rejects(async () => await getSafeAppsRequestCommand({ method: 'getSafeInfo' }, 'https://app.example', activeAddress, rpcNetwork, async () => ({ ...safeState, nonce: BigInt(Number.MAX_SAFE_INTEGER) + 1n })), /nonce is too large/)
	})
})

 test('Safe SDK settings select off-chain signing or one on-chain message proposal', async () => {
	for (const offChainSigning of [true, false]) {
		assert.deepEqual(await getSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'safe_setSettings', params: [{ offChainSigning }] } }, 'app.example', activeAddress, rpcNetwork, getSafeState), { kind: 'settings', offChainSigning })
		const command = await getSafeAppsRequestCommand({ method: 'signMessage', params: { message: 'Hello' }, offChainSigning }, 'app.example', activeAddress, rpcNetwork, getSafeState)
		if (command.kind !== 'ethereumRequest') throw new Error('Missing message command')
		assert.equal(command.method, offChainSigning ? 'eth_signTypedData_v4' : 'eth_sendTransaction')
		assert.equal(command.mapResult, offChainSigning ? 'safeMessage' : 'safeTxHash')
		if (!offChainSigning) {
			const request = SendTransactionParams.parse({ method: command.method, params: command.params })
			assert.equal(command.safeRequestContext?.operation, 1)
			assert.equal(command.safeRequestContext?.message?.text, 'Hello')
			assert.equal(addressString(request.params[0].from), addressString(activeAddress))
		}
	}
	for (const params of [[], [{}], [{ offChainSigning: 'false' }], [{ offChainSigning: false }, {}], [{ offChainSigning: false, unknown: true }]]) {
		await assert.rejects(getSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'safe_setSettings', params } }, 'app.example', activeAddress, rpcNetwork, getSafeState), /settings object/)
	}
})
