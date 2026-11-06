/** Shared wire grammar; callers decide whether to normalize accepted values. */
export function isUuidV4(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

export function isProviderRdns(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 253 && /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/u.test(value)
}

/** Persistent provider identity shared by background admission and page-world forwarding. UUIDs are session-local. */
export function getBrowserProviderId(signerName: string, identity?: { readonly rdns?: string, readonly ambiguous?: boolean }) {
	if (identity?.ambiguous) return undefined
	return identity?.rdns === undefined ? `legacy:${ signerName }` : `eip6963:${ identity.rdns }`
}
