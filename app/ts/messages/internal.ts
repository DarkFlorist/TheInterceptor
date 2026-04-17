import { WebsiteSocket } from '../utils/requests.js'

export type InternalMessage =
	| {
		action: 'signer.accountsChanged'
		payload: { socket: WebsiteSocket }
	}
