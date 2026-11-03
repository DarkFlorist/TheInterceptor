// Negative fixture: the write helper returns its committed change, but the handler discards it instead of reconciling it.
import type { CommittedAccessChange } from '../../../app/ts/background/accessManagement.js'
import { updateWebsiteAccess as writeWebsiteAccess } from '../../../app/ts/background/settings.js'

const denyWebsite = async (websiteOrigin: string): Promise<CommittedAccessChange> => {
	await writeWebsiteAccess((previousAccess) => previousAccess.map((access) => access.website.websiteOrigin === websiteOrigin ? { ...access, access: false } : access))
	return { kind: 'website-access', websiteOrigins: [websiteOrigin] }
}

export async function handler(websiteOrigin: string) {
	await denyWebsite(websiteOrigin)
}
