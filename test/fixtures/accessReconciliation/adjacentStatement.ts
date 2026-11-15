// Negative fixture: the reconciliation runs as a separate statement with admitted settings, after the entry point instead of inside it.
import { reconcileCommittedAccessChange, updateWebsiteApprovalAccesses } from '../../../app/ts/background/accessManagement.js'
import type { Settings } from '../../../app/ts/types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../../../app/ts/types/user-interface-types.js'

export async function handler(websiteTabConnections: WebsiteTabConnections, admittedSettings: Settings) {
	await reconcileCommittedAccessChange(websiteTabConnections, { kind: 'address-book' }, { simulationServicesOwner: undefined, promptForAccesses: true, throwOnError: false, notifyWebsiteAccessChanged: false })
	await updateWebsiteApprovalAccesses(undefined, websiteTabConnections, admittedSettings, true)
}
