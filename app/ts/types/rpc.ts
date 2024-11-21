import * as funtypes from 'funtypes'
import { EthereumQuantity } from './wire-types.js'
import { ChainIdWithUniversal } from './addressBookTypes.js'

export type ChainEntry = funtypes.Static<typeof ChainEntry>
export const ChainEntry = funtypes.Intersect(
	funtypes.ReadonlyObject({
		name: funtypes.String,
		chainId: ChainIdWithUniversal,
	}),
)

export type RpcEntry = funtypes.Static<typeof RpcEntry>
export const RpcEntry = funtypes.Intersect(
	funtypes.ReadonlyObject({
		name: funtypes.String,
		chainId: EthereumQuantity,
		httpsRpc: funtypes.String,
		currencyName: funtypes.String,
		currencyTicker: funtypes.String,
		primary: funtypes.Boolean,
		minimized: funtypes.Boolean,
	}),
	funtypes.ReadonlyPartial({
		currencyLogoUri: funtypes.String,
	})
)

export type RpcEntries = funtypes.Static<typeof RpcEntries>
export const RpcEntries = funtypes.ReadonlyArray(RpcEntry)

export type RpcNetwork = funtypes.Static<typeof RpcNetwork>
export const RpcNetwork = funtypes.Union(
	RpcEntry,
	funtypes.ReadonlyObject({
		httpsRpc: funtypes.Undefined,
		chainId: EthereumQuantity,
		name: funtypes.String,
		currencyName: funtypes.Literal('Ether?'),
		currencyTicker: funtypes.Literal('ETH?'),
		primary: funtypes.Literal(false),
		minimized: funtypes.Literal(true),
	})
)

export type CodeMessageError = funtypes.Static<typeof CodeMessageError>
export const CodeMessageError = funtypes.ReadonlyObject({
	code: funtypes.Number,
	message: funtypes.String,
})
