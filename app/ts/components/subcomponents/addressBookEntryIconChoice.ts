import type { AddressBookEntry, EntrySource } from '../../types/addressBookTypes.js'
import { assertNever } from '../../utils/typescript.js'

// More than two characters become illegible inside a 1em icon, so longer symbols are cut to their first two letters or digits
const MAX_TICKER_CHARACTERS = 2

export type AddressBookEntryIconChoice =
	| { readonly kind: 'logo', readonly logoUri: string }
	| { readonly kind: 'curatedTicker', readonly tickerText: string }
	| { readonly kind: 'blockieWithTicker', readonly tickerText: string }
	| { readonly kind: 'blockie' }

// How much each entry source is trusted to put its token symbol into the icon, see chooseAddressBookEntryIcon
function getTokenSymbolIconKind(entrySource: EntrySource): Exclude<AddressBookEntryIconChoice['kind'], 'logo'> {
	switch (entrySource) {
		case 'DarkFloristMetadata':
		case 'Interceptor': return 'curatedTicker'
		case 'User': return 'blockieWithTicker'
		case 'OnChain':
		case 'FilledIn': return 'blockie'
		default: return assertNever(entrySource)
	}
}

// Only ASCII letters and digits are kept so emoji, punctuation, invisible or combining characters never reach the icon and every glyph fits it predictably
function getTickerText(symbol: string) {
	const tickerCharacters = (symbol.match(/[A-Za-z0-9]/gu) ?? []).slice(0, MAX_TICKER_CHARACTERS)
	if (tickerCharacters.length === 0) return undefined
	return tickerCharacters.join('').toUpperCase()
}

// Decides how an address book entry is drawn: its logo when it has one, otherwise a token ticker as far as the entry source is trusted, otherwise the address Blockie. Curated symbols ship with The Interceptor, so their ticker icon may replace the Blockie. User symbols may come from the token contract through wallet_watchAsset, and the 16 bit hue of a ticker icon is no address fingerprint, so they are drawn over the unchanged address Blockie instead, which a token copying another token's symbol cannot also copy. OnChain and FilledIn symbols are unreviewed contract or placeholder data and only get the plain Blockie
export function chooseAddressBookEntryIcon(addressBookEntry: AddressBookEntry): AddressBookEntryIconChoice {
	if (addressBookEntry.logoUri !== undefined) return { kind: 'logo', logoUri: addressBookEntry.logoUri }
	if (addressBookEntry.type !== 'ERC20' && addressBookEntry.type !== 'ERC721' && addressBookEntry.type !== 'ERC1155') return { kind: 'blockie' }
	const tickerText = getTickerText(addressBookEntry.symbol)
	if (tickerText === undefined) return { kind: 'blockie' }
	const iconKind = getTokenSymbolIconKind(addressBookEntry.entrySource)
	switch (iconKind) {
		case 'curatedTicker': return { kind: 'curatedTicker', tickerText }
		case 'blockieWithTicker': return { kind: 'blockieWithTicker', tickerText }
		case 'blockie': return { kind: 'blockie' }
		default: return assertNever(iconKind)
	}
}
