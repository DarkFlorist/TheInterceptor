import * as funtypes from 'funtypes'
import type { RpcNetwork } from '../types/rpc.js'
import { addressString } from '../utils/bigint.js'
import type { SafeContractState } from '../safe/safeCore.js'
import type { SafeAppsRequestCommand } from '../types/safeApps.js'

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

const SafeAppsRequest = funtypes.ReadonlyObject({ method: funtypes.String }).And(funtypes.ReadonlyPartial({ params: funtypes.Unknown }))
const SafeTransactionsParams = funtypes.ReadonlyObject({ txs: funtypes.ReadonlyArray(funtypes.Unknown) }).And(funtypes.ReadonlyPartial({ params: funtypes.Unknown }))
const SafeTransaction = funtypes.ReadonlyObject({
	to: funtypes.String,
	value: funtypes.String,
	data: funtypes.String,
}).And(funtypes.ReadonlyPartial({ operation: funtypes.Unknown }))
const SafeTransactionOptions = funtypes.ReadonlyPartial({ safeTxGas: funtypes.Unknown })
const SafeRpcCall = funtypes.ReadonlyObject({ call: funtypes.String, params: funtypes.Unknown })
const SafePermissionRequests = funtypes.ReadonlyArray(funtypes.ReadonlyRecord(funtypes.String, funtypes.Unknown))

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

function parseSafeAppsRequest(value: unknown): funtypes.Static<typeof SafeAppsRequest> {
	const parsed = SafeAppsRequest.safeParse(value)
	if (!parsed.success) throw safeAppsPolicyError('Safe Apps request must contain a method string.')
	return parsed.value
}

function toEthereumQuantity(value: string): string {
	if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) throw safeAppsPolicyError('Safe transaction value must be a non-negative integer.')
	return `0x${ BigInt(value).toString(16) }`
}

function parseSafeTransaction(params: unknown, from: string) {
	const parsedParams = SafeTransactionsParams.safeParse(params)
	if (!parsedParams.success) throw safeAppsPolicyError('Safe sendTransactions params must contain a transaction array.')
	if (parsedParams.value.txs.length !== 1) throw safeAppsPolicyError('Interceptor Safe compatibility currently supports exactly one transaction per request; Safe batches require atomic MultiSend support.')
	const parsedTransaction = SafeTransaction.safeParse(parsedParams.value.txs[0])
	if (!parsedTransaction.success) throw safeAppsPolicyError('Safe transaction fields must be strings.')
	const transaction = parsedTransaction.value
	if (!/^0x[0-9a-f]{40}$/i.test(transaction.to)) throw safeAppsPolicyError('Safe transaction destination must be an Ethereum address.')
	if (!/^0x(?:[0-9a-f]{2})*$/i.test(transaction.data)) throw safeAppsPolicyError('Safe transaction data must be hex-encoded bytes.')
	if (transaction.operation !== undefined && transaction.operation !== 0) throw safeAppsPolicyError('Interceptor Safe compatibility supports only CALL transactions; delegate calls are not supported.')
	let safeTxGas: number | undefined
	if (parsedParams.value.params !== undefined) {
		const parsedOptions = SafeTransactionOptions.safeParse(parsedParams.value.params)
		if (!parsedOptions.success || (parsedOptions.value.safeTxGas !== undefined && (typeof parsedOptions.value.safeTxGas !== 'number' || !Number.isSafeInteger(parsedOptions.value.safeTxGas) || parsedOptions.value.safeTxGas < 0))) throw safeAppsPolicyError('Safe transaction gas must be a non-negative safe integer.')
		safeTxGas = parsedOptions.value.safeTxGas
	}
	return { from, to: transaction.to, value: toEthereumQuantity(transaction.value), data: transaction.data, ...(safeTxGas === undefined || safeTxGas === 0 ? {} : { gas: `0x${ safeTxGas.toString(16) }` }) }
}

function parseRpcCall(params: unknown) {
	const parsedCall = SafeRpcCall.safeParse(params)
	if (!parsedCall.success || !SAFE_APPS_RPC_METHODS.has(parsedCall.value.call)) throw safeAppsPolicyError('Unsupported Safe Apps RPC call.')
	const parsedParams = funtypes.ReadonlyArray(funtypes.Unknown).safeParse(parsedCall.value.params)
	if (!parsedParams.success) throw safeAppsPolicyError('Safe Apps RPC params must be an array.')
	const rpcParams = parsedCall.value.call === 'eth_getBlockByNumber' && parsedParams.value.length === 1 ? [...parsedParams.value, false] : parsedParams.value
	return { method: SAFE_APPS_RPC_ALIASES.get(parsedCall.value.call) ?? parsedCall.value.call, params: rpcParams }
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
			const parsedPermissions = SafePermissionRequests.safeParse(request.params)
			if (!parsedPermissions.success) throw safeAppsPolicyError('Safe Apps permission request params must be an array.')
			if (parsedPermissions.value.length === 0) return { kind: 'result', value: [] }
			if (!parsedPermissions.value.every((permission) => Object.keys(permission).length > 0 && Object.keys(permission).every((key) => key === 'requestAddressBook'))) throw safeAppsPolicyError('Unsupported Safe Apps permission request.')
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
