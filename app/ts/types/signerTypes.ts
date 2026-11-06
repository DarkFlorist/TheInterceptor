import { isSignerName, type SignerName as SignerIdentityName } from '../utils/signerIdentity.js'
import * as funtypes from 'funtypes'
import { isEip6963ProviderUuid, isEip6963ProviderName, isEip6963ProviderIcon, isEip6963ProviderRdns, type EIP6963ProviderInfo as ProviderInfo } from '../utils/eip6963ProviderInfo.js'
import { EthereumAddress, EthereumQuantity } from './wire-types.js'

export type SignerName = SignerIdentityName
export const SignerName = funtypes.Guard(isSignerName)

// The runtime schema adapts the realm-neutral provider-info contract owned by the shared validator module.
export type EIP6963ProviderInfo = ProviderInfo
export const EIP6963ProviderInfo = funtypes.ReadonlyObject({
	uuid: funtypes.String.withConstraint(isEip6963ProviderUuid),
	name: funtypes.String.withConstraint(isEip6963ProviderName),
	icon: funtypes.String.withConstraint(isEip6963ProviderIcon),
	rdns: funtypes.String.withConstraint(isEip6963ProviderRdns),
}) satisfies funtypes.Runtype<ProviderInfo>

export type SignerPreference = funtypes.Static<typeof SignerPreference>
export const SignerPreference = funtypes.ReadonlyObject({
	websiteOrigin: funtypes.String,
	rdns: EIP6963ProviderInfo.fields.rdns,
})

export type SignerPreferences = funtypes.Static<typeof SignerPreferences>
export const SignerPreferences = funtypes.ReadonlyArray(SignerPreference)
export type SigningAddressPreference = funtypes.Static<typeof SigningAddressPreference>
export const SigningAddressPreference = funtypes.Union(
	funtypes.ReadonlyObject({
		signerAddress: EthereumAddress,
		selection: funtypes.Literal('signer'),
	}),
	funtypes.ReadonlyObject({
		signerAddress: EthereumAddress,
		selection: funtypes.Literal('safe'),
		safeAddress: EthereumAddress,
		chainId: EthereumQuantity,
	}),
)

export type SigningAddressPreferences = funtypes.Static<typeof SigningAddressPreferences>
export const SigningAddressPreferences = funtypes.ReadonlyArray(SigningAddressPreference)
