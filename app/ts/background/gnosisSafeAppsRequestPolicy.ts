import { GnosisSafeReviewInput } from '../types/gnosisSafeReview.js'
import { encodeGnosisSafeBatch, GNOSIS_SAFE_MULTI_SEND_CALL_ONLY } from '../gnosisSafe/gnosisSafeDelegateCalls.js'
import { buildGnosisSafeMessageApproval } from '../gnosisSafe/gnosisSafeMessageApproval.js'
import { addressString, dataStringWith0xStart, stringToUint8Array } from '../utils/bigint.js'
import { createGnosisSafeMessageTypedData } from '../gnosisSafe/gnosisSafeMessage.js'
import type { GnosisSafeAppsMessageServices } from './gnosisSafeAppsMessages.js'
import * as funtypes from 'funtypes'
import type { RpcNetwork } from '../types/rpc.js'
import type { GnosisSafeContractState } from '../gnosisSafe/gnosisSafeCore.js'
import { JsonValue, type GnosisSafeAppsRequestCommand } from '../types/gnosisSafeApps.js'

export type GnosisSafeAppsRequestServices = { readonly mode: 'simulation' } | {
	readonly mode: 'signing'
	readonly messages: GnosisSafeAppsMessageServices
	readonly getBalances: (currency: string) => Promise<JsonValue>
	readonly getTransaction: (safeTxHash: string) => Promise<JsonValue>
}

export type GnosisSafeAppsChainInfo = funtypes.Static<typeof GnosisSafeAppsChainInfo>
export const GnosisSafeAppsChainInfo = funtypes.ReadonlyObject({
	chainId: funtypes.String,
	name: funtypes.String,
	currencyName: funtypes.String,
	currencyTicker: funtypes.String,
}).And(funtypes.ReadonlyPartial({
	currencyLogoUri: funtypes.String,
	blockExplorerApiUrl: funtypes.String,
}))

const GnosisSafeAppsRequest = funtypes.ReadonlyObject({ method: funtypes.String }).And(funtypes.ReadonlyPartial({ params: JsonValue, offChainSigning: funtypes.Boolean }))
const GnosisSafeTransactionsParams = funtypes.ReadonlyObject({ txs: funtypes.ReadonlyArray(JsonValue) }).And(funtypes.ReadonlyPartial({ params: JsonValue }))
const GnosisSafeTransaction = funtypes.ReadonlyObject({
	to: funtypes.String,
	value: funtypes.String,
	data: funtypes.String,
}).And(funtypes.ReadonlyPartial({ operation: funtypes.Number }))
const GnosisSafeTransactionOptions = funtypes.ReadonlyPartial({ safeTxGas: funtypes.Number })
const gnosisSafeTransactionOptionKeys = new Set(Object.keys(GnosisSafeTransactionOptions.fields))
const GnosisSafeSignMessageParams = funtypes.ReadonlyObject({ message: funtypes.String.withConstraint((value) => value.length <= 100_000) })
const GnosisSafeSubmitMessageParams = GnosisSafeSignMessageParams.And(funtypes.ReadonlyObject({ signature: funtypes.String.withConstraint((value) => /^0x[0-9a-f]{130}$/i.test(value)), safeAddress: funtypes.String, chainId: funtypes.String })).And(funtypes.ReadonlyPartial({ isTypedData: funtypes.Boolean }))
const GnosisSafeTransactionLookupParams = funtypes.ReadonlyObject({ safeTxHash: funtypes.String.withConstraint((value) => /^0x[0-9a-f]{64}$/i.test(value)) })
const GnosisSafeBalanceParams = funtypes.ReadonlyPartial({ currency: funtypes.String })
const GnosisSafeRpcCall = funtypes.ReadonlyObject({ call: funtypes.String, params: JsonValue })
const GnosisSafePermissionRequests = funtypes.ReadonlyArray(funtypes.ReadonlyRecord(funtypes.String, JsonValue))

const GnosisSafeAppsRpcMethod = funtypes.Union(
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

const GNOSIS_SAFE_APPS_RPC_ALIASES = new Map([
	['eth_getGasPrice', 'eth_gasPrice'],
	['eth_getPastLogs', 'eth_getLogs'],
	['eth_getPermissions', 'wallet_getPermissions'],
	['eth_requestPermissions', 'wallet_requestPermissions'],
])

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null
type GnosisSafeAppsPolicyErrorCandidate = { readonly gnosisSafeAppsPolicyError?: unknown }
const isGnosisSafeAppsPolicyErrorCandidate = (value: unknown): value is GnosisSafeAppsPolicyErrorCandidate => isRecord(value)
const gnosisSafeAppsPolicyError = (message: string) => Object.assign(new Error(message), { gnosisSafeAppsPolicyError: true as const })
export const isGnosisSafeAppsRequestPolicyError = (error: unknown): error is Error & { readonly gnosisSafeAppsPolicyError: true } => error instanceof Error && isGnosisSafeAppsPolicyErrorCandidate(error) && error.gnosisSafeAppsPolicyError === true

function normalizeGnosisSafeTransactionOptions(value: unknown) {
	if (!isRecord(value)) return value
	const { method, params } = value
	if (method !== 'sendTransactions' || !isRecord(params) || Array.isArray(params)) return value
	const { params: options, ...transactionParams } = params
	// Firefox preserves omitted optional SDK fields during structured cloning; Chrome's JSON messaging omits them. Normalize only the known SDK option, retaining strict validation for every other undefined/non-JSON value.
	if (options === undefined) return { ...value, params: transactionParams }
	if (!isRecord(options) || Array.isArray(options)) return value
	const definedOptions = Object.fromEntries(Object.entries(options).filter(([key, field]) => field !== undefined || !gnosisSafeTransactionOptionKeys.has(key)))
	return { ...value, params: { ...transactionParams, params: definedOptions } }
}

function parseGnosisSafeAppsRequest(value: unknown): funtypes.Static<typeof GnosisSafeAppsRequest> {
	const parsed = GnosisSafeAppsRequest.safeParse(normalizeGnosisSafeTransactionOptions(value))
	if (!parsed.success) {
		const parsedMethod = funtypes.ReadonlyObject({ method: funtypes.String }).safeParse(value)
		if (!parsedMethod.success) throw gnosisSafeAppsPolicyError('Gnosis Safe Apps request must contain a method string.')
		throw gnosisSafeAppsPolicyError('Gnosis Safe Apps request params must be JSON-compatible.')
	}
	return parsed.value
}

function toEthereumQuantity(value: string): string {
	if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) throw gnosisSafeAppsPolicyError('Gnosis Safe transaction value must be a non-negative integer.')
	return `0x${ BigInt(value).toString(16) }`
}

const GNOSIS_SAFE_PROPOSAL_GAS_LIMIT = '0x989680'

function parseGnosisSafeTransaction(params: unknown, from: string): { transaction: JsonValue, batch: boolean } {
	const parsedParams = GnosisSafeTransactionsParams.safeParse(params)
	if (!parsedParams.success || parsedParams.value.txs.length === 0 || parsedParams.value.txs.length > 100) throw gnosisSafeAppsPolicyError('Gnosis Safe sendTransactions params must contain between 1 and 100 transactions.')
	const transactions = parsedParams.value.txs.map((value) => {
		const parsed = GnosisSafeTransaction.safeParse(value)
		if (!parsed.success) throw gnosisSafeAppsPolicyError('Gnosis Safe transaction fields must be strings.')
		const transaction = parsed.value
		if (!/^0x[0-9a-f]{40}$/i.test(transaction.to)) throw gnosisSafeAppsPolicyError('Gnosis Safe transaction destination must be an Ethereum address.')
		if (!/^0x(?:[0-9a-f]{2})*$/i.test(transaction.data)) throw gnosisSafeAppsPolicyError('Gnosis Safe transaction data must be hex-encoded bytes.')
		if (transaction.operation !== undefined && transaction.operation !== 0) throw gnosisSafeAppsPolicyError('Gnosis Safe Apps delegate calls are not supported inside a batch or as app-provided transactions.')
		return { to: transaction.to, value: toEthereumQuantity(transaction.value), data: transaction.data }
	})
	let safeTxGas: number | undefined
	if (parsedParams.value.params !== undefined) {
		const parsedOptions = GnosisSafeTransactionOptions.safeParse(parsedParams.value.params)
		if (!parsedOptions.success || (parsedOptions.value.safeTxGas !== undefined && (!Number.isSafeInteger(parsedOptions.value.safeTxGas) || parsedOptions.value.safeTxGas < 0))) throw gnosisSafeAppsPolicyError('Gnosis Safe transaction gas must be a non-negative safe integer.')
		safeTxGas = parsedOptions.value.safeTxGas
	}
	const gas = safeTxGas === undefined || safeTxGas === 0 ? undefined : `0x${ safeTxGas.toString(16) }`
	const firstTransaction = transactions[0]
	if (firstTransaction === undefined) throw gnosisSafeAppsPolicyError('A Gnosis Safe transaction is required.')
	if (transactions.length === 1) return { transaction: { from, ...firstTransaction, ...(gas === undefined ? {} : { gas }) }, batch: false }
	const data = encodeGnosisSafeBatch(transactions.map((transaction) => ({ to: BigInt(transaction.to), value: BigInt(transaction.value), data: stringToUint8Array(transaction.data) })))
	return { transaction: { from, to: addressString(GNOSIS_SAFE_MULTI_SEND_CALL_ONLY), value: '0x0', data: dataStringWith0xStart(data), gas: gas ?? GNOSIS_SAFE_PROPOSAL_GAS_LIMIT }, batch: true }
}

function createOnChainMessageCommand(from: string, message: string, isTypedData: boolean): GnosisSafeAppsRequestCommand {
	const review = { text: message, isTypedData }
	const approval = buildGnosisSafeMessageApproval(review)
	return { kind: 'ethereumRequest', method: 'eth_sendTransaction', params: [{
		from, to: addressString(approval.to), value: `0x${ approval.value.toString(16) }`, gas: GNOSIS_SAFE_PROPOSAL_GAS_LIMIT,
		data: dataStringWith0xStart(approval.data),
	}], safeRequestContext: GnosisSafeReviewInput.parse({ operation: Number(approval.operation), message: review }), mapResult: 'safeTxHash' }
}

function parseRpcCall(params: JsonValue | undefined) {
	const parsedCall = GnosisSafeRpcCall.safeParse(params)
	if (!parsedCall.success) throw gnosisSafeAppsPolicyError(`Unsupported Gnosis Safe Apps RPC call. Received params: ${ JSON.stringify(params) }`)
	const parsedMethod = GnosisSafeAppsRpcMethod.safeParse(parsedCall.value.call)
	if (!parsedMethod.success) throw gnosisSafeAppsPolicyError(`Unsupported Gnosis Safe Apps RPC call. Received params: ${ JSON.stringify(params) }`)
	const parsedParams = funtypes.ReadonlyArray(JsonValue).safeParse(parsedCall.value.params)
	if (!parsedParams.success) throw gnosisSafeAppsPolicyError(`Gnosis Safe Apps RPC params must be an array. Received params: ${ JSON.stringify(params) }`)
	const rpcParams = parsedMethod.value === 'eth_getBlockByNumber' && parsedParams.value.length === 1 ? [...parsedParams.value, false] : parsedParams.value
	return { method: GNOSIS_SAFE_APPS_RPC_ALIASES.get(parsedMethod.value) ?? parsedMethod.value, params: rpcParams }
}

function toGnosisSafeAppsNumber(value: bigint, label: string) {
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw gnosisSafeAppsPolicyError(`The Gnosis Safe ${ label } is too large for the Gnosis Safe Apps protocol.`)
	return Number(value)
}

export function getGnosisSafeAppsChainInfo(rpcNetwork: RpcNetwork): GnosisSafeAppsChainInfo {
	return {
		chainId: rpcNetwork.chainId.toString(),
		name: rpcNetwork.name,
		currencyName: rpcNetwork.currencyName,
		currencyTicker: rpcNetwork.currencyTicker,
		...('currencyLogoUri' in rpcNetwork && rpcNetwork.currencyLogoUri !== undefined ? { currencyLogoUri: rpcNetwork.currencyLogoUri } : {}),
		...(!('blockExplorer' in rpcNetwork) || rpcNetwork.blockExplorer === undefined ? {} : { blockExplorerApiUrl: rpcNetwork.blockExplorer.apiUrl }),
	}
}

export async function getGnosisSafeAppsRequestCommand(value: unknown, websiteOrigin: string, activeSafeAddress: bigint, rpcNetwork: RpcNetwork, getGnosisSafeContractState: () => Promise<GnosisSafeContractState>, services: GnosisSafeAppsRequestServices): Promise<GnosisSafeAppsRequestCommand> {
	const request = parseGnosisSafeAppsRequest(value)
	const offChainSigning = request.offChainSigning ?? true
	if (services.mode === 'simulation' && (request.method === 'signMessage' || request.method === 'signTypedMessage') && offChainSigning) throw gnosisSafeAppsPolicyError('Off-chain Gnosis Safe message services are unavailable in simulation mode. Disable off-chain signing in the app to simulate an on-chain message approval.')
	const safeAddress = addressString(activeSafeAddress)
	const chainInfo = getGnosisSafeAppsChainInfo(rpcNetwork)
	switch (request.method) {
		case 'getEnvironmentInfo': return { kind: 'result', value: { origin: websiteOrigin } }
		case 'getChainInfo': return { kind: 'result', value: { chainName: chainInfo.name, chainId: chainInfo.chainId, shortName: chainInfo.name, nativeCurrency: { name: chainInfo.currencyName, symbol: chainInfo.currencyTicker, decimals: 18, logoUri: chainInfo.currencyLogoUri ?? '' }, blockExplorerUriTemplate: { address: '', txHash: '', api: chainInfo.blockExplorerApiUrl ?? '' } } }
		case 'getSafeInfo': {
			const safeState = await getGnosisSafeContractState()
			return { kind: 'result', value: { safeAddress, chainId: toGnosisSafeAppsNumber(rpcNetwork.chainId, 'chain ID'), owners: safeState.owners.map(addressString), threshold: toGnosisSafeAppsNumber(safeState.threshold, 'threshold'), isReadOnly: false, nonce: toGnosisSafeAppsNumber(safeState.nonce, 'nonce'), implementation: ZERO_ADDRESS, modules: [], fallbackHandler: ZERO_ADDRESS, guard: ZERO_ADDRESS, version: safeState.version, network: `CHAIN_${ rpcNetwork.chainId.toString() }` } }
		}
		case 'signMessage': {
			const params = GnosisSafeSignMessageParams.safeParse(request.params)
			if (!params.success) throw gnosisSafeAppsPolicyError('Gnosis Safe Apps signMessage params must contain a message string of at most 100000 characters.')
			if (!offChainSigning) return createOnChainMessageCommand(safeAddress, params.value.message, false)
			return { kind: 'ethereumRequest', method: 'eth_signTypedData_v4', params: [safeAddress, JSON.stringify(createGnosisSafeMessageTypedData(rpcNetwork.chainId, activeSafeAddress, params.value.message))], safeRequestContext: { message: { text: params.value.message, isTypedData: false } }, mapResult: 'safeMessage', message: params.value.message, safeAddress, chainId: rpcNetwork.chainId.toString() }
		}
		case 'signTypedMessage': {
			const params = funtypes.ReadonlyObject({ typedData: JsonValue }).safeParse(request.params)
			if (!params.success) throw gnosisSafeAppsPolicyError('Gnosis Safe Apps signTypedMessage params must contain EIP-712 typedData.')
			const message = JSON.stringify(params.value.typedData, undefined, 2)
			if (message.length > 100_000) throw gnosisSafeAppsPolicyError('The Gnosis Safe typed message exceeds 100000 characters.')
			if (!offChainSigning) return createOnChainMessageCommand(safeAddress, message, true)
			const typedData = createGnosisSafeMessageTypedData(rpcNetwork.chainId, activeSafeAddress, message, true)
			return { kind: 'ethereumRequest', method: 'eth_signTypedData_v4', params: [safeAddress, JSON.stringify(typedData)], safeRequestContext: { message: { text: message, isTypedData: true } }, mapResult: 'safeMessage', message, isTypedData: true, safeAddress, chainId: rpcNetwork.chainId.toString() }
		}
		case 'submitOffChainMessage': {
			if (services.mode === 'simulation') throw gnosisSafeAppsPolicyError('Off-chain Gnosis Safe message services are unavailable in simulation mode. Disable off-chain signing in the app to simulate an on-chain message approval.')
			const params = GnosisSafeSubmitMessageParams.safeParse(request.params)
			if (!params.success || params.value.safeAddress !== safeAddress || params.value.chainId !== rpcNetwork.chainId.toString()) throw gnosisSafeAppsPolicyError('The signed Gnosis Safe message account or chain changed. Request the message again.')
			return { kind: 'result', value: await services.messages.submit(params.value.message, params.value.signature, params.value.isTypedData) }
		}
		case 'getOffChainSignature': {
			if (services.mode === 'simulation') throw gnosisSafeAppsPolicyError('Off-chain Gnosis Safe message services are unavailable in simulation mode. Disable off-chain signing in the app to simulate an on-chain message approval.')
			if (typeof request.params !== 'string' || !/^0x[0-9a-f]{64}$/i.test(request.params)) throw gnosisSafeAppsPolicyError('Gnosis Safe Apps getOffChainSignature requires a message hash.')
			return { kind: 'result', value: await services.messages.getSignature(request.params.toLowerCase()) }
		}
		case 'getTxBySafeTxHash': {
			const params = GnosisSafeTransactionLookupParams.safeParse(request.params)
			if (!params.success) throw gnosisSafeAppsPolicyError('Gnosis Safe Apps getTxBySafeTxHash requires a 32-byte Gnosis Safe transaction hash prefixed with 0x.')
			if (services.mode === 'simulation') throw gnosisSafeAppsPolicyError('Gnosis Safe transaction services are unavailable in simulation mode.')
			return { kind: 'result', value: await services.getTransaction(params.value.safeTxHash.toLowerCase()) }
		}
		case 'getSafeBalances': {
			const params = GnosisSafeBalanceParams.safeParse(request.params === undefined ? {} : request.params)
			if (!params.success || (params.value.currency !== undefined && !/^[a-zA-Z]{3,10}$/.test(params.value.currency))) throw gnosisSafeAppsPolicyError('Gnosis Safe Apps balance currency must be a fiat currency code, such as usd or eur.')
			if (services.mode === 'simulation') throw gnosisSafeAppsPolicyError('Gnosis Safe balance services are unavailable in simulation mode.')
			return { kind: 'result', value: await services.getBalances(params.value.currency?.toLowerCase() ?? 'usd') }
		}
		case 'wallet_getPermissions': return { kind: 'result', value: [] }
		case 'wallet_requestPermissions': {
			const parsedPermissions = GnosisSafePermissionRequests.safeParse(request.params)
			if (!parsedPermissions.success) throw gnosisSafeAppsPolicyError('Gnosis Safe Apps permission request params must be an array.')
			if (parsedPermissions.value.length === 0) return { kind: 'result', value: [] }
			if (!parsedPermissions.value.every((permission) => Object.keys(permission).length > 0 && Object.keys(permission).every((key) => key === 'requestAddressBook'))) throw gnosisSafeAppsPolicyError('Unsupported Gnosis Safe Apps permission request.')
			throw gnosisSafeAppsPolicyError('Interceptor Gnosis Safe compatibility does not support the requestAddressBook permission.')
		}
		case 'rpcCall': {
			const settingCall = GnosisSafeRpcCall.safeParse(request.params)
			if (settingCall.success && settingCall.value.call === 'safe_setSettings') {
				const settings = funtypes.ReadonlyTuple(funtypes.ReadonlyRecord(funtypes.String, JsonValue).withConstraint((value) => Object.keys(value).every((key) => key === 'offChainSigning')).And(funtypes.ReadonlyObject({ offChainSigning: funtypes.Boolean }))).safeParse(settingCall.value.params)
				if (!settings.success) throw gnosisSafeAppsPolicyError('safe_setSettings requires exactly one settings object with a boolean offChainSigning field.')
				return { kind: 'settings', offChainSigning: settings.value[0].offChainSigning }
			}
			const rpcCall = parseRpcCall(request.params)
			if (rpcCall.method === 'wallet_getPermissions' || rpcCall.method === 'wallet_requestPermissions') {
				return await getGnosisSafeAppsRequestCommand({ method: rpcCall.method, params: rpcCall.params }, websiteOrigin, activeSafeAddress, rpcNetwork, getGnosisSafeContractState, services)
			}
			return { kind: 'ethereumRequest', ...rpcCall, mapResult: 'passthrough' }
		}
		case 'sendTransactions': {
			const { transaction, batch } = parseGnosisSafeTransaction(request.params, safeAddress)
			return { kind: 'ethereumRequest', method: 'eth_sendTransaction', params: [transaction], safeRequestContext: { operation: batch ? 1 : 0 }, mapResult: 'safeTxHash' }
		}
		default: throw gnosisSafeAppsPolicyError(`Unsupported Gnosis Safe Apps method: ${ request.method }.`)
	}
}
