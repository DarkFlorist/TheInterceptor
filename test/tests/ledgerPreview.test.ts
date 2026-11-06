import { describe, expect, test } from 'bun:test'
import { ledgerNanoXPreview } from '../../app/ts/signing/ledgerPreview.js'
import { preparePersonalSigningPayload, prepareTransactionSigningPayload, prepareTypedDataSigningPayload } from '../../app/ts/signing/exactPayload.js'
import { serializeTransaction } from '../../app/ts/utils/ethereumTransactions.js'

const address = '0xDad77910DbDFdE764fC21FCD4E74D71bBACA6D8D'
const settings = { rawMessages: false, displayNonce: false, displayHash: false }
const typed = prepareTypedDataSigningPayload(JSON.stringify({ types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Message: [{ name: 'contents', type: 'string' }] }, primaryType: 'Message', domain: { name: 'Interceptor', chainId: 1 }, message: { contents: 'Hello Ledger' } }), address, 1n)

describe('Nano X Ethereum 1.22.3 screen content', () => {
	test('matches the plain EIP-1559 transfer emulator transcript without optional screens', () => {
		const payload = prepareTransactionSigningPayload(serializeTransaction({ type: 'eip1559', chainId: 1n, nonce: 0n, gas: 21000n, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n, to: address, value: 1000000000000000n }), address, 1n)
		expect(ledgerNanoXPreview(payload, settings).screens).toEqual([
			{ title: 'Review transaction', value: '' }, { title: 'From', value: address }, { title: 'Amount', value: '0.001 ETH' }, { title: 'To', value: address }, { title: 'Max fees', value: '0.000042 ETH' }, { title: 'Sign transaction', value: '' },
		])
		const optional = ledgerNanoXPreview(payload, { ...settings, displayNonce: true, displayHash: true }).screens
		expect(optional).toContainEqual({ title: 'Nonce', value: '0' })
		expect(optional).toContainEqual({ title: 'Tx hash', value: payload.digest })
	})
	test('uses Ledger network tickers and labels rather than assuming ETH on another chain', () => {
		const payload = prepareTransactionSigningPayload(serializeTransaction({ type: 'eip1559', chainId: 137n, nonce: 0n, gas: 53000n, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n, value: 1n }), address, 137n)
		const screens = ledgerNanoXPreview(payload, settings).screens
		expect(screens).toContainEqual({ title: 'Network', value: 'Polygon' })
		expect(screens).toContainEqual({ title: 'Amount', value: '0.000000000000000001 POL' })
		expect(screens).toContainEqual({ title: 'To', value: 'Contract' })
	})

	test('keeps personal-sign bytes exact while matching device whitespace and binary presentation', () => {
		const plain = preparePersonalSigningPayload('0x48656c6c6f204c6564676572', address)
		expect(ledgerNanoXPreview(plain, settings).screens).toEqual([{ title: 'Review message', value: '' }, { title: 'Message', value: 'Hello Ledger' }, { title: 'Sign message', value: '' }])
		const whitespace = preparePersonalSigningPayload('0x61090a0b0c0d62', address)
		expect(ledgerNanoXPreview(whitespace, settings).screens[1]?.value).toBe('a     b')
		expect(whitespace.message).toBe('0x61090a0b0c0d62')
		const binary = preparePersonalSigningPayload('0x00ffc3a9', address)
		expect(ledgerNanoXPreview(binary, settings).screens[1]?.value).toBe('0x00ffc3a9')
	})
	test('matches the domain and message hash shown with Raw messages disabled', () => {
		expect(ledgerNanoXPreview(typed, settings).screens).toEqual([
			{ title: 'Blind signing ahead', value: 'To accept risk, press both buttons' }, { title: 'Review typed message', value: '' }, { title: 'name', value: 'Interceptor' }, { title: 'chainId', value: '1' }, { title: 'Message hash', value: '0x98F0DC9D02335FC4A066D382C5FB74AB423E09EB3A05F82F08CC4152A13CC7AA' }, { title: 'Sign message', value: '' },
		])
	})
	test('shows typed fields only when the preview is set to Raw messages', () => {
		const preview = ledgerNanoXPreview(typed, { ...settings, rawMessages: true })
		expect(preview.screens.filter((screen) => screen.title === 'Review struct').map((screen) => screen.value)).toEqual(['EIP712Domain', 'Message'])
		expect(preview.screens).toContainEqual({ title: 'contents', value: 'Hello Ledger' })
		expect(preview.screens.some((screen) => screen.title === 'Message hash')).toBe(false)
	})
})
