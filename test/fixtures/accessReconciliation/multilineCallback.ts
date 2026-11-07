// Valid fixture: both reconciliation functions (one renamed) run inside a multiline callback of a renamed command import.
import { finalizeWebsiteAccessChange as finalize, reconcileCommittedAccessChange as reconcile, updateWebsiteApprovalAccesses } from '../../../app/ts/background/accessManagement.js'
import type { WebsiteTabConnections } from '../../../app/ts/types/user-interface-types.js'

export async function handler(websiteTabConnections: WebsiteTabConnections) {
	await reconcile(
		websiteTabConnections,
		{ kind: 'settings-import' },
		async (committedSettings) => {
			const generation = await updateWebsiteApprovalAccesses(undefined, websiteTabConnections, committedSettings, true)
			await finalize(undefined, websiteTabConnections, committedSettings, generation === 0)
		},
	)
}
