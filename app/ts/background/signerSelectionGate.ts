import { websiteSocketToString, type WebsiteSocket } from '../utils/requests.js'

type GateReservation = {
	readonly release: () => void
}

type ActiveSignerSelectionLease = {
	readonly tabId: number
	readonly socket?: WebsiteSocket
	readonly release: () => void
	readonly timeout: ReturnType<typeof setTimeout>
}

// A coordinator creates one gate; this module owns no global or collection registry.
export function createSignerSelectionGate() {
	const gateTailsByTab = new Map<number, Promise<void>>()
	const activeLeasesByToken = new Map<string, ActiveSignerSelectionLease>()

	async function reserveSignerSelectionGate(tabId: number): Promise<GateReservation> {
		const previousTail = gateTailsByTab.get(tabId) ?? Promise.resolve()
		let releaseReservation: (() => void) | undefined
		const completion = new Promise<void>((resolve) => { releaseReservation = resolve })
		const currentTail = previousTail.then(async () => await completion)
		gateTailsByTab.set(tabId, currentTail)
		await previousTail
		let released = false
		const release = () => {
			if (released) return
			released = true
			releaseReservation?.()
			void currentTail.then(() => {
				if (gateTailsByTab.get(tabId) === currentTail) gateTailsByTab.delete(tabId)
			})
		}
		return { release }
	}

	async function acquire(tabId: number, socket?: WebsiteSocket) {
		const reservation = await reserveSignerSelectionGate(tabId)
		const token = crypto.randomUUID()
		const release = () => {
			const lease = activeLeasesByToken.get(token)
			if (lease === undefined) return
			activeLeasesByToken.delete(token)
			clearTimeout(lease.timeout)
			reservation.release()
		}
		const timeout = setTimeout(release, 30_000)
		activeLeasesByToken.set(token, { tabId, socket, release, timeout })
		return token
	}

	function release(tabId: number, token: string) {
		const lease = activeLeasesByToken.get(token)
		if (lease?.tabId !== tabId) return false
		lease.release()
		return true
	}

	function isActive(tabId: number, token: string) {
		return activeLeasesByToken.get(token)?.tabId === tabId
	}

	function releaseForTab(tabId: number) {
		for (const lease of activeLeasesByToken.values()) {
			if (lease.tabId === tabId) lease.release()
		}
	}

	function releaseForSocketKey(socketKey: string) {
		for (const lease of activeLeasesByToken.values()) {
			if (lease.socket !== undefined && websiteSocketToString(lease.socket) === socketKey) lease.release()
		}
	}

	async function run<T>(tabId: number, action: () => Promise<T>) {
		const reservation = await reserveSignerSelectionGate(tabId)
		try {
			return await action()
		} finally {
			reservation.release()
		}
	}

	return { acquire, release, isActive, releaseForTab, releaseForSocketKey, run, isIdle: () => gateTailsByTab.size === 0 && activeLeasesByToken.size === 0 }
}
