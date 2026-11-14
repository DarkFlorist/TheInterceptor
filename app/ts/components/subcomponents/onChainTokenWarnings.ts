import { getUnverifiedOnChainTokenLabel, type OnChainTokenEntry } from '../../utils/onChainTokenMetadata.js'
import { assertNever } from '../../utils/typescript.js'

export const ON_CHAIN_TOKEN_METADATA_WARNING = 'The name and symbol for this token was provided by the token itself and we have not validated its legitimacy. A token may claim to have a name/symbol that is the same as another popular token (e.g., USDC or DAI) in an attempt to trick you. If you recognize this token\'s name, please verify elsewhere that this is the correct address for it.'

export const ON_CHAIN_TOKEN_IDENTITY_WARNING = 'This token was discovered on-chain and has not been verified by you or The Interceptor. Please verify elsewhere that this is the correct address for it.'

// Message for the warning sign on token cards, matching what the card shows: token-provided metadata gets the impersonation warning, while an address-only label only says the token is unverified. The switch is exhaustive, so a new kind of unverified label fails to compile until it gets a message.
export function getOnChainTokenWarning(entry: OnChainTokenEntry) {
	const unverifiedLabel = getUnverifiedOnChainTokenLabel(entry)
	switch (unverifiedLabel) {
		case 'tokenProvidedNameAndSymbol': return ON_CHAIN_TOKEN_METADATA_WARNING
		case 'addressOnly': return ON_CHAIN_TOKEN_IDENTITY_WARNING
		case undefined: return undefined
		default: return assertNever(unverifiedLabel)
	}
}
