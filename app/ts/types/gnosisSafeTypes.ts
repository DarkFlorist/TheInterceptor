import { GnosisSafeMessageReview } from './gnosisSafeReview.js'
import * as funtypes from 'funtypes'
import { GnosisSafeTx } from './personal-message-definitions.js'
import { EthereumAddress, EthereumBytes32, EthereumQuantity, EthereumTimestamp } from './wire-types.js'
import { AddressBookEntry } from './addressBookTypes.js'

export type GnosisSafeContractStateSnapshot = funtypes.Static<typeof GnosisSafeContractStateSnapshot>
export const GnosisSafeContractStateSnapshot = funtypes.ReadonlyObject({
	version: funtypes.String,
	nonce: EthereumQuantity,
	owners: funtypes.ReadonlyArray(EthereumAddress),
	threshold: EthereumQuantity,
})

// How many owner signatures a Safe needs to execute, and whether the account asked to sign is one of its owners.
export type GnosisSafeSignatureRequirement = funtypes.Static<typeof GnosisSafeSignatureRequirement>
export const GnosisSafeSignatureRequirement = funtypes.ReadonlyObject({
	threshold: EthereumQuantity,
	ownerCount: EthereumQuantity,
	signerIsOwner: funtypes.Boolean,
})

export type GnosisSafeMessageCoSignSnapshot = funtypes.Static<typeof GnosisSafeMessageCoSignSnapshot>
export const GnosisSafeMessageCoSignSnapshot = funtypes.ReadonlyObject({
	safeAddress: EthereumAddress,
	safeSignerAddress: EthereumAddress,
	reviewedSafeState: GnosisSafeContractStateSnapshot,
}).And(funtypes.Union(
	funtypes.ReadonlyObject({ safeTxHash: EthereumBytes32 }),
	funtypes.ReadonlyObject({ safeMessageHash: EthereumBytes32 }),
))

export type GnosisSafeSignerErrorDetails = funtypes.Static<typeof GnosisSafeSignerErrorDetails>
export const GnosisSafeSignerErrorDetails = funtypes.Union(
	funtypes.ReadonlyObject({
		kind: funtypes.Literal('safeSigningAccountMismatch'),
		requestedSigningAccount: EthereumAddress,
		activeSafe: EthereumAddress,
		requestedSafe: EthereumAddress,
		safeOwners: funtypes.ReadonlyArray(EthereumAddress),
		safeOwnerAddressBookEntries: funtypes.ReadonlyArray(AddressBookEntry),
	}).And(funtypes.ReadonlyPartial({
		safeOwnersUnavailableReason: funtypes.String,
	})),
	funtypes.ReadonlyObject({
		kind: funtypes.Literal('safeOwnerMismatch'),
		expectedOwner: EthereumAddress,
	}).And(funtypes.ReadonlyPartial({
		walletAccount: EthereumAddress,
	})),
)

export type GnosisSafeTransactionSigningRequest = funtypes.Static<typeof GnosisSafeTransactionSigningRequest>
export const GnosisSafeTransactionSigningRequest = funtypes.ReadonlyObject({
	safeAddress: EthereumAddress,
	safeVersion: funtypes.String,
	threshold: EthereumQuantity,
	safeTxHash: EthereumBytes32,
	safeTx: GnosisSafeTx,
}).And(funtypes.Partial({
	// Undefined only while a reviewed proposal is waiting for the signer wallet to select an owner.
	safeSignerAddress: EthereumAddress,
	executionGasLimit: EthereumQuantity,
	messageReview: GnosisSafeMessageReview,
	reviewedSafeState: GnosisSafeContractStateSnapshot,
}))

// How a page asked for a Gnosis Safe transaction beyond its call: the SafeTx operation (0 call, 1 delegate call), and the message an on-chain Safe message approval signs.
export type GnosisSafeTransactionRequestContext = funtypes.Static<typeof GnosisSafeTransactionRequestContext>
export const GnosisSafeTransactionRequestContext = funtypes.ReadonlyObject({
	operation: funtypes.Union(funtypes.Literal(0), funtypes.Literal(1)),
}).And(funtypes.ReadonlyPartial({
	messageReview: GnosisSafeMessageReview,
}))

export type GnosisSafeOwnerSignature = funtypes.Static<typeof GnosisSafeOwnerSignature>
export const GnosisSafeOwnerSignature = funtypes.ReadonlyObject({
	signer: EthereumAddress,
	signature: funtypes.String,
})

export type GnosisSafeStackTransaction = funtypes.Static<typeof GnosisSafeStackTransaction>
export const GnosisSafeStackTransaction = funtypes.ReadonlyObject({
	safeTx: GnosisSafeTx,
	safeTxHash: EthereumBytes32,
	created: EthereumTimestamp,
	websiteOrigin: funtypes.String,
	transactionIdentifier: EthereumQuantity,
	signatures: funtypes.ReadonlyArray(GnosisSafeOwnerSignature),
})

export type GnosisSafeTransactionStack = funtypes.Static<typeof GnosisSafeTransactionStack>
export const GnosisSafeTransactionStack = funtypes.ReadonlyObject({
	chainId: EthereumQuantity,
	safeAddress: EthereumAddress,
	safeVersion: funtypes.String,
	baseNonce: EthereumQuantity,
	threshold: EthereumQuantity,
	transactions: funtypes.ReadonlyArray(GnosisSafeStackTransaction),
})

export type GnosisSafeTransactionStacks = funtypes.Static<typeof GnosisSafeTransactionStacks>
export const GnosisSafeTransactionStacks = funtypes.ReadonlyArray(GnosisSafeTransactionStack)

export type GnosisSafeStackExport = funtypes.Static<typeof GnosisSafeStackExport>
export const GnosisSafeStackExport = funtypes.ReadonlyObject({
	name: funtypes.Literal('Interceptor Safe Stack'),
	version: funtypes.Literal('1.0.0'),
	stacks: GnosisSafeTransactionStacks,
})
