import { stringToAddress } from './bigint.js'
import { getAddress } from './ethereumPrimitives.js'

// EIP-3770 chain-specific addresses are written as `<shortName>:<address>`, for example `eth:0x...` copied from Safe{Wallet}: https://eips.ethereum.org/EIPS/eip-3770
// Short names use the ethereum-lists/chains `shortName` pattern `^[A-Za-z0-9-_]{1,64}$`, and the address must follow the colon directly: https://github.com/ethereum-lists/chains/blob/master/tools/schema/chainSchema.json
// A full address also matches that pattern but is never a chain short name, so `0x<address>:...` is not treated as a prefix and cannot silently resolve to the second address.
const EIP3770_CHAIN_SHORT_NAME_PREFIX = /^(?!0x[0-9a-fA-F]{40}:)[-_a-zA-Z0-9]{1,64}:(?!\s)/u

// The short name is only checked for valid syntax. The Interceptor has no short-name-to-chain-ID registry, so the prefix is discarded instead of being compared with the selected chain.
function trimAndRemoveEip3770ChainShortName(userEnteredAddress: string) {
	return userEnteredAddress.trim().replace(EIP3770_CHAIN_SHORT_NAME_PREFIX, '')
}

// Parses an address typed or pasted by the user. Accepts `0x...` and EIP-3770 `<shortName>:0x...`, with the same checksum rules as `stringToAddress`.
export function parseUserEnteredAddress(userEnteredAddress: string | undefined) {
	if (userEnteredAddress === undefined) return undefined
	return stringToAddress(trimAndRemoveEip3770ChainShortName(userEnteredAddress))
}

export function getIssueWithUserEnteredAddress(userEnteredAddress: string): string | undefined {
	const address = trimAndRemoveEip3770ChainShortName(userEnteredAddress)
	// A colon left after removing the short name means the prefix was not a valid short name directly followed by the address.
	if (address.includes(':')) return 'Chain prefix must be an EIP-3770 short name followed directly by the address (e.g. eth:0x...).'
	return getIssueWithAddressString(address)
}

// Free-text search queries are kept as typed unless the whole query is an address, so a pasted `eth:0x...` finds the same entries as `0x...`.
export function removeEip3770ChainShortNameFromSearchQuery(searchQuery: string) {
	if (parseUserEnteredAddress(searchQuery) === undefined) return searchQuery
	return trimAndRemoveEip3770ChainShortName(searchQuery)
}

export function getIssueWithAddressString(address: string): string | undefined {
	if (address.length > 42) return 'Address is too long.'
	if (address.length > 2 && address.substring(0, 2) !== '0x') return 'Address does not contain 0x prefix.'
	if (address.length < 42) return 'Address is too short.'

	if (address.match(/^(0x)?[0-9a-fA-F]{40}$/)) {
		const checkSummedAddress = getAddress(address.toLowerCase())
		const addressBody = address.slice(2)
		const isUniformlyCased = addressBody === addressBody.toLowerCase() || addressBody === addressBody.toUpperCase()

		// It is a checksummed address with a bad checksum
		if (checkSummedAddress !== address && !isUniformlyCased) {
			return `Bad address checksum, did you mean ${ checkSummedAddress } ?`
		}
	} else {
		return 'Address contains invalid characters.'
	}

	return undefined
}
