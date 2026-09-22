import type { DirectSigningInput } from '../types/directSigning.js'
import type { SigningWalletBinding } from '../types/signingWallet.js'
import { getPrettySignerName } from '../utils/signerMetadata.js'
import { preparePersonalSigningPayload, prepareTransactionSigningPayload, prepareTypedDataSigningPayload, verifyPersonalSigningResponse, verifySignedTransaction, verifyTypedDataSigningResponse } from './exactPayload.js'

export type SigningBackend = Readonly<{
	binding: SigningWalletBinding
	broadcast: 'browser-wallet' | 'configured-rpc'
	label: string
}>

export function getSigningBackend(binding: SigningWalletBinding): SigningBackend {
	const wallet = binding.wallet
	return { binding, broadcast: wallet.type === 'browser' ? 'browser-wallet' : 'configured-rpc', label: wallet.type === 'browser' ? getPrettySignerName(wallet.signerName) : wallet.type === 'ledger' ? 'Ledger' : 'AirGap Vault' }
}

export function signingWalletDescription(binding: SigningWalletBinding | undefined) {
	if (binding === undefined) return 'No signing wallet'
	return `${ getSigningBackend(binding).label } · ${ binding.wallet.label }`
}

export function prepareDirectPayload(input: DirectSigningInput) {
	switch (input.method) {
		case 'eth_sendTransaction': return prepareTransactionSigningPayload(input.data, input.address, input.chainId)
		case 'personal_sign': return preparePersonalSigningPayload(input.data, input.address)
		case 'eth_signTypedData_v4': return prepareTypedDataSigningPayload(input.data, input.address, input.chainId)
	}
}

export async function verifyDirectResult(input: DirectSigningInput, result: string) {
	const payload = prepareDirectPayload(input)
	switch (payload.method) {
		case 'eth_sendTransaction': return verifySignedTransaction(payload, result)
		case 'personal_sign': return await verifyPersonalSigningResponse(payload, result)
		case 'eth_signTypedData_v4': return await verifyTypedDataSigningResponse(payload, result)
	}
}
