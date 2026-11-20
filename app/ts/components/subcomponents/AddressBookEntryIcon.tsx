import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import { chooseAddressBookEntryIcon } from './addressBookEntryIconChoice.js'
import { addressString } from '../../utils/bigint.js'
import { keccak256 } from '../../utils/ethereumPrimitives.js'
import { assertNever } from '../../utils/typescript.js'
import { Blockie } from './SVGBlockie.js'

// Fixed saturation and lightness keep the black ticker text above 8:1 contrast for every hue, and the circle above 3.5:1 against the dark card backgrounds
const TICKER_ICON_SATURATION_AND_LIGHTNESS = '60%, 75%'

// The hue comes from 16 bits of the address hash, so curated tokens sharing a symbol still look different and vanity addresses with shared leading bytes spread across the hue wheel
function getTickerIconBackgroundColor(address: bigint) {
	const addressHashPrefix = Number.parseInt(keccak256(addressString(address)).slice(2, 6), 16)
	const hue = Math.floor(addressHashPrefix * 360 / 0x10000)
	return `hsl(${ hue }, ${ TICKER_ICON_SATURATION_AND_LIGHTNESS })`
}

// The letters of both ticker icons are drawn by CSS from the data-ticker-text attribute, so they never become text that is copied or read together with the token label next to the icon
function CuratedTickerIcon({ address, tickerText }: { address: bigint, tickerText: string }) {
	const className = tickerText.length === 1 ? 'token-ticker-icon token-ticker-icon--single-character' : 'token-ticker-icon'
	return <span class = { className } data-ticker-text = { tickerText } style = { { backgroundColor: getTickerIconBackgroundColor(address) } } />
}

// The unchanged address Blockie with the letters on top, see chooseAddressBookEntryIcon for why user added tokens keep their Blockie
function BlockieWithTickerIcon({ address, tickerText }: { address: bigint, tickerText: string }) {
	return <span class = 'blockie-with-ticker' data-ticker-text = { tickerText }><Blockie address = { address } /></span>
}

// Draws the icon that chooseAddressBookEntryIcon picks for the entry
export function AddressBookEntryIcon({ addressBookEntry }: { addressBookEntry: AddressBookEntry }) {
	const icon = chooseAddressBookEntryIcon(addressBookEntry)
	switch (icon.kind) {
		case 'logo': return <img style = { { minWidth: '1em', minHeight: '1em' } } width = '16' height = '16' src = { icon.logoUri } />
		case 'curatedTicker': return <CuratedTickerIcon address = { addressBookEntry.address } tickerText = { icon.tickerText } />
		case 'blockieWithTicker': return <BlockieWithTickerIcon address = { addressBookEntry.address } tickerText = { icon.tickerText } />
		case 'blockie': return <Blockie address = { addressBookEntry.address } />
		default: return assertNever(icon)
	}
}
