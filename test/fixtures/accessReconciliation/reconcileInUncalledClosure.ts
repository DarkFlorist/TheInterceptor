// Negative fixture: the reconciliation sits in a nested function that is never called, so the write is never reconciled.
import { reconcileCommittedAccessChange } from '../../../app/ts/background/accessManagement.js'
import { updateWebsiteAccess } from '../../../app/ts/background/settings.js'
import type { WebsiteTabConnections } from '../../../app/ts/types/user-interface-types.js'

export async function handler(websiteTabConnections: WebsiteTabConnections, websiteOrigin: string) {
	await updateWebsiteAccess((previousAccess) => previousAccess.filter((access) => access.website.websiteOrigin !== websiteOrigin))
	const reconcileLater = async () => await reconcileCommittedAccessChange(websiteTabConnections, { kind: 'website-access', websiteOrigins: [websiteOrigin] }, { simulationServicesOwner: undefined, promptForAccesses: true, throwOnError: false, notifyWebsiteAccessChanged: false })
	return reconcileLater
}
