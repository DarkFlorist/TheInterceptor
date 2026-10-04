import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { RpcRequestContext } from '../types/confirmationRequest.js'
import type { InterceptedRequestForward, Settings } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { Website } from '../types/websiteAccessTypes.js'
import type { InterceptedRequest } from '../utils/requests.js'
import { getSafeAppsExecution } from '../safe/safeAppsExecution.js'
import { getSafeContractState, isSafeContractValidationFailure, isSafeOwnerValidationFailure } from '../safe/safeCore.js'
import { fetchSafeAppsBalances } from './safeAppsBalances.js'
import { isSafeAppsConnectionEligible } from './safeAppsCompatibilityCoordinator.js'
import { createSafeAppsMessageServices } from './safeAppsMessages.js'
import { getSafeAppsRequestCommand, isSafeAppsRequestPolicyError } from './safeAppsRequestPolicy.js'
import { fetchSafeAppsTransaction } from './safeAppsTransactions.js'
import { getSafeAppsCompatibilityMode } from './settings.js'

type SafeAppsAdmission = { readonly kind: 'execute', readonly context: RpcRequestContext } | { readonly kind: 'reply', readonly reply: InterceptedRequestForward }

// Admission owns the secondary protocol; execution rejoins the shared RPC policy and confirmation pipeline.
export async function prepareSafeAppsRequest(ethereum: EthereumClientService, connections: WebsiteTabConnections, request: InterceptedRequest, website: Website, activeAddress: AddressBookEntry, settings: Settings, safeSigningMode: boolean): Promise<SafeAppsAdmission> {
	const reply = (message: InterceptedRequestForward): SafeAppsAdmission => ({ kind: 'reply', reply: message })
	const failure = (code: number, message: string) => reply({ type: 'result', method: 'safe_apps_request', uniqueRequestIdentifier: request.uniqueRequestIdentifier, error: { code, message } })
	const enabled = await getSafeAppsCompatibilityMode()
	const eligible = enabled && safeSigningMode && await isSafeAppsConnectionEligible(connections, request.uniqueRequestIdentifier.requestSocket, settings)
	if (!eligible) return failure(-32602, 'Interceptor Safe Apps compatibility is not enabled for this connection.')
	try {
		const execution = getSafeAppsExecution(request)
		if (execution !== undefined) return { kind: 'execute', context: execution }
		const safeAddress = activeAddress.address
		const chainId = settings.activeRpcNetwork.chainId
		const command = await getSafeAppsRequestCommand('params' in request ? request.params?.[0] : undefined, website.websiteOrigin, safeAddress, settings.activeRpcNetwork, async () => await getSafeContractState(ethereum, safeAddress), {
			messages: createSafeAppsMessageServices(ethereum, safeAddress, chainId),
			getBalances: async (currency) => await fetchSafeAppsBalances(chainId, safeAddress, currency),
			getTransaction: async (safeTxHash) => await fetchSafeAppsTransaction(chainId, safeAddress, safeTxHash),
		})
		const result = command.kind === 'settings' ? { kind: 'result' as const, value: { offChainSigning: command.offChainSigning } } : command
		return reply({ type: 'result', method: 'safe_apps_request', result, uniqueRequestIdentifier: request.uniqueRequestIdentifier })
	} catch (error: unknown) {
		if (isSafeAppsRequestPolicyError(error)) return failure(-32602, error.message)
		if (isSafeContractValidationFailure(error) || isSafeOwnerValidationFailure(error)) return failure(-32000, error.message)
		throw error
	}
}
