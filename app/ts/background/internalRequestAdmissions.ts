import type { InternalProviderAdmissionMethod } from '../../shared/ts/internalProviderMethods.js'
import type { RpcRequestContext } from '../types/confirmationRequest.js'
import type { InterceptedRequestForward, Settings } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { Website } from '../types/websiteAccessTypes.js'
import type { InterceptedRequest } from '../utils/requests.js'
import { prepareGnosisSafeAppsRequest } from './gnosisSafeAppsRequestHandler.js'
import type { AddressedRequestAccessContext, RequestAccessContextOwner } from './requestAccessContext.js'
import type { SimulationServicesSnapshot } from './simulationServicesOwner.js'
import { getSiteReadRequestAccessContext } from './siteReadRequestAdmission.js'
import { prepareSiteRpcRequest } from './siteRpcInterception.js'
import { hasOwnKey } from '../utils/typescript.js'

type AdmissionInput = {
	readonly services: SimulationServicesSnapshot
	readonly connections: WebsiteTabConnections
	readonly request: InterceptedRequest
	readonly website: Website
	readonly settings: Settings
	readonly accessContext: AddressedRequestAccessContext
	readonly safeSigningMode: boolean
}
type Admission = { readonly kind: 'execute', readonly context: RpcRequestContext } | { readonly kind: 'reply', readonly reply: InterceptedRequestForward }
type InternalRequestAdmission = {
	readonly prepare: (input: AdmissionInput) => Promise<Admission>
	readonly resolveAccess: RequestAccessContextOwner['resolve']
}

// The shared internal-method inventory makes this table exhaustive. Each protocol owns both admission and access resolution; SDK and hosted HTTP policies remain separate.
export const internalRequestAdmissions = {
	safe_apps_request: {
		prepare: ({ services, connections, request, website, accessContext, settings, safeSigningMode }) => prepareGnosisSafeAppsRequest(services, connections, request, website, accessContext.activeAddress, settings, safeSigningMode),
		resolveAccess: async () => undefined,
	},
	site_rpc_request: {
		prepare: ({ services, connections, request, settings, accessContext }) => prepareSiteRpcRequest(services.ethereum, connections, request, settings, accessContext),
		resolveAccess: getSiteReadRequestAccessContext,
	},
} satisfies Readonly<Record<InternalProviderAdmissionMethod, InternalRequestAdmission>>

export function getInternalRequestAdmission(method: string): InternalRequestAdmission | undefined {
	return hasOwnKey(internalRequestAdmissions, method) ? internalRequestAdmissions[method] : undefined
}

export const internalRequestAccessContextOwners: readonly RequestAccessContextOwner[] = Object.entries(internalRequestAdmissions).map(([method, owner]) => ({ method, resolve: owner.resolveAccess }))
