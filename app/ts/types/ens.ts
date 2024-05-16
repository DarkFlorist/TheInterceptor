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

export type ENSLabelHash = funtypes.Static<typeof ENSLabelHash>
export const ENSLabelHash = funtypes.ReadonlyObject({
	labelHash: EthereumBytes32,
	label: funtypes.String,
})

export type MaybeENSLabelHash = funtypes.Static<typeof MaybeENSLabelHash>
export const MaybeENSLabelHash = funtypes.ReadonlyObject({
	labelHash: EthereumBytes32,
	label: funtypes.Union(funtypes.String, funtypes.Undefined),
})

export type ENSLabelHashes = funtypes.Static<typeof ENSLabelHashes>
export const ENSLabelHashes = funtypes.ReadonlyArray(ENSLabelHash)

export type MaybeENSLabelHashes = funtypes.Static<typeof MaybeENSLabelHashes>
export const MaybeENSLabelHashes = funtypes.ReadonlyArray(MaybeENSLabelHash)
