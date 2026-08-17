import { DEFAULT_ACTIVE_ADDRESSES } from '../config/defaults.js'
import { browserStorageLocalSafeParseGet, browserStorageLocalSet } from '../utils/storageUtils.js'

async function hasStoredActiveSimulationAddress() {
	const storedValue = await browserStorageLocalSafeParseGet('activeSimulationAddress')
	if (storedValue === undefined) return false
	const { activeSimulationAddress } = storedValue
	return activeSimulationAddress !== undefined
}

export async function initializeIndependentActiveAddressState() {
	const defaultActiveAddress = DEFAULT_ACTIVE_ADDRESSES[0]
	if (defaultActiveAddress === undefined) throw new Error('Default active address was missing')
	const { hasIndependentActiveSimulationAddress } = await browser.storage.local.get('hasIndependentActiveSimulationAddress')
	if (hasIndependentActiveSimulationAddress !== undefined) return
	await browserStorageLocalSet({
		activeSimulationAddress: defaultActiveAddress.address,
		hasIndependentActiveSimulationAddress: true,
		activeAddressSelectionResetNoticePending: await hasStoredActiveSimulationAddress(),
	})
}

export async function getActiveAddressSelectionResetNoticePending() {
	const { activeAddressSelectionResetNoticePending: rawValue } = await browser.storage.local.get('activeAddressSelectionResetNoticePending')
	const parsedValue = await browserStorageLocalSafeParseGet('activeAddressSelectionResetNoticePending')
	if (parsedValue !== undefined && 'activeAddressSelectionResetNoticePending' in parsedValue) {
		const { activeAddressSelectionResetNoticePending } = parsedValue
		return activeAddressSelectionResetNoticePending === true
	}
	if (rawValue === undefined) return false
	console.warn('activeAddressSelectionResetNoticePending was corrupt:')
	console.warn(rawValue)
	await browserStorageLocalSet({ activeAddressSelectionResetNoticePending: false })
	return false
}

export async function acknowledgeActiveAddressSelectionResetNotice() {
	await browserStorageLocalSet({ activeAddressSelectionResetNoticePending: false })
}
