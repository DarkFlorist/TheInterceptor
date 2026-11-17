import type { RpcNetwork } from '../types/rpc.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { relabelPopupVisualisation } from './popupVisualisationUpdater.js'
import { relabelReportingUnexpectedErrors } from './simulationRelabel.js'

// Notifies even when there was nothing to re-label, so the notification always marks the end of the re-label.
async function relabelStoredSimulationsAndNotify(rpcNetwork: RpcNetwork) {
	await Promise.all([
		relabelReportingUnexpectedErrors(relabelPopupVisualisation(rpcNetwork)),
	])
	await sendPopupMessageToOpenWindows({ method: 'popup_simulationsRelabelled' })
}

// Broadcasts a persisted address-book change immediately, then re-labels the stored stack in the background. Callers wait for the change broadcast; simulation views re-read after popup_simulationsRelabelled.
export async function publishAddressBookChangeAndRelabelSimulations(rpcNetwork: RpcNetwork) {
	const addressBookChangeBroadcast = sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
	void relabelStoredSimulationsAndNotify(rpcNetwork)
	await addressBookChangeBroadcast
}
