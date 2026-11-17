import * as funtypes from 'funtypes'
import { AddressBookEntries } from './addressBookTypes.js'
import { ENSLabelHashes, ENSNameHashes } from './ens.js'

// Persisted name stores owned by address identification. The general storage setter excludes these fields.
export type AddressBookStorageItems = funtypes.Static<typeof AddressBookStorageItems>
export const AddressBookStorageItems = funtypes.ReadonlyPartial({
	userAddressBookEntriesV3: AddressBookEntries,
	ensNameHashes: ENSNameHashes,
	ensLabelHashes: ENSLabelHashes,
})
