import { authorizesExecutedCall, type PreSimulationTransaction, type TransactionSimulationOptions, type WebsiteCreatedEthereumTransaction } from '../../types/visualizer-types.js'
import { EthereumQuantity, type EthereumSendableSignedTransaction, type EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { EthereumUnsignedTransactionToUnsignedTransaction, type IUnsignedTransaction7702, serializeSignedTransactionToBytes } from '../../utils/ethereum.js'
import { hasEip7702AuthorizationSignature, hasPartialEip7702AuthorizationSignature } from '../../utils/eip7702Authorization.js'
import { keccak256 } from '../../utils/ethereumPrimitives.js'

type Unsigned7702Authorization = IUnsignedTransaction7702['authorizationList'][number]
type Signed7702Authorization = Unsigned7702Authorization & {
	readonly yParity: 'even' | 'odd'
	readonly r: bigint
	readonly s: bigint
}

const mockSign7702Authorization = (authorization: Unsigned7702Authorization): Signed7702Authorization => {
	if (hasEip7702AuthorizationSignature(authorization)) return authorization
	if (hasPartialEip7702AuthorizationSignature(authorization)) throw new Error('EIP-7702 authorization signature is missing required fields')
	return { ...authorization, r: 0n, s: 0n, yParity: 'even' }
}

// The s of a mock signature. A call that an executor runs in its sender's place (a Gnosis Safe execution's own call) gets its own s, so its hash never equals a mock-signed ordinary transaction's with the same fields, whatever its fees and nonce.
const ORDINARY_MOCK_SIGNATURE_S = 0n
const EXECUTED_CALL_MOCK_SIGNATURE_S = 1n
type MockSignatureS = typeof ORDINARY_MOCK_SIGNATURE_S | typeof EXECUTED_CALL_MOCK_SIGNATURE_S
const getMockSignatureS = (simulationOptions: TransactionSimulationOptions | undefined): MockSignatureS => authorizesExecutedCall(simulationOptions) ? EXECUTED_CALL_MOCK_SIGNATURE_S : ORDINARY_MOCK_SIGNATURE_S

// The r of a mock signature: the sender's 160-bit address, so identical transactions from different senders get different hashes, with a uniqueness salt above it (withUniqueSimulationHash). Nothing recovers a sender from a mock signature, and the node simulates without validating signatures.
const ADDRESS_BITS = 160n
const getMockSignatureR = (from: bigint, salt: bigint) => (salt << ADDRESS_BITS) | from

export const mockSignTransaction = (transaction: EthereumUnsignedTransaction, s: MockSignatureS = ORDINARY_MOCK_SIGNATURE_S, salt = 0n): EthereumSendableSignedTransaction => {
	const unsignedTransaction = EthereumUnsignedTransactionToUnsignedTransaction(transaction)
	const r = getMockSignatureR(transaction.from, salt)
	if (unsignedTransaction.type === 'legacy') {
		const signatureParams = { r, s, v: 0n }
		const hash = EthereumQuantity.parse(keccak256(serializeSignedTransactionToBytes({ ...unsignedTransaction, ...signatureParams })))
		if (transaction.type !== 'legacy') throw new Error('types do not match')
		return { ...transaction, ...signatureParams, hash }
	}
	if (unsignedTransaction.type === '7702') {
		const signatureParams = { r, s, yParity: 'even' as const }
		const authorizationList = unsignedTransaction.authorizationList.map(mockSign7702Authorization)
		const hash = EthereumQuantity.parse(keccak256(serializeSignedTransactionToBytes({ ...unsignedTransaction, ...signatureParams, authorizationList })))
		if (transaction.type !== '7702') throw new Error('types do not match')
		return { ...transaction, ...signatureParams, hash, authorizationList }
	}
	const signatureParams = { r, s, yParity: 'even' as const }
	const hash = EthereumQuantity.parse(keccak256(serializeSignedTransactionToBytes({ ...unsignedTransaction, ...signatureParams })))
	if (transaction.type === 'legacy' || transaction.type === '7702') throw new Error('types do not match')
	return { ...transaction, ...signatureParams, hash }
}

export const getSignedTransactionForSimulation = (transactionToSimulate: WebsiteCreatedEthereumTransaction) => (
	transactionToSimulate.signedTransaction ?? mockSignTransaction(transactionToSimulate.transaction, getMockSignatureS(transactionToSimulate.simulationOptions))
)

// The transaction a simulation-mode confirmation previews and accepting stacks, under its reserved hash when it has one. That hash identifies it from its forming on, as a stacked transaction's does after removal renumbers it, so it need not be the hash of the fields a refresh forms again.
export const toPreSimulationTransaction = (transactionToSimulate: WebsiteCreatedEthereumTransaction, reservedTransactionHash: bigint | undefined): PreSimulationTransaction => {
	const signedTransaction = getSignedTransactionForSimulation(transactionToSimulate)
	return {
		signedTransaction: reservedTransactionHash === undefined ? signedTransaction : { ...signedTransaction, hash: reservedTransactionHash },
		website: transactionToSimulate.website,
		created: transactionToSimulate.created,
		originalRequestParameters: transactionToSimulate.originalRequestParameters,
		transactionIdentifier: transactionToSimulate.transactionIdentifier,
		...(transactionToSimulate.simulationOptions === undefined ? {} : { simulationOptions: transactionToSimulate.simulationOptions }),
	}
}

// A signed transaction's own fields, without its signature or hash, so mock signing it again leaves no field of its previous signature (an imported transaction of any type can carry v as well as yParity).
const withoutSignature = (transaction: EthereumSendableSignedTransaction): EthereumUnsignedTransaction => {
	const { r: _r, s: _s, v: _v, hash: _hash, ...transactionWithParity } = transaction
	if (!('yParity' in transactionWithParity)) return transactionWithParity
	const { yParity: _yParity, ...unsignedTransaction } = transactionWithParity
	return unsignedTransaction
}

// Where withUniqueSimulationHash resumes its salt search for a transaction, by the hash its fields and Gnosis Safe execution marker get without a salt. Shared across the transactions of one stack update, whose taken hashes only grow, so every salt it skips is still taken and N identical transactions take N signings instead of N squared.
export type SaltSearch = { readonly nextSaltByUnsaltedHash: Map<bigint, bigint> }
export const createSaltSearch = (): SaltSearch => ({ nextSaltByUnsaltedHash: new Map() })

/**
 * Gives a transaction entering the simulation stack a hash that no transaction in stackHashes has, so hash lookups find exactly one transaction. A transaction whose hash is free keeps it; otherwise it is mock-signed again from its own fields, keeping its Gnosis Safe execution marker, with the lowest salt that frees its hash. That includes a duplicate of a stacked raw signed transaction, whose real hash is taken.
 * A new transaction's hash can equal a stacked one's even with the sender in r: removal renumbers later nonces but keeps their hashes, two confirmations pending at once are formed with the same nonce, and an import keeps its recorded hashes. The stacked transaction keeps its hash, because pages may already hold it.
 * A Gnosis Safe proposal keeps its hash, which is its safeTxHash: the Safe stack mirrors it by that hash (safeTransaction), so a new hash would split the two. Its SafeTx nonce keeps it apart from the Safe's other proposals.
 */
export const withUniqueSimulationHash = (transaction: PreSimulationTransaction, stackHashes: ReadonlySet<bigint>, saltSearch: SaltSearch = createSaltSearch()): PreSimulationTransaction => {
	if (transaction.safeTransaction !== undefined) return transaction
	if (!stackHashes.has(transaction.signedTransaction.hash)) return transaction
	const s = getMockSignatureS(transaction.simulationOptions)
	const unsignedTransaction = withoutSignature(transaction.signedTransaction)
	const unsaltedHash = mockSignTransaction(unsignedTransaction, s).hash
	for (let salt = saltSearch.nextSaltByUnsaltedHash.get(unsaltedHash) ?? 1n; ; salt++) {
		const signedTransaction = mockSignTransaction(unsignedTransaction, s, salt)
		if (stackHashes.has(signedTransaction.hash)) continue
		saltSearch.nextSaltByUnsaltedHash.set(unsaltedHash, salt + 1n)
		return { ...transaction, signedTransaction }
	}
}
