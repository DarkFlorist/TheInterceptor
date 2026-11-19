import type { Website, WebsiteAccess, WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import type { EthereumAddress } from '../types/wire-types.js'
import { replaceElementInReadonlyArray } from '../utils/typed-arrays.js'
import { modifyObject } from '../utils/typescript.js'
import { getNetworkBlockingKey, getWebsiteHostname, shareNetworkBlocking } from '../utils/websiteOrigin.js'

// Network blocking is enforced per hostname across every scheme and port (updateDeclarativeNetRequestBlocks), so a toggle sets every record sharing the hostname. Updating only the selected origin would let another scheme's record keep blocking it while its toggle shows it as unblocked.
export function setNetworkBlockModeForHostname(websiteAccess: WebsiteAccessArray, websiteOrigin: string, shouldBlock: boolean): WebsiteAccessArray {
	return websiteAccess.map((access) => {
		if (!shareNetworkBlocking(access.website.websiteOrigin, websiteOrigin)) return access
		return modifyObject(access, { declarativeNetRequestBlockMode: shouldBlock ? 'block-all' : 'disabled' })
	})
}

type NetworkBlockDecision = { readonly websiteOrigin: string, readonly shouldBlock: boolean }
type WebsiteAccessEdit = { readonly removed: boolean, readonly oldEntry: WebsiteAccess, readonly newEntry: WebsiteAccess }

const blocksNetworkRequests = (access: WebsiteAccess) => access.declarativeNetRequestBlockMode === 'block-all'

// A save's explicit block toggles, one per hostname (or per origin without one). Throws before anything is written when two toggles of one hostname disagree, since enforcement cannot block a hostname for one scheme and not another. The access-list editor derives every row's block mode from one decision per key (getShownNetworkBlockMode), so this only rejects a crafted or stale message.
export function getNetworkBlockDecisions(edits: readonly WebsiteAccessEdit[]): readonly NetworkBlockDecision[] {
	const decisions = new Map<string, NetworkBlockDecision>()
	for (const edit of edits) {
		if (edit.removed || blocksNetworkRequests(edit.oldEntry) === blocksNetworkRequests(edit.newEntry)) continue
		const websiteOrigin = edit.newEntry.website.websiteOrigin
		const decision = { websiteOrigin, shouldBlock: blocksNetworkRequests(edit.newEntry) }
		const decisionKey = getNetworkBlockingKey(websiteOrigin)
		const previous = decisions.get(decisionKey)
		if (previous !== undefined && previous.shouldBlock !== decision.shouldBlock) {
			throw new Error(`Cannot both block and allow external requests for ${ getWebsiteHostname(websiteOrigin) ?? websiteOrigin }: ${ previous.websiteOrigin } and ${ websiteOrigin } share its network blocking. Set them to the same value.`)
		}
		decisions.set(decisionKey, decision)
	}
	return [...decisions.values()]
}

// Apply ordinary record edits first, then each explicit block toggle across its whole hostname, so another edited record of that hostname carrying its old block mode cannot undo the toggle.
export function applyWebsiteAccessEdits(websiteAccess: WebsiteAccessArray, edits: readonly WebsiteAccessEdit[], networkBlockDecisions: readonly NetworkBlockDecision[]): WebsiteAccessArray {
	const withEntriesRemoved = websiteAccess.filter((access) => edits.find((edit) => edit.newEntry.website.websiteOrigin === access.website.websiteOrigin)?.removed !== true)
	const withRecordEdits = withEntriesRemoved.map((access) => edits.find((edit) => edit.newEntry.website.websiteOrigin === access.website.websiteOrigin)?.newEntry ?? access)
	return networkBlockDecisions.reduce<WebsiteAccessArray>((accessList, decision) => setNetworkBlockModeForHostname(accessList, decision.websiteOrigin, decision.shouldBlock), withRecordEdits)
}

// Pure changes to website-access data live here. The handler-level workflow in applyWebsiteAccessUpdate.ts owns persistence, injection refresh, reloads and approval reconciliation.
export type WebsiteAccessMutation = (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray

export const withInterceptorDisabledForWebsite = (website: Website, interceptorDisabled: boolean): WebsiteAccessMutation => (previousWebsiteAccess) => {
	const index = previousWebsiteAccess.findIndex((entry) => entry.website.websiteOrigin === website.websiteOrigin)
	const previousAccess = index !== -1 ? previousWebsiteAccess[index] : undefined
	if (previousAccess === undefined) return [...previousWebsiteAccess, { website, addressAccess: [], interceptorDisabled }]
	return replaceElementInReadonlyArray(previousWebsiteAccess, index, { ...previousAccess, interceptorDisabled })
}

export const withExternalRequestsBlockedOrAllowed = (website: Website, shouldBlock: boolean): WebsiteAccessMutation => (previousAccessList) => setNetworkBlockModeForHostname(previousAccessList, website.websiteOrigin, shouldBlock)

export const withoutAddressAccess = (websiteOrigin: string, address: EthereumAddress): WebsiteAccessMutation => (previousAccessList) => previousAccessList.map((access) => {
	if (access.website.websiteOrigin !== websiteOrigin || !access.addressAccess) return access
	return modifyObject(access, { addressAccess: access.addressAccess.filter((addressAccess) => addressAccess.address !== address) })
})

export const withAddressAccessForWebsite = (websiteOrigin: string, address: EthereumAddress, allowAccess: boolean): WebsiteAccessMutation => (previousAccessList) => previousAccessList.map((access) => {
	if (access.website.websiteOrigin !== websiteOrigin || access.addressAccess === undefined) return access
	const addressAccess = access.addressAccess.map((entry) => entry.address === address ? modifyObject(entry, { access: allowAccess }) : entry)
	return modifyObject(access, { addressAccess })
})

export const withoutWebsiteAccess = (websiteOrigin: string): WebsiteAccessMutation => (previousAccess) => previousAccess.filter((access) => access.website.websiteOrigin !== websiteOrigin)

export const withWebsiteAccessChanges = (changes: readonly WebsiteAccessEdit[]): WebsiteAccessMutation => {
	const decisions = getNetworkBlockDecisions(changes)
	return (previousAccess) => applyWebsiteAccessEdits(previousAccess, changes, decisions)
}
