import { createSaltSearch, findFreeSimulationSalt, type SimulationHashReservation, toPreSimulationTransaction, withSimulationSalt, withUniqueSimulationHash } from '../simulation/services/simulationTransactionSigning.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { InterceptorStackOperation, InterceptorTransactionStack, PreSimulationTransaction, WebsiteCreatedEthereumTransaction } from '../types/visualizer-types.js'
import { doesUniqueRequestIdentifiersMatch, type UniqueRequestIdentifier } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { getInterceptorTransactionStack, getPendingTransactionsAndMessages, updatePendingTransactionOrMessage } from './storageVariables.js'

const getTransactionHashes = (operations: readonly InterceptorStackOperation[]) => operations.flatMap((operation) => operation.type === 'Transaction' ? [operation.preSimulationTransaction.signedTransaction.hash] : [])

// Serializes each step that allocates hashes against the stack and the pending reservations together with its commit: reserving a confirmation's hash, accepting a confirmation and importing a stack. Lock order: the pending-confirmation lock (confirmTransaction.ts), then this one, then the pending-request and stack storage locks, which take no other lock.
const simulationHashSemaphore = new Semaphore(1)
export const withSimulationHashLock = async <Result>(allocateAndCommit: () => Promise<Result>) => await simulationHashSemaphore.execute(allocateAndCommit)

// Whether accepting the request stacks its transaction, so it needs a reserved hash: a simulation-mode transaction other than a Gnosis Safe proposal, which is stacked under its safeTxHash.
export const stacksTransactionOnAccept = (request: { readonly simulationMode: boolean, readonly safeTransaction?: unknown }) => request.simulationMode && request.safeTransaction === undefined

// The hashes pending confirmations other than except hold: their reservations, and for one pending from before reservations, the hash accepting it would take. No other transaction may take them.
export const getReservedTransactionHashes = (pending: readonly PendingTransactionOrSignableMessage[], except?: UniqueRequestIdentifier): ReadonlySet<bigint> => new Set(pending.flatMap((request) => {
	if (request.type !== 'Transaction' || !stacksTransactionOnAccept(request)) return []
	if (except !== undefined && doesUniqueRequestIdentifiersMatch(request.uniqueRequestIdentifier, except)) return []
	if (request.simulationHashReservation !== undefined) return [request.simulationHashReservation.hash]
	if (!('transactionToSimulate' in request) || !request.transactionToSimulate.success) return []
	return [toPreSimulationTransaction(request.transactionToSimulate, undefined).signedTransaction.hash]
}))

// Reserves the hash a confirmation's transaction keeps from then on: free on the stack and among the other pending confirmations' hashes. Run under withSimulationHashLock, together with storing the reservation.
export const allocateSimulationHashReservation = async (transactionToSimulate: WebsiteCreatedEthereumTransaction, requestIdentifier: UniqueRequestIdentifier): Promise<SimulationHashReservation> => {
	const takenHashes = new Set([...getTransactionHashes((await getInterceptorTransactionStack()).operations), ...getReservedTransactionHashes(await getPendingTransactionsAndMessages(), requestIdentifier)])
	const unreserved = toPreSimulationTransaction(transactionToSimulate, undefined)
	const salt = findFreeSimulationSalt(unreserved, takenHashes)
	return { salt, hash: withSimulationSalt(unreserved, salt).signedTransaction.hash }
}

// The pending confirmation's reservation, reserved and stored now if its transaction formed successfully for the first time after it was opened, before its first preview is shown.
export const ensureSimulationHashReservation = async (requestIdentifier: UniqueRequestIdentifier, transactionToSimulate: WebsiteCreatedEthereumTransaction) => await withSimulationHashLock(async () => {
	const pending = (await getPendingTransactionsAndMessages()).find((request) => doesUniqueRequestIdentifiersMatch(request.uniqueRequestIdentifier, requestIdentifier))
	if (pending?.type !== 'Transaction' || !stacksTransactionOnAccept(pending)) return undefined
	if (pending.simulationHashReservation !== undefined) return pending.simulationHashReservation
	const simulationHashReservation = await allocateSimulationHashReservation(transactionToSimulate, requestIdentifier)
	await updatePendingTransactionOrMessage(requestIdentifier, async (request) => request.type === 'Transaction' ? { ...request, simulationHashReservation } : request)
	return simulationHashReservation
})

// Appends operations to the stack, giving each appended transaction, in order, a hash that no stacked transaction has and no pending confirmation holds (withUniqueSimulationHash). The stacked transactions keep theirs, even duplicates a stack stored before #1713 holds. Returns the operations as appended, whose hashes are the stored ones.
export const appendOperationsToStack = (stack: InterceptorTransactionStack, operations: readonly InterceptorStackOperation[], reservedHashes: ReadonlySet<bigint>) => {
	const takenHashes = new Set([...getTransactionHashes(stack.operations), ...reservedHashes])
	const saltSearch = createSaltSearch()
	const appended = operations.map((operation): InterceptorStackOperation => {
		if (operation.type !== 'Transaction') return operation
		const preSimulationTransaction = withUniqueSimulationHash(operation.preSimulationTransaction, takenHashes, saltSearch)
		takenHashes.add(preSimulationTransaction.signedTransaction.hash)
		return preSimulationTransaction === operation.preSimulationTransaction ? operation : { ...operation, preSimulationTransaction }
	})
	return { stack: { ...stack, operations: [...stack.operations, ...appended] }, appended }
}

// Appends an accepted confirmation's transaction under its reserved hash. Undefined if a stacked transaction already has that hash, which only a stack update that ignored reservations can cause.
export const appendAcceptedTransactionToStack = (stack: InterceptorTransactionStack, transaction: PreSimulationTransaction): InterceptorTransactionStack | undefined => {
	if (getTransactionHashes(stack.operations).includes(transaction.signedTransaction.hash)) return undefined
	return { ...stack, operations: [...stack.operations, { type: 'Transaction', preSimulationTransaction: transaction }] }
}
