import { stringToAddress } from './bigint.js'
import { getAddress } from './ethereumPrimitives.js'

// EIP-3770 chain-specific addresses are written as `<shortName>:<address>`, for example `eth:0x...` copied from Safe{Wallet}: https://eips.ethereum.org/EIPS/eip-3770
// Short names come from ethereum-lists/chains, whose schema allows `^[A-Za-z0-9-_]{1,64}$`: https://github.com/ethereum-lists/chains/blob/master/tools/schema/chainSchema.json
// That schema also allows address-like text such as `0XAb58...` or `ab58...`, so `<known address>:<other address>` could show one address first and resolve to the other. The rules below are stricter than the schema to prevent that.
const CHAIN_SHORT_NAME_CHARACTERS = /^[A-Za-z0-9_-]+$/u
// The longest registry short names that are not deprecated have 25 characters. 32 leaves room for new names while keeping 40 hex digits of an address out.
const MAX_CHAIN_SHORT_NAME_LENGTH = 32
// No registry short name has more than 5 hex digits in a row (`Bobabeam`), so a longer run is part of an address or other hex data.
const HEX_DATA_RUN = /[0-9a-f]{6,}/iu
const CHAIN_PREFIX_ISSUE = 'Chain prefix must be an EIP-3770 short name followed directly by the address (e.g. eth:0x...).'

// Every registry short name that is not deprecated passes, except `0xl3` and `0xt`, which start like an address.
function isUserEnteredChainShortName(shortName: string) {
	if (shortName.length === 0 || shortName.length > MAX_CHAIN_SHORT_NAME_LENGTH) return false
	if (!CHAIN_SHORT_NAME_CHARACTERS.test(shortName)) return false
	// `0x` in any letter case starts an address, so it never starts a short name.
	if (shortName.slice(0, 2).toLowerCase() === '0x') return false
	return !HEX_DATA_RUN.test(shortName)
}

// Returns the trimmed input without its EIP-3770 short name, or undefined when the input has a colon but not a valid short name directly followed by the address, so an invalid prefix makes the whole input invalid instead of being dropped.
function removeEip3770ChainShortName(userEnteredAddress: string) {
	const trimmed = userEnteredAddress.trim()
	const separatorIndex = trimmed.indexOf(':')
	if (separatorIndex === -1) return trimmed
	const shortName = trimmed.slice(0, separatorIndex)
	const address = trimmed.slice(separatorIndex + 1)
	if (!isUserEnteredChainShortName(shortName)) return undefined
	if (address.includes(':') || /^\s/u.test(address)) return undefined
	// The Interceptor has no short-name-to-chain-ID registry, so a valid short name is not compared with the selected chain.
	return address
}

// Parses an address typed or pasted by the user. Accepts `0x...` and EIP-3770 `<shortName>:0x...`, with the same checksum rules as `stringToAddress`.
export function parseUserEnteredAddress(userEnteredAddress: string | undefined) {
	if (userEnteredAddress === undefined) return undefined
	return stringToAddress(removeEip3770ChainShortName(userEnteredAddress))
}

export function getIssueWithUserEnteredAddress(userEnteredAddress: string): string | undefined {
	const address = removeEip3770ChainShortName(userEnteredAddress)
	if (address === undefined) return CHAIN_PREFIX_ISSUE
	return getIssueWithAddressString(address)
}

// Free-text search queries are kept as typed unless the whole query is an address, so a pasted `eth:0x...` finds the same entries as `0x...`.
export function removeEip3770ChainShortNameFromSearchQuery(searchQuery: string) {
	const address = removeEip3770ChainShortName(searchQuery)
	if (address === undefined || stringToAddress(address) === undefined) return searchQuery
	return address
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
