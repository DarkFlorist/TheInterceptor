import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { RpcRequestContext } from '../types/confirmationRequest.js'
import type { InterceptedRequestForward, Settings } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { Website } from '../types/websiteAccessTypes.js'
import type { InterceptedRequest } from '../utils/requests.js'
import { getGnosisSafeAppsExecution } from '../gnosisSafe/gnosisSafeAppsExecution.js'
import { getGnosisSafeContractState, isGnosisSafeContractValidationFailure, isGnosisSafeOwnerValidationFailure } from '../gnosisSafe/gnosisSafeCore.js'
import { fetchGnosisSafeAppsBalances } from './gnosisSafeAppsBalances.js'
import { isGnosisSafeAppsConnectionEligible } from './gnosisSafeAppsCompatibilityCoordinator.js'
import { createGnosisSafeAppsMessageServices } from './gnosisSafeAppsMessages.js'
import { getGnosisSafeAppsRequestCommand, isGnosisSafeAppsRequestPolicyError } from './gnosisSafeAppsRequestPolicy.js'
import { fetchGnosisSafeAppsTransaction } from './gnosisSafeAppsTransactions.js'
import { getGnosisSafeAppsCompatibilityMode } from './settings.js'

type GnosisSafeAppsAdmission = { readonly kind: 'execute', readonly context: RpcRequestContext } | { readonly kind: 'reply', readonly reply: InterceptedRequestForward }

// Admission owns the secondary protocol; execution rejoins the shared RPC policy and confirmation pipeline.
export async function prepareGnosisSafeAppsRequest(ethereum: EthereumClientService, connections: WebsiteTabConnections, request: InterceptedRequest, website: Website, activeAddress: AddressBookEntry, settings: Settings, safeSigningMode: boolean): Promise<GnosisSafeAppsAdmission> {
	const reply = (message: InterceptedRequestForward): GnosisSafeAppsAdmission => ({ kind: 'reply', reply: message })
	const failure = (code: number, message: string) => reply({ type: 'result', method: 'safe_apps_request', uniqueRequestIdentifier: request.uniqueRequestIdentifier, error: { code, message } })
	const enabled = await getGnosisSafeAppsCompatibilityMode()
	const eligible = enabled && safeSigningMode && await isGnosisSafeAppsConnectionEligible(connections, request.uniqueRequestIdentifier.requestSocket, settings)
	if (!eligible) return failure(-32602, 'Interceptor Gnosis Safe Apps compatibility is not enabled for this connection.')
	try {
		const execution = getGnosisSafeAppsExecution(request)
		if (execution !== undefined) return { kind: 'execute', context: execution }
		const safeAddress = activeAddress.address
		const chainId = settings.activeRpcNetwork.chainId
		const command = await getGnosisSafeAppsRequestCommand('params' in request ? request.params?.[0] : undefined, website.websiteOrigin, safeAddress, settings.activeRpcNetwork, async () => await getGnosisSafeContractState(ethereum, safeAddress), {
			messages: createGnosisSafeAppsMessageServices(ethereum, safeAddress, chainId),
			getBalances: async (currency) => await fetchGnosisSafeAppsBalances(chainId, safeAddress, currency),
			getTransaction: async (safeTxHash) => await fetchGnosisSafeAppsTransaction(chainId, safeAddress, safeTxHash),
		})
		const result = command.kind === 'settings' ? { kind: 'result' as const, value: { offChainSigning: command.offChainSigning } } : command
		return reply({ type: 'result', method: 'safe_apps_request', result, uniqueRequestIdentifier: request.uniqueRequestIdentifier })
	} catch (error: unknown) {
		if (isGnosisSafeAppsRequestPolicyError(error)) return failure(-32602, error.message)
		if (isGnosisSafeContractValidationFailure(error) || isGnosisSafeOwnerValidationFailure(error)) return failure(-32000, error.message)
		throw error
	}
}
