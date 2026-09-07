import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { assertInterceptorSafeTransactionPolicy, assertUniqueSafeTransactionStacks, createSafeOwnerValidator, getSafeContractSnapshot } from '../safe/safeCore.js'
import { getSafeTransactionStackInvariantViolation, mapSafeTransactionMetadata, mergeSafeOwnerSignatures, reconcileSafeTransactionStack, reconcileSafeTransactionState, recoverSafeTransactionStackFromLocalOperations } from '../safe/safeStack.js'
import { SafeStackExport, type SafeTransactionStack } from '../types/safeTypes.js'
import { checksummedAddress } from '../utils/bigint.js'
import { getErrorMessage } from '../utils/errors.js'
import { updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'
import { getSafeTransactionStacks, updateTransactionState } from './storageVariables.js'

export async function validateSafeTransactionStackForCurrentContract(ethereum: EthereumClientService, stack: SafeTransactionStack) {
	if (stack.chainId !== ethereum.getChainId()) throw new Error(`Switch Interceptor to chain ${ stack.chainId.toString() } before validating this Gnosis Safe stack.`)
	const { blockNumber, state: safeState } = await getSafeContractSnapshot(ethereum, stack.safeAddress)
	const ownerValidator = createSafeOwnerValidator(ethereum, stack.safeAddress, { blockNumber, state: safeState })
	if (safeState.version !== stack.safeVersion) {
		throw new Error(`Gnosis Safe ${ checksummedAddress(stack.safeAddress) } is now version ${ safeState.version }, but this stack records ${ stack.safeVersion }.`)
	}
	if (safeState.threshold !== stack.threshold) {
		throw new Error(`Gnosis Safe ${ checksummedAddress(stack.safeAddress) } now has threshold ${ safeState.threshold.toString() }, but this stack records ${ stack.threshold.toString() }.`)
	}
	const reconciledStack = reconcileSafeTransactionStack(stack, safeState.nonce)
	const invariantViolation = getSafeTransactionStackInvariantViolation(reconciledStack)
	if (invariantViolation !== undefined) throw new Error(invariantViolation)
	const normalizedTransactions = await Promise.all(reconciledStack.transactions.map(async (transaction) => {
		assertInterceptorSafeTransactionPolicy(transaction.safeTx)
		if (new Set(transaction.signatures.map((signature) => signature.signer)).size !== transaction.signatures.length) {
			throw new Error('A Gnosis Safe transaction contains duplicate owner signatures.')
		}
		const signatures = await Promise.all(transaction.signatures.map(async (signature) =>
			await ownerValidator.validateSignature(transaction.safeTxHash, signature.signature, signature.signer)
		))
		return { ...transaction, signatures }
	}))
	return { safeState, reconciledStack: { ...reconciledStack, transactions: normalizedTransactions } }
}

export async function requestSafeStackExport(ethereum: EthereumClientService) {
	try {
		const stacks = (await getSafeTransactionStacks()).filter((stack) =>
			stack.chainId === ethereum.getChainId() && stack.transactions.length > 0
		)
		if (stacks.length === 0) throw new Error('There are no Gnosis Safe proposals to export on the selected chain.')
		assertUniqueSafeTransactionStacks(stacks)
		const exportPayload: SafeStackExport = {
			name: 'Interceptor Safe Stack',
			version: '1.0.0',
			stacks,
		}
		return {
			method: 'popup_requestSafeStackExport' as const,
			ok: true as const,
			safeStackJson: JSON.stringify(SafeStackExport.serialize(exportPayload), undefined, '\t'),
		}
	} catch (error) {
		return {
			method: 'popup_requestSafeStackExport' as const,
			ok: false as const,
			message: getErrorMessage(error) ?? 'Failed to export the Gnosis Safe stack.',
		}
	}
}

export async function importSafeStack(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	request: { readonly data: SafeStackExport },
) {
	try {
		assertUniqueSafeTransactionStacks(request.data.stacks)
		const validatedImports = await Promise.all(request.data.stacks.map(async (importedStack) => {
			const validated = await validateSafeTransactionStackForCurrentContract(ethereum, importedStack)
			return { importedStack: validated.reconciledStack, safeState: validated.safeState }
		}))
		await updateTransactionState((previousState) => {
			let reconciledState = previousState
			for (const { importedStack, safeState } of validatedImports) {
				reconciledState = reconcileSafeTransactionState(reconciledState, importedStack.chainId, importedStack.safeAddress, safeState.nonce)
			}
			const mergedStacks: SafeTransactionStack[] = [...reconciledState.safeTransactionStacks]
			for (const { importedStack, safeState } of validatedImports) {
				if (importedStack.transactions.length === 0) continue
				let existingIndex = mergedStacks.findIndex((stack) =>
					stack.chainId === importedStack.chainId && stack.safeAddress === importedStack.safeAddress
				)
				let storedExistingStack = existingIndex === -1 ? undefined : mergedStacks[existingIndex]
				if (storedExistingStack === undefined) {
					storedExistingStack = recoverSafeTransactionStackFromLocalOperations(importedStack, reconciledState.interceptorTransactionStack)
					if (storedExistingStack !== undefined) {
						existingIndex = mergedStacks.length
						mergedStacks.push(storedExistingStack)
					}
				}
				if (storedExistingStack === undefined) throw new Error('The imported Gnosis Safe stack does not match a locally created Interceptor Gnosis Safe stack.')
				const existingStack = reconcileSafeTransactionStack(storedExistingStack, safeState.nonce)
				if (
					importedStack.transactions.length > existingStack.transactions.length
					|| importedStack.transactions.some((transaction, index) => transaction.safeTxHash !== existingStack.transactions[index]?.safeTxHash)
				) {
					throw new Error('The imported Gnosis Safe transaction list was changed. Only signatures for locally created transactions may be merged.')
				}

				const mergedTransactions = existingStack.transactions.map((existingTransaction, index) => {
					const importedTransaction = importedStack.transactions[index]
					if (importedTransaction === undefined) return existingTransaction
					return { ...existingTransaction, signatures: mergeSafeOwnerSignatures(existingTransaction.signatures, importedTransaction.signatures) }
				})
				mergedStacks[existingIndex] = {
					...existingStack,
					safeVersion: safeState.version,
					threshold: safeState.threshold,
					transactions: mergedTransactions,
				}
			}
			const transactionMetadata = new Map(mergedStacks.flatMap((stack) =>
				stack.transactions.map((transaction) => [transaction.safeTxHash, transaction] as const)
			))
			return {
				safeTransactionStacks: mergedStacks,
				interceptorTransactionStack: mapSafeTransactionMetadata(reconciledState.interceptorTransactionStack, (safeTransaction) =>
					transactionMetadata.get(safeTransaction.safeTxHash) ?? safeTransaction
				),
			}
		})
		await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, true, false)
		return { type: 'ImportSafeStackReply' as const, ok: true as const }
	} catch(error) {
		return {
			type: 'ImportSafeStackReply' as const,
			ok: false as const,
			message: getErrorMessage(error) ?? 'Failed to import Gnosis Safe stack.',
		}
	}
}
