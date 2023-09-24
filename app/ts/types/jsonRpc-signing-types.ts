import * as funtypes from 'funtypes'
import { EthereumAddress } from './wire-types.js'
import { EIP712Message } from './eip721.js'

export type OldSignTypedDataParams = funtypes.Static<typeof OldSignTypedDataParams>
export const OldSignTypedDataParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_signTypedData'),
	params: funtypes.ReadonlyTuple(funtypes.ReadonlyArray(
		funtypes.ReadonlyObject({
			name: funtypes.String,
			type: funtypes.String,
		})
	), EthereumAddress),
})

export type PersonalSignParams = funtypes.Static<typeof PersonalSignParams>
export const PersonalSignParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('personal_sign'),
	params: funtypes.Union(
		funtypes.ReadonlyTuple(funtypes.String, EthereumAddress, funtypes.Union(funtypes.String, funtypes.Undefined, funtypes.Null)), // message, account, password
		funtypes.ReadonlyTuple(funtypes.String, EthereumAddress) // message, account
	)
})

export type SignTypedDataParams = funtypes.Static<typeof SignTypedDataParams>
export const SignTypedDataParams = funtypes.ReadonlyObject({
	method: funtypes.Union(
		funtypes.Literal('eth_signTypedData_v1'),
		funtypes.Literal('eth_signTypedData_v2'),
		funtypes.Literal('eth_signTypedData_v3'),
		funtypes.Literal('eth_signTypedData_v4'),
	),
	params: funtypes.ReadonlyTuple(EthereumAddress, EIP712Message), // address that will sign the message, typed data
})

export type SignMessageParams = funtypes.Static<typeof SignMessageParams>
export const SignMessageParams = funtypes.Union(PersonalSignParams, SignTypedDataParams, OldSignTypedDataParams)
