import * as funtypes from 'funtypes'
import { EthereumAddress } from './wire-types.js'
import { RpcEntry, RpcEntries } from './rpc.js'

export type ModifyMakeMeRich = funtypes.Static<typeof ModifyMakeMeRich>
export const ModifyMakeMeRich = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_modifyMakeMeRich'),
	data: funtypes.ReadonlyObject({
		add: funtypes.Boolean,
		address: funtypes.Union(funtypes.Literal('CurrentAddress'), EthereumAddress),
	})
}).asReadonly()

export type EnableSimulationMode = funtypes.Static<typeof EnableSimulationMode>
export const EnableSimulationMode = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_enableSimulationMode'),
	data: funtypes.Boolean
}).asReadonly()

export type ChangeActiveChain = funtypes.Static<typeof ChangeActiveChain>
export const ChangeActiveChain = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_changeActiveRpc'),
	data: RpcEntry,
}).asReadonly()

export type ChangeActiveAddress = funtypes.Static<typeof ChangeActiveAddress>
export const ChangeActiveAddress = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_changeActiveAddress'),
	data: funtypes.ReadonlyObject({
		simulationMode: funtypes.Boolean,
		activeAddress: funtypes.Union(EthereumAddress, funtypes.Literal('signer')),
	}).And(funtypes.ReadonlyPartial({
		// The kind of the picked address-book entry, which tells a Safe apart from an ordinary entry at the same address.
		activeAddressKind: funtypes.Union(funtypes.Literal('safe'), funtypes.Literal('account')),
	}))
}).asReadonly()

export type ImportSettings = funtypes.Static<typeof ImportSettings>
export const ImportSettings = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_import_settings'),
	data: funtypes.ReadonlyObject({ fileContents: funtypes.String })
})

export type ImportSettingsReply = funtypes.Static<typeof ImportSettingsReply>
export const ImportSettingsReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_initiate_export_settings_reply'),
	data: funtypes.Union(
		funtypes.ReadonlyObject({ success: funtypes.Literal(true) }),
		funtypes.ReadonlyObject({ success: funtypes.Literal(false), errorMessage: funtypes.String })
	)
})

// Keep import-specific wire construction beside its codec; protocol descriptors select this builder.
export const createImportSettingsFailureReply = (errorMessage: string): ImportSettingsReply => ({
	method: 'popup_initiate_export_settings_reply',
	data: { success: false, errorMessage },
})

export type SetRpcList = funtypes.Static<typeof SetRpcList>
export const SetRpcList = funtypes.ReadonlyObject({
	method: funtypes.Union(funtypes.Literal('popup_set_rpc_list')),
	data: RpcEntries,
})

export type PopupSettingsRequest = ModifyMakeMeRich | EnableSimulationMode | ChangeActiveChain | ChangeActiveAddress | SetRpcList

export type PopupSettingsRequestWithSharedReply = Exclude<PopupSettingsRequest, ChangeActiveAddress>
