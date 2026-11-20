// Its own module so that each provider and the registry in revertReasonHints.ts both import it, and providers never depend on the registry that lists them.
export type RevertReasonHintProvider = {
	protocolName: string
	// Receives a decoded Error(string) revert reason and returns an explanation only for reasons the protocol is known to use.
	explainRevertReason: (revertReason: string) => string | undefined
}
