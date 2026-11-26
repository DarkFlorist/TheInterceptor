import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { InterceptedRequest, WebsiteSocket } from '../utils/requests.js'

// Borrowed authority must provide a real captured-authority revalidation gate. Ordinary connection authority is checked by the shared access policy; it does not pretend to capture a separate authority.
type RequestAccessAuthority =
	| { readonly requireAddressAccess: false }
	| { readonly requireAddressAccess: true, readonly isCurrent: (settings: Settings) => Promise<boolean> }

// Permission authority can differ from reply identity. The request's real socket still owns replies, signer state and any interactive approval; an effective access context never replaces it.
export type RequestAccessContext = RequestAccessAuthority & {
	readonly activeAddress: AddressBookEntry | undefined
	readonly accessSocket: WebsiteSocket
	readonly accessOrigin: string
}

export type AddressedRequestAccessContext = RequestAccessContext & { readonly activeAddress: AddressBookEntry }

export function hasRequestAccessAddress(context: RequestAccessContext): context is AddressedRequestAccessContext {
	return context.activeAddress !== undefined
}

export type RequestAccessContextOwner = {
	readonly method: string
	readonly resolve: (connections: WebsiteTabConnections, request: InterceptedRequest, settings: Settings) => Promise<RequestAccessContext | undefined>
}

// Composition selects admission owners; this shared resolver has no feature dependencies. Unrelated requests do not invoke feature admission or native-host discovery.
export function createRequestAccessContextResolver(owners: readonly RequestAccessContextOwner[]) {
	const byMethod = new Map(owners.map((owner) => [owner.method, owner.resolve]))
	return async (connections: WebsiteTabConnections, socket: WebsiteSocket, request: InterceptedRequest, settings: Settings, websiteOrigin: string, resolveOrdinaryAddress: () => Promise<AddressBookEntry | undefined>): Promise<RequestAccessContext> => {
		const resolve = byMethod.get(request.method)
		const admitted = await resolve?.(connections, request, settings)
		return admitted ?? { activeAddress: await resolveOrdinaryAddress(), accessSocket: socket, accessOrigin: websiteOrigin, requireAddressAccess: false }
	}
}
