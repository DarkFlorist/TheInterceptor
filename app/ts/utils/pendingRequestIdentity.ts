import type { PendingRequestInstance } from '../types/accessRequest.js'
import { doesUniqueRequestIdentifiersMatch } from './requests.js'

// Page-selected request ids can be reused; a pending instance also includes the extension-generated identity.
export const isSamePendingRequestInstance = (first: PendingRequestInstance, second: PendingRequestInstance) => {
	return first.instanceId === second.instanceId && doesUniqueRequestIdentifiersMatch(first.uniqueRequestIdentifier, second.uniqueRequestIdentifier)
}
