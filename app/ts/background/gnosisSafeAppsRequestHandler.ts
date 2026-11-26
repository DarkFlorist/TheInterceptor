import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { isGnosisSafeAppsConnectionEligibleForAdmittedAddress } from './gnosisSafeAppsConnectionEligibility.js'
import { getCurrentSimulationInput, prepareSimulationInputForRpc } from './simulationUpdating.js'
import type { SimulationServicesSnapshot } from './simulationServicesOwner.js'
import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { RpcRequestContext } from '../types/confirmationRequest.js'
import type { InterceptedRequestForward, Settings } from '../types/interceptor-messages.js'
import type { Website } from '../types/websiteAccessTypes.js'
import type { InterceptedRequest } from '../utils/requests.js'
import { getGnosisSafeAppsExecution } from '../gnosisSafe/gnosisSafeAppsExecution.js'
import { getGnosisSafeContractState, isGnosisSafeContractValidationFailure, isGnosisSafeOwnerValidationFailure } from '../gnosisSafe/gnosisSafeCore.js'
import { fetchGnosisSafeAppsBalances } from './gnosisSafeAppsBalances.js'
import { createGnosisSafeAppsMessageServices } from './gnosisSafeAppsMessages.js'
import { getGnosisSafeAppsRequestCommand, isGnosisSafeAppsRequestPolicyError } from './gnosisSafeAppsRequestPolicy.js'
import { fetchGnosisSafeAppsTransaction } from './gnosisSafeAppsTransactions.js'
import { getGnosisSafeAppsCompatibilityMode } from './settings.js'

type GnosisSafeAppsAdmission = { readonly kind: 'execute', readonly context: RpcRequestContext } | { readonly kind: 'reply', readonly reply: InterceptedRequestForward }

// Admission owns the secondary protocol; execution rejoins the shared RPC policy and confirmation pipeline.
export async function prepareGnosisSafeAppsRequest(services: SimulationServicesSnapshot, connections: WebsiteTabConnections, request: InterceptedRequest, website: Website, activeAddress: AddressBookEntry, settings: Settings, safeSigningMode: boolean): Promise<GnosisSafeAppsAdmission> {
	const { ethereum, gnosisSafeAppsSimulationMetadata } = services
	const reply = (message: InterceptedRequestForward): GnosisSafeAppsAdmission => ({ kind: 'reply', reply: message })
	const failure = (code: number, message: string) => reply({ type: 'result', method: 'safe_apps_request', uniqueRequestIdentifier: request.uniqueRequestIdentifier, error: { code, message } })
	const enabled = await getGnosisSafeAppsCompatibilityMode()
	const connectionEligible = enabled && isGnosisSafeAppsConnectionEligibleForAdmittedAddress(connections, request.uniqueRequestIdentifier.requestSocket, settings, { activeAddress, safeSigningMode })
	if (!connectionEligible) return failure(-32602, 'Interceptor Gnosis Safe Apps compatibility is not enabled for this connection.')
	try {
		const execution = getGnosisSafeAppsExecution(request)
		if (execution !== undefined) return { kind: 'execute', context: execution }
		const safeAddress = activeAddress.address
		const chainId = settings.activeRpcNetwork.chainId
		const command = await getGnosisSafeAppsRequestCommand('params' in request ? request.params?.[0] : undefined, website.websiteOrigin, safeAddress, settings.activeRpcNetwork, async () => settings.simulationMode ? await gnosisSafeAppsSimulationMetadata.getContractState(safeAddress, await getCurrentSimulationInput(undefined, settings), prepareSimulationInputForRpc) : await getGnosisSafeContractState(ethereum, safeAddress), settings.simulationMode ? { mode: 'simulation' } : {
			mode: 'signing',
			messages: createGnosisSafeAppsMessageServices(ethereum, safeAddress, chainId),
			getBalances: async (currency: string) => await fetchGnosisSafeAppsBalances(chainId, safeAddress, currency),
			getTransaction: async (safeTxHash: string) => await fetchGnosisSafeAppsTransaction(chainId, safeAddress, safeTxHash),
		})
		const result = command.kind === 'settings' ? { kind: 'result' as const, value: { offChainSigning: command.offChainSigning } } : command
		return reply({ type: 'result', method: 'safe_apps_request', result, uniqueRequestIdentifier: request.uniqueRequestIdentifier })
	} catch (error: unknown) {
		if (isGnosisSafeAppsRequestPolicyError(error)) return failure(-32602, error.message)
		if (isGnosisSafeContractValidationFailure(error) || isGnosisSafeOwnerValidationFailure(error)) return failure(-32000, error.message)
		throw error
	}
}
