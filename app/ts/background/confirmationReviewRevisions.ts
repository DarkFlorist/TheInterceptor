import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { getUniqueRequestIdentifierString, type UniqueRequestIdentifier } from '../utils/requests.js'

// An accept approves the request as the user last saw it. When an accept ends by asking the user to confirm again (a Safe refresh, a blocked signer, a request that is still simulating), the request's review revision moves on, so an accept made before that, such as the second click of a double click, cannot approve a refreshed request the user has not reviewed. This module owns the revisions. They are scoped to the connection registry, like the claims in confirmTransaction.ts, and resolvePendingTransactionOrMessage forgets a request's revision once the request is no longer pending. A revision left behind cannot block an accept: a confirmation is compared with the revision it captured on arrival, which is that same value. They guard against a duplicate accept within one background session, so they are not stored with the request.
const reviewRevisions = new WeakMap<WebsiteTabConnections, Map<string, number>>()

function getRevisions(websiteTabConnections: WebsiteTabConnections) {
	const existing = reviewRevisions.get(websiteTabConnections)
	if (existing !== undefined) return existing
	const created = new Map<string, number>()
	reviewRevisions.set(websiteTabConnections, created)
	return created
}

// The review revision a confirmation is made against. Capture it when the confirmation arrives, before any await, so work that runs first (such as refreshing the signer accounts) cannot let the confirmation observe a later revision.
export function getReviewRevision(websiteTabConnections: WebsiteTabConnections, uniqueRequestIdentifier: UniqueRequestIdentifier) {
	return getRevisions(websiteTabConnections).get(getUniqueRequestIdentifierString(uniqueRequestIdentifier)) ?? 0
}

// Called when an accept made against reviewedRevision asked the user to review the request again.
export function advanceReviewRevision(websiteTabConnections: WebsiteTabConnections, uniqueRequestIdentifier: UniqueRequestIdentifier, reviewedRevision: number) {
	getRevisions(websiteTabConnections).set(getUniqueRequestIdentifierString(uniqueRequestIdentifier), reviewedRevision + 1)
}

export function forgetReviewRevision(websiteTabConnections: WebsiteTabConnections, uniqueRequestIdentifier: UniqueRequestIdentifier) {
	getRevisions(websiteTabConnections).delete(getUniqueRequestIdentifierString(uniqueRequestIdentifier))
}
