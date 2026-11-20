import { browserStorageLocalSet } from '../../../app/ts/utils/storageUtils.js'
import { type AddressBookStorageWrite, prepareAddressBookWrite, writeAddressBookStorage } from '../../../app/ts/background/addressBookRevision.js'
import { runSettingsStorageTransaction } from '../../../app/ts/background/settingsStorageTransaction.js'

export async function verifyExplicitNameWrites() {
	await browserStorageLocalSet({ useTabsInsteadOfPopup: true })
	await writeAddressBookStorage({ userAddressBookEntriesV3: [] })
	await runSettingsStorageTransaction(async () => ({ writes: [prepareAddressBookWrite({ ensNameHashes: [] }), { useTabsInsteadOfPopup: false }], result: undefined }))
	const forged: AddressBookStorageWrite = { addressBookWrite: { ensNameHashes: [] }, change: 'identification-cache-filled' } // expect-type-error
	await runSettingsStorageTransaction(async () => ({ writes: [forged], result: undefined }))
	await browserStorageLocalSet({ userAddressBookEntriesV3: [] }) // expect-type-error
	await runSettingsStorageTransaction(async () => ({ writes: [{ ensNameHashes: [] }], result: undefined })) // expect-type-error
}

prepareAddressBookWrite({ useTabsInsteadOfPopup: true }) // expect-type-error
prepareAddressBookWrite({ simulationMode: false }) // expect-type-error
prepareAddressBookWrite({ metamaskCompatibilityMode: true }) // expect-type-error
prepareAddressBookWrite({ userAddressBookEntriesV3: [] }, async (commit: () => Promise<void>) => await commit()) // expect-type-error
