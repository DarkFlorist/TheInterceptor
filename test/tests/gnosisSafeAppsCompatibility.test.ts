import { createGnosisSafeAppsSigningServices } from '../fixtures/gnosisSafeAppsRequestServices.js'
import { getGnosisSafeAppsExecution } from '../../app/ts/gnosisSafe/gnosisSafeAppsExecution.js'
import { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import { type GnosisSafeAppsRequestServices, getGnosisSafeAppsChainInfo, getGnosisSafeAppsRequestCommand, isGnosisSafeAppsRequestPolicyError } from '../../app/ts/background/gnosisSafeAppsRequestPolicy.js'
import { InterceptorMessageToInpage } from '../../app/ts/types/interceptor-messages.js'
import { decodeGnosisSafeBatch, GNOSIS_SAFE_MULTI_SEND_CALL_ONLY } from '../../app/ts/gnosisSafe/gnosisSafeDelegateCalls.js'
import { addressString, dataStringWith0xStart, stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import { serialize } from '../../app/ts/types/wire-types.js'

const activeAddress = 0x1111111111111111111111111111111111111111n
const safeState = {
	version: '1.4.1',
	nonce: 7n,
	owners: [0x3333333333333333333333333333333333333333n, 0x4444444444444444444444444444444444444444n],
	threshold: 2n,
}
const getGnosisSafeState = async () => safeState
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

describe('Gnosis Safe Apps compatibility policy', () => {
	test('preserves Gnosis Safe Apps errors at the background-to-inpage wire boundary', () => {
		assert.deepEqual(serialize(InterceptorMessageToInpage, {
			interceptorApproved: true,
			requestId: 7,
			bridgeRequestSettled: true,
			type: 'result',
			method: 'safe_apps_request',
			error: { code: -32602, message: 'Unsupported Gnosis Safe Apps permission request.' },
		}), {
			interceptorApproved: true,
			requestId: 7,
			bridgeRequestSettled: true,
			type: 'result',
			method: 'safe_apps_request',
			error: { code: -32602, message: 'Unsupported Gnosis Safe Apps permission request.' },
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
		assert.deepEqual(getGnosisSafeAppsChainInfo(networkWithoutOptionalMetadata), {
			chainId: '31337',
			name: 'Local',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
		})
	})

	test('constructs protocol responses from privileged network and Gnosis Safe state', async () => {
		assert.deepEqual(await getGnosisSafeAppsRequestCommand({ method: 'getEnvironmentInfo' }, 'https://app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()), {
			kind: 'result',
			value: { origin: 'https://app.example' },
		})
		assert.deepEqual(await getGnosisSafeAppsRequestCommand({ method: 'getChainInfo' }, 'https://app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()), {
			kind: 'result',
			value: {
				chainName: 'Polygon',
				chainId: '137',
				shortName: 'Polygon',
				nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18, logoUri: 'https://example.test/pol.svg' },
				blockExplorerUriTemplate: { address: '', txHash: '', api: 'https://api.polygonscan.com/api' },
			},
		})
		assert.deepEqual(await getGnosisSafeAppsRequestCommand({ method: 'getSafeInfo' }, 'https://app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()), {
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
		assert.deepEqual(await getGnosisSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'eth_getPastLogs', params: [{ fromBlock: 'latest' }] } }, 'https://app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()), {
			kind: 'ethereumRequest',
			method: 'eth_getLogs',
			params: [{ fromBlock: 'latest' }],
			mapResult: 'passthrough',
		})
		assert.deepEqual(await getGnosisSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'eth_getBlockByNumber', params: ['latest'] } }, 'https://app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()), {
			kind: 'ethereumRequest',
			method: 'eth_getBlockByNumber',
			params: ['latest', false],
			mapResult: 'passthrough',
		})
		assert.deepEqual(await getGnosisSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'eth_getPermissions', params: [] } }, 'https://app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()), {
			kind: 'result',
			value: [],
		})
		await assert.rejects(
			async () => await getGnosisSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'eth_requestPermissions', params: [{ requestAddressBook: {} }] } }, 'https://app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()),
			(error: unknown) => isGnosisSafeAppsRequestPolicyError(error) && /does not support the requestAddressBook permission/.test(error.message),
		)
		await assert.rejects(
			async () => await getGnosisSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'eth_sendRawTransaction', params: [] } }, 'https://app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()),
			(error: unknown) => isGnosisSafeAppsRequestPolicyError(error) && /Unsupported Gnosis Safe Apps RPC call/.test(error.message),
		)
		assert.equal(isGnosisSafeAppsRequestPolicyError(new Error('unexpected storage failure')), false)
	})

	test('rejects non-finite numbers before serializing RPC diagnostics', async () => {
		for (const value of [NaN, Infinity, -Infinity]) {
			await assert.rejects(
				async () => await getGnosisSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'unsupported_method', params: [value] } }, 'https://app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()),
				(error: unknown) => isGnosisSafeAppsRequestPolicyError(error) && error.message === 'Gnosis Safe Apps request params must be JSON-compatible.',
			)
		}
	})

	test('includes the supplied RPC call params in policy errors', async () => {
		const cases = [
			{ params: undefined, reason: 'Unsupported Gnosis Safe Apps RPC call.' },
			{ params: { params: ['latest'] }, reason: 'Unsupported Gnosis Safe Apps RPC call.' },
			{ params: { call: 'unsupported_method', params: [{ address: '0x1234' }] }, reason: 'Unsupported Gnosis Safe Apps RPC call.' },
			{ params: { call: 'eth_call', params: {} }, reason: 'Gnosis Safe Apps RPC params must be an array.' },
		]
		for (const { params, reason } of cases) {
			await assert.rejects(
				async () => await getGnosisSafeAppsRequestCommand({ method: 'rpcCall', ...(params === undefined ? {} : { params }) }, 'https://app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()),
				(error: unknown) => isGnosisSafeAppsRequestPolicyError(error) && error.message === `${ reason } Received params: ${ JSON.stringify(params) }`,
			)
		}
	})

	test('validates and maps a single CALL transaction from the active Gnosis Safe', async () => {
		const transaction = { to: '0x2222222222222222222222222222222222222222', value: '15', data: '0x1234' }
		assert.deepEqual(await getGnosisSafeAppsRequestCommand({ method: 'sendTransactions', params: { txs: [transaction], params: { safeTxGas: 21000 } } }, 'https://app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()), {
			kind: 'ethereumRequest',
			method: 'eth_sendTransaction',
			params: [{ from: '0x1111111111111111111111111111111111111111', to: transaction.to, value: '0xf', data: transaction.data, gas: '0x5208' }],
			safeRequestContext: { operation: 0 },
			mapResult: 'safeTxHash',
		})
		const batch = await getGnosisSafeAppsRequestCommand({ method: 'sendTransactions', params: { txs: [transaction, { ...transaction, value: '20' }] } }, 'https://app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices())
		if (batch.kind !== 'ethereumRequest') throw new Error('Missing batch command')
		const request = SendTransactionParams.parse({ method: batch.method, params: batch.params })
		assert.equal(request.params[0].to, GNOSIS_SAFE_MULTI_SEND_CALL_ONLY)
		assert.equal(batch.safeRequestContext?.operation, 1)
		assert.equal(request.params[0].value, 0n)
		assert.deepEqual(decodeGnosisSafeBatch(request.params[0].data ?? new Uint8Array()), [
			{ to: BigInt(transaction.to), value: 15n, data: stringToUint8Array(transaction.data) },
			{ to: BigInt(transaction.to), value: 20n, data: stringToUint8Array(transaction.data) },
		])
		await assert.rejects(async () => await getGnosisSafeAppsRequestCommand({ method: 'sendTransactions', params: { txs: [{ ...transaction, operation: 1 }] } }, 'https://app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()), /delegate calls are not supported/)
	})

	test('accepts structured-cloned SDK requests with explicitly undefined transaction options', async () => {
		const transaction = { to: '0x2222222222222222222222222222222222222222', value: '0', data: '0x' }
		for (const txs of [[transaction], [transaction, transaction]]) for (const options of [undefined, { safeTxGas: undefined }]) {
			const sdkRequest = structuredClone({ method: 'sendTransactions', params: { txs, params: options } })
			assert.equal(Object.hasOwn(sdkRequest.params, 'params'), true)
			assert.deepEqual(
				await getGnosisSafeAppsRequestCommand(sdkRequest, 'app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()),
				await getGnosisSafeAppsRequestCommand({ method: 'sendTransactions', params: { txs } }, 'app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()),
			)
			assert.equal(Object.hasOwn(sdkRequest.params, 'params'), true)
		}
		for (const params of [
			{ txs: [undefined], params: undefined },
			{ txs: [{ ...transaction, value: undefined }], params: undefined },
			{ txs: [transaction], params: undefined, unknown: undefined },
			{ txs: [transaction], params: { safeTxGas: undefined, unknown: undefined } },
			{ txs: [transaction], params: { safeTxGas: NaN } },
		]) await assert.rejects(getGnosisSafeAppsRequestCommand({ method: 'sendTransactions', params }, 'app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()), /JSON-compatible/)
	})

	test('rejects malformed Gnosis Safe Apps shapes at the shared runtype boundaries', async () => {
		await assert.rejects(
			async () => await getGnosisSafeAppsRequestCommand({ method: 'sendTransactions', params: { txs: [{ to: 1, value: '0', data: '0x' }] } }, 'https://app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()),
			/Gnosis Safe transaction fields must be strings/,
		)
		await assert.rejects(
			async () => await getGnosisSafeAppsRequestCommand({ method: 'sendTransactions', params: { txs: [{ to: '0x2222222222222222222222222222222222222222', value: '0', data: '0x' }], params: { safeTxGas: '21000' } } }, 'https://app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()),
			/Gnosis Safe transaction gas must be a non-negative safe integer/,
		)
		await assert.rejects(
			async () => await getGnosisSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'eth_call', params: {} } }, 'https://app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()),
			/Gnosis Safe Apps RPC params must be an array/,
		)
		await assert.rejects(
			async () => await getGnosisSafeAppsRequestCommand({ method: 'wallet_requestPermissions', params: [undefined] }, 'https://app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()),
			/Gnosis Safe Apps request params must be JSON-compatible/,
		)
	})

	test('rejects Gnosis Safe metadata that cannot be represented by the Gnosis Safe SDK', async () => {
		await assert.rejects(async () => await getGnosisSafeAppsRequestCommand({ method: 'getSafeInfo' }, 'https://app.example', activeAddress, { ...rpcNetwork, chainId: BigInt(Number.MAX_SAFE_INTEGER) + 1n }, getGnosisSafeState, createGnosisSafeAppsSigningServices()), /chain ID is too large/)
		await assert.rejects(async () => await getGnosisSafeAppsRequestCommand({ method: 'getSafeInfo' }, 'https://app.example', activeAddress, rpcNetwork, async () => ({ ...safeState, nonce: BigInt(Number.MAX_SAFE_INTEGER) + 1n }), createGnosisSafeAppsSigningServices()), /nonce is too large/)
	})
})

	test('Gnosis Safe SDK settings select off-chain signing or one on-chain message proposal', async () => {
	for (const offChainSigning of [true, false]) {
		assert.deepEqual(await getGnosisSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'safe_setSettings', params: [{ offChainSigning }] } }, 'app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()), { kind: 'settings', offChainSigning })
		const command = await getGnosisSafeAppsRequestCommand({ method: 'signMessage', params: { message: 'Hello' }, offChainSigning }, 'app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices())
		if (command.kind !== 'ethereumRequest') throw new Error('Missing message command')
		assert.equal(command.method, offChainSigning ? 'eth_signTypedData_v4' : 'eth_sendTransaction')
		assert.equal(command.mapResult, offChainSigning ? 'safeMessage' : 'safeTxHash')
		if (!offChainSigning) {
			const request = SendTransactionParams.parse({ method: command.method, params: command.params })
			assert.equal(command.safeRequestContext?.operation, 1)
			assert.equal(command.safeRequestContext?.message?.text, 'Hello')
			assert.equal(addressString(request.params[0].from), addressString(activeAddress))
			// Literal contract ABI vector, independent of the production ABI encoder; payload is the EIP-191 digest of Hello.
			const expected = '0x85a5affe' + '0'.repeat(62) + '20' + '0'.repeat(62) + '20' + 'aa744ba2ca576ec62ca0045eca00ad3917fdf7ffa34fbbae50828a5a69c1580e'
			assert.equal(dataStringWith0xStart(request.params[0].data ?? new Uint8Array()), expected)
		}
	}
	for (const params of [[], [{}], [{ offChainSigning: 'false' }], [{ offChainSigning: false }, {}], [{ offChainSigning: false, unknown: true }]]) {
		await assert.rejects(getGnosisSafeAppsRequestCommand({ method: 'rpcCall', params: { call: 'safe_setSettings', params } }, 'app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()), /settings object/)
	}
})


test('Gnosis Safe Apps execution normalizes transaction and message commands for the ordinary RPC pipeline', async () => {
	const uniqueRequestIdentifier = { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } }
	const transactions = [{ to: addressString(activeAddress), value: '0', data: '0x' }, { to: addressString(activeAddress), value: '1', data: '0x' }]
	for (const command of [
		await getGnosisSafeAppsRequestCommand({ method: 'sendTransactions', params: { txs: transactions } }, 'app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()),
		await getGnosisSafeAppsRequestCommand({ method: 'signMessage', params: { message: 'Reviewed text' } }, 'app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices()),
	]) {
		if (command.kind !== 'ethereumRequest' || command.safeRequestContext === undefined) throw new Error('Expected a Gnosis Safe execution command')
		const execution = getGnosisSafeAppsExecution({ method: 'safe_apps_request', params: [{ method: 'execute', params: command }], interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier })
		if (execution === undefined) throw new Error('Missing normalized execution')
		assert.equal(execution.request.method, command.method)
		assert.equal(execution.confirmation.parameters.method, command.method)
		if (execution.confirmation.kind === 'transaction') assert.equal(execution.confirmation.safeTransaction?.operation, command.safeRequestContext.operation)
		else assert.deepEqual(execution.confirmation.review, command.safeRequestContext.message)
		assert.equal(EthereumJsonRpcRequest.safeParse(execution.request).success, true)
		assert.equal('safeRequestContext' in execution.request, false)
		assert.equal(JSON.stringify(execution.request.params).includes('safeRequestContext'), false)
		assert.deepEqual(execution.request.uniqueRequestIdentifier, uniqueRequestIdentifier)
	}
})

test('Gnosis Safe Apps policy validates and normalizes gateway requests before invoking injected services', async () => {
	const calls: string[] = []
	const services = createGnosisSafeAppsSigningServices({
		getBalances: async (currency: string) => { calls.push(`balances:${ currency }`); return { items: [] } },
		getTransaction: async (hash: string) => { calls.push(`transaction:${ hash }`); return { safeTxHash: hash } },
	})
	const request = async (value: unknown) => await getGnosisSafeAppsRequestCommand(value, 'app.example', activeAddress, rpcNetwork, getGnosisSafeState, services)
	const hash = `0x${ 'AB'.repeat(32) }`
	assert.deepEqual(await request({ method: 'getSafeBalances', params: { currency: 'EUR' } }), { kind: 'result', value: { items: [] } })
	assert.deepEqual(await request({ method: 'getTxBySafeTxHash', params: { safeTxHash: hash } }), { kind: 'result', value: { safeTxHash: hash.toLowerCase() } })
	assert.deepEqual(calls, ['balances:eur', `transaction:${ hash.toLowerCase() }`])
	await assert.rejects(request({ method: 'getSafeBalances', params: { currency: '../usd' } }), /fiat currency code/)
	await assert.rejects(request({ method: 'getTxBySafeTxHash', params: { safeTxHash: 'invalid' } }), /32-byte Gnosis Safe transaction hash/)
	assert.equal(calls.length, 2)
	const unavailable = new Error('Service failed')
	await assert.rejects(getGnosisSafeAppsRequestCommand({ method: 'getSafeBalances' }, 'app.example', activeAddress, rpcNetwork, getGnosisSafeState, createGnosisSafeAppsSigningServices({ getBalances: async () => { throw unavailable } })), (error) => error === unavailable)
	await assert.rejects(getGnosisSafeAppsRequestCommand({ method: 'getSafeBalances' }, 'app.example', activeAddress, rpcNetwork, getGnosisSafeState, { mode: 'simulation' }), /balance services are unavailable in simulation mode/)
	await assert.rejects(getGnosisSafeAppsRequestCommand({ method: 'getTxBySafeTxHash', params: { safeTxHash: hash } }, 'app.example', activeAddress, rpcNetwork, getGnosisSafeState, { mode: 'simulation' }), /transaction services are unavailable in simulation mode/)
})

test('simulation Gnosis Safe Apps supports on-chain approvals and never submits simulated off-chain signatures', async () => {
	const services: GnosisSafeAppsRequestServices = { mode: 'simulation' }
	for (const request of [
		{ method: 'signMessage', params: { message: 'Test' } },
		{ method: 'signTypedMessage', params: { typedData: {} } },
		{ method: 'submitOffChainMessage', params: {} },
		{ method: 'getOffChainSignature', params: '0x' },
	]) await assert.rejects(getGnosisSafeAppsRequestCommand(request, 'app.example', activeAddress, rpcNetwork, getGnosisSafeState, services), /Off-chain Gnosis Safe message services are unavailable in simulation mode/)
	const approval = await getGnosisSafeAppsRequestCommand({ method: 'signMessage', params: { message: 'Test' }, offChainSigning: false }, 'app.example', activeAddress, rpcNetwork, getGnosisSafeState, services)
	assert.equal(approval.kind, 'ethereumRequest')
	if (approval.kind !== 'ethereumRequest') throw new Error('Missing simulated approval')
	assert.equal(approval.mapResult, 'safeTxHash')
	assert.equal(approval.safeRequestContext?.operation, 1)
})
