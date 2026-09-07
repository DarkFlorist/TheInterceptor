import { createSafeMessageTypedData } from '../safe/safeMessage.js'
import type { SafeAppsMessageServices } from './safeAppsMessages.js'
import * as funtypes from 'funtypes'
import type { RpcNetwork } from '../types/rpc.js'
import { addressString } from '../utils/bigint.js'
import type { SafeContractState } from '../safe/safeCore.js'
import { JsonValue, type SafeAppsRequestCommand } from '../types/safeApps.js'
import { fetchSafeAppsBalances } from './safeAppsBalances.js'

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

const SafeAppsRequest = funtypes.ReadonlyObject({ method: funtypes.String }).And(funtypes.ReadonlyPartial({ params: JsonValue }))
const SafeTransactionsParams = funtypes.ReadonlyObject({ txs: funtypes.ReadonlyArray(JsonValue) }).And(funtypes.ReadonlyPartial({ params: JsonValue }))
const SafeTransaction = funtypes.ReadonlyObject({
	to: funtypes.String,
	value: funtypes.String,
	data: funtypes.String,
}).And(funtypes.ReadonlyPartial({ operation: funtypes.Number }))
const SafeTransactionOptions = funtypes.ReadonlyPartial({ safeTxGas: funtypes.Number })
const SafeSignMessageParams = funtypes.ReadonlyObject({ message: funtypes.String.withConstraint((value) => value.length <= 100_000) })
const SafeSubmitMessageParams = SafeSignMessageParams.And(funtypes.ReadonlyObject({ signature: funtypes.String.withConstraint((value) => /^0x[0-9a-f]{130}$/i.test(value)), safeAddress: funtypes.String, chainId: funtypes.String }))
const SafeBalanceParams = funtypes.ReadonlyPartial({ currency: funtypes.String })
const SafeRpcCall = funtypes.ReadonlyObject({ call: funtypes.String, params: JsonValue })
const SafePermissionRequests = funtypes.ReadonlyArray(funtypes.ReadonlyRecord(funtypes.String, JsonValue))

const SafeAppsRpcMethod = funtypes.Union(
	funtypes.Literal('eth_call'),
	funtypes.Literal('eth_estimateGas'),
	funtypes.Literal('eth_gasPrice'),
	funtypes.Literal('eth_getBalance'),
	funtypes.Literal('eth_getBlockByHash'),
	funtypes.Literal('eth_getBlockByNumber'),
	funtypes.Literal('eth_getCode'),
	funtypes.Literal('eth_getLogs'),
	funtypes.Literal('eth_getStorageAt'),
	funtypes.Literal('eth_getTransactionByHash'),
	funtypes.Literal('eth_getTransactionCount'),
	funtypes.Literal('eth_getTransactionReceipt'),
	funtypes.Literal('eth_getGasPrice'),
	funtypes.Literal('eth_getPastLogs'),
	funtypes.Literal('eth_getPermissions'),
	funtypes.Literal('eth_requestPermissions'),
)

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
	if (!parsed.success) {
		const parsedMethod = funtypes.ReadonlyObject({ method: funtypes.String }).safeParse(value)
		if (!parsedMethod.success) throw safeAppsPolicyError('Safe Apps request must contain a method string.')
		throw safeAppsPolicyError('Safe Apps request params must be JSON-compatible.')
	}
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
		if (!parsedOptions.success || (parsedOptions.value.safeTxGas !== undefined && (!Number.isSafeInteger(parsedOptions.value.safeTxGas) || parsedOptions.value.safeTxGas < 0))) throw safeAppsPolicyError('Safe transaction gas must be a non-negative safe integer.')
		safeTxGas = parsedOptions.value.safeTxGas
	}
	return { from, to: transaction.to, value: toEthereumQuantity(transaction.value), data: transaction.data, ...(safeTxGas === undefined || safeTxGas === 0 ? {} : { gas: `0x${ safeTxGas.toString(16) }` }) }
}

function parseRpcCall(params: JsonValue | undefined) {
	const parsedCall = SafeRpcCall.safeParse(params)
	if (!parsedCall.success) throw safeAppsPolicyError(`Unsupported Safe Apps RPC call. Received params: ${ JSON.stringify(params) }`)
	const parsedMethod = SafeAppsRpcMethod.safeParse(parsedCall.value.call)
	if (!parsedMethod.success) throw safeAppsPolicyError(`Unsupported Safe Apps RPC call. Received params: ${ JSON.stringify(params) }`)
	const parsedParams = funtypes.ReadonlyArray(JsonValue).safeParse(parsedCall.value.params)
	if (!parsedParams.success) throw safeAppsPolicyError(`Safe Apps RPC params must be an array. Received params: ${ JSON.stringify(params) }`)
	const rpcParams = parsedMethod.value === 'eth_getBlockByNumber' && parsedParams.value.length === 1 ? [...parsedParams.value, false] : parsedParams.value
	return { method: SAFE_APPS_RPC_ALIASES.get(parsedMethod.value) ?? parsedMethod.value, params: rpcParams }
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

export async function getSafeAppsRequestCommand(value: unknown, websiteOrigin: string, activeSafeAddress: bigint, rpcNetwork: RpcNetwork, getSafeContractState: () => Promise<SafeContractState>, messageServices?: SafeAppsMessageServices): Promise<SafeAppsRequestCommand> {
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
		case 'signMessage': {
			const params = SafeSignMessageParams.safeParse(request.params)
			if (!params.success) throw safeAppsPolicyError('Safe Apps signMessage params must contain a message string of at most 100000 characters.')
			return { kind: 'ethereumRequest', method: 'eth_signTypedData_v4', params: [safeAddress, JSON.stringify(createSafeMessageTypedData(rpcNetwork.chainId, activeSafeAddress, params.value.message))], mapResult: 'safeMessage', message: params.value.message, safeAddress, chainId: rpcNetwork.chainId.toString() }
		}
		case 'submitOffChainMessage': {
			const params = SafeSubmitMessageParams.safeParse(request.params)
			if (!params.success || params.value.safeAddress !== safeAddress || params.value.chainId !== rpcNetwork.chainId.toString()) throw safeAppsPolicyError('The signed Safe message account or chain changed. Request the message again.')
			if (messageServices === undefined) throw safeAppsPolicyError('Safe message services are unavailable.')
			return { kind: 'result', value: await messageServices.submit(params.value.message, params.value.signature) }
		}
		case 'getOffChainSignature': {
			if (typeof request.params !== 'string' || !/^0x[0-9a-f]{64}$/i.test(request.params)) throw safeAppsPolicyError('Safe Apps getOffChainSignature requires a message hash.')
			if (messageServices === undefined) throw safeAppsPolicyError('Safe message services are unavailable.')
			return { kind: 'result', value: await messageServices.getSignature(request.params.toLowerCase()) }
		}
		case 'getSafeBalances': {
			const params = SafeBalanceParams.safeParse(request.params === undefined ? {} : request.params)
			if (!params.success || (params.value.currency !== undefined && !/^[a-zA-Z]{3,10}$/.test(params.value.currency))) throw safeAppsPolicyError('Safe Apps balance currency must be a fiat currency code, such as usd or eur.')
			return { kind: 'result', value: await fetchSafeAppsBalances(rpcNetwork.chainId, activeSafeAddress, params.value.currency?.toLowerCase() ?? 'usd') }
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
