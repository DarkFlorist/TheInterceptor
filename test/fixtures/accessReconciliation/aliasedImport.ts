// Negative fixture: a renamed import of the reconciliation function used outside the command.
import { updateWebsiteApprovalAccesses as reconcileApprovals } from '../../../app/ts/background/accessManagement.js'
import type { Settings } from '../../../app/ts/types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../../../app/ts/types/user-interface-types.js'

export async function handler(websiteTabConnections: WebsiteTabConnections, admittedSettings: Settings) {
	await reconcileApprovals(undefined, websiteTabConnections, admittedSettings, true)
}
