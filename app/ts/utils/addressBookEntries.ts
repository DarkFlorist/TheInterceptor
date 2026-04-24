import { ContactEntry } from '../types/addressBookTypes.js'
import { checksummedAddress } from './bigint.js'

export function getFilledInContactEntry(address: bigint): ContactEntry {
	return {
		type: 'contact',
		name: checksummedAddress(address),
		address,
		entrySource: 'FilledIn',
	}
}
