import { hmac } from '@noble/hashes/hmac'
import { sha512 } from '@noble/hashes/sha512'
import { concatBytes } from '@noble/hashes/utils'
import { secp256k1 } from '@noble/curves/secp256k1'
import { addr } from 'micro-eth-signer'
import { bytesFromHex, bytesToHex, ensureHex, getAddress, type Hex } from '../utils/ethereumBytes.js'
import { decodeAirGapCbor, encodeAirGapCbor, type AirGapCbor } from './airgapCbor.js'
import { parseDerivationPath } from '../utils/derivationPath.js'
import { assembleSignedTransaction, preparePersonalSigningPayload, prepareTransactionSigningPayload, prepareTypedDataSigningPayload, verifyPersonalSigningResponse, verifyTypedDataSigningResponse, type PersonalSigningPayload, type TransactionSigningPayload, type TypedDataSigningPayload } from './exactPayload.js'

export type AirGapPublicAccount = Readonly<{ address: Hex, publicKey: Hex, derivationPath: string, sourceFingerprint: number }>
type DirectPayload = TransactionSigningPayload | PersonalSigningPayload | TypedDataSigningPayload

function map(value: AirGapCbor | undefined): ReadonlyMap<bigint, AirGapCbor> {
	if (!(value instanceof Map)) throw new Error('Expected an AirGap registry map')
	return value
}

function tagged(value: AirGapCbor | undefined, tag: bigint): AirGapCbor {
	if (typeof value !== 'object' || value === undefined || !('tag' in value) || value.tag !== tag) throw new Error(`Expected AirGap registry tag ${ tag }`)
	return value.value
}

function fingerprint(value: AirGapCbor | undefined): number {
	if (typeof value !== 'bigint' || value < 1n || value > 0xffffffffn) throw new Error('AirGap export requires a nonzero master fingerprint')
	return Number(value)
}

function publicChild(publicKey: Uint8Array, chainCode: Uint8Array, index: number) {
	const encodedIndex = new Uint8Array(4)
	new DataView(encodedIndex.buffer).setUint32(0, index)
	const digest = hmac(sha512, chainCode, concatBytes(publicKey, encodedIndex))
	const tweak = BigInt(bytesToHex(digest.subarray(0, 32)))
	if (tweak === 0n || tweak >= secp256k1.CURVE.n) throw new Error('Invalid BIP-32 child; choose a different account index')
	const point = secp256k1.ProjectivePoint.fromHex(publicKey).add(secp256k1.ProjectivePoint.BASE.multiply(tweak))
	if (point.equals(secp256k1.ProjectivePoint.ZERO)) throw new Error('Invalid BIP-32 child point')
	return { publicKey: point.toRawBytes(true), chainCode: digest.slice(32) }
}

function importHdKey(value: AirGapCbor, masterFingerprint: number | undefined, childIndex: number): AirGapPublicAccount {
	const fields = map(value)
	if ((fields.has(1n) && fields.get(1n) !== false) || (fields.has(2n) && fields.get(2n) !== false)) throw new Error('Import public derived accounts only; private or master-key exports are not accepted')
	for (const key of fields.keys()) if (key < 1n || key > 10n) throw new Error('Unsupported AirGap HD-key field')
	if (fields.has(7n)) throw new Error('AirGap child-range exports are unsupported; export a concrete Ethereum account')
	const rawKey = fields.get(3n)
	if (!(rawKey instanceof Uint8Array) || rawKey.length !== 33 || (rawKey[0] !== 2 && rawKey[0] !== 3)) throw new Error('AirGap export must contain a compressed secp256k1 public key')
	secp256k1.ProjectivePoint.fromHex(rawKey).assertValidity()
	if (fields.has(5n)) {
		const use = map(tagged(fields.get(5n), 305n))
		if (use.get(1n) !== 60n) throw new Error('AirGap export is not an Ethereum account')
	}
	const origin = map(tagged(fields.get(6n), 304n))
	const components = origin.get(1n)
	if (!Array.isArray(components) || (components.length !== 6 && components.length !== 10)) throw new Error('Export an Ethereum account root or a concrete five-component Ethereum path')
	const sourceFingerprint = origin.has(2n) ? fingerprint(origin.get(2n)) : masterFingerprint
	if (sourceFingerprint === undefined || (masterFingerprint !== undefined && sourceFingerprint !== masterFingerprint)) throw new Error('AirGap master fingerprint is missing or inconsistent')
	if (origin.has(3n) && origin.get(3n) !== BigInt(components.length / 2)) throw new Error('AirGap derivation depth does not match its path')
	let derivationPath = 'm'
	for (let index = 0; index < components.length; index += 2) {
		const child = components[index]
		const hardened = components[index + 1]
		if (typeof child !== 'bigint' || child < 0n || child >= 0x80000000n || typeof hardened !== 'boolean') throw new Error('AirGap derivation paths must contain concrete indices')
		derivationPath += `/${ child }${ hardened ? '\'' : '' }`
	}
	if (components[0] !== 44n || components[1] !== true || components[2] !== 60n || components[3] !== true || components[5] !== true) throw new Error('AirGap account must use the Ethereum BIP-44 derivation path')
	let publicKey: Uint8Array = rawKey
	const chainCode = fields.get(4n)
	if (chainCode !== undefined && (!(chainCode instanceof Uint8Array) || chainCode.length !== 32)) throw new Error('Invalid AirGap chain code')
	if (components.length === 6) {
		if (!(chainCode instanceof Uint8Array)) throw new Error('Account-root export needs a chain code to derive an address')
		const change = publicChild(rawKey, chainCode, 0)
		publicKey = publicChild(change.publicKey, change.chainCode, childIndex).publicKey
		derivationPath += `/0/${ childIndex }`
	} else if (components[6] !== 0n || components[7] !== false || components[9] !== false) throw new Error('Unsupported AirGap Ethereum change or address path')
	return Object.freeze({ address: getAddress(addr.fromPublicKey(publicKey)), publicKey: bytesToHex(publicKey), derivationPath, sourceFingerprint })
}

export function importAirGapAccounts(type: 'crypto-hdkey' | 'crypto-account', cbor: Uint8Array, childIndex = 0): readonly AirGapPublicAccount[] {
	if (!Number.isInteger(childIndex) || childIndex < 0 || childIndex > 19) throw new Error('Choose an AirGap account index from 0 to 19')
	const decoded = decodeAirGapCbor(cbor)
	if (type === 'crypto-hdkey') return [importHdKey(decoded, undefined, childIndex)]
	if (type !== 'crypto-account') throw new Error('Unsupported AirGap public-account registry')
	const account = map(decoded)
	for (const key of account.keys()) if (key !== 1n && key !== 2n) throw new Error('Unsupported AirGap account-export field')
	const master = fingerprint(account.get(1n))
	const outputs = account.get(2n)
	if (!Array.isArray(outputs) || outputs.length === 0 || outputs.length > 20) throw new Error('AirGap export must contain between 1 and 20 public accounts')
	const accounts = outputs.map((output) => {
		let value: AirGapCbor = output
		if (typeof value === 'object' && 'tag' in value && value.tag === 308n) value = value.value
		if (typeof value === 'object' && 'tag' in value && value.tag === 403n) value = value.value
		return importHdKey(tagged(value, 303n), master, childIndex)
	})
	if (new Set(accounts.map((entry) => entry.address)).size !== accounts.length) throw new Error('AirGap export contains duplicate accounts')
	return accounts
}

function requestIdBytes(requestId: string) {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId)) throw new Error('AirGap request ID must be a UUID v4')
	return bytesFromHex(ensureHex(`0x${ requestId.replaceAll('-', '') }`))
}

export function encodeAirGapSigningRequest(account: AirGapPublicAccount, payload: DirectPayload, chainId: bigint, requestId: string): Uint8Array {
	if (chainId < 1n || chainId > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Chain ID exceeds AirGap protocol interoperability limits')
	if (getAddress(account.address) !== getAddress(payload.expectedAddress) || getAddress(addr.fromPublicKey(bytesFromHex(account.publicKey))) !== getAddress(account.address)) throw new Error('AirGap public account does not match the request')
	const sourceFingerprint = fingerprint(BigInt(account.sourceFingerprint))
	let data: Uint8Array
	let dataType: bigint
	if (payload.method === 'eth_sendTransaction') {
		const prepared = prepareTransactionSigningPayload(payload.unsignedTransaction, payload.expectedAddress, chainId)
		if (payload.chainId !== chainId || prepared.digest !== payload.digest) throw new Error('AirGap transaction payload changed')
		data = bytesFromHex(payload.unsignedTransaction)
		dataType = 4n
	} else if (payload.method === 'eth_signTypedData_v4') {
		const prepared = prepareTypedDataSigningPayload(payload.typedDataJson, payload.expectedAddress, chainId)
		if (payload.chainId !== chainId || prepared.digest !== payload.digest || prepared.domainChainId !== payload.domainChainId) throw new Error('AirGap typed-data payload changed')
		data = new TextEncoder().encode(payload.typedDataJson)
		dataType = 2n
	} else {
		if (preparePersonalSigningPayload(payload.message, payload.expectedAddress).digest !== payload.digest) throw new Error('AirGap personal-sign payload changed')
		data = bytesFromHex(payload.message)
		dataType = 3n
	}
	const path = parseDerivationPath(account.derivationPath)
	if (path === undefined) throw new Error('Invalid AirGap derivation path')
	const components: AirGapCbor[] = path.flatMap(({ index, hardened }) => [BigInt(index), hardened])
	return encodeAirGapCbor(new Map<bigint, AirGapCbor>([
		[1n, { tag: 37n, value: requestIdBytes(requestId) }], [2n, data], [3n, dataType], [4n, chainId],
		[5n, { tag: 304n, value: new Map<bigint, AirGapCbor>([[1n, components], [2n, BigInt(sourceFingerprint)]]) }],
		[6n, bytesFromHex(account.address)], [7n, 'Interceptor'],
	]))
}

export async function verifyAirGapSigningResponse(cbor: Uint8Array, requestId: string, payload: DirectPayload): Promise<Hex> {
	const response = map(decodeAirGapCbor(cbor))
	for (const key of response.keys()) if (key < 1n || key > 3n) throw new Error('Unsupported AirGap signature field')
	const responseId = tagged(response.get(1n), 37n)
	if (!(responseId instanceof Uint8Array) || bytesToHex(responseId) !== bytesToHex(requestIdBytes(requestId))) throw new Error('AirGap signature belongs to another request')
	const signature = response.get(2n)
	if (!(signature instanceof Uint8Array) || signature.length !== 65) throw new Error('AirGap response must contain a 65-byte signature')
	const hex = bytesToHex(signature)
	if (payload.method === 'eth_sendTransaction') return await assembleSignedTransaction(payload, hex)
	if (payload.method === 'personal_sign') return await verifyPersonalSigningResponse(payload, hex)
	return await verifyTypedDataSigningResponse(payload, hex)
}
