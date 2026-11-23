import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumQuantity } from './wire-types.js'
import { RichToken } from './richMode.js'

export type ModifyRichTokenRequest = funtypes.Static<typeof ModifyRichTokenRequest>
export const ModifyRichTokenRequest = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_modifyRichToken'),
	data: funtypes.Union(
		funtypes.ReadonlyObject({
			action: funtypes.Literal('Add'),
			chainId: EthereumQuantity,
			tokenAddress: EthereumAddress,
			address: EthereumAddress,
		}).And(funtypes.ReadonlyPartial({ tokenId: EthereumQuantity })),
		funtypes.ReadonlyObject({
			action: funtypes.Literal('Remove'),
			chainId: EthereumQuantity,
			tokenAddress: EthereumAddress,
			address: EthereumAddress,
		}).And(funtypes.ReadonlyPartial({ tokenId: EthereumQuantity })),
		funtypes.ReadonlyObject({
			action: funtypes.Literal('SetAmount'),
			chainId: EthereumQuantity,
			tokenAddress: EthereumAddress,
			address: EthereumAddress,
			amount: EthereumQuantity,
		}).And(funtypes.ReadonlyPartial({ tokenId: EthereumQuantity })),
	),
}).asReadonly()

// A successful reply means the change is saved and the simulation is not known to be unavailable. 'Refreshed' means the simulation reflects it; 'Superseded' means a newer queued refresh replaced this one before it ran and that refresh will update the simulation. A change saved while the simulation is unavailable replies as a failure with the shared saved-but-unavailable message, exactly like the rich setting command.
export type RichTokenSimulationRefresh = funtypes.Static<typeof RichTokenSimulationRefresh>
export const RichTokenSimulationRefresh = funtypes.Union(funtypes.Literal('Refreshed'), funtypes.Literal('Superseded'))

export const ModifyRichTokenReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_modifyRichToken'),
	result: funtypes.Union(
		funtypes.ReadonlyObject({
			success: funtypes.Literal(true),
			richToken: funtypes.Union(RichToken, funtypes.Undefined),
			simulationRefresh: RichTokenSimulationRefresh,
		}),
		funtypes.ReadonlyObject({
			success: funtypes.Literal(false),
			error: funtypes.String,
		}),
	),
})

export const createRichTokenFailureReply = (error: string) => ({ method: 'popup_modifyRichToken' as const, result: { success: false as const, error } })
