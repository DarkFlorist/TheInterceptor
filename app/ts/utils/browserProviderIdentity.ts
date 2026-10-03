/** Persistent provider identity shared by background admission and page-world forwarding. UUIDs are session-local. */
export function getBrowserProviderId(signerName: string, identity?: { readonly rdns?: string, readonly ambiguous?: boolean }) {
	if (identity?.ambiguous) return undefined
	return identity?.rdns === undefined ? `legacy:${ signerName }` : `eip6963:${ identity.rdns }`
}
