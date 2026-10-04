import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumQuantity } from './wire-types.js'

export type DelegateClearingPreference = funtypes.Static<typeof DelegateClearingPreference>
export const DelegateClearingPreference = funtypes.ReadonlyObject({
	address: EthereumAddress,
	chainId: EthereumQuantity,
})

export type DelegateClearingPreferences = funtypes.Static<typeof DelegateClearingPreferences>
export const DelegateClearingPreferences = funtypes.ReadonlyArray(DelegateClearingPreference)
