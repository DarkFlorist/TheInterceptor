import { DEFAULT_ACTIVE_ADDRESSES } from '../config/defaults.js'
import { browserStorageLocalSafeParseGet, browserStorageLocalSet } from '../utils/storageUtils.js'
import { createIndependentActiveSimulationAddressStorageUpdate } from './activeSimulationAddressStorage.js'

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
		...createIndependentActiveSimulationAddressStorageUpdate(defaultActiveAddress.address),
		activeAddressSelectionResetNoticePending: await hasStoredActiveSimulationAddress(),
	})
}
