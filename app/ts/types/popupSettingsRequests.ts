import * as funtypes from 'funtypes'
import { EthereumAddress } from './wire-types.js'
import { RpcEntry } from './rpc.js'

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
	})
}).asReadonly()

export type PopupSettingsRequest = ModifyMakeMeRich | EnableSimulationMode | ChangeActiveChain | ChangeActiveAddress

export type PopupSettingsRequestWithSharedReply = Exclude<PopupSettingsRequest, ChangeActiveAddress>
