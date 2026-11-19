import { authorization as eip7702Authorization } from 'micro-eth-signer'
import { EthereumAddress } from '../types/wire-types.js'
import { addressString, bytes32String, bigintToUint8Array } from './bigint.js'
import { secp256k1 } from '@noble/curves/secp256k1'
import { invert, mod } from '@noble/curves/abstract/modular'
import { rlpEncode } from './ethereum.js'
import { keccak256 } from './ethereumPrimitives.js'
import { stripLeadingZeros } from './typed-arrays.js'

export type Eip7702Authorization = {
	readonly chainId: bigint
	readonly address: bigint
	readonly nonce: bigint
	readonly authority?: bigint
	readonly r?: bigint
	readonly s?: bigint
	readonly yParity?: 'even' | 'odd'
}

export type RpcEip7702Authorization = {
	readonly chainId: bigint
	readonly address: bigint
	readonly nonce: bigint
	readonly r?: bigint
	readonly s?: bigint
	readonly yParity?: 'even' | 'odd'
}

type Eip7702AuthorizationBase = {
	readonly chainId: bigint
	readonly address: bigint
	readonly nonce: bigint
}

type UnsignedNormalizedEip7702Authorization = Eip7702AuthorizationBase & {
	readonly authority?: bigint
	readonly r?: undefined
	readonly s?: undefined
	readonly yParity?: undefined
}

export type SignedEip7702Authorization = Eip7702Authorization & {
	readonly r: bigint
	readonly s: bigint
	readonly yParity: 'even' | 'odd'
}

type SignedNormalizedEip7702Authorization = SignedEip7702Authorization & {
	readonly authority: bigint
}

export type NormalizedEip7702Authorization = UnsignedNormalizedEip7702Authorization | SignedNormalizedEip7702Authorization

export const projectEip7702AuthorizationForRpc = (authorization: Eip7702Authorization): RpcEip7702Authorization => ({
	chainId: authorization.chainId,
	address: authorization.address,
	nonce: authorization.nonce,
	...(authorization.r === undefined ? {} : { r: authorization.r }),
	...(authorization.s === undefined ? {} : { s: authorization.s }),
	...(authorization.yParity === undefined ? {} : { yParity: authorization.yParity }),
})

export const hasEip7702AuthorizationSignature = (authorization: Eip7702Authorization): authorization is SignedEip7702Authorization => {
	return authorization.r !== undefined && authorization.s !== undefined && authorization.yParity !== undefined
}

export const hasPartialEip7702AuthorizationSignature = (authorization: Eip7702Authorization) => {
	return authorization.r !== undefined || authorization.s !== undefined || authorization.yParity !== undefined
}

// The secp256k1 group order n. The node accepts an authorization signature only with r and s in [1, n - 1] and s no greater than n / 2: replacing s with n - s and flipping yParity yields a second signature that recovers the same authority.
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
export const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n
// EIP-7702 skips an authorization whose nonce is not below 2**64 - 1.
const EIP7702_AUTHORIZATION_NONCE_LIMIT = 2n ** 64n - 1n

const recoverEip7702AuthorizationAuthoritySync = (authorization: SignedEip7702Authorization): bigint => EthereumAddress.parse(eip7702Authorization.getAuthority({
	chainId: authorization.chainId,
	address: addressString(authorization.address),
	nonce: authorization.nonce,
	r: BigInt(bytes32String(authorization.r)),
	s: BigInt(bytes32String(authorization.s)),
	yParity: authorization.yParity === 'even' ? 0 : 1,
}))

const recoverEip7702AuthorizationAuthority = async (authorization: SignedEip7702Authorization): Promise<bigint> => recoverEip7702AuthorizationAuthoritySync(authorization)

// Recover with explicit curve checks: invalid points and the point at infinity are node-skipped signatures, independent of a signature library's exception wording. ECDSA recovery is Q = r^-1(sR - hash*G), with R.x = r and the supplied parity.
export const getNodeRecoveredEip7702Authority = (authorization: Eip7702Authorization): bigint | undefined => {
	if (!hasEip7702AuthorizationSignature(authorization)) return undefined
	if (authorization.r < 1n || authorization.r >= SECP256K1_ORDER || authorization.s < 1n || authorization.s > SECP256K1_HALF_ORDER) return undefined
	const field = secp256k1.CURVE.Fp
	const ySquared = field.add(field.mul(field.sqr(authorization.r), authorization.r), 7n)
	const root = field.pow(ySquared, (field.ORDER + 1n) / 4n)
	if (!field.eql(field.sqr(root), ySquared)) return undefined
	const parity = authorization.yParity === 'even' ? 0n : 1n
	const y = root % 2n === parity ? root : field.neg(root)
	const recoveryPoint = secp256k1.ProjectivePoint.fromAffine({ x: authorization.r, y })
	const payload = rlpEncode([
		stripLeadingZeros(bigintToUint8Array(authorization.chainId, 32)),
		bigintToUint8Array(authorization.address, 20),
		stripLeadingZeros(bigintToUint8Array(authorization.nonce, 32)),
	])
	const hash = BigInt(keccak256(new Uint8Array([0x05, ...payload])))
	const inverseR = invert(authorization.r, SECP256K1_ORDER)
	const publicKey = secp256k1.ProjectivePoint.BASE.multiplyAndAddUnsafe(
		recoveryPoint,
		mod(-hash * inverseR, SECP256K1_ORDER),
		mod(authorization.s * inverseR, SECP256K1_ORDER),
	)
	if (publicKey === undefined) return undefined
	return BigInt(keccak256(publicKey.toRawBytes(false).slice(1))) % (2n ** 160n)
}

// The authority's account state an authorization is checked against; undefined fields are unknown.
export type Eip7702AuthorityState = {
	readonly nonce: bigint | undefined
	// Whether the authority's code may be replaced: empty code or a delegation designator.
	readonly acceptsAuthorization: boolean | undefined
}

// The single owner of EIP-7702's per-authorization validity rules, returning the authority whose nonce the node raises and whose code it sets, or undefined when the node skips the authorization: chain ID 0 or the current chain, a nonce below 2**64 - 1, a signature the node recovers an authority from (getNodeRecoveredEip7702Authority), an authority whose code is empty or a delegation, and a nonce equal to the authority's current nonce. Unknown authority state fails closed.
export const getApplicableEip7702Authority = (
	authorization: Eip7702Authorization,
	chainId: bigint,
	getAuthorityState: (authority: bigint) => Eip7702AuthorityState,
): bigint | undefined => {
	if (authorization.chainId !== 0n && authorization.chainId !== chainId) return undefined
	if (authorization.nonce >= EIP7702_AUTHORIZATION_NONCE_LIMIT) return undefined
	const authority = getNodeRecoveredEip7702Authority(authorization)
	if (authority === undefined) return undefined
	const authorityState = getAuthorityState(authority)
	return authorityState.acceptsAuthorization === true && authorityState.nonce !== undefined && authorityState.nonce === authorization.nonce ? authority : undefined
}

const normalizeEip7702Authorization = async (authorization: Eip7702Authorization): Promise<NormalizedEip7702Authorization> => {
	const base = {
		chainId: authorization.chainId,
		address: authorization.address,
		nonce: authorization.nonce,
	}
	if (hasEip7702AuthorizationSignature(authorization)) return { ...authorization, authority: await recoverEip7702AuthorizationAuthority(authorization) }
	if (hasPartialEip7702AuthorizationSignature(authorization)) throw new Error('EIP-7702 authorization signature is missing required fields')
	if (authorization.authority !== undefined) return { ...base, authority: authorization.authority }
	return base
}

export const createEip1559Or7702Transaction = async <TransactionBase extends object>(
	transactionBase: TransactionBase,
	data: { readonly type?: string, readonly authorizationList?: readonly Eip7702Authorization[] },
): Promise<(TransactionBase & { readonly type: '1559' }) | (TransactionBase & { readonly type: '7702', readonly authorizationList: readonly NormalizedEip7702Authorization[] })> => {
	const authorizationList = data.authorizationList === undefined ? undefined : await normalizeEip7702AuthorizationList(data.authorizationList)
	if (data.type === '7702' || authorizationList !== undefined) return {
		...transactionBase,
		type: '7702',
		authorizationList: authorizationList ?? [],
	}
	return { ...transactionBase, type: '1559' }
}

export const normalizeEip7702AuthorizationList = async (
	authorizationList: readonly Eip7702Authorization[]
): Promise<readonly NormalizedEip7702Authorization[]> => {
	return await Promise.all(authorizationList.map(normalizeEip7702Authorization))
}
