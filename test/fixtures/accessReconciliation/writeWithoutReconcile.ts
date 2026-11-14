// Negative fixture: a website-access write that neither reconciles nor returns the change it committed.
import { updateWebsiteAccess } from '../../../app/ts/background/settings.js'

export async function denyWebsite(websiteOrigin: string) {
	await updateWebsiteAccess((previousAccess) => previousAccess.map((access) => access.website.websiteOrigin === websiteOrigin ? { ...access, access: false } : access))
}
