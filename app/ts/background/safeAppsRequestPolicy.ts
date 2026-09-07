import { encodeSafeBatch, SAFE_MULTI_SEND_CALL_ONLY, SAFE_SIGN_MESSAGE_LIB, SAFE_SIGN_MESSAGE_ABI } from '../safe/safeDelegateCalls.js'
import { encodeFunctionCall } from '../utils/abiRuntime.js'
import { addressString, dataStringWith0xStart, stringToUint8Array } from '../utils/bigint.js'
import { createSafeMessageTypedData, getSafeMessageDigest } from '../safe/safeMessage.js'
import type { SafeAppsMessageServices } from './safeAppsMessages.js'
import * as funtypes from 'funtypes'
import type { RpcNetwork } from '../types/rpc.js'
import type { SafeContractState } from '../safe/safeCore.js'
import { JsonValue, type SafeAppsRequestCommand } from '../types/safeApps.js'
import { fetchSafeAppsBalances } from './safeAppsBalances.js'
import { fetchSafeAppsTransaction } from './safeAppsTransactions.js'

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

const SafeAppsRequest = funtypes.ReadonlyObject({ method: funtypes.String }).And(funtypes.ReadonlyPartial({ params: JsonValue, offChainSigning: funtypes.Boolean }))
const SafeTransactionsParams = funtypes.ReadonlyObject({ txs: funtypes.ReadonlyArray(JsonValue) }).And(funtypes.ReadonlyPartial({ params: JsonValue }))
const SafeTransaction = funtypes.ReadonlyObject({
	to: funtypes.String,
	value: funtypes.String,
	data: funtypes.String,
}).And(funtypes.ReadonlyPartial({ operation: funtypes.Number }))
const SafeTransactionOptions = funtypes.ReadonlyPartial({ safeTxGas: funtypes.Number })
const SafeSignMessageParams = funtypes.ReadonlyObject({ message: funtypes.String.withConstraint((value) => value.length <= 100_000) })
const SafeSubmitMessageParams = SafeSignMessageParams.And(funtypes.ReadonlyObject({ signature: funtypes.String.withConstraint((value) => /^0x[0-9a-f]{130}$/i.test(value)), safeAddress: funtypes.String, chainId: funtypes.String })).And(funtypes.ReadonlyPartial({ isTypedData: funtypes.Boolean }))
const SafeTransactionLookupParams = funtypes.ReadonlyObject({ safeTxHash: funtypes.String.withConstraint((value) => /^0x[0-9a-f]{64}$/i.test(value)) })
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

const SAFE_PROPOSAL_GAS_LIMIT = '0x989680'

function parseSafeTransaction(params: unknown, from: string): JsonValue {
	const parsedParams = SafeTransactionsParams.safeParse(params)
	if (!parsedParams.success || parsedParams.value.txs.length === 0 || parsedParams.value.txs.length > 100) throw safeAppsPolicyError('Safe sendTransactions params must contain between 1 and 100 transactions.')
	const transactions = parsedParams.value.txs.map((value) => {
		const parsed = SafeTransaction.safeParse(value)
		if (!parsed.success) throw safeAppsPolicyError('Safe transaction fields must be strings.')
		const transaction = parsed.value
		if (!/^0x[0-9a-f]{40}$/i.test(transaction.to)) throw safeAppsPolicyError('Safe transaction destination must be an Ethereum address.')
		if (!/^0x(?:[0-9a-f]{2})*$/i.test(transaction.data)) throw safeAppsPolicyError('Safe transaction data must be hex-encoded bytes.')
		if (transaction.operation !== undefined && transaction.operation !== 0) throw safeAppsPolicyError('Safe Apps delegate calls are not supported inside a batch or as app-provided transactions.')
		return { to: transaction.to, value: toEthereumQuantity(transaction.value), data: transaction.data }
	})
	let safeTxGas: number | undefined
	if (parsedParams.value.params !== undefined) {
		const parsedOptions = SafeTransactionOptions.safeParse(parsedParams.value.params)
		if (!parsedOptions.success || (parsedOptions.value.safeTxGas !== undefined && (!Number.isSafeInteger(parsedOptions.value.safeTxGas) || parsedOptions.value.safeTxGas < 0))) throw safeAppsPolicyError('Safe transaction gas must be a non-negative safe integer.')
		safeTxGas = parsedOptions.value.safeTxGas
	}
	const gas = safeTxGas === undefined || safeTxGas === 0 ? undefined : `0x${ safeTxGas.toString(16) }`
	const firstTransaction = transactions[0]
	if (firstTransaction === undefined) throw safeAppsPolicyError('A Safe transaction is required.')
	if (transactions.length === 1) return { from, ...firstTransaction, ...(gas === undefined ? {} : { gas }) }
	const data = encodeSafeBatch(transactions.map((transaction) => ({ to: BigInt(transaction.to), value: BigInt(transaction.value), data: stringToUint8Array(transaction.data) })))
	return { from, to: addressString(SAFE_MULTI_SEND_CALL_ONLY), value: '0x0', data: dataStringWith0xStart(data), safeOperation: '0x1', gas: gas ?? SAFE_PROPOSAL_GAS_LIMIT }
}

function createOnChainMessageCommand(from: string, message: string, isTypedData: boolean): SafeAppsRequestCommand {
	return { kind: 'ethereumRequest', method: 'eth_sendTransaction', params: [{
		from, to: addressString(SAFE_SIGN_MESSAGE_LIB), value: '0x0', gas: SAFE_PROPOSAL_GAS_LIMIT, safeOperation: '0x1',
		data: encodeFunctionCall(SAFE_SIGN_MESSAGE_ABI, 'signMessage', [getSafeMessageDigest(message, isTypedData)]),
		safeMessageText: message, safeMessageIsTypedData: isTypedData,
	}], mapResult: 'safeTxHash' }
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
	const offChainSigning = request.offChainSigning ?? true
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
			if (!offChainSigning) return createOnChainMessageCommand(safeAddress, params.value.message, false)
			return { kind: 'ethereumRequest', method: 'eth_signTypedData_v4', params: [safeAddress, JSON.stringify(createSafeMessageTypedData(rpcNetwork.chainId, activeSafeAddress, params.value.message))], mapResult: 'safeMessage', message: params.value.message, safeAddress, chainId: rpcNetwork.chainId.toString() }
		}
		case 'signTypedMessage': {
			const params = funtypes.ReadonlyObject({ typedData: JsonValue }).safeParse(request.params)
			if (!params.success) throw safeAppsPolicyError('Safe Apps signTypedMessage params must contain EIP-712 typedData.')
			const message = JSON.stringify(params.value.typedData, undefined, 2)
			if (message.length > 100_000) throw safeAppsPolicyError('The Safe typed message exceeds 100000 characters.')
			if (!offChainSigning) return createOnChainMessageCommand(safeAddress, message, true)
			const typedData = createSafeMessageTypedData(rpcNetwork.chainId, activeSafeAddress, message, true)
			return { kind: 'ethereumRequest', method: 'eth_signTypedData_v4', params: [safeAddress, JSON.stringify(typedData)], mapResult: 'safeMessage', message, isTypedData: true, safeAddress, chainId: rpcNetwork.chainId.toString() }
		}
		case 'submitOffChainMessage': {
			const params = SafeSubmitMessageParams.safeParse(request.params)
			if (!params.success || params.value.safeAddress !== safeAddress || params.value.chainId !== rpcNetwork.chainId.toString()) throw safeAppsPolicyError('The signed Safe message account or chain changed. Request the message again.')
			if (messageServices === undefined) throw safeAppsPolicyError('Safe message services are unavailable.')
			return { kind: 'result', value: await messageServices.submit(params.value.message, params.value.signature, params.value.isTypedData) }
		}
		case 'getOffChainSignature': {
			if (typeof request.params !== 'string' || !/^0x[0-9a-f]{64}$/i.test(request.params)) throw safeAppsPolicyError('Safe Apps getOffChainSignature requires a message hash.')
			if (messageServices === undefined) throw safeAppsPolicyError('Safe message services are unavailable.')
			return { kind: 'result', value: await messageServices.getSignature(request.params.toLowerCase()) }
		}
		case 'getTxBySafeTxHash': {
			const params = SafeTransactionLookupParams.safeParse(request.params)
			if (!params.success) throw safeAppsPolicyError('Safe Apps getTxBySafeTxHash requires a 32-byte Safe transaction hash prefixed with 0x.')
			return { kind: 'result', value: await fetchSafeAppsTransaction(rpcNetwork.chainId, activeSafeAddress, params.value.safeTxHash.toLowerCase()) }
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
			const settingCall = SafeRpcCall.safeParse(request.params)
			if (settingCall.success && settingCall.value.call === 'safe_setSettings') {
				const settings = funtypes.ReadonlyTuple(funtypes.ReadonlyRecord(funtypes.String, JsonValue).withConstraint((value) => Object.keys(value).every((key) => key === 'offChainSigning')).And(funtypes.ReadonlyObject({ offChainSigning: funtypes.Boolean }))).safeParse(settingCall.value.params)
				if (!settings.success) throw safeAppsPolicyError('safe_setSettings requires exactly one settings object with a boolean offChainSigning field.')
				return { kind: 'settings', offChainSigning: settings.value[0].offChainSigning }
			}
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
