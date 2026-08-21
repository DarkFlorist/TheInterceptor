import * as funtypes from 'funtypes'
import type { RpcNetwork } from '../types/rpc.js'
import { addressString } from '../utils/bigint.js'
import type { SafeContractState } from '../safe/safeCore.js'

export type SafeAppsChainInfo = funtypes.Static<typeof SafeAppsChainInfo>
export const SafeAppsChainInfo = funtypes.ReadonlyObject({
	chainId: funtypes.String,
	name: funtypes.String,
	currencyName: funtypes.String,
	currencyTicker: funtypes.String,
}).And(funtypes.ReadonlyPartial({
	currencyLogoUri: funtypes.String,
	blockExplorerApiUrl: funtypes.String,
}))

export type SafeAppsRequestCommand =
	| { readonly kind: 'result', readonly value: unknown }
	| { readonly kind: 'ethereumRequest', readonly method: string, readonly params: readonly unknown[], readonly mapResult: 'passthrough' | 'safeTxHash' }

type SafeAppsRequest = { readonly method: string, readonly params?: unknown }
type SafeAppsRequestCandidate = { readonly method?: unknown, readonly params?: unknown }
type SafeTransactionsCandidate = { readonly txs?: unknown, readonly params?: unknown }
type SafeTransactionCandidate = { readonly to?: unknown, readonly value?: unknown, readonly data?: unknown, readonly operation?: unknown }
type SafeTransactionOptionsCandidate = { readonly safeTxGas?: unknown }
type SafeRpcCallCandidate = { readonly call?: unknown, readonly params?: unknown }

const SAFE_APPS_RPC_METHODS = new Set([
	'eth_call',
	'eth_estimateGas',
	'eth_gasPrice',
	'eth_getBalance',
	'eth_getBlockByHash',
	'eth_getBlockByNumber',
	'eth_getCode',
	'eth_getLogs',
	'eth_getStorageAt',
	'eth_getTransactionByHash',
	'eth_getTransactionCount',
	'eth_getTransactionReceipt',
	'eth_getGasPrice',
	'eth_getPastLogs',
	'eth_getPermissions',
	'eth_requestPermissions',
])

const SAFE_APPS_RPC_ALIASES = new Map([
	['eth_getGasPrice', 'eth_gasPrice'],
	['eth_getPastLogs', 'eth_getLogs'],
	['eth_getPermissions', 'wallet_getPermissions'],
	['eth_requestPermissions', 'wallet_requestPermissions'],
])

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null
type SafeAppsPolicyErrorCandidate = { readonly safeAppsPolicyError?: unknown }
const isSafeAppsPolicyErrorCandidate = (value: unknown): value is SafeAppsPolicyErrorCandidate => isRecord(value)
const safeAppsPolicyError = (message: string) => Object.assign(new Error(message), { safeAppsPolicyError: true as const })
export const isSafeAppsRequestPolicyError = (error: unknown): error is Error & { readonly safeAppsPolicyError: true } => error instanceof Error && isSafeAppsPolicyErrorCandidate(error) && error.safeAppsPolicyError === true
const isSafeAppsRequestCandidate = (value: unknown): value is SafeAppsRequestCandidate => isRecord(value)
const isSafeTransactionsCandidate = (value: unknown): value is SafeTransactionsCandidate => isRecord(value)
const isSafeTransactionCandidate = (value: unknown): value is SafeTransactionCandidate => isRecord(value)
const isSafeTransactionOptionsCandidate = (value: unknown): value is SafeTransactionOptionsCandidate => isRecord(value)
const isSafeRpcCallCandidate = (value: unknown): value is SafeRpcCallCandidate => isRecord(value)

function parseSafeAppsRequest(value: unknown): SafeAppsRequest {
	if (!isSafeAppsRequestCandidate(value) || typeof value.method !== 'string') throw safeAppsPolicyError('Safe Apps request must contain a method string.')
	return { method: value.method, ...(value.params === undefined ? {} : { params: value.params }) }
}

function toEthereumQuantity(value: string): string {
	if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) throw safeAppsPolicyError('Safe transaction value must be a non-negative integer.')
	return `0x${ BigInt(value).toString(16) }`
}

function parseSafeTransaction(params: unknown, from: string) {
	if (!isSafeTransactionsCandidate(params) || !Array.isArray(params.txs)) throw safeAppsPolicyError('Safe sendTransactions params must contain a transaction array.')
	if (params.txs.length !== 1) throw safeAppsPolicyError('Interceptor Safe compatibility currently supports exactly one transaction per request; Safe batches require atomic MultiSend support.')
	const transaction = params.txs[0]
	if (!isSafeTransactionCandidate(transaction) || typeof transaction.to !== 'string' || typeof transaction.value !== 'string' || typeof transaction.data !== 'string') throw safeAppsPolicyError('Safe transaction fields must be strings.')
	if (!/^0x[0-9a-f]{40}$/i.test(transaction.to)) throw safeAppsPolicyError('Safe transaction destination must be an Ethereum address.')
	if (!/^0x(?:[0-9a-f]{2})*$/i.test(transaction.data)) throw safeAppsPolicyError('Safe transaction data must be hex-encoded bytes.')
	if (transaction.operation !== undefined && transaction.operation !== 0) throw safeAppsPolicyError('Interceptor Safe compatibility supports only CALL transactions; delegate calls are not supported.')
	let safeTxGas: number | undefined
	if (params.params !== undefined) {
		if (!isSafeTransactionOptionsCandidate(params.params) || (params.params.safeTxGas !== undefined && (typeof params.params.safeTxGas !== 'number' || !Number.isSafeInteger(params.params.safeTxGas) || params.params.safeTxGas < 0))) throw safeAppsPolicyError('Safe transaction gas must be a non-negative safe integer.')
		safeTxGas = params.params.safeTxGas
	}
	return { from, to: transaction.to, value: toEthereumQuantity(transaction.value), data: transaction.data, ...(safeTxGas === undefined || safeTxGas === 0 ? {} : { gas: `0x${ safeTxGas.toString(16) }` }) }
}

function parseRpcCall(params: unknown) {
	if (!isSafeRpcCallCandidate(params) || typeof params.call !== 'string' || !SAFE_APPS_RPC_METHODS.has(params.call)) throw safeAppsPolicyError('Unsupported Safe Apps RPC call.')
	if (!Array.isArray(params.params)) throw safeAppsPolicyError('Safe Apps RPC params must be an array.')
	const rpcParams = params.call === 'eth_getBlockByNumber' && params.params.length === 1 ? [...params.params, false] : params.params
	return { method: SAFE_APPS_RPC_ALIASES.get(params.call) ?? params.call, params: rpcParams }
}

function toSafeAppsNumber(value: bigint, label: string) {
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw safeAppsPolicyError(`The Safe ${ label } is too large for the Safe Apps protocol.`)
	return Number(value)
}

export function getSafeAppsChainInfo(rpcNetwork: RpcNetwork): SafeAppsChainInfo {
	return {
		chainId: rpcNetwork.chainId.toString(),
		name: rpcNetwork.name,
		currencyName: rpcNetwork.currencyName,
		currencyTicker: rpcNetwork.currencyTicker,
		...('currencyLogoUri' in rpcNetwork && rpcNetwork.currencyLogoUri !== undefined ? { currencyLogoUri: rpcNetwork.currencyLogoUri } : {}),
		...(!('blockExplorer' in rpcNetwork) || rpcNetwork.blockExplorer === undefined ? {} : { blockExplorerApiUrl: rpcNetwork.blockExplorer.apiUrl }),
	}
}

export async function getSafeAppsRequestCommand(value: unknown, websiteOrigin: string, activeSafeAddress: bigint, rpcNetwork: RpcNetwork, getSafeContractState: () => Promise<SafeContractState>): Promise<SafeAppsRequestCommand> {
	const request = parseSafeAppsRequest(value)
	const safeAddress = addressString(activeSafeAddress)
	const chainInfo = getSafeAppsChainInfo(rpcNetwork)
	switch (request.method) {
		case 'getEnvironmentInfo': return { kind: 'result', value: { origin: websiteOrigin } }
		case 'getChainInfo': return { kind: 'result', value: { chainName: chainInfo.name, chainId: chainInfo.chainId, shortName: chainInfo.name, nativeCurrency: { name: chainInfo.currencyName, symbol: chainInfo.currencyTicker, decimals: 18, logoUri: chainInfo.currencyLogoUri ?? '' }, blockExplorerUriTemplate: { address: '', txHash: '', api: chainInfo.blockExplorerApiUrl ?? '' } } }
		case 'getSafeInfo': {
			const safeState = await getSafeContractState()
			return { kind: 'result', value: { safeAddress, chainId: toSafeAppsNumber(rpcNetwork.chainId, 'chain ID'), owners: safeState.owners.map(addressString), threshold: toSafeAppsNumber(safeState.threshold, 'threshold'), isReadOnly: false, nonce: toSafeAppsNumber(safeState.nonce, 'nonce'), implementation: ZERO_ADDRESS, modules: [], fallbackHandler: ZERO_ADDRESS, guard: ZERO_ADDRESS, version: safeState.version, network: `CHAIN_${ rpcNetwork.chainId.toString() }` } }
		}
		case 'wallet_getPermissions': return { kind: 'result', value: [] }
		case 'wallet_requestPermissions': {
			if (!Array.isArray(request.params)) throw safeAppsPolicyError('Safe Apps permission request params must be an array.')
			if (request.params.length === 0) return { kind: 'result', value: [] }
			if (!request.params.every((permission) => isRecord(permission) && Object.keys(permission).length > 0 && Object.keys(permission).every((key) => key === 'requestAddressBook'))) throw safeAppsPolicyError('Unsupported Safe Apps permission request.')
			throw safeAppsPolicyError('Interceptor Safe compatibility does not support the requestAddressBook permission.')
		}
		case 'rpcCall': {
			const rpcCall = parseRpcCall(request.params)
			if (rpcCall.method === 'wallet_getPermissions' || rpcCall.method === 'wallet_requestPermissions') {
				return await getSafeAppsRequestCommand({ method: rpcCall.method, params: rpcCall.params }, websiteOrigin, activeSafeAddress, rpcNetwork, getSafeContractState)
			}
			return { kind: 'ethereumRequest', ...rpcCall, mapResult: 'passthrough' }
		}
		case 'sendTransactions': return { kind: 'ethereumRequest', method: 'eth_sendTransaction', params: [parseSafeTransaction(request.params, safeAddress)], mapResult: 'safeTxHash' }
		default: throw safeAppsPolicyError(`Unsupported Safe Apps method: ${ request.method }.`)
	}
}
