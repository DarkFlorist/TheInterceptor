import type { DeclarativeNetRequestBlockMode } from '../../types/addressBookTypes.js'
import type { ChangeInterceptorAccess } from '../../types/interceptor-messages.js'
import type { WebsiteAccess, WebsiteAccessArray, WebsiteAddressAccess } from '../../types/websiteAccessTypes.js'
import { modifyObject } from '../../utils/typescript.js'
import { getNetworkBlockingKey } from '../../utils/websiteOrigin.js'

export interface ModifiedAddressAccess {
	address: bigint,
	access: boolean,
	removed: boolean,
}

// A row's edits next to the stored record they apply to. Its network block mode is not a row edit: see NetworkBlockDecisions.
export interface EditableAccess {
	websiteAccess: WebsiteAccess,
	addressAccess: readonly WebsiteAddressAccess[],
	addressAccessModified: readonly ModifiedAddressAccess[],
	access: boolean | undefined,
	interceptorDisabled: boolean | undefined,
	removed: boolean,
}

// Network blocking is enforced per hostname (getNetworkBlockingKey), so the editor keeps the user's explicit block toggles by that key, separately from the rows. Settings refreshes replace only the rows, so every row of a key, including a refreshed or newly added one, shows the user's decision, and a key the user did not toggle follows storage. A save therefore never carries contradictory toggles for one hostname.
export type NetworkBlockDecisions = ReadonlyMap<string, DeclarativeNetRequestBlockMode>

export const createEditableAccess = (websiteAccess: WebsiteAccess): EditableAccess => ({
	websiteAccess,
	addressAccess: websiteAccess.addressAccess === undefined ? [] : websiteAccess.addressAccess,
	addressAccessModified: websiteAccess.addressAccess === undefined ? [] : websiteAccess.addressAccess.map((addr) => ({
		address: addr.address,
		access: addr.access,
		removed: false,
	})),
	access: websiteAccess.access,
	interceptorDisabled: websiteAccess.interceptorDisabled,
	removed: false,
})

// Replace each row's stored record with the refreshed one while keeping the row edits the user made against the previous record.
export function mergeRefreshedWebsiteAccess(current: readonly EditableAccess[] | undefined, refreshed: WebsiteAccessArray): readonly EditableAccess[] {
	if (current === undefined) return refreshed.map(createEditableAccess)
	return refreshed.map((newAccess) => {
		const previousEntity = current.find((x) => x.websiteAccess.website.websiteOrigin === newAccess.website.websiteOrigin)
		if (previousEntity === undefined) return createEditableAccess(newAccess)
		// we need to merge edited and new updated access rights together
		const mergeAddressAccess = (addr: WebsiteAddressAccess) => {
			const previousModifiedAccess = previousEntity.addressAccessModified.find((x) => x.address === addr.address)
			const previousAccess = previousEntity.addressAccess.find((x) => x.address === addr.address)
			return {
				address: addr.address,
				access: previousModifiedAccess === undefined || previousAccess === undefined ? addr.access : (previousModifiedAccess.access === previousAccess.access ? addr.access : previousModifiedAccess.access),
				removed: previousModifiedAccess === undefined ? false : previousModifiedAccess.removed,
			}
		}
		return modifyObject(previousEntity, {
			websiteAccess: newAccess,
			addressAccess: newAccess.addressAccess === undefined ? [] : newAccess.addressAccess,
			addressAccessModified: newAccess.addressAccess === undefined ? [] : newAccess.addressAccess.map(mergeAddressAccess),
			access: previousEntity.access === previousEntity.websiteAccess.access ? newAccess.access : previousEntity.access,
		})
	})
}

export const setNetworkBlockDecision = (decisions: NetworkBlockDecisions, websiteOrigin: string, declarativeNetRequestBlockMode: DeclarativeNetRequestBlockMode): NetworkBlockDecisions => new Map([...decisions, [getNetworkBlockingKey(websiteOrigin), declarativeNetRequestBlockMode]])

// The block mode a row shows and saves: the user's decision for its hostname, otherwise the stored one.
export const getShownNetworkBlockMode = (editable: EditableAccess, decisions: NetworkBlockDecisions) => decisions.get(getNetworkBlockingKey(editable.websiteAccess.website.websiteOrigin)) ?? editable.websiteAccess.declarativeNetRequestBlockMode

export function hasEditableAccessChanged(state: EditableAccess, decisions: NetworkBlockDecisions) {
	if (state.removed
		|| state.access !== state.websiteAccess.access
		|| state.interceptorDisabled !== state.websiteAccess.interceptorDisabled
		|| getShownNetworkBlockMode(state, decisions) !== state.websiteAccess.declarativeNetRequestBlockMode
	) return true
	for (const [index, access] of state.addressAccessModified.entries()) {
		const addressAccessAtIndex = state.addressAccess[index]
		if (addressAccessAtIndex === undefined) throw new Error('addressAccessAtIndex was undefined')
		if (access.removed || addressAccessAtIndex.access !== access.access) {
			return true
		}
	}
	return false
}

const getAccessEdit = (editable: EditableAccess, decisions: NetworkBlockDecisions): ChangeInterceptorAccess['data'][number] => {
	const declarativeNetRequestBlockMode = getShownNetworkBlockMode(editable, decisions)
	return {
		oldEntry: editable.websiteAccess,
		newEntry: {
			website: editable.websiteAccess.website,
			addressAccess: editable.addressAccessModified.filter((x) => !x.removed).map((addr) => ({
				address: BigInt(addr.address),
				access: addr.access,
			})),
			...(editable.access !== undefined ? { access: editable.access } : {}),
			...(editable.interceptorDisabled !== undefined ? { interceptorDisabled: editable.interceptorDisabled } : {}),
			...(declarativeNetRequestBlockMode !== undefined ? { declarativeNetRequestBlockMode } : {}),
		},
		removed: editable.removed,
	}
}

// The save message and the access list the editor keeps afterwards. Both derive each row's block mode from the same decisions, so the kept list matches what the background stores.
export function getAccessListSave(editableAccessList: readonly EditableAccess[], decisions: NetworkBlockDecisions): { readonly message: ChangeInterceptorAccess, readonly savedWebsiteAccess: WebsiteAccessArray } {
	return {
		message: { method: 'popup_changeInterceptorAccess', data: editableAccessList.filter((editable) => hasEditableAccessChanged(editable, decisions)).map((editable) => getAccessEdit(editable, decisions)) },
		savedWebsiteAccess: editableAccessList.filter((editable) => !editable.removed).map((editable) => getAccessEdit(editable, decisions).newEntry),
	}
}
