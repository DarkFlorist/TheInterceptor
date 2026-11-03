// Valid fixture: one handler writes and then reconciles itself, the other reconciles the change its write helper returns.
import { type CommittedAccessChange, reconcileCommittedAccessChange, updateWebsiteApprovalAccesses } from '../../../app/ts/background/accessManagement.js'
import { updateWebsiteAccess } from '../../../app/ts/background/settings.js'
import type { WebsiteTabConnections } from '../../../app/ts/types/user-interface-types.js'

const denyWebsite = async (websiteOrigin: string): Promise<CommittedAccessChange> => {
	await updateWebsiteAccess((previousAccess) => previousAccess.map((access) => access.website.websiteOrigin === websiteOrigin ? { ...access, access: false } : access))
	return { kind: 'website-access', websiteOrigins: [websiteOrigin] }
}

export async function reconcilingHandler(websiteTabConnections: WebsiteTabConnections, websiteOrigin: string) {
	await updateWebsiteAccess((previousAccess) => previousAccess.filter((access) => access.website.websiteOrigin !== websiteOrigin))
	await reconcileCommittedAccessChange(websiteTabConnections, { kind: 'website-access', websiteOrigins: [websiteOrigin] }, async (committedSettings) => await updateWebsiteApprovalAccesses(undefined, websiteTabConnections, committedSettings, true))
}

export async function helperHandler(websiteTabConnections: WebsiteTabConnections, websiteOrigin: string) {
	const change = await denyWebsite(websiteOrigin)
	await reconcileCommittedAccessChange(websiteTabConnections, change, async (committedSettings) => await updateWebsiteApprovalAccesses(undefined, websiteTabConnections, committedSettings, true))
}
