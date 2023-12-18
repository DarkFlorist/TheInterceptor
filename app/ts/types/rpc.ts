import * as funtypes from 'funtypes'
import { EthereumQuantity } from './wire-types.js'

export type RpcEntry = funtypes.Static<typeof RpcEntry>
export const RpcEntry = funtypes.ReadonlyObject({
	name: funtypes.String,
	chainId: EthereumQuantity,
	httpsRpc: funtypes.String,
	currencyName: funtypes.String,
	currencyTicker: funtypes.String,
	primary: funtypes.Boolean,
	minimized: funtypes.Boolean,
	weth: EthereumQuantity,
})

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
	})
)

export type CodeMessageError = funtypes.Static<typeof CodeMessageError>
export const CodeMessageError = funtypes.ReadonlyObject({
	code: funtypes.Number,
	message: funtypes.String,
})
