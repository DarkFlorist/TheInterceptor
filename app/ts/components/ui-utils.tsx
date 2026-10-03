import { useEffect } from 'preact/hooks'
import type { ComponentChildren, RefObject } from 'preact'
import type { EthereumAddress } from '../types/wire-types.js'
import { getSafeSignerAddresses, type AddressBookEntry } from '../types/addressBookTypes.js'
import { addressString, bigintSecondsToDate, checksummedAddress } from '../utils/bigint.js'
import { getFilledInContactEntry } from '../utils/addressBookEntries.js'
import type { ChainEntry, RpcEntries } from '../types/rpc.js'
import { CHAIN_NAMES } from '../utils/chainNames.js'
export type { PopupOrTab } from '../utils/popupOrTab.js'
export { tryFocusingTabOrWindow } from '../utils/popupOrTab.js'

function assertIsNode(e: EventTarget | null): asserts e is Node {
	if (!e || !('nodeType' in e)) {
        throw new Error('Node expected')
    }
}

export function clickOutsideAlerter(ref: RefObject<HTMLDivElement>, callback: () => void) {
	useEffect(() => {
		function handleClickOutside({ target }: MouseEvent) {
			assertIsNode(target);
			if (ref.current && !ref.current.contains(target)) {
				callback()
			}
		}

		document.addEventListener('mousedown', handleClickOutside);

		return () => {
			document.removeEventListener('mousedown', handleClickOutside);
		}
	}, [ref, callback]);
}

// The four meanings a status colour can carry anywhere in the UI.
export type StatusTone = 'positive' | 'neutral' | 'warning' | 'negative'

// The styled families and the tones each one has a `family--tone` rule for. Adding a tone here without its rule, or the other way round, fails the stylesheet test.
export const toneClassFamilies = {
	'transaction-check': ['positive', 'neutral', 'warning', 'negative'],
	'outcome-chip': ['positive', 'neutral', 'warning', 'negative'],
	'result-notice': ['positive', 'warning', 'negative'],
	'connection-chip': ['positive', 'negative'],
	'coin-text': ['positive', 'negative'],
} as const satisfies Record<string, readonly StatusTone[]>

type ToneClassFamily = keyof typeof toneClassFamilies

// The only place a tone is turned into a class name, so a family can only be given a tone it has a rule for.
export function getToneClass<Family extends ToneClassFamily>(family: Family, tone: (typeof toneClassFamilies)[Family][number]) {
	return `${ family }--${ tone }`
}

// Pages add this class to their root so the stylesheet can tint the accent by mode: calm teal while simulating, amber while signing for real.
export function getInterceptorModeClass(simulationMode: boolean) {
	return simulationMode ? 'interceptor-mode-simulating' : 'interceptor-mode-signing'
}

export function upperCaseFirstCharacter(text: string) {
	if (text.length === 0) return text
	return text.charAt(0).toUpperCase() + text.slice(1)
}

export function convertNumberToCharacterRepresentationIfSmallEnough(num: number) {
	const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
	const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
	const teens = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']

	function convertTens(num: number) {
		if (num < 10) return ones[num]
		if (num >= 10 && num < 20) return teens[num - 10]
		return tens[Math.floor(num / 10)] + ' ' + ones[num % 10]
	}

	if (num === 0) return 'zero'
	if (num > 99) return num.toString()
	const convertedNumber = convertTens(num)
	if (convertedNumber === undefined) throw new Error('index error when trying to convert number into a string')
	return convertedNumber
}

export const humanReadableDate = (date: Date) => date.toISOString()

export function humanReadableDateFromSeconds(timeInSeconds: bigint) {
	return humanReadableDate(bigintSecondsToDate(timeInSeconds))
}

// Appends an optional modifier class, such as a tone passed by a caller, to an element's own classes.
export const withModifierClass = (baseClass: string, modifierClass: string | undefined) => modifierClass === undefined ? baseClass : `${ baseClass } ${ modifierClass }`

export const CellElement = (param: { text: ComponentChildren, useLegibleFont?: boolean }) => {
	return <div class = 'log-cell log-cell--right'>
		<p class = { `paragraph${ param.useLegibleFont ? ' text-legible' : '' } log-cell-text` }>{ param.text }</p>
	</div>
}

export const getAddressBookEntryOrAFiller = (addressMetaData: readonly AddressBookEntry[], addressToFind: EthereumAddress) => {
	const foundEntry = addressMetaData.find((entry) => entry.address === addressToFind)
	if (foundEntry !== undefined) return foundEntry
	return getFilledInContactEntry(addressToFind)
}

export const rpcEntriesToChainEntriesWithAllChainsEntry = (rpcEntries: RpcEntries): readonly ChainEntry[] => {
	const entries = rpcEntries.map(({ chainId }): [string, ChainEntry] => {
		const chainIdString = chainId.toString()
		return [chainIdString, { chainId, name: CHAIN_NAMES.get(chainIdString) || `Chain ID: ${ chainIdString }` }]
	})
	const chainsMap = new Map<string, ChainEntry>(entries)
	chainsMap.set('AllChains', { name: 'All Chains', chainId: 'AllChains' })
	return [...chainsMap.values()]
}

export const addressEditEntry = (entry: AddressBookEntry) => {
	return {
		windowStateId: addressString(entry.address),
		errorState: undefined,
		incompleteAddressBookEntry: {
			addingAddress: false,
			askForAddressAccess: true,
			symbol: undefined,
			decimals: undefined,
			logoUri: undefined,
			useAsActiveAddress: false,
			abi : undefined,
			safeVersion: undefined,
			declarativeNetRequestBlockMode: undefined,
			chainId: entry.chainId ?? 1n,
			...entry,
			address: checksummedAddress(entry.address),
			safeSimulationSignerAddress: entry.type === 'safe' && entry.safeSimulationSignerAddress !== undefined
				? checksummedAddress(entry.safeSimulationSignerAddress)
				: undefined,
			safeSignerAddresses: entry.type === 'safe'
				? getSafeSignerAddresses(entry).map(checksummedAddress)
				: [],
		}
	}
}
