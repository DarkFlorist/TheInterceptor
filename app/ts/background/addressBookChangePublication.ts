import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import type { RpcNetwork } from '../types/rpc.js'
import { backgroundTaskSupervisor } from './backgroundTasks.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { relabelPopupVisualisation } from './popupVisualisationUpdater.js'
import { isExpectedInfrastructureError } from '../utils/errors.js'

// Popup command boundaries bind the live network once per mutation. The callback reads it when the write has committed.
export function createAddressBookChangePublisher(owner: SimulationServicesOwner): () => void {
	return () => scheduleAddressBookChangePublication(owner.getCurrent().ethereum.getRpcEntry())
}

// Call after persistence. The supervisor owns the notification and replay so the edit reply need not wait for popup listeners.
export function scheduleAddressBookChangePublication(rpcNetwork: RpcNetwork): void {
	backgroundTaskSupervisor.start({ source: 'address_book_change_publication' }, async () => {
		await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
		try {
			await relabelPopupVisualisation(rpcNetwork)
		} catch (error) {
			if (!isExpectedInfrastructureError(error)) throw error
		} finally {
			await sendPopupMessageToOpenWindows({ method: 'popup_simulationsRelabelled' })
		}
	})
}
