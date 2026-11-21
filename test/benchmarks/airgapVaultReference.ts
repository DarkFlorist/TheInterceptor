// Opt-in reference check: install the versions documented in docs/direct-signing-development.md in an isolated directory.
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { importAirGapAccounts, encodeAirGapSigningRequest, verifyAirGapSigningResponse } from '../../app/ts/signing/airgapEthereum.js'
import { createAirGapUrEncoder, createAirGapUrDecoder } from '../../app/ts/signing/airgapUr.js'
import { preparePersonalSigningPayload, prepareTransactionSigningPayload, prepareTypedDataSigningPayload } from '../../app/ts/signing/exactPayload.js'
import { serializeTransaction } from '../../app/ts/utils/ethereumTransactions.js'
import { bytesToHex } from '../../app/ts/utils/ethereumBytes.js'

const directory = process.env.AIRGAP_REFERENCE_DIR
if (directory === undefined) throw new Error('Set AIRGAP_REFERENCE_DIR to the isolated reference package directory')
const reference = createRequire(resolve(directory, 'package.json'))
const versions = { '@airgap/ethereum': '0.13.46', '@airgap/coinlib-core': '0.13.46', '@airgap/crypto': '0.13.46', '@airgap/module-kit': '0.13.46', '@airgap/serializer': '0.13.46', '@keystonehq/bc-ur-registry-eth': '0.19.1', '@ngraveio/bc-ur': '1.1.6', '@ethereumjs/tx': '3.4.0' }
for (const [name, version] of Object.entries(versions)) assert.equal(reference(`${ name }/package.json`).version, version)
const { createEthereumProtocol } = reference('@airgap/ethereum')
const { derive } = reference('@airgap/crypto')
const { EthereumV3SerializerCompanion } = reference('@airgap/ethereum/v1/serializer/v3/serializer-companion')
const { CryptoHDKey, CryptoKeypath, PathComponent } = reference('@keystonehq/bc-ur-registry')
const { EthSignRequest, ETHSignature, DataType } = reference('@keystonehq/bc-ur-registry-eth')
const { URDecoder } = reference('@ngraveio/bc-ur')
const { TransactionFactory } = reference('@ethereumjs/tx')
const bitcoin = reference('@airgap/coinlib-core/dependencies/src/bitgo-utxo-lib-5d91049fd7a988382df81c8260e244ee56d57aac/src')
const protocol = createEthereumProtocol()
const serializer = new EthereumV3SerializerCompanion()
// BIP-32 public reference seed. Never use a real wallet's secret in this harness.
const seed = '000102030405060708090a0b0c0d0e0f'
const accountPath = 'm/44\'/60\'/0\''
const path = `${ accountPath }/0/0`
const root = bitcoin.HDNode.fromSeedHex(seed)
const node = root.derivePath(accountPath).neutered()
// Match Vault 3.34.4's MetamaskGenerator: origin carries this account node's fingerprint.
const key = new CryptoHDKey({ isMaster: false, key: node.getPublicKeyBuffer(), chainCode: node.chainCode, origin: new CryptoKeypath([new PathComponent({ index: 44, hardened: true }), new PathComponent({ index: 60, hardened: true }), new PathComponent({ index: 0, hardened: true })], node.getFingerprint()), parentFingerprint: root.getFingerprint(), name: 'AirGap - Reference' })
const exported = key.toCBOR()
const account = importAirGapAccounts('crypto-hdkey', exported)[0]
if (account === undefined) throw new Error('Missing imported account')
// Vault's v0 adapter delegates to this v1 protocol, serializer, and key-derivation pipeline.
const derivative = await derive(await protocol.getCryptoConfiguration(), Buffer.from(seed, 'hex'), accountPath)
const extended = await protocol.getExtendedKeyPairFromDerivative(derivative)
const publicKey = await protocol.deriveFromExtendedPublicKey(extended.publicKey, 0, 0)
const secretKey = await protocol.deriveFromExtendedSecretKey(extended.secretKey, 0, 0)
assert.equal(account.address.toLowerCase(), (await protocol.getAddressFromPublicKey(publicKey)).toLowerCase())
const requestId = '11111111-1111-4111-8111-111111111111'
const inputs = [
	prepareTransactionSigningPayload(serializeTransaction({ type: 'eip1559', chainId: 1n, nonce: 7n, gas: 21000n, maxFeePerGas: 30000000000n, maxPriorityFeePerGas: 1000000000n, to: account.address, value: 1000000000000000n }), account.address, 1n),
	preparePersonalSigningPayload('0x000affc3a948656c6c6f', account.address),
	prepareTypedDataSigningPayload(JSON.stringify({ types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Message: [{ name: 'values', type: 'uint256[]' }, { name: 'contents', type: 'string' }] }, primaryType: 'Message', domain: { name: 'Interceptor', chainId: 1 }, message: { values: ['1', '2', '9007199254740993'], contents: 'AirGap reference' } }), account.address, 1n),
]
const vectors = []
for (const payload of inputs) {
	const cbor = encodeAirGapSigningRequest(account, payload, 1n, requestId)
	const encoder = createAirGapUrEncoder('eth-sign-request', cbor, 40)
	const requestDecoder = new URDecoder()
	// Lose every systematic fragment: decode mixed fountain fragments only, in reverse order.
	const frames = Array.from({ length: 160 }, (_, index) => encoder.part(index + 1))
	for (const frame of frames.slice(encoder.count).reverse()) { requestDecoder.receivePart(frame); if (requestDecoder.isComplete()) break }
	assert.equal(requestDecoder.isSuccess(), true)
	assert.deepEqual(Buffer.from(requestDecoder.resultUR().cbor), Buffer.from(cbor))
	const decoded = EthSignRequest.fromCBOR(requestDecoder.resultUR().cbor)
	assert.equal(decoded.getDerivationPath(), path.slice(2))
	assert.equal(decoded.getChainId(), 1)
	assert.equal(decoded.derivationPath.getSourceFingerprint().readUInt32BE(0), account.sourceFingerprint)
	let signature: Buffer
	if (payload.method === 'eth_sendTransaction') {
		assert.equal(decoded.getDataType(), DataType.typedTransaction)
		const unsigned = await serializer.fromTransactionSignRequest('eth', { transaction: { serialized: decoded.getSignData().toString('hex'), derivationPath: decoded.getDerivationPath(), masterFingerprint: decoded.derivationPath.getSourceFingerprint().toString('hex') }, publicKey: '' })
		const signed = await protocol.signTransactionWithSecretKey(unsigned, secretKey)
		const transaction = TransactionFactory.fromSerializedData(Buffer.from(signed.serialized, 'hex'))
		signature = Buffer.concat([Buffer.from(transaction.r.toString(16, 32), 'hex'), Buffer.from(transaction.s.toString(16, 32), 'hex'), Buffer.from(transaction.v.toString(16, 2), 'hex')])
	} else {
		assert.equal(decoded.getDataType(), payload.method === 'personal_sign' ? DataType.personalMessage : DataType.typedData)
		const message = payload.method === 'personal_sign' ? `0x${ decoded.getSignData().toString('hex') }` : decoded.getSignData().toString()
		signature = Buffer.from((await protocol.signMessageWithKeyPair(message, { secretKey, publicKey })).value.replace(/^0x/u, ''), 'hex')
	}
	const response = new ETHSignature(signature, decoded.getRequestId())
	const responseEncoder = response.toUREncoder(30)
	const responseDecoder = createAirGapUrDecoder('eth-signature')
	let responsePayload: Uint8Array | undefined
	const responseFrames: string[] = []
	for (let index = 0; index < 160 && responsePayload === undefined; index++) {
		const frame: string = responseEncoder.nextPart()
		responseFrames.push(frame)
		// Drop systematic fragments so local fountain decoding also uses mixed reference fragments.
		if (index >= responseEncoder.fragmentsLength) responsePayload = responseDecoder.receive(frame).payload
	}
	if (responsePayload === undefined) throw new Error('Reference response did not decode')
	assert.deepEqual(Buffer.from(responsePayload), response.toCBOR())
	const verified = await verifyAirGapSigningResponse(responsePayload, requestId, payload)
	vectors.push({ method: payload.method, data: payload.method === 'personal_sign' ? payload.message : payload.method === 'eth_sendTransaction' ? payload.unsignedTransaction : payload.typedDataJson, request: bytesToHex(cbor), response: bytesToHex(responsePayload), responseFrames, verified })
}
console.info(JSON.stringify({ vault: '3.34.4', versions, accountExport: bytesToHex(exported), account, requestId, vectors }, undefined, 2))
