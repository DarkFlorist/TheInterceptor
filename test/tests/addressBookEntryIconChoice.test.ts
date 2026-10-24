import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { EntrySource, type AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import { chooseAddressBookEntryIcon } from '../../app/ts/components/subcomponents/addressBookEntryIconChoice.js'

const TOKEN_ADDRESS = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n
const ALL_ENTRY_SOURCES = EntrySource.alternatives.map((alternative) => alternative.value)

const createTokenEntries = (entrySource: EntrySource, symbol = 'USDC'): readonly AddressBookEntry[] => [
	{ type: 'ERC20', name: 'USD Coin', symbol, decimals: 6n, address: TOKEN_ADDRESS, entrySource },
	{ type: 'ERC721', name: 'Example Collection', symbol, address: TOKEN_ADDRESS, entrySource },
	{ type: 'ERC1155', name: 'Example Items', symbol, decimals: undefined, address: TOKEN_ADDRESS, entrySource },
]

const readTickerText = (entry: AddressBookEntry) => {
	const icon = chooseAddressBookEntryIcon(entry)
	return icon.kind === 'curatedTicker' || icon.kind === 'blockieWithTicker' ? icon.tickerText : undefined
}

describe('address book entry icon choice', () => {
	test('picks the icon kind of every token type without a logo from its entry source', () => {
		const expectedIconKindBySource = {
			DarkFloristMetadata: 'curatedTicker',
			Interceptor: 'curatedTicker',
			User: 'blockieWithTicker',
			OnChain: 'blockie',
			FilledIn: 'blockie',
		} as const
		for (const entrySource of ALL_ENTRY_SOURCES) {
			for (const tokenEntry of createTokenEntries(entrySource)) {
				assert.equal(chooseAddressBookEntryIcon(tokenEntry).kind, expectedIconKindBySource[entrySource], `${ entrySource } ${ tokenEntry.type }`)
				assert.equal(readTickerText(tokenEntry), expectedIconKindBySource[entrySource] === 'blockie' ? undefined : 'US', `${ entrySource } ${ tokenEntry.type }`)
			}
		}
	})

	test('prefers the logo over any ticker', () => {
		for (const entrySource of ALL_ENTRY_SOURCES) {
			for (const tokenEntry of createTokenEntries(entrySource)) {
				assert.deepEqual(chooseAddressBookEntryIcon({ ...tokenEntry, logoUri: 'https://logo.example/usdc.png' }), { kind: 'logo', logoUri: 'https://logo.example/usdc.png' }, `${ entrySource } ${ tokenEntry.type }`)
			}
		}
	})

	test('keeps at most two uppercase ASCII letters or digits of the symbol', () => {
		const tickerTextBySymbol = { ' $wstETH ': 'WS', '1INCH': '1I', 'u': 'U', '🦄UNI': 'UN', 'VERYLONGTOKENSYMBOL': 'VE' }
		for (const entrySource of ['DarkFloristMetadata', 'User'] as const) {
			for (const [symbol, tickerText] of Object.entries(tickerTextBySymbol)) {
				for (const tokenEntry of createTokenEntries(entrySource, symbol)) assert.equal(readTickerText(tokenEntry), tickerText, `${ entrySource } ${ tokenEntry.type } ${ JSON.stringify(symbol) }`)
			}
		}
	})

	test('falls back to the plain Blockie when the symbol has no ASCII letters or digits', () => {
		// The Kelvin sign and the long s only become ASCII K and S after a case change, so they check that the filter runs on the original symbol
		const symbolsWithoutTicker = ['', '   ', '???', '$.-', '🦄', 'ΞΞ', '\u212A', '\u017F']
		for (const entrySource of ['DarkFloristMetadata', 'User'] as const) {
			for (const symbol of symbolsWithoutTicker) {
				for (const tokenEntry of createTokenEntries(entrySource, symbol)) assert.deepEqual(chooseAddressBookEntryIcon(tokenEntry), { kind: 'blockie' }, `${ entrySource } ${ tokenEntry.type } ${ JSON.stringify(symbol) }`)
			}
		}
	})

	test('keeps the plain Blockie for entries that are not tokens whatever their source', () => {
		for (const entrySource of ALL_ENTRY_SOURCES) {
			const nonTokenEntries: readonly AddressBookEntry[] = [
				{ type: 'contact', name: 'Friend', address: TOKEN_ADDRESS, entrySource },
				{ type: 'contract', name: 'Router', address: TOKEN_ADDRESS, entrySource },
				{ type: 'safe', name: 'Treasury', address: TOKEN_ADDRESS, chainId: 1n, entrySource, useAsActiveAddress: false },
			]
			for (const entry of nonTokenEntries) assert.deepEqual(chooseAddressBookEntryIcon(entry), { kind: 'blockie' }, `${ entrySource } ${ entry.type }`)
		}
	})
})
