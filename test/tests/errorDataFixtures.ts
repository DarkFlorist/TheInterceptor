import { encodeAbiValues } from '../../app/ts/utils/abiRuntime.js'

// Revert data as nodes return it for `revert(reason)` and for compiler panics, shared so every test encodes the same selectors.
export const encodeErrorString = (reason: string) => `0x08c379a0${ encodeAbiValues(['string'], [reason]).slice(2) }`
export const encodePanic = (code: bigint) => `0x4e487b71${ encodeAbiValues(['uint256'], [code]).slice(2) }`
