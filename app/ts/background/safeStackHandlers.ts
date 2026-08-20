import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { assertInterceptorSafeTransactionPolicy, assertUniqueSafeTransactionStacks, createSafeOwnerValidator, getSafeContractSnapshot } from '../safe/safeCore.js'
import { reconcileSafeTransactionStack, reconcileSafeTransactionState } from '../safe/safeStack.js'
import { SafeStackExport, type SafeTransactionStack } from '../types/safeTypes.js'
import type { InterceptorStackOperation } from '../types/visualizer-types.js'
import { checksummedAddress } from '../utils/bigint.js'
import { getSafeTxHash } from '../utils/eip712.js'
import { getErrorMessage } from '../utils/errors.js'
import { modifyObject } from '../utils/typescript.js'
import { updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'
import { getSafeTransactionStacks, updateTransactionState } from './storageVariables.js'
import { reconcileStoredSafeState } from './safeStackState.js'

function recoverSafeTransactionStackFromLocalOperations(
	importedStack: SafeTransactionStack,
	operations: readonly InterceptorStackOperation[],
) {
	const localTransactions = operations.flatMap((operation) => {
		if (operation.type !== 'Transaction') return []
		const safeTransaction = operation.preSimulationTransaction.safeTransaction
		if (safeTransaction === undefined) return []
		if (safeTransaction.safeTx.domain.chainId !== importedStack.chainId) return []
		if (safeTransaction.safeTx.domain.verifyingContract !== importedStack.safeAddress) return []
		return [safeTransaction]
	})
	const importedTransactionHashes = importedStack.transactions.map(({ safeTxHash }) => safeTxHash)
	const matchingStartIndex = localTransactions.findIndex((_transaction, startIndex) =>
		importedTransactionHashes.every((safeTxHash, offset) => localTransactions[startIndex + offset]?.safeTxHash === safeTxHash)
	)
	if (matchingStartIndex === -1) return undefined
	const transactions = localTransactions.slice(matchingStartIndex)
	if (transactions[0]?.safeTx.message.nonce !== importedStack.baseNonce) return undefined
	if (transactions.some((transaction, index) => transaction.safeTx.message.nonce !== importedStack.baseNonce + BigInt(index))) return undefined
	return { ...importedStack, transactions }
}

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
	const normalizedTransactions = await Promise.all(reconciledStack.transactions.map(async (transaction, index) => {
		assertInterceptorSafeTransactionPolicy(transaction.safeTx)
		if (transaction.safeTx.domain.verifyingContract !== reconciledStack.safeAddress) throw new Error('Gnosis Safe transaction verifying contract does not match the stack Gnosis Safe.')
		if (transaction.safeTx.domain.chainId !== reconciledStack.chainId) throw new Error('Gnosis Safe transaction chain ID does not match the stack chain.')
		if (transaction.safeTx.message.nonce !== reconciledStack.baseNonce + BigInt(index)) throw new Error('Gnosis Safe stack transaction nonces must be contiguous.')
		if (BigInt(getSafeTxHash(transaction.safeTx)) !== transaction.safeTxHash) throw new Error('A Gnosis Safe transaction hash does not match its transaction data.')
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

export async function requestSafeStackExport(ethereum: EthereumClientService, tokenPriceService: TokenPriceService) {
	try {
		const storedStacks = (await getSafeTransactionStacks()).filter((stack) =>
			stack.chainId === ethereum.getChainId() && stack.transactions.length > 0
		)
		if (storedStacks.length === 0) throw new Error('There are no Gnosis Safe proposals to export on the selected chain.')
		assertUniqueSafeTransactionStacks(storedStacks)
		const validatedStacks = await Promise.all(storedStacks.map(async (stack) => ({
			stack,
			validated: await validateSafeTransactionStackForCurrentContract(ethereum, stack),
		})))
		await Promise.all(validatedStacks.map(async ({ stack, validated }) => {
			await reconcileStoredSafeState(ethereum, stack.safeAddress, validated.safeState)
		}))
		await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, true, false)
		const stacks = validatedStacks
			.map(({ validated }) => validated.reconciledStack)
			.filter((stack) => stack.transactions.length > 0)
		if (stacks.length === 0) throw new Error('All locally stored Gnosis Safe proposals on the selected chain have already executed.')
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
			message: getErrorMessage(error) ?? 'Failed to validate the Gnosis Safe stack before export.',
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
					storedExistingStack = recoverSafeTransactionStackFromLocalOperations(importedStack, reconciledState.interceptorTransactionStack.operations)
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
					const signatures = [...existingTransaction.signatures]
					for (const importedSignature of importedTransaction.signatures) {
						if (!signatures.some((signature) => signature.signer === importedSignature.signer)) signatures.push(importedSignature)
					}
					return { ...existingTransaction, signatures }
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
				interceptorTransactionStack: {
					operations: reconciledState.interceptorTransactionStack.operations.map((operation) => {
						if (operation.type !== 'Transaction') return operation
						const safeTransaction = operation.preSimulationTransaction.safeTransaction
						if (safeTransaction === undefined) return operation
						const updatedMetadata = transactionMetadata.get(safeTransaction.safeTxHash)
						if (updatedMetadata === undefined) return operation
						return modifyObject(operation, {
							preSimulationTransaction: modifyObject(operation.preSimulationTransaction, { safeTransaction: updatedMetadata }),
						})
					}),
				},
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
