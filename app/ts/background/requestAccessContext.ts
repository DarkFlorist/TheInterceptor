import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { InterceptedRequest, WebsiteSocket } from '../utils/requests.js'
import { getSiteReadRequestAccessContext } from './siteReadRequestAdmission.js'

// Permission authority can differ from reply identity. The request's real socket still owns replies, signer state and any interactive approval; an effective access context never replaces it.
export type RequestAccessContext = {
	readonly activeAddress: AddressBookEntry | undefined
	readonly accessSocket: WebsiteSocket
	readonly accessOrigin: string
	// A missing address denies access; an existing one requires its current stored grant even on an approved connection.
	readonly requireAddressAccess: boolean
	// Validate the captured permission authority after asynchronous work, without selecting another source or address.
	readonly isCurrent: (settings: Settings) => Promise<boolean>
}

export type AddressedRequestAccessContext = RequestAccessContext & { readonly activeAddress: AddressBookEntry }

export function hasRequestAccessAddress(context: RequestAccessContext): context is AddressedRequestAccessContext {
	return context.activeAddress !== undefined
}

// Admission owners supply effective permission contexts. Ordinary account selection remains with the caller's canonical address resolver, including when no admission owner handles the request.
export async function resolveRequestAccessContext(connections: WebsiteTabConnections, socket: WebsiteSocket, request: InterceptedRequest, settings: Settings, websiteOrigin: string, resolveOrdinaryAddress: () => Promise<AddressBookEntry | undefined>): Promise<RequestAccessContext> {
	return await getSiteReadRequestAccessContext(connections, request, settings) ?? { activeAddress: await resolveOrdinaryAddress(), accessSocket: socket, accessOrigin: websiteOrigin, requireAddressAccess: false, isCurrent: async () => true }
}
