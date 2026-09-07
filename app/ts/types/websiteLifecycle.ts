import type { WebsiteSocket } from '../utils/requests.js'

// Startup injects observers of connection transitions, including changes during pending RPCs. Callback returns never authorize access or signer ownership; consumers use the core APIs for those decisions.
export type WebsiteLifecycleCallbacks = {
	readonly approvalChanged?: (socket: WebsiteSocket, approved: boolean) => void | Promise<void>
	readonly connectionRemoved?: (socket: WebsiteSocket) => void | Promise<void>
	readonly signerConnected?: (socket: WebsiteSocket, accountsRequested: boolean) => void | Promise<void>
	readonly signerAccountsChanged?: (socket: WebsiteSocket) => void | Promise<void>
	readonly accessReconciled?: () => void | Promise<void>
}
