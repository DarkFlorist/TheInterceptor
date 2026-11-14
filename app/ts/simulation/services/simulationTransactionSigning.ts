import { authorizesExecutedCall, type WebsiteCreatedEthereumTransaction } from '../../types/visualizer-types.js'
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

export const mockSignTransaction = (transaction: EthereumUnsignedTransaction, s: MockSignatureS = ORDINARY_MOCK_SIGNATURE_S): EthereumSendableSignedTransaction => {
	const unsignedTransaction = EthereumUnsignedTransactionToUnsignedTransaction(transaction)
	if (unsignedTransaction.type === 'legacy') {
		const signatureParams = { r: 0n, s, v: 0n }
		const hash = EthereumQuantity.parse(keccak256(serializeSignedTransactionToBytes({ ...unsignedTransaction, ...signatureParams })))
		if (transaction.type !== 'legacy') throw new Error('types do not match')
		return { ...transaction, ...signatureParams, hash }
	}
	if (unsignedTransaction.type === '7702') {
		const signatureParams = { r: 0n, s, yParity: 'even' as const }
		const authorizationList = unsignedTransaction.authorizationList.map(mockSign7702Authorization)
		const hash = EthereumQuantity.parse(keccak256(serializeSignedTransactionToBytes({ ...unsignedTransaction, ...signatureParams, authorizationList })))
		if (transaction.type !== '7702') throw new Error('types do not match')
		return { ...transaction, ...signatureParams, hash, authorizationList }
	}
	const signatureParams = { r: 0n, s, yParity: 'even' as const }
	const hash = EthereumQuantity.parse(keccak256(serializeSignedTransactionToBytes({ ...unsignedTransaction, ...signatureParams })))
	if (transaction.type === 'legacy' || transaction.type === '7702') throw new Error('types do not match')
	return { ...transaction, ...signatureParams, hash }
}

export const getSignedTransactionForSimulation = (transactionToSimulate: WebsiteCreatedEthereumTransaction) => (
	transactionToSimulate.signedTransaction ?? mockSignTransaction(transactionToSimulate.transaction, authorizesExecutedCall(transactionToSimulate) ? EXECUTED_CALL_MOCK_SIGNATURE_S : ORDINARY_MOCK_SIGNATURE_S)
)
