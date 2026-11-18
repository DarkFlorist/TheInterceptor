// Negative fixture: the committed change is held in a `let` and overwritten before it is returned, so the returned value is not the committed change.
import type { CommittedAccessChange } from '../../../app/ts/background/accessManagement.js'
import { updateWebsiteAccess } from '../../../app/ts/background/settings.js'

const denyWebsite = async (websiteOrigin: string): Promise<CommittedAccessChange> => {
	await updateWebsiteAccess((previousAccess) => previousAccess.map((access) => access.website.websiteOrigin === websiteOrigin ? { ...access, access: false } : access))
	return { kind: 'website-access', websiteOrigins: [websiteOrigin] }
}

export async function handler(websiteOrigin: string): Promise<CommittedAccessChange> {
	let change = await denyWebsite(websiteOrigin)
	change = { kind: 'website-access', websiteOrigins: [] }
	return change
}
