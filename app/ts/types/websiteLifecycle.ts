import type { WebsiteSocket } from '../utils/requests.js'

// Optional observers are injected by background startup alongside the connection state.
export type WebsiteLifecycleCallbacks = {
	readonly approvalChanged?: (socket: WebsiteSocket, approved: boolean) => void | Promise<void>
	readonly connectionRemoved?: (socket: WebsiteSocket) => void | Promise<void>
	readonly signerConnected?: (socket: WebsiteSocket, accountsRequested: boolean) => void | Promise<void>
	readonly signerAccountsChanged?: (socket: WebsiteSocket) => void | Promise<void>
	readonly accessReconciled?: () => void | Promise<void>
}
