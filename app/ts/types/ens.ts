import * as funtypes from 'funtypes'
import { EthereumBytes32 } from './wire-types.js'

export type MaybeENSNameHash = funtypes.Static<typeof MaybeENSNameHash>
export const MaybeENSNameHash = funtypes.ReadonlyObject({
	nameHash: EthereumBytes32,
	name: funtypes.Union(funtypes.String, funtypes.Undefined),
})
export type MaybeENSNameHashes = funtypes.Static<typeof MaybeENSNameHashes>
export const MaybeENSNameHashes = funtypes.ReadonlyArray(MaybeENSNameHash)

export type ENSNameHash = funtypes.Static<typeof ENSNameHash>
export const ENSNameHash = funtypes.ReadonlyObject({
	nameHash: EthereumBytes32,
	name: funtypes.String,
})

export type ENSNameHashes = funtypes.Static<typeof ENSNameHashes>
export const ENSNameHashes = funtypes.ReadonlyArray(ENSNameHash)
