import { BrowserSigningMethod, DirectSigningMethod, isSigningOperation } from '../types/signingMethods.js'
import type { DirectSigningInput } from '../types/directSigning.js'
import type { SigningWalletBinding } from '../types/signingWallet.js'
import { getPrettySignerName } from '../utils/signerMetadata.js'
import { preparePersonalSigningPayload, prepareTransactionSigningPayload, prepareTypedDataSigningPayload, verifyPersonalSigningResponse, verifySignedTransaction, verifyTypedDataSigningResponse } from './exactPayload.js'

const DIRECT_CAPABILITIES = { methods: DirectSigningMethod, broadcast: 'configured-rpc', supportsUnknownWalletMethods: false } satisfies { methods: typeof DirectSigningMethod, broadcast: 'configured-rpc', supportsUnknownWalletMethods: boolean }

export const SIGNING_CAPABILITIES = {
	browser: { methods: BrowserSigningMethod, broadcast: 'browser-wallet', supportsUnknownWalletMethods: true },
	ledger: DIRECT_CAPABILITIES,
	airgap: DIRECT_CAPABILITIES,
} satisfies Record<SigningWalletBinding['wallet']['type'], { methods: { test: (method: unknown) => boolean }, broadcast: 'browser-wallet' | 'configured-rpc', supportsUnknownWalletMethods: boolean }>

export const DIRECT_SIGNING_CAPABILITY_ERROR = 'This signing wallet supports EIP-1559 eth_sendTransaction, personal_sign, and eth_signTypedData_v4 only.'

export function getSigningMethodError(type: SigningWalletBinding['wallet']['type'], method: string) {
	const capabilities = SIGNING_CAPABILITIES[type]
	return !capabilities.supportsUnknownWalletMethods && isSigningOperation(method) && !capabilities.methods.test(method) ? DIRECT_SIGNING_CAPABILITY_ERROR : undefined
}

export type SigningBackend = Readonly<{
	binding: SigningWalletBinding
	broadcast: 'browser-wallet' | 'configured-rpc'
	label: string
	capabilities: typeof SIGNING_CAPABILITIES[SigningWalletBinding['wallet']['type']]
}>

export function getSigningBackend(binding: SigningWalletBinding): SigningBackend {
	const wallet = binding.wallet
	const capabilities = SIGNING_CAPABILITIES[wallet.type]
	return { binding, capabilities, broadcast: capabilities.broadcast, label: wallet.type === 'browser' ? getPrettySignerName(wallet.signerName) : wallet.type === 'ledger' ? 'Ledger' : 'AirGap Vault' }
}

export function signingWalletDescription(binding: SigningWalletBinding | undefined) {
	if (binding === undefined) return 'No signing wallet'
	return `${ getSigningBackend(binding).label } · ${ binding.wallet.label }`
}

export function prepareDirectPayload(input: DirectSigningInput) {
	if (!DIRECT_CAPABILITIES.methods.test(input.method)) throw new Error(DIRECT_SIGNING_CAPABILITY_ERROR)
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
