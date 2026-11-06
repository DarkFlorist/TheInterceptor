import { expect, test } from 'bun:test'
import airgap from '../fixtures/directSigning/airgap-vault-3.34.4.json'
import ledger from '../fixtures/directSigning/ledger-nanox-1.22.3.json'
import ledgerRaw from '../fixtures/directSigning/ledger-nanox-1.22.3-raw.json'
import { createAirGapAccountImporter } from '../../app/ts/signing/airgapAccountImport.js'
import { createAirGapUrEncoder, createAirGapUrDecoder } from '../../app/ts/signing/airgapUr.js'
import { encodeAirGapSigningRequest, verifyAirGapSigningResponse } from '../../app/ts/signing/airgapEthereum.js'
import { preparePersonalSigningPayload, prepareTransactionSigningPayload, prepareTypedDataSigningPayload, verifyPersonalSigningResponse, verifyTypedDataSigningResponse, verifySignedTransaction } from '../../app/ts/signing/exactPayload.js'
import { bytesFromHex, bytesToHex, ensureHex } from '../../app/ts/utils/ethereumBytes.js'
import { serializeTransaction } from '../../app/ts/utils/ethereumTransactions.js'

const payloadFor = (method: string, data: string, address: string) => {
	if (method === 'personal_sign') return preparePersonalSigningPayload(data, address)
	if (method === 'eth_signTypedData_v4') return prepareTypedDataSigningPayload(data, address, 1n)
	if (method === 'eth_sendTransaction') return prepareTransactionSigningPayload(data, address, 1n)
	throw new Error('Unknown reference method')
}

test('imports Vault 3.34.4 public account and checks independent signing/QR reference vectors', async () => {
	const importer = createAirGapAccountImporter()
	const account = importer(createAirGapUrEncoder('crypto-hdkey', bytesFromHex(ensureHex(airgap.accountExport))).part(1).toUpperCase()).accounts?.[0]
	expect(account).toEqual(airgap.account)
	if (account === undefined) throw new Error('Missing account')
	for (const vector of airgap.vectors) {
		const payload = payloadFor(vector.method, vector.data, account.address)
		expect(bytesToHex(encodeAirGapSigningRequest(account, payload, 1n, airgap.requestId))).toBe(vector.request)
		const decoder = createAirGapUrDecoder('eth-signature')
		let result: Uint8Array | undefined
		for (const frame of [...vector.responseFrames].reverse()) { result = decoder.receive(frame).payload; if (result !== undefined) break }
		if (result === undefined) throw new Error('Missing QR response')
		expect(bytesToHex(result)).toBe(vector.response)
		expect(await verifyAirGapSigningResponse(result, airgap.requestId, payload)).toBe(vector.verified)
	}
})

test('public account scanner rejects signing responses and switching registry mid-import', () => {
	expect(() => createAirGapAccountImporter()('ur:eth-signature/abcd')).toThrow('public-account export')
	const importer = createAirGapAccountImporter()
	const cbor = bytesFromHex(ensureHex(airgap.accountExport))
	importer(createAirGapUrEncoder('crypto-hdkey', cbor, 30).part(1))
	expect(() => importer(createAirGapUrEncoder('crypto-account', cbor, 30).part(2))).toThrow()
})

test('independently verifies Nano X emulator signatures in both raw-message display modes', async () => {
	for (const fixture of [ledger, ledgerRaw]) {
		const { address } = fixture.account
		for (const transcript of fixture.transcripts) {
			if (transcript.method === 'eth_sendTransaction') {
				const unsigned = serializeTransaction({ type: 'eip1559', chainId: 1n, nonce: 0n, gas: 21000n, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n, to: address, value: 1000000000000000n })
				expect(verifySignedTransaction(prepareTransactionSigningPayload(unsigned, address, 1n), transcript.result)).toBe(transcript.result)
			} else if (transcript.method === 'personal_sign') {
				expect(await verifyPersonalSigningResponse(preparePersonalSigningPayload('0x48656c6c6f204c6564676572', address), transcript.result)).toBe(transcript.result)
			} else {
				const typed = JSON.stringify({ types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Message: [{ name: 'contents', type: 'string' }] }, primaryType: 'Message', domain: { name: 'Interceptor', chainId: 1 }, message: { contents: 'Hello Ledger' } })
				expect(await verifyTypedDataSigningResponse(prepareTypedDataSigningPayload(typed, address, 1n), transcript.result)).toBe(transcript.result)
			}
		}
	}
})
