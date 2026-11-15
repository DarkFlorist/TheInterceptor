// Valid fixture: both inner reconciliation functions (one renamed) run inside a multiline callback of a renamed collecting entry point import.
import { reconcileCommittedAccessChangeCollectingFailures as reconcile, reconcileWebsiteApprovalAccessesCollectingFailures as reconcileCollecting, updateWebsiteApprovalAccesses } from '../../../app/ts/background/accessManagement.js'
import type { WebsiteTabConnections } from '../../../app/ts/types/user-interface-types.js'

export async function handler(websiteTabConnections: WebsiteTabConnections) {
	return await reconcile(
		websiteTabConnections,
		{ kind: 'settings-import' },
		async (committedSettings) => {
			const { failures } = await reconcileCollecting(websiteTabConnections, committedSettings)
			await updateWebsiteApprovalAccesses(undefined, websiteTabConnections, committedSettings, failures.length === 0)
			return failures
		},
	)
}
