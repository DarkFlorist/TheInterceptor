import * as funtypes from 'funtypes'
import type { PopupSettingsRequest } from './popupSettingsRequests.js'

// Exhaustive over settings requests: admission and shared status use this definition.
export const popupSettingsOperations = {
	popup_changeActiveAddress: { operation: 'wallet', replyType: 'ChangeActiveAddressReply' },
	popup_enableSimulationMode: { operation: 'mode', replyType: 'PopupSettingsChangeReply' },
	popup_changeActiveRpc: { operation: 'rpc', replyType: 'PopupSettingsChangeReply' },
	popup_modifyMakeMeRich: { operation: 'rich', replyType: 'PopupSettingsChangeReply' },
} as const satisfies Record<PopupSettingsRequest['method'], { operation: string, replyType: 'ChangeActiveAddressReply' | 'PopupSettingsChangeReply' }>

const operations = Object.values(popupSettingsOperations)
export type PopupSettingsOperation = typeof operations[number]['operation']
export const PopupSettingsOperation = funtypes.String.withGuard((value): value is PopupSettingsOperation => operations.some(entry => entry.operation === value))
export const getPopupSettingsOperation = (method: string) => Object.entries(popupSettingsOperations).find(([key]) => key === method)?.[1]

export type PopupSettingsChangeStatus = funtypes.Static<typeof PopupSettingsChangeStatus>
export const PopupSettingsChangeStatus = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_settingsChangeStatus'),
	data: funtypes.ReadonlyObject({ revision: funtypes.Number, operation: funtypes.Union(funtypes.Undefined, PopupSettingsOperation) }),
})

export function acceptPopupSettingsChangeStatus(current: PopupSettingsChangeStatus['data'], incoming: PopupSettingsChangeStatus['data']) {
	return incoming.revision >= current.revision ? incoming : current
}
