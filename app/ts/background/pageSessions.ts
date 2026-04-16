import { WebsiteSocket } from '../utils/requests.js'
import { websiteSocketToString } from './backgroundUtils.js'

export type PageSession = {
	port: browser.runtime.Port
	socket: WebsiteSocket
	websiteOrigin: string
	approved: boolean
	wantsToConnect: boolean
}

type PageSessionState = {
	sessionsByKey: Map<string, PageSession>
	sessionsByTab: Map<number, Map<string, PageSession>>
}

export type PageSessionStore = ReturnType<typeof createPageSessionStore>

const createPageSessionState = (): PageSessionState => ({
	sessionsByKey: new Map<string, PageSession>(),
	sessionsByTab: new Map<number, Map<string, PageSession>>(),
})

const getSessionKey = (socket: WebsiteSocket) => websiteSocketToString(socket)

const mergeSession = (existing: PageSession | undefined, session: PageSession) => existing === undefined ? session : {
	...existing,
	port: session.port,
	websiteOrigin: session.websiteOrigin,
	socket: session.socket,
}

const getOrCreateTabSessions = (state: PageSessionState, tabId: number) => {
	const existingSessions = state.sessionsByTab.get(tabId)
	if (existingSessions !== undefined) return existingSessions
	const nextSessions = new Map<string, PageSession>()
	state.sessionsByTab.set(tabId, nextSessions)
	return nextSessions
}

const getAllSessions = (state: PageSessionState) => Array.from(state.sessionsByKey.values())
const getSessionsByTabId = (state: PageSessionState, tabId: number) => Array.from(state.sessionsByTab.get(tabId)?.values() ?? [])
const getSession = (state: PageSessionState, socket: WebsiteSocket) => state.sessionsByKey.get(getSessionKey(socket))

function upsertSession(state: PageSessionState, session: PageSession) {
	const key = getSessionKey(session.socket)
	const nextSession = mergeSession(state.sessionsByKey.get(key), session)
	state.sessionsByKey.set(key, nextSession)
	getOrCreateTabSessions(state, session.socket.tabId).set(key, nextSession)
	return nextSession
}

function removeSession(state: PageSessionState, socket: WebsiteSocket) {
	const key = getSessionKey(socket)
	state.sessionsByKey.delete(key)
	const tabSessions = state.sessionsByTab.get(socket.tabId)
	if (tabSessions === undefined) return
	tabSessions.delete(key)
	if (tabSessions.size === 0) state.sessionsByTab.delete(socket.tabId)
}

export function createPageSessionStore() {
	const state = createPageSessionState()

	return {
		upsert: (session: PageSession) => upsertSession(state, session),
		remove: (socket: WebsiteSocket) => removeSession(state, socket),
		get: (socket: WebsiteSocket) => getSession(state, socket),
		getByTabId: (tabId: number) => getSessionsByTabId(state, tabId),
		getAll: () => getAllSessions(state),
		getApproved: () => getAllSessions(state).filter((session) => session.approved),
		hasApprovedTab: (tabId: number) => getSessionsByTabId(state, tabId).some((session) => session.approved),
	}
}
