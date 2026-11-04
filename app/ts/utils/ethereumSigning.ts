import { concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { addr, eip191Signer } from 'micro-eth-signer'
import { initSig, sign as signDigestWithMicro } from 'micro-eth-signer/utils.js'
import { canonicalAbiType, FIXED_BYTES_REGEX, INTEGER_REGEX, parseIntegerString } from './ethereumAbiInternals.js'
import { bytesFromHex, bytesFromHexOrBytes, ensureHex, hexOrUtf8StringToBytes, keccak256, stringToBytes, type Hex } from './ethereumBytes.js'
import { encodeAbiParameters } from './ethereumPrimitiveCore.js'
import { normalizeSignatureYParity } from './ethereumSignature.js'
import { isRecord } from './runtimeTypeGuards.js'

type TypedDataField = {
	readonly name: string
	readonly type: string
}

type TypedData = {
	readonly types: { readonly EIP712Domain?: readonly TypedDataField[] } & Record<string, readonly TypedDataField[] | undefined>
	readonly primaryType: string
	readonly domain: Record<string, unknown>
	readonly message: Record<string, unknown>
}

type HashStructParameters = {
	readonly data: Record<string, unknown>
	readonly primaryType: string
	readonly types: Record<string, readonly TypedDataField[] | undefined>
}

const DOMAIN_FIELD_TYPES = {
	name: 'string',
	version: 'string',
	chainId: 'uint256',
	verifyingContract: 'address',
	salt: 'bytes32',
} as const
const DETERMINISTIC_SIGNATURES = false

const integerToMinimalBytes = (value: number | bigint): Uint8Array => {
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Number "${ value }" is not in safe integer range`)
		return integerToMinimalBytes(BigInt(value))
	}
	if (value < 0n) throw new Error(`Number "${ value }" is not in safe integer range`)
	const hex = value.toString(16)
	return hexToBytes(hex.length % 2 === 0 ? hex : `0${ hex }`)
}

const bytesFromTypedDataPrimitive = (value: unknown): Uint8Array => {
	if (value instanceof Uint8Array) return value
	if (typeof value === 'boolean') return new Uint8Array([value ? 1 : 0])
	if (typeof value === 'number' || typeof value === 'bigint') return integerToMinimalBytes(value)
	if (typeof value === 'string') return hexOrUtf8StringToBytes(value)
	return utf8ToBytes(String(value))
}

const bytesFromTypedDataString = (value: unknown): Uint8Array => typeof value === 'string' ? utf8ToBytes(value) : bytesFromTypedDataPrimitive(value)

export const hashMessage = (message: string | { readonly raw: Hex | Uint8Array }): Hex => {
	const messageBytes = typeof message === 'string' ? stringToBytes(message) : bytesFromHexOrBytes(message.raw)
	const prefix = stringToBytes(`\x19Ethereum Signed Message:\n${ messageBytes.length }`)
	return keccak256(concatBytes(prefix, messageBytes))
}

const getTypedDataDependencies = (types: Record<string, readonly TypedDataField[] | undefined>, primaryType: string, found = new Set<string>()): Set<string> => {
	const fields = types[primaryType]
	if (fields === undefined) throw new Error(`Unknown EIP-712 type ${ primaryType }`)
	for (const field of fields) {
		const baseType = getBaseTypedDataType(field.type)
		if (baseType === primaryType || found.has(baseType) || types[baseType] === undefined) continue
		found.add(baseType)
		getTypedDataDependencies(types, baseType, found)
	}
	return found
}

const getBaseTypedDataType = (type: string) => type.replace(/\[[0-9]*\]/gu, '')

const encodeTypedDataType = (types: Record<string, readonly TypedDataField[] | undefined>, primaryType: string): string => {
	const fields = types[primaryType]
	if (fields === undefined) throw new Error(`Unknown EIP-712 type ${ primaryType }`)
	return `${ primaryType }(${ fields.map((field) => `${ field.type } ${ field.name }`).join(',') })`
}

const encodeType = (types: Record<string, readonly TypedDataField[] | undefined>, primaryType: string): string => {
	const dependencies = [...getTypedDataDependencies(types, primaryType)].sort()
	return [primaryType, ...dependencies].map((type) => encodeTypedDataType(types, type)).join('')
}

const splitArrayTypedDataType = (type: string): { readonly itemType: string } | undefined => {
	const match = type.match(/^(.+)\[[0-9]*\]$/u)
	return match?.[1] === undefined ? undefined : { itemType: match[1] }
}

const normalizeEip712PrimitiveValue = (type: string, value: unknown): unknown => {
	if (INTEGER_REGEX.test(type) && typeof value === 'string') return parseIntegerString(value) ?? value
	if ((type === 'bytes' || FIXED_BYTES_REGEX.test(type)) && typeof value === 'string') return bytesFromHex(ensureHex(value, type))
	return value
}

const encodeTypedDataValue = (
	type: string,
	value: unknown,
	types: Record<string, readonly TypedDataField[] | undefined>,
): { readonly abiType: string, readonly value: unknown } => {
	const arrayType = splitArrayTypedDataType(type)
	if (arrayType !== undefined) {
		if (!Array.isArray(value)) throw new Error(`Expected array value for ${ type }`)
		const encodedItems = value.map((entry) => {
			const encoded = encodeTypedDataValue(arrayType.itemType, entry, types)
			return bytesFromHex(encodeAbiParameters([{ type: encoded.abiType }], [encoded.value]))
		})
		return { abiType: 'bytes32', value: keccak256(concatBytes(...encodedItems)) }
	}
	if (types[type] !== undefined) {
		if (!isRecord(value)) throw new Error(`Expected object value for ${ type }`)
		return { abiType: 'bytes32', value: hashStruct({ data: value, primaryType: type, types }) }
	}
	if (type === 'string') return { abiType: 'bytes32', value: keccak256(bytesFromTypedDataString(value)) }
	if (type === 'bytes') return { abiType: 'bytes32', value: keccak256(bytesFromTypedDataPrimitive(value)) }
	return { abiType: canonicalAbiType(type), value: normalizeEip712PrimitiveValue(canonicalAbiType(type), value) }
}

export const hashStruct = ({ data, primaryType, types }: HashStructParameters): Hex => {
	const fields = types[primaryType]
	if (fields === undefined) throw new Error(`Unknown EIP-712 type ${ primaryType }`)
	const encodedValues = fields.map((field) => {
		const value = data[field.name]
		if (value === undefined) throw new Error(`Missing EIP-712 value for ${ primaryType }.${ field.name }`)
		return encodeTypedDataValue(field.type, value, types)
	})
	return keccak256(encodeAbiParameters(
		[{ type: 'bytes32' }, ...encodedValues.map((entry) => ({ type: entry.abiType }))],
		[keccak256(stringToBytes(encodeType(types, primaryType))), ...encodedValues.map((entry) => entry.value)],
	))
}

const getDomainType = (domain: Record<string, unknown>): readonly TypedDataField[] => {
	return Object.entries(DOMAIN_FIELD_TYPES)
		.filter(([name]) => domain[name] !== undefined)
		.map(([name, type]) => ({ name, type }))
}

export const hashTypedData = (typedData: TypedData): Hex => {
	const domainHash = hashStruct({
		data: typedData.domain,
		primaryType: 'EIP712Domain',
		types: { EIP712Domain: typedData.types.EIP712Domain ?? getDomainType(typedData.domain) },
	})
	const messageHash = hashStruct({
		data: typedData.message,
		primaryType: typedData.primaryType,
		types: typedData.types,
	})
	return keccak256(concatBytes(bytesFromHex('0x1901'), bytesFromHex(domainHash), bytesFromHex(messageHash)))
}

const signDigest = (digest: Hex, privateKey: Hex): Hex => {
	const signature = signDigestWithMicro(bytesFromHex(digest), bytesFromHex(privateKey), DETERMINISTIC_SIGNATURES)
	const recovery = signature.recovery
	if (recovery !== 0 && recovery !== 1) throw new Error('Unexpected signature recovery bit')
	return `0x${ signature.toHex('compact') }${ recovery === 0 ? '1b' : '1c' }`
}

export const privateKeyToAccount = (privateKey: Hex) => {
	const address = ensureHex(addr.fromPrivateKey(privateKey), 'account address')
	return {
		address,
		signMessage: async ({ message }: { readonly message: string | { readonly raw: Hex | Uint8Array } }) => {
			if (typeof message === 'string') return ensureHex(eip191Signer.sign(message, privateKey, DETERMINISTIC_SIGNATURES), 'message signature')
			return ensureHex(eip191Signer.sign(bytesFromHexOrBytes(message.raw), privateKey, DETERMINISTIC_SIGNATURES), 'message signature')
		},
		signTypedData: async (typedData: TypedData) => signDigest(hashTypedData(typedData), privateKey),
	}
}

type SignatureParameter = Hex | {
	readonly r: Hex | bigint
	readonly s: Hex | bigint
	readonly yParity?: number
	readonly v?: bigint | number
}

type SignatureParts = { readonly r: bigint, readonly s: bigint, readonly yParity: number }

const toSignatureParts = (signature: SignatureParameter): SignatureParts => typeof signature === 'string'
	? signatureToParts(signature)
	: {
		r: typeof signature.r === 'bigint' ? signature.r : BigInt(signature.r),
		s: typeof signature.s === 'bigint' ? signature.s : BigInt(signature.s),
		yParity: normalizeSignatureYParity(signature),
	}

const recoverAddressFromParts = (digest: Uint8Array, signature: SignatureParts): Hex => {
	const recoveredSignature = initSig({ r: signature.r, s: signature.s }, signature.yParity)
	return ensureHex(addr.fromPublicKey(recoveredSignature.recoverPublicKey(digest).toBytes(false)), 'recovered address')
}

export const recoverAddress = async ({ hash, signature }: { readonly hash: Hex | Uint8Array, readonly signature: SignatureParameter }): Promise<Hex> => recoverAddressFromParts(bytesFromHexOrBytes(hash), toSignatureParts(signature))

// secp256k1 curve y^2 = x^3 + 7 over the field prime p, with group order n.
const SECP256K1_FIELD_PRIME = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn
const SECP256K1_GROUP_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

const modularPower = (base: bigint, exponent: bigint, modulus: bigint) => {
	let result = 1n
	let remainingBase = base % modulus
	for (let remainingExponent = exponent; remainingExponent > 0n; remainingExponent >>= 1n) {
		if ((remainingExponent & 1n) === 1n) result = result * remainingBase % modulus
		remainingBase = remainingBase * remainingBase % modulus
	}
	return result
}

const isSignatureScalar = (value: bigint) => value >= 1n && value < SECP256K1_GROUP_ORDER

// r is the x-coordinate of the signing nonce point, so it names a curve point only if x^3 + 7 is a nonzero square mod p (Euler's criterion; secp256k1 has no point with y = 0).
const isCurveXCoordinate = (x: bigint) => modularPower(x ** 3n + 7n, (SECP256K1_FIELD_PRIME - 1n) / 2n, SECP256K1_FIELD_PRIME) === 1n

// Checked here rather than inferred from library errors: r and s must be in 1..n-1 and r must be a curve x-coordinate for recovery to have a nonce point to start from.
const hasRecoverableRAndS = (signature: SignatureParts) => isSignatureScalar(signature.r) && isSignatureScalar(signature.s) && isCurveXCoordinate(signature.r)

// The one unrecoverable case left after hasRecoverableRAndS is a recovery that lands on the point at infinity (s * R = hash * G), which takes curve arithmetic to detect, so it is recognised by the micro-eth-signer @noble/curves error text (including its 'infinify' typo). tryRecoverAddress.test.ts triggers it with a real signature, so a reworded message fails that test instead of silently turning the RPC reply into an internal error.
const isRecoveryAtInfinityError = (error: unknown) => error instanceof Error && error.message.startsWith('invalid recovery: point at infinify')

export type AddressRecovery = { readonly type: 'recovered', readonly address: Hex } | { readonly type: 'unrecoverable' }

// Like recoverAddress, but reports a signature whose r and s recover to no address as 'unrecoverable' instead of throwing; any other failure is unexpected and still throws.
export const tryRecoverAddress = async ({ hash, signature }: Parameters<typeof recoverAddress>[0]): Promise<AddressRecovery> => {
	const digest = bytesFromHexOrBytes(hash)
	const signatureParts = toSignatureParts(signature)
	if (!hasRecoverableRAndS(signatureParts)) return { type: 'unrecoverable' }
	try {
		return { type: 'recovered', address: recoverAddressFromParts(digest, signatureParts) }
	} catch (error: unknown) {
		if (isRecoveryAtInfinityError(error)) return { type: 'unrecoverable' }
		throw error
	}
}

const signatureToParts = (signature: Hex): SignatureParts => {
	const hex = ensureHex(signature, 'signature').slice(2)
	if (hex.length !== 130) throw new Error('Signature must be 65 bytes')
	const recovery = Number.parseInt(hex.slice(128), 16)
	return {
		r: BigInt(`0x${ hex.slice(0, 64) }`),
		s: BigInt(`0x${ hex.slice(64, 128) }`),
		yParity: normalizeSignatureYParity({ v: recovery }),
	}
}
