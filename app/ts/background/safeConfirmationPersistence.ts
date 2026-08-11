import * as funtypes from 'funtypes'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { SafeOwnerSignature, SafeStackTransaction, SafeTransactionSigningRequest } from '../types/safeTypes.js'
import { getErrorMessage } from '../utils/errors.js'
import { EthereumBytes32 } from '../types/wire-types.js'
import { getHtmlFile } from './backgroundUtils.js'
import { getSafeTransactionStacks, updateTransactionState } from './storageVariables.js'
import { updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'
import { openPopupOrTab } from '../utils/popupOrTab.js'
import { assertSafeContractStateUnchanged, createSafeOwnerValidator, getSafeContractSnapshot } from '../safe/safeCore.js'
import { createSafeExecutionPreSimulationTransaction } from '../safe/safeSimulation.js'
import { reconcileSafeTransactionStack, reconcileSafeTransactionState } from '../safe/safeStack.js'
import { validateSafeMessageCoSignature } from './safeConfirmationResolver.js'
import { createSafeSignerErrorStatus, type SafeSignerErrorStatus } from './safeSignerErrors.js'

export type SafeSignerReplyResolution =
	| { readonly status: 'not-safe' }
	| { readonly status: 'success', readonly result: string }
	| { readonly status: 'error', readonly approvalStatus: SafeSignerErrorStatus }

const signerError = (message: string): SafeSignerReplyResolution => ({
	status: 'error',
	approvalStatus: createSafeSignerErrorStatus(message),
})

export async function resolveSafeSignerReply(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	pending: PendingTransactionOrSignableMessage,
	signerReply: unknown,
): Promise<SafeSignerReplyResolution> {
	if (
		pending.type === 'Transaction'
		&& pending.safeTransaction !== undefined
		&& pending.transactionOrMessageCreationStatus === 'Simulated'
	) return await persistSignedSafeTransaction(ethereum, tokenPriceService, pending, pending.safeTransaction, signerReply)

	if (
		pending.type === 'SignableMessage'
		&& pending.transactionOrMessageCreationStatus === 'Simulated'
		&& pending.visualizedPersonalSignRequest.type === 'SafeTx'
		&& pending.safeMessageCoSignSnapshot !== undefined
	) {
		try {
			return { status: 'success', result: await validateSafeMessageCoSignature(ethereum, pending, signerReply) }
		} catch (error) {
			return signerError(`Gnosis Safe co-signature was rejected: ${ getErrorMessage(error) ?? 'The signer returned an invalid Gnosis Safe signature.' }`)
		}
	}
	return { status: 'not-safe' }
}

type PendingSafeTransaction = Extract<PendingTransactionOrSignableMessage, { readonly type: 'Transaction' }> & {
	readonly transactionOrMessageCreationStatus: 'Simulated'
}

async function persistSignedSafeTransaction(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	pendingTransaction: PendingSafeTransaction,
	safeSigningRequest: SafeTransactionSigningRequest,
	signerReply: unknown,
): Promise<SafeSignerReplyResolution> {
	let ownerSignature: SafeOwnerSignature
	let currentSafeNonce: bigint
	try {
		if (safeSigningRequest.safeSignerAddress === undefined) {
			throw new Error('Connect a signer wallet and select a current Gnosis Safe owner before signing.')
		}
		if (safeSigningRequest.reviewedSafeState === undefined) {
			throw new Error('Review this Gnosis Safe proposal again so its current owners, threshold, nonce, and signer can be verified.')
		}
		const { blockNumber, state: safeState } = await getSafeContractSnapshot(ethereum, safeSigningRequest.safeAddress)
		currentSafeNonce = safeState.nonce
		assertSafeContractStateUnchanged(safeSigningRequest.reviewedSafeState, safeState)
		const storedStack = (await getSafeTransactionStacks()).find((stack) =>
			stack.chainId === ethereum.getChainId() && stack.safeAddress === safeSigningRequest.safeAddress
		)
		const existingStack = storedStack === undefined ? undefined : reconcileSafeTransactionStack(storedStack, safeState.nonce)
		const alreadyPersisted = existingStack?.transactions.some((transaction) => transaction.safeTxHash === safeSigningRequest.safeTxHash) === true
		const expectedNonce = safeState.nonce + BigInt(existingStack?.transactions.length ?? 0)
		if (!alreadyPersisted && safeSigningRequest.safeTx.message.nonce !== expectedNonce) {
			throw new Error(`This proposal uses Gnosis Safe nonce ${ safeSigningRequest.safeTx.message.nonce.toString() }, but the next available nonce is ${ expectedNonce.toString() }. Review and sign the rebased proposal again.`)
		}
		ownerSignature = await createSafeOwnerValidator(
			ethereum, safeSigningRequest.safeAddress, { blockNumber, state: safeState },
		).validateSignature(
			safeSigningRequest.safeTxHash,
			funtypes.String.parse(signerReply),
			safeSigningRequest.safeSignerAddress,
		)
	} catch (error) {
		return signerError(`Gnosis Safe proposal or owner signature was rejected: ${ getErrorMessage(error) ?? 'The signer returned an invalid proposal signature.' }`)
	}

	const stackTransaction: SafeStackTransaction = {
		safeTx: safeSigningRequest.safeTx,
		safeTxHash: safeSigningRequest.safeTxHash,
		created: pendingTransaction.created,
		websiteOrigin: pendingTransaction.website.websiteOrigin,
		transactionIdentifier: pendingTransaction.transactionIdentifier,
		signatures: [ownerSignature],
	}
	const transaction = {
		...createSafeExecutionPreSimulationTransaction(pendingTransaction.transactionToSimulate, safeSigningRequest),
		safeTransaction: stackTransaction,
	}
	try {
		await updateTransactionState((previousState) => {
			const reconciledState = reconcileSafeTransactionState(
				previousState,
				ethereum.getChainId(),
				safeSigningRequest.safeAddress,
				currentSafeNonce,
			)
			const existingStack = reconciledState.safeTransactionStacks.find((stack) =>
				stack.chainId === ethereum.getChainId() && stack.safeAddress === safeSigningRequest.safeAddress
			)
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
					safeTransactionStacks = reconciledState.safeTransactionStacks
				} else {
					const expectedNonce = existingStack.baseNonce + BigInt(existingStack.transactions.length)
					if (safeSigningRequest.safeTx.message.nonce !== expectedNonce) {
						throw new Error(`Gnosis Safe transaction nonce ${ safeSigningRequest.safeTx.message.nonce.toString() } does not follow local stack nonce ${ expectedNonce.toString() }.`)
					}
					safeTransactionStacks = reconciledState.safeTransactionStacks.map((stack) => stack === existingStack
						? { ...stack, transactions: [...stack.transactions, stackTransaction] }
						: stack
					)
				}
			}
			const interceptorTransactionStack = reconciledState.interceptorTransactionStack.operations.some((operation) =>
				operation.type === 'Transaction' && operation.preSimulationTransaction.transactionIdentifier === pendingTransaction.transactionIdentifier
			)
				? reconciledState.interceptorTransactionStack
				: {
					operations: [
						...reconciledState.interceptorTransactionStack.operations,
						{ type: 'Transaction' as const, preSimulationTransaction: transaction },
					],
				}
			return { safeTransactionStacks, interceptorTransactionStack }
		})
	} catch (error) {
		return signerError(`Gnosis Safe proposal could not be persisted: ${ getErrorMessage(error) ?? 'The local Gnosis Safe proposal stack changed.' }`)
	}
	await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, true, false)
	await openPopupOrTab({ url: getHtmlFile('simulationStack') })
	return { status: 'success', result: funtypes.String.parse(EthereumBytes32.serialize(safeSigningRequest.safeTxHash)) }
}
