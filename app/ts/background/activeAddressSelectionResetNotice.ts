import { browserStorageLocalSafeParseGet, browserStorageLocalSet } from '../utils/storageUtils.js'

export async function getActiveAddressSelectionResetNoticePending() {
	const storedValue = await browserStorageLocalSafeParseGet('activeAddressSelectionResetNoticePending')
	return storedValue?.activeAddressSelectionResetNoticePending === true
}

export async function acknowledgeActiveAddressSelectionResetNotice() {
	await browserStorageLocalSet({ activeAddressSelectionResetNoticePending: false })
}
