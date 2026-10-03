import { ledgerNetworkDisplay } from './ledgerNetworks.js'
import { bytesFromHex, getAddress } from '../utils/ethereumBytes.js'
import { hashStruct } from '../utils/ethereumSigning.js'
import { parseTransaction } from '../utils/ethereumTransactions.js'
import { formatUnits } from '../utils/ethereumUnits.js'
import { isRecord } from '../utils/runtimeTypeGuards.js'
import { parseDirectSigningTypedData, type PersonalSigningPayload, type TransactionSigningPayload, type TypedDataSigningPayload } from './exactPayload.js'

export type LedgerPreviewScreen = Readonly<{ title: string, value: string }>
export type LedgerPreviewSettings = Readonly<{ rawMessages: boolean, displayNonce: boolean, displayHash: boolean }>
export type LedgerPreview = Readonly<{ screens: readonly LedgerPreviewScreen[], notes: readonly string[] }>

// Labels and formatting follow Ledger Ethereum 1.22.3 on Nano X; this is a local preview, not device telemetry.
export function ledgerNanoXPreview(payload: TransactionSigningPayload | PersonalSigningPayload | TypedDataSigningPayload, settings: LedgerPreviewSettings): LedgerPreview {
	const screens: LedgerPreviewScreen[] = []
	const notes: string[] = []
	const add = (title: string, value = '') => screens.push({ title, value })
	if (payload.method === 'eth_sendTransaction') {
		const tx = parseTransaction(payload.unsignedTransaction)
		const network = ledgerNetworkDisplay(payload.chainId)
		const hasData = tx.data !== undefined && tx.data !== '0x'
		if (hasData) {
			add('Blind signing ahead', 'To accept risk, press both buttons')
			notes.push('Contract data requires Blind signing. Device plugins can change this flow; decoded contract effects are Interceptor’s explanation and are not reproduced here.')
		}
		add('Review transaction')
		add('From', getAddress(payload.expectedAddress))
		if (!hasData || (tx.value ?? 0n) !== 0n) add('Amount', `${ formatUnits(tx.value ?? 0n, 18) } ${ network.ticker }`)
		add('To', tx.to === undefined ? 'Contract' : getAddress(tx.to))
		if (settings.displayNonce) add('Nonce', String(tx.nonce))
		add('Max fees', `${ formatUnits(BigInt(tx.gas ?? 0) * (tx.maxFeePerGas ?? 0n), 18) } ${ network.ticker }`)
		if (payload.chainId !== 1n) {
			add('Network', network.name)
			notes.push('Network names and tickers match the app’s built-in table. Dynamically loaded network metadata can change the device’s display.')
		}
		if (settings.displayHash || hasData) add('Tx hash', payload.digest)
		add('Sign transaction')
	} else if (payload.method === 'personal_sign') {
		const bytes = bytesFromHex(payload.message)
		const printable = bytes.every((byte) => byte >= 32 && byte <= 126 || byte >= 9 && byte <= 13)
		const message = printable ? new TextDecoder().decode(bytes).replace(/[\t\n\v\f\r]/gu, ' ') : payload.message.toLowerCase()
		add('Review message')
		add('Message', message)
		if (settings.displayHash) add('Message hash', payload.digest)
		add('Sign message')
		notes.push('Nano X replaces ASCII whitespace with spaces and displays non-ASCII or binary messages as hexadecimal. The exact original bytes above are what you sign.')
	} else {
		const data = parseDirectSigningTypedData(payload.typedDataJson)
		add('Blind signing ahead', 'To accept risk, press both buttons')
		add('Review typed message')
		// Device field titles are raw JSON keys, including repeated keys inside structs and arrays.
		let fields = 0
		const visit = (type: string, value: unknown, title: string, depth: number): void => {
			if (++fields > 8192 || depth > 16) throw new Error('Ledger preview exceeds typed-data limits')
			const array = /^(.*)\[[0-9]*\]$/u.exec(type)
			if (array?.[1] !== undefined && Array.isArray(value)) {
				for (const item of value) visit(array[1], item, title, depth + 1)
				return
			}
			const struct = data.types[type]
			if (struct !== undefined && isRecord(value)) {
				if (settings.rawMessages) add('Review struct', type)
				for (const field of struct) visit(field.type, value[field.name], field.name, depth + 1)
				return
			}
			if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new Error('Unsupported Ledger preview field')
			let text = String(value)
			if (/^u?int[0-9]+$/u.test(type)) text = BigInt(text).toString()
			if (type === 'address') text = getAddress(text)
			if (/^bytes([0-9]+)?$/u.test(type)) text = `0x${ text.slice(2).toUpperCase() }`
			add(title, text)
		}
		visit('EIP712Domain', data.domain, '', 0)
		if (settings.rawMessages) visit(data.primaryType, data.message, '', 0)
		else if (!settings.displayHash) add('Message hash', `0x${ hashStruct({ data: data.message, primaryType: data.primaryType, types: data.types }).slice(2).toUpperCase() }`)
		if (settings.displayHash) {
			add('Domain hash', `0x${ hashStruct({ data: data.domain, primaryType: 'EIP712Domain', types: data.types }).slice(2).toUpperCase() }`)
			add('Message hash', `0x${ hashStruct({ data: data.message, primaryType: data.primaryType, types: data.types }).slice(2).toUpperCase() }`)
		}
		add('Sign message')
		notes.push('This full-data EIP-712 protocol still requires Blind signing on Ethereum 1.22.3. With Raw messages enabled, press right to review every field; pressing both buttons at the skip prompt skips fields on the device.')
		notes.push('Long values may be truncated by Ledger, and unsupported characters may render differently. Compare the complete data above; this preview keeps full values visible.')
	}
	return { screens, notes }
}
