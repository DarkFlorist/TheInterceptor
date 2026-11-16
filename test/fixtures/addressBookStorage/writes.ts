import { browserStorageLocalSet } from '../../../app/ts/utils/storageUtils.js'
import { prepareAddressBookWrite, writeAddressBookStorage } from '../../../app/ts/background/addressBookRevision.js'
import { runSettingsStorageTransaction } from '../../../app/ts/background/settingsStorageTransaction.js'

export async function verifyExplicitNameWrites() {
	await browserStorageLocalSet({ useTabsInsteadOfPopup: true })
	await writeAddressBookStorage({ userAddressBookEntriesV3: [] })
	await runSettingsStorageTransaction(async () => ({ writes: [prepareAddressBookWrite({ ensNameHashes: [] }), { useTabsInsteadOfPopup: false }], result: undefined }))
	await browserStorageLocalSet({ userAddressBookEntriesV3: [] }) // expect-type-error
	await runSettingsStorageTransaction(async () => ({ writes: [{ ensNameHashes: [] }], result: undefined })) // expect-type-error
}
