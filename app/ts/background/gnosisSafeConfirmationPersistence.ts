import * as funtypes from 'funtypes'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { GnosisSafeOwnerSignature, GnosisSafeStackTransaction, GnosisSafeTransactionSigningRequest } from '../types/gnosisSafeTypes.js'
import type { SimulationStackChange } from '../types/visualizer-types.js'
import { getErrorMessage } from '../utils/errors.js'
import { EthereumBytes32 } from '../types/wire-types.js'
import { getGnosisSafeTransactionStacks, updateTransactionState } from './storageVariables.js'
import { assertGnosisSafeContractStateUnchanged, assertGnosisSafeProposalChainMatchesConnectedNetwork, createGnosisSafeContractValidationFailure, createGnosisSafeOwnerValidationFailure, createGnosisSafeOwnerValidator, getGnosisSafeContractSnapshot, isGnosisSafeContractValidationFailure, isGnosisSafeOwnerValidationFailure } from '../gnosisSafe/gnosisSafeCore.js'
import { createGnosisSafeExecutionPreSimulationTransaction } from '../gnosisSafe/gnosisSafeSimulation.js'
import { mapGnosisSafeTransactionMetadata, mergeGnosisSafeOwnerSignatures, reconcileGnosisSafeTransactionStack, reconcileGnosisSafeTransactionState } from '../gnosisSafe/gnosisSafeStack.js'
import { isGnosisSafeSignerSelectionFailure, validateGnosisSafeMessageCoSignature } from './gnosisSafeConfirmationResolver.js'
import { createGnosisSafeSignerErrorStatus, type GnosisSafeSignerErrorStatus } from './gnosisSafeSignerErrors.js'
import { getGnosisSafePendingFlow } from '../gnosisSafe/gnosisSafePendingFlow.js'

export type GnosisSafeSignerReplyResolution =
	| { readonly status: 'not-safe' }
	| { readonly status: 'success', readonly result: string, readonly simulationStack: SimulationStackChange }
	| { readonly status: 'error', readonly approvalStatus: GnosisSafeSignerErrorStatus }

const signerError = (message: string): GnosisSafeSignerReplyResolution => ({
	status: 'error',
	approvalStatus: createGnosisSafeSignerErrorStatus(message),
})

export async function resolveGnosisSafeSignerReply(
	ethereum: EthereumClientService,
	pending: PendingTransactionOrSignableMessage,
	signerReply: unknown,
): Promise<GnosisSafeSignerReplyResolution> {
	const flow = getGnosisSafePendingFlow(pending)
	if (flow?.kind === 'proposal' && flow.pending.transactionOrMessageCreationStatus === 'Simulated') {
		return await persistSignedGnosisSafeTransaction(ethereum, flow.pending, flow.pending.safeFlow.safeTransaction, signerReply)
	}

	if (
		flow?.kind === 'messageCoSign'
		&& flow.pending.transactionOrMessageCreationStatus === 'Simulated'
	) {
		try {
			return { status: 'success', result: await validateGnosisSafeMessageCoSignature(ethereum, flow.pending, signerReply), simulationStack: 'unchanged' }
		} catch (error) {
			if (!isGnosisSafeContractValidationFailure(error) && !isGnosisSafeOwnerValidationFailure(error) && !isGnosisSafeSignerSelectionFailure(error)) throw error
			return signerError(`Gnosis Safe co-signature was rejected: ${ getErrorMessage(error) ?? 'The signer returned an invalid Gnosis Safe signature.' }`)
		}
	}
	return { status: 'not-safe' }
}

type PendingGnosisSafeTransaction = Extract<PendingTransactionOrSignableMessage, { readonly type: 'Transaction' }> & {
	readonly transactionOrMessageCreationStatus: 'Simulated'
}

async function prepareGnosisSafeProposalPersistence(
	ethereum: EthereumClientService,
	safeSigningRequest: GnosisSafeTransactionSigningRequest,
) {
	// The proposal is stored in the stack of the connected chain, so its domain chain must be that chain.
	assertGnosisSafeProposalChainMatchesConnectedNetwork(ethereum, safeSigningRequest.safeTx)
	if (safeSigningRequest.reviewedSafeState === undefined) {
		throw createGnosisSafeContractValidationFailure('Review this Gnosis Safe proposal again so its current owners, threshold, and nonce can be verified.')
	}
	const safeSnapshot = await getGnosisSafeContractSnapshot(ethereum, safeSigningRequest.safeAddress)
	assertGnosisSafeContractStateUnchanged(safeSigningRequest.reviewedSafeState, safeSnapshot.state)
	const storedStack = (await getGnosisSafeTransactionStacks()).find((stack) =>
		stack.chainId === ethereum.getChainId() && stack.safeAddress === safeSigningRequest.safeAddress
	)
	const existingStack = storedStack === undefined ? undefined : reconcileGnosisSafeTransactionStack(storedStack, safeSnapshot.state.nonce)
	const alreadyPersisted = existingStack?.transactions.some((transaction) => transaction.safeTxHash === safeSigningRequest.safeTxHash) === true
	const expectedNonce = safeSnapshot.state.nonce + BigInt(existingStack?.transactions.length ?? 0)
	if (!alreadyPersisted && safeSigningRequest.safeTx.message.nonce !== expectedNonce) {
		throw createGnosisSafeContractValidationFailure(`This proposal uses Gnosis Safe nonce ${ safeSigningRequest.safeTx.message.nonce.toString() }, but the next available nonce is ${ expectedNonce.toString() }. Review the rebased proposal again.`)
	}
	return safeSnapshot
}

async function persistSignedGnosisSafeTransaction(
	ethereum: EthereumClientService,
	pendingTransaction: PendingGnosisSafeTransaction,
	safeSigningRequest: GnosisSafeTransactionSigningRequest,
	signerReply: unknown,
): Promise<GnosisSafeSignerReplyResolution> {
	let ownerSignature: GnosisSafeOwnerSignature
	let safeSnapshot: Awaited<ReturnType<typeof getGnosisSafeContractSnapshot>>
	try {
		if (safeSigningRequest.safeSignerAddress === undefined) {
			throw createGnosisSafeContractValidationFailure('Connect a signer wallet and select a current Gnosis Safe owner before signing.')
		}
		safeSnapshot = await prepareGnosisSafeProposalPersistence(ethereum, safeSigningRequest)
		if (typeof signerReply !== 'string') throw createGnosisSafeOwnerValidationFailure('The signer returned a non-string Gnosis Safe owner signature.')
		ownerSignature = await createGnosisSafeOwnerValidator(
			ethereum, safeSigningRequest.safeAddress, safeSnapshot,
		).validateSignature(
			safeSigningRequest.safeTxHash,
			signerReply,
			safeSigningRequest.safeSignerAddress,
		)
	} catch (error) {
		if (!isGnosisSafeContractValidationFailure(error) && !isGnosisSafeOwnerValidationFailure(error)) throw error
		return signerError(`Gnosis Safe proposal or owner signature was rejected: ${ getErrorMessage(error) ?? 'The signer returned an invalid proposal signature.' }`)
	}
	return await persistGnosisSafeTransaction(ethereum, pendingTransaction, safeSigningRequest, safeSnapshot.state.nonce, [ownerSignature])
}

async function persistGnosisSafeTransaction(
	ethereum: EthereumClientService,
	pendingTransaction: PendingGnosisSafeTransaction,
	safeSigningRequest: GnosisSafeTransactionSigningRequest,
	currentSafeNonce: bigint,
	signatures: readonly GnosisSafeOwnerSignature[],
): Promise<GnosisSafeSignerReplyResolution> {
	const stackTransaction: GnosisSafeStackTransaction = {
		safeTx: safeSigningRequest.safeTx,
		safeTxHash: safeSigningRequest.safeTxHash,
		created: pendingTransaction.created,
		websiteOrigin: pendingTransaction.website.websiteOrigin,
		transactionIdentifier: pendingTransaction.transactionIdentifier,
		signatures,
	}
	const transaction = {
		...createGnosisSafeExecutionPreSimulationTransaction(pendingTransaction.transactionToSimulate, safeSigningRequest),
		safeTransaction: stackTransaction,
	}
	try {
		await updateTransactionState((previousState) => {
			const reconciledState = reconcileGnosisSafeTransactionState(
				previousState,
				ethereum.getChainId(),
				safeSigningRequest.safeAddress,
				currentSafeNonce,
			)
			const existingStack = reconciledState.safeTransactionStacks.find((stack) =>
				stack.chainId === ethereum.getChainId() && stack.safeAddress === safeSigningRequest.safeAddress
			)
			let persistedStackTransaction = stackTransaction
			let safeTransactionStacks: typeof previousState.safeTransactionStacks
			if (existingStack === undefined) {
				safeTransactionStacks = [...reconciledState.safeTransactionStacks, {
					chainId: ethereum.getChainId(),
					safeAddress: safeSigningRequest.safeAddress,
					safeVersion: safeSigningRequest.safeVersion,
					baseNonce: safeSigningRequest.safeTx.message.nonce,
					threshold: safeSigningRequest.threshold,
					transactions: [stackTransaction],
				}]
			} else {
				const duplicate = existingStack.transactions.find((entry) => entry.safeTxHash === safeSigningRequest.safeTxHash)
				if (duplicate !== undefined) {
					persistedStackTransaction = { ...duplicate, signatures: mergeGnosisSafeOwnerSignatures(duplicate.signatures, signatures) }
					safeTransactionStacks = reconciledState.safeTransactionStacks.map((stack) => stack === existingStack
						? { ...stack, transactions: stack.transactions.map((entry) => entry === duplicate ? persistedStackTransaction : entry) }
						: stack
					)
				} else {
					const expectedNonce = existingStack.baseNonce + BigInt(existingStack.transactions.length)
					if (safeSigningRequest.safeTx.message.nonce !== expectedNonce) {
						throw createGnosisSafeContractValidationFailure(`Gnosis Safe transaction nonce ${ safeSigningRequest.safeTx.message.nonce.toString() } does not follow local stack nonce ${ expectedNonce.toString() }.`)
					}
					safeTransactionStacks = reconciledState.safeTransactionStacks.map((stack) => stack === existingStack
						? { ...stack, transactions: [...stack.transactions, stackTransaction] }
						: stack
					)
				}
			}
			let updatedSafeMirror = false
			const stackWithUpdatedSafeMirror = mapGnosisSafeTransactionMetadata(reconciledState.interceptorTransactionStack, (safeTransaction) => {
				if (safeTransaction.safeTxHash !== safeSigningRequest.safeTxHash) return safeTransaction
				updatedSafeMirror = true
				return persistedStackTransaction
			})
			const updatedOperations = stackWithUpdatedSafeMirror.operations
			const interceptorTransactionStack = updatedSafeMirror || updatedOperations.some((operation) =>
				operation.type === 'Transaction' && operation.preSimulationTransaction.transactionIdentifier === pendingTransaction.transactionIdentifier
			)
				? { operations: updatedOperations }
				: { operations: [...updatedOperations, {
					type: 'Transaction' as const,
					preSimulationTransaction: { ...transaction, safeTransaction: persistedStackTransaction },
				}] }
			return { safeTransactionStacks, interceptorTransactionStack }
		})
	} catch (error) {
		if (!isGnosisSafeContractValidationFailure(error)) throw error
		return signerError(`Gnosis Safe proposal could not be persisted: ${ getErrorMessage(error) ?? 'The local Gnosis Safe proposal stack changed.' }`)
	}
	return { status: 'success', result: funtypes.String.parse(EthereumBytes32.serialize(safeSigningRequest.safeTxHash)), simulationStack: 'safeProposalStored' }
}

export async function persistUnsignedGnosisSafeTransaction(
	ethereum: EthereumClientService,
	pending: PendingTransactionOrSignableMessage,
): Promise<GnosisSafeSignerReplyResolution> {
	const flow = getGnosisSafePendingFlow(pending)
	if (flow?.kind !== 'proposal' || flow.pending.transactionOrMessageCreationStatus !== 'Simulated') return { status: 'not-safe' }
	try {
		const safeSnapshot = await prepareGnosisSafeProposalPersistence(ethereum, flow.pending.safeFlow.safeTransaction)
		return await persistGnosisSafeTransaction(ethereum, flow.pending, flow.pending.safeFlow.safeTransaction, safeSnapshot.state.nonce, [])
	} catch (error) {
		if (!isGnosisSafeContractValidationFailure(error)) throw error
		return signerError(`Gnosis Safe proposal could not be added to the stack: ${ getErrorMessage(error) ?? 'The local Gnosis Safe proposal stack changed.' }`)
	}
}
