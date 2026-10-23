export type SignerExecutionAuthority = {
	readonly websiteOrigin: string
	readonly documentGeneration: string
	readonly mode: 'pending' | 'blocked' | 'legacy' | 'eip6963'
	readonly providerUuid: string | undefined
	readonly eligibleSocketKeys: Set<string>
	readonly authorizedSocketKeys: Set<string>
}

export type SignerExecutionAuthorityState = {
	readonly authoritativeTopSocketKeys: Map<number, string>
	readonly signerExecutionAuthorities: Map<number, SignerExecutionAuthority>
	readonly currentChildSocketKeysByTab: Map<number, Map<number, string>>
	readonly childFrameIdsBySocketKey: Map<string, number>
	readonly pendingChildSocketRemovalTimers: Map<string, ReturnType<typeof setTimeout>>
}
