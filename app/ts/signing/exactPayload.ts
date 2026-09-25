import { secp256k1 } from '@noble/curves/secp256k1'
import { bytesFromHex, bytesToHex, ensureHex, getAddress, keccak256, type Hex } from '../utils/ethereumBytes.js'
import { hashMessage, hashTypedData, recoverAddress } from '../utils/ethereumSigning.js'
import { parseTransaction, recoverTransactionSender, serializeTransaction } from '../utils/ethereumTransactions.js'
import { EIP712Message, Eip712Number } from '../types/eip721.js'
import { verifyEip712Message } from '../utils/eip712.js'

const MAX_SIGNING_PAYLOAD_BYTES = 65536

function parseDirectSigningTransaction(serialized: Hex) {
	const parsed = parseTransaction(serialized)
	if (parsed.type !== 'eip1559' || parsed.authorizationList !== undefined) throw new Error('Direct signing supports only EIP-1559 transactions')
	return { ...parsed, authorizationList: undefined }
}

function boundedHex(value: string): Hex {
	if (value.length > 2 + MAX_SIGNING_PAYLOAD_BYTES * 2) throw new Error('Signing payload exceeds size limit')
	return ensureHex(value.toLowerCase())
}

/** These immutable values are payloads, not evidence of user approval or persisted request ownership. */
export type TransactionSigningPayload = Readonly<{
	method: 'eth_sendTransaction'
	expectedAddress: Hex
	chainId: bigint
	unsignedTransaction: Hex
	digest: Hex
}>

export type PersonalSigningPayload = Readonly<{
	method: 'personal_sign'
	expectedAddress: Hex
	message: Hex
	digest: Hex
}>

export type TypedDataSigningPayload = Readonly<{
	method: 'eth_signTypedData_v4'
	expectedAddress: Hex
	chainId: bigint
	domainChainId: bigint | undefined
	typedDataJson: string
	digest: Hex
}>

/** Bound work before the existing recursive schema validator and reject ambiguous duplicate keys. */
export function parseDirectSigningTypedData(json: string): EIP712Message {
	if (json.length > MAX_SIGNING_PAYLOAD_BYTES || new TextEncoder().encode(json).length > MAX_SIGNING_PAYLOAD_BYTES) throw new Error('Typed data exceeds size limit')
	const stack: { keys: Set<string> | undefined, expectingKey: boolean }[] = []
	let tokens = 0
	for (const match of json.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,"]+/gu)) {
		if (++tokens > 8192) throw new Error('Typed data complexity limit exceeded')
		const token = match[0]
		if (token === '{' || token === '[') {
			if (stack.length >= 16) throw new Error('Typed data nesting limit exceeded')
			stack.push({ keys: token === '{' ? new Set() : undefined, expectingKey: token === '{' })
		} else if (token === '}' || token === ']') stack.pop()
		else {
			const parent = stack[stack.length - 1]
			if (parent?.keys === undefined) continue
			if (token === ',') parent.expectingKey = true
			else if (parent.expectingKey && token.startsWith('"')) {
				const key: unknown = JSON.parse(token)
				if (typeof key !== 'string') throw new Error('Invalid typed-data key')
				if (parent.keys.has(key)) throw new Error('Duplicate typed-data key')
				parent.keys.add(key)
				parent.expectingKey = false
			}
		}
	}
	const parsed = EIP712Message.parse(json)
	const validation = verifyEip712Message(parsed)
	if (!validation.valid) throw new Error(validation.reason)
	return parsed
}

export function prepareTypedDataSigningPayload(typedDataJson: string, expectedAddress: string, chainId: bigint): TypedDataSigningPayload {
	if (chainId <= 0n) throw new Error('Invalid signing chain')
	const parsed = parseDirectSigningTypedData(typedDataJson)
	const { chainId: rawDomainChainId } = parsed.domain
	const domainChainId = rawDomainChainId === undefined ? undefined : Eip712Number.parse(rawDomainChainId)
	if (domainChainId !== undefined && domainChainId !== chainId) throw new Error('Typed-data domain chain does not match the signing request')
	return Object.freeze({ method: 'eth_signTypedData_v4', expectedAddress: getAddress(expectedAddress), chainId, domainChainId, typedDataJson, digest: hashTypedData(parsed) })
}

export async function verifyTypedDataSigningResponse(payload: TypedDataSigningPayload, signature: string): Promise<Hex> {
	const prepared = prepareTypedDataSigningPayload(payload.typedDataJson, payload.expectedAddress, payload.chainId)
	if (prepared.digest !== payload.digest || prepared.domainChainId !== payload.domainChainId) throw new Error('Signing payload digest or domain mismatch')
	const recovered = await recoverAddress({ hash: prepared.digest, signature: signatureParts(signature) })
	if (recovered.toLowerCase() !== prepared.expectedAddress.toLowerCase()) throw new Error('Signature does not match the expected account and typed data')
	return ensureHex(signature)
}

export function prepareTransactionSigningPayload(unsignedTransaction: string, expectedAddress: string, chainId: bigint): TransactionSigningPayload {
	const unsigned = boundedHex(unsignedTransaction)
	const parsed = parseDirectSigningTransaction(unsigned)
	if (chainId <= 0n || parsed.chainId !== chainId) throw new Error('Transaction chain does not match the signing request')
	if ('r' in parsed || 's' in parsed || 'yParity' in parsed) throw new Error('Expected an unsigned transaction')
	if (serializeTransaction(parsed).toLowerCase() !== unsigned) throw new Error('Noncanonical unsigned transaction')
	return Object.freeze({ method: 'eth_sendTransaction', expectedAddress: getAddress(expectedAddress), chainId, unsignedTransaction: unsigned, digest: keccak256(unsigned) })
}

export function preparePersonalSigningPayload(message: string, expectedAddress: string): PersonalSigningPayload {
	const exactBytes = boundedHex(message)
	return Object.freeze({ method: 'personal_sign', expectedAddress: getAddress(expectedAddress), message: exactBytes, digest: hashMessage({ raw: exactBytes }) })
}

function signatureParts(signature: string) {
	if (signature.length !== 132) throw new Error('Expected a 65-byte Ethereum signature')
	const bytes = bytesFromHex(ensureHex(signature))
	const recovery = bytes[64]
	if (recovery !== 0 && recovery !== 1 && recovery !== 27 && recovery !== 28) throw new Error('Invalid signature recovery byte')
	const r = BigInt(bytesToHex(bytes.subarray(0, 32)))
	const s = BigInt(bytesToHex(bytes.subarray(32, 64)))
	if (r <= 0n || r >= secp256k1.CURVE.n || s <= 0n || s > secp256k1.CURVE.n / 2n) throw new Error('Invalid or noncanonical Ethereum signature')
	return { r, s, yParity: recovery >= 27 ? recovery - 27 : recovery }
}

export async function verifyPersonalSigningResponse(payload: PersonalSigningPayload, signature: string): Promise<Hex> {
	const prepared = preparePersonalSigningPayload(payload.message, payload.expectedAddress)
	if (prepared.digest !== payload.digest) throw new Error('Signing payload digest mismatch')
	const recovered = await recoverAddress({ hash: prepared.digest, signature: signatureParts(signature) })
	if (recovered.toLowerCase() !== prepared.expectedAddress.toLowerCase()) throw new Error('Signature does not match the expected account and message')
	return ensureHex(signature)
}

export async function assembleSignedTransaction(payload: TransactionSigningPayload, signature: string): Promise<Hex> {
	const prepared = prepareTransactionSigningPayload(payload.unsignedTransaction, payload.expectedAddress, payload.chainId)
	if (prepared.digest !== payload.digest) throw new Error('Signing payload digest mismatch')
	const parts = signatureParts(signature)
	const recovered = await recoverAddress({ hash: prepared.digest, signature: parts })
	if (recovered.toLowerCase() !== prepared.expectedAddress.toLowerCase()) throw new Error('Signature does not match the expected account and transaction')
	const signed = serializeTransaction(parseDirectSigningTransaction(prepared.unsignedTransaction), parts)
	return verifySignedTransaction(prepared, signed)
}

/** Re-serialize all unsigned fields, including the access list, before accepting a signed transaction. */
export function verifySignedTransaction(payload: TransactionSigningPayload, signedTransaction: string): Hex {
	const prepared = prepareTransactionSigningPayload(payload.unsignedTransaction, payload.expectedAddress, payload.chainId)
	if (prepared.digest !== payload.digest) throw new Error('Signing payload digest mismatch')
	const signed = boundedHex(signedTransaction)
	const parsed = parseDirectSigningTransaction(signed)
	if (parsed.type !== 'eip1559' || parsed.r === undefined || parsed.s === undefined || parsed.yParity === undefined) throw new Error('Expected a signed EIP-1559 transaction')
	if (serializeTransaction(parsed).toLowerCase() !== prepared.unsignedTransaction) throw new Error('Signed transaction fields differ from the reviewed payload')
	const signature = { r: parsed.r, s: parsed.s, yParity: parsed.yParity }
	if (BigInt(signature.s) > secp256k1.CURVE.n / 2n) throw new Error('Noncanonical transaction signature')
	if (serializeTransaction(parsed, signature).toLowerCase() !== signed) throw new Error('Noncanonical signed transaction')
	if (recoverTransactionSender(signed).toLowerCase() !== prepared.expectedAddress.toLowerCase()) throw new Error('Signed transaction has the wrong sender')
	return signed
}
