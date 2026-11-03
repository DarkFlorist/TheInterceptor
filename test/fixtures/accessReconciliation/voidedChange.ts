// Negative fixture: the returned change is assigned and then voided instead of being reconciled or returned.
import type { CommittedAccessChange } from '../../../app/ts/background/accessManagement.js'
import { updateWebsiteAccess } from '../../../app/ts/background/settings.js'

const denyWebsite = async (websiteOrigin: string): Promise<CommittedAccessChange> => {
	await updateWebsiteAccess((previousAccess) => previousAccess.map((access) => access.website.websiteOrigin === websiteOrigin ? { ...access, access: false } : access))
	return { kind: 'website-access', websiteOrigins: [websiteOrigin] }
}

export async function handler(websiteOrigin: string) {
	const change = await denyWebsite(websiteOrigin)
	void change
}
