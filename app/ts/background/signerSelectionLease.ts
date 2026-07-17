import type { WebsiteSocket } from '../utils/requests.js'
import { registerAuthoritativeTopSocket } from './signerExecutionAuthority.js'

type GateReservation = {
	readonly release: () => void
}

type ActiveSignerSelectionLease = {
	readonly tabId: number
	readonly release: () => void
	readonly timeout: ReturnType<typeof setTimeout>
}

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

export async function acquireSignerSelectionLease(tabId: number) {
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
	activeLeasesByToken.set(token, { tabId, release, timeout })
	return token
}

export function releaseSignerSelectionLease(tabId: number, token: string) {
	const lease = activeLeasesByToken.get(token)
	if (lease?.tabId !== tabId) return false
	lease.release()
	return true
}

export function signerSelectionLeaseIsActive(tabId: number, token: string) {
	return activeLeasesByToken.get(token)?.tabId === tabId
}

export function releaseSignerSelectionLeasesForTab(tabId: number) {
	for (const lease of activeLeasesByToken.values()) {
		if (lease.tabId === tabId) lease.release()
	}
}

export function registerTopSignerDocument(socket: WebsiteSocket, websiteOrigin: string) {
	const startsNewSignerDocument = registerAuthoritativeTopSocket(socket, websiteOrigin)
	if (startsNewSignerDocument) releaseSignerSelectionLeasesForTab(socket.tabId)
	return startsNewSignerDocument
}

export async function runWithSignerSelectionGate<T>(tabId: number, action: () => Promise<T>) {
	const reservation = await reserveSignerSelectionGate(tabId)
	try {
		return await action()
	} finally {
		reservation.release()
	}
}
