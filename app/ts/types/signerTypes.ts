import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumQuantity } from './wire-types.js'

export type SignerName = funtypes.Static<typeof SignerName>
export const SignerName = funtypes.String.withConstraint((value) => value.length > 0 && value.length <= 128)

const internalSignerStatuses = new Set(['NoSigner', 'NotRecognizedSigner', 'NoSignerDetected'])

export type EIP6963ProviderInfo = funtypes.Static<typeof EIP6963ProviderInfo>
export const EIP6963ProviderInfo = funtypes.ReadonlyObject({
	uuid: funtypes.String.withConstraint((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)),
	name: SignerName.withConstraint((value) => !internalSignerStatuses.has(value)),
	icon: funtypes.String.withConstraint((value) => value.length > 0 && value.length <= 131_072),
	rdns: funtypes.String.withConstraint((value) => value.length > 0
		&& value.length <= 255
		&& /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value)),
})

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
