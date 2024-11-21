import { WebsiteAccessArray } from "../types/websiteAccessTypes.js"

export const searchWebsiteAccess = (query: string, websiteAccess: WebsiteAccessArray) => {
	console.log('searching', query)
	for(const access of websiteAccess) {
		console.log(access)
		//
	}
	return websiteAccess
}
