export const isPublicGnosisSafeAppsMethod = (method: string) => new Set(['getEnvironmentInfo', 'getChainInfo', 'getSafeInfo', 'signMessage', 'signTypedMessage', 'getOffChainSignature', 'getTxBySafeTxHash', 'getSafeBalances', 'wallet_getPermissions', 'wallet_requestPermissions', 'rpcCall', 'sendTransactions']).has(method)

import type { GnosisSafeAppsRequest } from './gnosisSafeAppsProtocol.js'

type EthereumRequest = (request: { readonly method: string, readonly params?: readonly unknown[] }) => Promise<unknown>
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null
type GnosisSafeAppsCommandCandidate = { readonly kind?: unknown, readonly value?: unknown, readonly method?: unknown, readonly params?: readonly unknown[], readonly mapResult?: unknown, readonly message?: unknown, readonly isTypedData?: unknown, readonly safeAddress?: unknown, readonly chainId?: unknown, readonly safeRequestContext?: unknown, readonly commandToken?: unknown }

const isGnosisSafeAppsCommandCandidate = (value: unknown): value is GnosisSafeAppsCommandCandidate => isRecord(value)

async function executeGnosisSafeAppsCommand(command: unknown, requestEthereum: EthereumRequest, requestSafeApps: (request: Pick<GnosisSafeAppsRequest, 'method' | 'params'>) => Promise<unknown>): Promise<unknown> {
	if (!isGnosisSafeAppsCommandCandidate(command) || (command.kind !== 'result' && command.kind !== 'ethereumRequest')) throw new Error('Interceptor returned an invalid Gnosis Safe Apps command.')
	if (command.kind === 'result') return command.value
	if (typeof command.method !== 'string' || !Array.isArray(command.params) || (command.mapResult !== 'passthrough' && command.mapResult !== 'safeTxHash' && command.mapResult !== 'safeMessage')) throw new Error('Interceptor returned an invalid Gnosis Safe Apps Ethereum request.')
	if (command.mapResult === 'safeMessage' && (typeof command.message !== 'string' || typeof command.safeAddress !== 'string' || typeof command.chainId !== 'string')) throw new Error('Interceptor returned an invalid Gnosis Safe message request.')
	const result = command.safeRequestContext === undefined
		? await requestEthereum({ method: command.method, params: command.params })
		: await requestSafeApps({ method: 'execute', params: command })
	if (command.mapResult === 'passthrough') return result
	if (command.mapResult === 'safeMessage') {
		if (typeof result !== 'string' || !/^0x[0-9a-f]{130}$/i.test(result)) throw new Error('Interceptor returned an invalid Gnosis Safe owner signature.')
		const submitted = await requestSafeApps({ method: 'submitOffChainMessage', params: { commandToken: command.commandToken, message: command.message, signature: result, safeAddress: command.safeAddress, chainId: command.chainId, ...(command.isTypedData === true ? { isTypedData: true } : {}) } })
		if (!isGnosisSafeAppsCommandCandidate(submitted) || submitted.kind !== 'result') throw new Error('Interceptor returned an invalid Gnosis Safe message submission response.')
		return submitted.value
	}
	if (typeof result !== 'string') throw new Error('Interceptor returned an invalid transaction hash.')
	return { safeTxHash: result }
}

export function createGnosisSafeAppsRequestHandler(requestBackground: (request: unknown) => Promise<unknown>, requestEthereum: EthereumRequest) {
	let offChainSigning = true
	return async (request: Pick<GnosisSafeAppsRequest, 'method' | 'params'>) => {
		if (!isPublicGnosisSafeAppsMethod(request.method)) throw new Error('Unsupported public Gnosis Safe Apps method.')
		const signingRequest = request.method === 'signMessage' || request.method === 'signTypedMessage'
		const command = await requestBackground({ method: request.method, ...(request.params === undefined ? {} : { params: request.params }), ...(signingRequest ? { offChainSigning } : {}) })
		const result = await executeGnosisSafeAppsCommand(command, requestEthereum, requestBackground)
		if (request.method === 'rpcCall' && isRecord(request.params)) {
			const { call } = request.params
			if (call === 'safe_setSettings') {
				if (!isRecord(result)) throw new Error('Interceptor returned invalid Gnosis Safe Apps settings.')
				const { offChainSigning: updated } = result
				if (typeof updated !== 'boolean') throw new Error('Interceptor returned invalid Gnosis Safe Apps settings.')
				offChainSigning = updated
			}
		}
		return result
	}
}

