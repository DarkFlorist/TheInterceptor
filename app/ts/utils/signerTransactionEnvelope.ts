import type { ConfirmTransactionTransactionSingleVisualization } from '../types/accessRequest.js'
import type { SendTransactionParams } from '../types/JsonRpc-types.js'
import type { EthereumAccessList, EthereumSendableSignedTransaction, EthereumUnsignedTransaction } from '../types/wire-types.js'
import { normalizeEip7702AuthorizationList, requestsEip7702Envelope } from './eip7702Authorization.js'
import { areEqualUint8Arrays } from './typed-arrays.js'
import { assertNever, type DistributiveOmit } from './typescript.js'

// The transaction envelope the wallet signs: which envelope a website request describes, the canonical request for a prepared transaction, and the check that the reviewed simulation describes that same transaction. Request preparation, the confirmation popup and every forwarding path read these rules from here.

// 'wallet-selects-nonce' omits the nonce so the wallet keeps choosing its next available nonce, which accounts for transactions still pending in its mempool view.
export type SignerNonceSelection = 'forward-reviewed-nonce' | 'wallet-selects-nonce'

export function toCanonicalSendTransactionParams(transaction: EthereumUnsignedTransaction, nonceSelection: SignerNonceSelection = 'forward-reviewed-nonce'): SendTransactionParams {
	const common = {
		type: transaction.type,
		from: transaction.from,
		chainId: transaction.chainId,
		...(nonceSelection === 'wallet-selects-nonce' ? {} : { nonce: transaction.nonce }),
		gas: transaction.gas,
		to: transaction.to,
		value: transaction.value,
		data: transaction.input,
	}
	switch (transaction.type) {
		case 'legacy':
			return { method: 'eth_sendTransaction', params: [{ ...common, gasPrice: transaction.gasPrice }] }
		case '2930':
			return { method: 'eth_sendTransaction', params: [{ ...common, gasPrice: transaction.gasPrice, accessList: transaction.accessList }] }
		case '1559':
			return { method: 'eth_sendTransaction', params: [{ ...common, maxFeePerGas: transaction.maxFeePerGas, maxPriorityFeePerGas: transaction.maxPriorityFeePerGas, accessList: transaction.accessList }] }
		case '4844':
			return { method: 'eth_sendTransaction', params: [{
				...common,
				maxFeePerGas: transaction.maxFeePerGas,
				maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
				accessList: transaction.accessList,
				maxFeePerBlobGas: transaction.maxFeePerBlobGas,
				blobVersionedHashes: transaction.blobVersionedHashes,
			}] }
		case '7702':
			return { method: 'eth_sendTransaction', params: [{
				...common,
				maxFeePerGas: transaction.maxFeePerGas,
				maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
				accessList: transaction.accessList,
				authorizationList: transaction.authorizationList.map((authorization) => ({
					chainId: authorization.chainId,
					address: authorization.address,
					nonce: authorization.nonce,
					...(authorization.r === undefined ? {} : { r: authorization.r }),
					...(authorization.s === undefined ? {} : { s: authorization.s }),
					...(authorization.yParity === undefined ? {} : { yParity: authorization.yParity }),
				})),
			}] }
		default:
			return assertNever(transaction)
	}
}

type AuthorizationWithoutSignature = { readonly chainId: bigint, readonly address: bigint, readonly nonce: bigint }

function areAccessListsEqual(first: EthereumAccessList | undefined, second: EthereumAccessList | undefined) {
	if (first === undefined || second === undefined) return first === second
	return first.length === second.length && first.every((entry, index) => {
		const other = second[index]
		return other !== undefined
			&& entry.address === other.address
			&& entry.storageKeys.length === other.storageKeys.length
			&& entry.storageKeys.every((storageKey, storageKeyIndex) => storageKey === other.storageKeys[storageKeyIndex])
	})
}

// Signature fields are ignored because the simulation adds placeholder signatures to unsigned authorizations; the forwarded request keeps the prepared ones.
function areAuthorizationsEqualIgnoringSignatures(first: readonly AuthorizationWithoutSignature[] | undefined, second: readonly AuthorizationWithoutSignature[] | undefined) {
	if (first === undefined || second === undefined) return first === second
	return first.length === second.length && first.every((authorization, index) => {
		const other = second[index]
		return other !== undefined && authorization.chainId === other.chainId && authorization.address === other.address && authorization.nonce === other.nonce
	})
}

function areBlobVersionedHashesEqual(first: readonly bigint[] | undefined, second: readonly bigint[] | undefined) {
	if (first === undefined || second === undefined) return first === second
	return first.length === second.length && first.every((hash, index) => hash === second[index])
}

export function assertSimulatedTransactionMatchesPrepared(prepared: EthereumUnsignedTransaction, simulated: EthereumSendableSignedTransaction) {
	if (simulated.type !== prepared.type
		|| simulated.from !== prepared.from
		|| simulated.to !== prepared.to
		|| simulated.value !== prepared.value
		|| simulated.gas !== prepared.gas
		|| simulated.chainId !== prepared.chainId
		|| !areEqualUint8Arrays(simulated.input, prepared.input)
		|| !areAccessListsEqual('accessList' in simulated ? simulated.accessList : undefined, 'accessList' in prepared ? prepared.accessList : undefined)
		|| !areAuthorizationsEqualIgnoringSignatures(simulated.type === '7702' ? simulated.authorizationList : undefined, prepared.type === '7702' ? prepared.authorizationList : undefined)
		|| (simulated.type === '4844' ? simulated.maxFeePerBlobGas : undefined) !== (prepared.type === '4844' ? prepared.maxFeePerBlobGas : undefined)
		|| !areBlobVersionedHashesEqual(simulated.type === '4844' ? simulated.blobVersionedHashes : undefined, prepared.type === '4844' ? prepared.blobVersionedHashes : undefined)) {
		throw new Error('The simulated transaction does not match the prepared transaction')
	}
}

// The confirmation simulation re-derives interceptor-filled fees for the current base fee, and the popup displays those fees, so the wallet receives them instead of the prepared ones. The simulation may also repair the nonce for its preview, so the nonce is the only other field allowed to differ and is never taken from it. The prepared unsigned authorization list is kept because the simulated one carries placeholder signatures.
export function getReviewedTransactionForSigning(prepared: EthereumUnsignedTransaction, popupVisualisation: Extract<ConfirmTransactionTransactionSingleVisualization, { statusCode: 'success' }>, transactionIdentifier: bigint): EthereumUnsignedTransaction {
	const simulated = popupVisualisation.data.simulationState.simulationStateInput
		.flatMap((block) => block.transactions)
		.find((transaction) => transaction.transactionIdentifier === transactionIdentifier)?.signedTransaction
	if (simulated === undefined) throw new Error('The reviewed transaction is missing from its confirmation simulation')
	assertSimulatedTransactionMatchesPrepared(prepared, simulated)
	switch (prepared.type) {
		case 'legacy': return simulated.type === 'legacy' ? { ...prepared, gasPrice: simulated.gasPrice } : prepared
		case '2930': return simulated.type === '2930' ? { ...prepared, gasPrice: simulated.gasPrice } : prepared
		case '1559': return simulated.type === '1559' ? { ...prepared, maxFeePerGas: simulated.maxFeePerGas, maxPriorityFeePerGas: simulated.maxPriorityFeePerGas } : prepared
		case '4844': return simulated.type === '4844' ? { ...prepared, maxFeePerGas: simulated.maxFeePerGas, maxPriorityFeePerGas: simulated.maxPriorityFeePerGas } : prepared
		case '7702': return simulated.type === '7702' ? { ...prepared, maxFeePerGas: simulated.maxFeePerGas, maxPriorityFeePerGas: simulated.maxPriorityFeePerGas } : prepared
		default: return assertNever(prepared)
	}
}

type SupportedSendTransactionType = Exclude<EthereumUnsignedTransaction['type'], '4844'>

// The wallet signs this transaction, so it keeps the envelope the website requested, including legacy and EIP-2930; gas estimation instead uses createEip1559Or7702Transaction because at zero fees those envelopes execute like EIP-1559.
export function getSupportedSendTransactionType(transactionDetails: SendTransactionParams['params'][0]): SupportedSendTransactionType {
	const requestedType = transactionDetails.type
		?? (requestsEip7702Envelope(transactionDetails)
			? '7702'
			: transactionDetails.gasPrice !== undefined
				? transactionDetails.accessList === undefined ? 'legacy' : '2930'
				: '1559')
	if (requestedType === '4844') throw new Error('EIP-4844 eth_sendTransaction requests are not supported')

	// The request schema accepts null fee placeholders (some websites send them), which leave the fee unspecified rather than requesting a dynamic fee.
	const isFeeSpecified = (fee: bigint | null | undefined) => fee !== undefined && fee !== null
	const hasDynamicFeeFields = isFeeSpecified(transactionDetails.maxFeePerGas) || isFeeSpecified(transactionDetails.maxPriorityFeePerGas)
	if ((requestedType === 'legacy' || requestedType === '2930') && hasDynamicFeeFields) {
		const transactionTypeName = requestedType === 'legacy' ? 'Legacy' : 'EIP-2930'
		throw new Error(`${ transactionTypeName } transactions cannot include dynamic fee fields`)
	}
	if ((requestedType === '1559' || requestedType === '7702') && transactionDetails.gasPrice !== undefined) {
		throw new Error(`EIP-${ requestedType } transactions cannot include gasPrice`)
	}
	if (requestedType === 'legacy' && transactionDetails.accessList !== undefined) {
		throw new Error('Legacy transactions cannot include an access list')
	}
	if (requestedType !== '7702' && transactionDetails.authorizationList !== undefined) {
		throw new Error('An authorization list requires an EIP-7702 transaction')
	}
	return requestedType
}

type SignerTransactionWithoutGas = DistributiveOmit<Exclude<EthereumUnsignedTransaction, { readonly type: '4844' }>, 'gas'>
type SignerTransactionCommonFields = Pick<Extract<EthereumUnsignedTransaction, { readonly type: '1559' }>, 'from' | 'to' | 'chainId' | 'nonce' | 'value' | 'input'>
type DynamicTransactionFees = Pick<Extract<EthereumUnsignedTransaction, { readonly type: '1559' }>, 'maxFeePerGas' | 'maxPriorityFeePerGas'>

// The caller resolves authorization, nonce and the gas payer; this owner alone maps the selected envelope to its wire fields.
export async function createSignerTransactionEnvelope(common: SignerTransactionCommonFields, details: SendTransactionParams['params'][0], envelope: { readonly type: SupportedSendTransactionType, readonly gasPrice: bigint } & DynamicTransactionFees): Promise<SignerTransactionWithoutGas> {
	switch (envelope.type) {
		case 'legacy': return { ...common, type: 'legacy', gasPrice: envelope.gasPrice }
		case '2930': return { ...common, type: '2930', gasPrice: envelope.gasPrice, accessList: details.accessList ?? [] }
		case '1559': return {
			...common, type: '1559',
			maxFeePerGas: envelope.maxFeePerGas, maxPriorityFeePerGas: envelope.maxPriorityFeePerGas,
			accessList: details.accessList ?? [],
		}
		case '7702': return {
			...common, type: '7702',
			maxFeePerGas: envelope.maxFeePerGas, maxPriorityFeePerGas: envelope.maxPriorityFeePerGas,
			accessList: details.accessList ?? [],
			authorizationList: await normalizeEip7702AuthorizationList(details.authorizationList ?? []),
		}
		default: return assertNever(envelope.type)
	}
}

// Fixed-price envelopes retain their requested price; dynamic-fee envelopes use fees finalized for the resolved gas limit.
export async function finalizeSignerTransactionEnvelope(transaction: SignerTransactionWithoutGas, gas: bigint, getDynamicFees: (gas: bigint) => Promise<DynamicTransactionFees>): Promise<EthereumUnsignedTransaction> {
	switch (transaction.type) {
		case 'legacy':
		case '2930': return { ...transaction, gas }
		case '1559':
		case '7702': return { ...transaction, ...await getDynamicFees(gas), gas }
		default: return assertNever(transaction)
	}
}
