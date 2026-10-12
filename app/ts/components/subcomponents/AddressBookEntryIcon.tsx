import type { AddressBookEntry, EntrySource } from '../../types/addressBookTypes.js'
import { addressString } from '../../utils/bigint.js'
import { keccak256 } from '../../utils/ethereumPrimitives.js'
import { assertNever } from '../../utils/typescript.js'
import { Blockie } from './SVGBlockie.js'

// More than two characters become illegible inside a 1em icon, so longer symbols are cut to their first two letters or digits
const MAX_TICKER_ICON_CHARACTERS = 2

// Fixed saturation and lightness keep the black ticker text above 8:1 contrast for every hue, and the circle above 3.5:1 against the dark card backgrounds
const TICKER_ICON_SATURATION_AND_LIGHTNESS = '60%, 75%'

// Only symbols the user has reviewed and saved (address book edits, approved wallet_watchAsset requests) or that ship with The Interceptor may replace the Blockie, because OnChain and FilledIn symbols are unreviewed contract or placeholder data, and a token that reuses another token's symbol must not also get a look-alike icon
function isTrustedTokenSymbolSource(entrySource: EntrySource) {
	switch (entrySource) {
		case 'User':
		case 'DarkFloristMetadata':
		case 'Interceptor': return true
		case 'OnChain':
		case 'FilledIn': return false
		default: return assertNever(entrySource)
	}
}

// Only ASCII letters and digits are kept so emoji, punctuation, invisible or combining characters never reach the icon and every glyph fits it predictably
function getTickerIconText(symbol: string) {
	const tickerCharacters = (symbol.match(/[A-Za-z0-9]/gu) ?? []).slice(0, MAX_TICKER_ICON_CHARACTERS)
	if (tickerCharacters.length === 0) return undefined
	return tickerCharacters.join('').toUpperCase()
}

function getTrustedTokenTickerIconText(addressBookEntry: AddressBookEntry) {
	if (addressBookEntry.type !== 'ERC20' && addressBookEntry.type !== 'ERC721' && addressBookEntry.type !== 'ERC1155') return undefined
	if (!isTrustedTokenSymbolSource(addressBookEntry.entrySource)) return undefined
	return getTickerIconText(addressBookEntry.symbol)
}

// The hue comes from the address hash so tokens sharing a symbol still look different, and vanity addresses with shared leading bytes spread across the hue wheel
function getTickerIconBackgroundColor(address: bigint) {
	const addressHashPrefix = Number.parseInt(keccak256(addressString(address)).slice(2, 6), 16)
	const hue = Math.floor(addressHashPrefix * 360 / 0x10000)
	return `hsl(${ hue }, ${ TICKER_ICON_SATURATION_AND_LIGHTNESS })`
}

// The letters are drawn by the token-ticker-icon CSS from the data attribute, so they never become text that is copied or read together with the token label next to the icon
function TokenTickerIcon({ address, tickerText }: { address: bigint, tickerText: string }) {
	const className = tickerText.length === 1 ? 'token-ticker-icon token-ticker-icon--single-character' : 'token-ticker-icon'
	return <span class = { className } data-ticker-text = { tickerText } style = { { backgroundColor: getTickerIconBackgroundColor(address) } } />
}

// Shows the entry logo when one exists, a ticker icon for tokens whose symbol comes from a trusted source, and the address-derived Blockie otherwise
export function AddressBookEntryIcon({ addressBookEntry }: { addressBookEntry: AddressBookEntry }) {
	if (addressBookEntry.logoUri !== undefined) return <img style = { { minWidth: '1em', minHeight: '1em' } } width = '16' height = '16' src = { addressBookEntry.logoUri } />
	const tickerText = getTrustedTokenTickerIconText(addressBookEntry)
	if (tickerText === undefined) return <Blockie address = { addressBookEntry.address } />
	return <TokenTickerIcon address = { addressBookEntry.address } tickerText = { tickerText } />
}
