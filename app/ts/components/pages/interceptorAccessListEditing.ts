import type { DeclarativeNetRequestBlockMode } from '../../types/addressBookTypes.js'
import type { ChangeInterceptorAccess } from '../../types/interceptor-messages.js'
import type { WebsiteAccess, WebsiteAccessArray, WebsiteAddressAccess } from '../../types/websiteAccessTypes.js'
import { modifyObject } from '../../utils/typescript.js'
import { shareNetworkBlocking } from '../../utils/websiteOrigin.js'

export interface ModifiedAddressAccess {
	address: bigint,
	access: boolean,
	removed: boolean,
}

export interface EditableAccess {
	websiteAccess: WebsiteAccess,
	addressAccess: readonly WebsiteAddressAccess[],
	addressAccessModified: readonly ModifiedAddressAccess[],
	access: boolean | undefined,
	interceptorDisabled: boolean | undefined,
	removed: boolean,
	declarativeNetRequestBlockMode: DeclarativeNetRequestBlockMode | undefined
}

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
	declarativeNetRequestBlockMode: websiteAccess.declarativeNetRequestBlockMode,
})

// The block setting is enforced per hostname, so toggling it on one row sets every row of that hostname. The user sees the hostname-wide effect before saving, and a save never carries contradictory toggles for one hostname, which the background rejects.
export function setEditableNetworkBlockMode(editableAccessList: readonly EditableAccess[], index: number, declarativeNetRequestBlockMode: DeclarativeNetRequestBlockMode): readonly EditableAccess[] {
	const toggledWebsiteOrigin = editableAccessList[index]?.websiteAccess.website.websiteOrigin
	if (toggledWebsiteOrigin === undefined) return editableAccessList
	return editableAccessList.map((editable) => shareNetworkBlocking(editable.websiteAccess.website.websiteOrigin, toggledWebsiteOrigin) ? modifyObject(editable, { declarativeNetRequestBlockMode }) : editable)
}

export function hasEditableAccessChanged(state: EditableAccess) {
	if (state.removed
		|| state.access !== state.websiteAccess.access
		|| state.interceptorDisabled !== state.websiteAccess.interceptorDisabled
		|| state.declarativeNetRequestBlockMode !== state.websiteAccess.declarativeNetRequestBlockMode
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

const getAccessEdit = (editable: EditableAccess): ChangeInterceptorAccess['data'][number] => ({
	oldEntry: editable.websiteAccess,
	newEntry: {
		website: editable.websiteAccess.website,
		addressAccess: editable.addressAccessModified.filter((x) => !x.removed).map((addr) => ({
			address: BigInt(addr.address),
			access: addr.access,
		})),
		...(editable.access !== undefined ? { access: editable.access } : {}),
		...(editable.interceptorDisabled !== undefined ? { interceptorDisabled: editable.interceptorDisabled } : {}),
		...(editable.declarativeNetRequestBlockMode !== undefined ? { declarativeNetRequestBlockMode: editable.declarativeNetRequestBlockMode } : {}),
	},
	removed: editable.removed,
})

// The save message and the access list the editor keeps afterwards, which matches what the background stores because each hostname's block toggles were already applied to all of its rows.
export function getAccessListSave(editableAccessList: readonly EditableAccess[]): { readonly message: ChangeInterceptorAccess, readonly savedWebsiteAccess: WebsiteAccessArray } {
	return {
		message: { method: 'popup_changeInterceptorAccess', data: editableAccessList.filter(hasEditableAccessChanged).map(getAccessEdit) },
		savedWebsiteAccess: editableAccessList.filter((editable) => !editable.removed).map((editable) => getAccessEdit(editable).newEntry),
	}
}
