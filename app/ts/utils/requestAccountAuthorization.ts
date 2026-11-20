// Account binding is shared by connection admission, request preparation and wallet delivery. An omitted request account means the authorized account; an absent authorized account never grants signing authority.
export function isAccountBoundToAddress(requested: bigint | undefined, authorized: bigint | undefined): boolean {
	return authorized !== undefined && (requested === undefined || requested === authorized)
}

export type RequestAccountBinding = {
	readonly websiteAccount: bigint | undefined
	// A Safe execution is reviewed from its executor while website approval stays bound to the original Safe. These are distinct roles, checked by the same account rule.
	readonly transactionSender?: { readonly requested: bigint, readonly authorized: bigint }
}

type ConnectionApproval = { readonly approved: boolean, readonly approvedAddress?: bigint }

export const WEBSITE_CONNECTION_INTERRUPTED_MESSAGE = 'The website connection was interrupted before the request reached your wallet. Reload the website and try again.'

export function getRequestAccountAuthorizationFailure(connection: ConnectionApproval | undefined, binding: RequestAccountBinding): string | undefined {
	if (connection?.approved !== true || (binding.websiteAccount !== undefined && !isAccountBoundToAddress(binding.websiteAccount, connection.approvedAddress))) return WEBSITE_CONNECTION_INTERRUPTED_MESSAGE
	if (binding.transactionSender !== undefined && !isAccountBoundToAddress(binding.transactionSender.requested, binding.transactionSender.authorized)) return 'The reviewed transaction sender is not the active authorized account. Reject this request and send it again from the active account.'
	return undefined
}
