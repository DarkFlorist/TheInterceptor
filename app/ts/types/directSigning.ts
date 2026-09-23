import { DirectSigningMethod } from './signingMethods.js'
import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumQuantity } from './wire-types.js'
import { SigningWallet, SigningWalletBinding } from './signingWallet.js'
import { UniqueRequestIdentifier } from '../utils/requests.js'

export type DirectSigningInput = funtypes.Static<typeof DirectSigningInput>
export const DirectSigningInput = funtypes.ReadonlyObject({
	method: DirectSigningMethod,
	data: funtypes.String.withConstraint((value) => value.length <= 131074),
	address: funtypes.String,
	chainId: EthereumQuantity,
})
export type DirectSigningRecord = funtypes.Static<typeof DirectSigningRecord>
export const DirectSigningRecord = funtypes.ReadonlyObject({
	id: funtypes.String,
	request: UniqueRequestIdentifier,
	binding: SigningWalletBinding,
	websiteOrigin: funtypes.String,
	rpcUrl: funtypes.String,
	input: DirectSigningInput,
	revision: funtypes.String,
	created: funtypes.Number,
	phase: funtypes.Union(funtypes.Literal('review'), funtypes.Literal('approved'), funtypes.Literal('signed'), funtypes.Literal('submitting'), funtypes.Literal('submitted'), funtypes.Literal('confirmed'), funtypes.Literal('cancelled')),
}).And(funtypes.ReadonlyPartial({ result: funtypes.String, transactionHash: funtypes.String, executionSucceeded: funtypes.Boolean }))
export const DirectSigningRecords = funtypes.ReadonlyArray(DirectSigningRecord).withConstraint((records) => records.length <= 100)

export const SigningPageRequest = funtypes.Union(
	funtypes.ReadonlyObject({ method: funtypes.Literal('signing_wallets') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('signing_setSafeAccounts'), chainId: EthereumQuantity, address: EthereumAddress, owner: EthereumAddress, executor: funtypes.Union(EthereumAddress, funtypes.Undefined) }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('signing_saveWallet'), address: EthereumAddress, wallet: funtypes.Union(SigningWallet, funtypes.Undefined), revision: funtypes.Union(funtypes.String, funtypes.Undefined), name: funtypes.Union(funtypes.String, funtypes.Undefined) }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('signing_get'), id: funtypes.String }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('signing_approve'), id: funtypes.String, revision: funtypes.String }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('signing_result'), id: funtypes.String, revision: funtypes.String, result: funtypes.String.withConstraint((value) => value.length <= 131074) }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('signing_broadcast'), id: funtypes.String, revision: funtypes.String }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('signing_cancel'), id: funtypes.String }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('signing_editFees'), id: funtypes.String, revision: funtypes.String, nonce: EthereumQuantity, gas: EthereumQuantity, maxFeePerGas: EthereumQuantity, maxPriorityFeePerGas: EthereumQuantity }),
)
export type SigningPageRequest = funtypes.Static<typeof SigningPageRequest>

/** Commands that operate on an existing, persisted signing request. */
export type DirectSigningRequest = Extract<SigningPageRequest, { id: string }>
