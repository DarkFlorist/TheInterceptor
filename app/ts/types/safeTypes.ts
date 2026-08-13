import * as funtypes from 'funtypes'
import { SafeTx } from './personal-message-definitions.js'
import { EthereumAddress, EthereumBytes32, EthereumQuantity, EthereumTimestamp } from './wire-types.js'
import { AddressBookEntry } from './addressBookTypes.js'

export type SafeContractStateSnapshot = funtypes.Static<typeof SafeContractStateSnapshot>
export const SafeContractStateSnapshot = funtypes.ReadonlyObject({
	version: funtypes.String,
	nonce: EthereumQuantity,
	owners: funtypes.ReadonlyArray(EthereumAddress),
	threshold: EthereumQuantity,
})

export type SafeMessageCoSignSnapshot = funtypes.Static<typeof SafeMessageCoSignSnapshot>
export const SafeMessageCoSignSnapshot = funtypes.ReadonlyObject({
	safeAddress: EthereumAddress,
	safeSignerAddress: EthereumAddress,
	safeTxHash: EthereumBytes32,
	reviewedSafeState: SafeContractStateSnapshot,
})

export type SafeSignerErrorDetails = funtypes.Static<typeof SafeSignerErrorDetails>
export const SafeSignerErrorDetails = funtypes.Union(
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

export type SafeTransactionSigningRequest = funtypes.Static<typeof SafeTransactionSigningRequest>
export const SafeTransactionSigningRequest = funtypes.ReadonlyObject({
	safeAddress: EthereumAddress,
	safeVersion: funtypes.String,
	threshold: EthereumQuantity,
	safeTxHash: EthereumBytes32,
	safeTx: SafeTx,
}).And(funtypes.Partial({
	// Undefined only while a reviewed proposal is waiting for the signer wallet to select an owner.
	safeSignerAddress: EthereumAddress,
	executionGasLimit: EthereumQuantity,
	reviewedSafeState: SafeContractStateSnapshot,
}))

export type SafeOwnerSignature = funtypes.Static<typeof SafeOwnerSignature>
export const SafeOwnerSignature = funtypes.ReadonlyObject({
	signer: EthereumAddress,
	signature: funtypes.String,
})

export type SafeStackTransaction = funtypes.Static<typeof SafeStackTransaction>
export const SafeStackTransaction = funtypes.ReadonlyObject({
	safeTx: SafeTx,
	safeTxHash: EthereumBytes32,
	created: EthereumTimestamp,
	websiteOrigin: funtypes.String,
	transactionIdentifier: EthereumQuantity,
	signatures: funtypes.ReadonlyArray(SafeOwnerSignature),
})

export type SafeTransactionStack = funtypes.Static<typeof SafeTransactionStack>
export const SafeTransactionStack = funtypes.ReadonlyObject({
	chainId: EthereumQuantity,
	safeAddress: EthereumAddress,
	safeVersion: funtypes.String,
	baseNonce: EthereumQuantity,
	threshold: EthereumQuantity,
	transactions: funtypes.ReadonlyArray(SafeStackTransaction),
})

export type SafeTransactionStacks = funtypes.Static<typeof SafeTransactionStacks>
export const SafeTransactionStacks = funtypes.ReadonlyArray(SafeTransactionStack)

export type SafeStackExport = funtypes.Static<typeof SafeStackExport>
export const SafeStackExport = funtypes.ReadonlyObject({
	name: funtypes.Literal('Interceptor Safe Stack'),
	version: funtypes.Literal('1.0.0'),
	stacks: SafeTransactionStacks,
})
