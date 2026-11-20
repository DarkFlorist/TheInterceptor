import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumQuantity } from './wire-types.js'
import { RichToken } from './richMode.js'

export type ModifyRichTokenRequest = funtypes.Static<typeof ModifyRichTokenRequest>
export const ModifyRichTokenRequest = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_modifyRichToken'),
	data: funtypes.Union(
		funtypes.ReadonlyObject({
			action: funtypes.Literal('Add'),
			tokenAddress: EthereumAddress,
			address: EthereumAddress,
		}).And(funtypes.ReadonlyPartial({ tokenId: EthereumQuantity })),
		funtypes.ReadonlyObject({
			action: funtypes.Literal('Remove'),
			tokenAddress: EthereumAddress,
			address: EthereumAddress,
		}).And(funtypes.ReadonlyPartial({ tokenId: EthereumQuantity })),
		funtypes.ReadonlyObject({
			action: funtypes.Literal('SetAmount'),
			tokenAddress: EthereumAddress,
			address: EthereumAddress,
			amount: EthereumQuantity,
		}).And(funtypes.ReadonlyPartial({ tokenId: EthereumQuantity })),
	),
}).asReadonly()

// A successful reply means the change is saved. 'Refreshed' means a completed refresh covered it; 'Superseded' means a newer queued refresh replaced this one before it ran and that refresh will update the simulation; 'Unavailable' means the refresh failed and the balances shown may be stale.
export type RichTokenSimulationRefresh = funtypes.Static<typeof RichTokenSimulationRefresh>
export const RichTokenSimulationRefresh = funtypes.Union(funtypes.Literal('Refreshed'), funtypes.Literal('Superseded'), funtypes.Literal('Unavailable'))

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
