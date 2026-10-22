import { uniswapV3RevertReasonHintProvider } from './uniswapV3RevertReasons.js'

export type RevertReasonHintProvider = {
	protocolName: string
	// Receives a decoded Error(string) revert reason and returns an explanation only for reasons the protocol is known to use.
	explainRevertReason: (revertReason: string) => string | undefined
}

// Adding a protocol means adding its provider here; getFailureReasonForDisplay and its callers stay unchanged.
const REVERT_REASON_HINT_PROVIDERS: readonly RevertReasonHintProvider[] = [
	uniswapV3RevertReasonHintProvider,
]

// A revert reason does not say which contract reverted, so each matching provider's explanation is labelled 'possible' and the original reason stays first.
export const appendRevertReasonHints = (providers: readonly RevertReasonHintProvider[], revertReason: string) => {
	const hints = providers.flatMap((provider) => {
		const explanation = provider.explainRevertReason(revertReason)
		return explanation === undefined ? [] : [`possible ${ provider.protocolName } error: ${ explanation }`]
	})
	if (hints.length === 0) return revertReason
	return `${ revertReason } - ${ hints.join('; ') }`
}

export const appendProtocolRevertReasonHints = (revertReason: string) => appendRevertReasonHints(REVERT_REASON_HINT_PROVIDERS, revertReason)
