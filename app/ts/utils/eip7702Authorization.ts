import { EthereumAddress } from '../types/wire-types.js'
import { getEip7702AuthorizationSigningHash } from './ethereum.js'
import { tryRecoverAddress } from './ethereumPrimitives.js'
import { dataString } from './bigint.js'

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

// Both normalization and node accounting recover the same signed payload through the shared library-backed recovery boundary. Node applicability (including low-s) is checked separately below.
const recoverEip7702AuthorizationAuthority = (authorization: SignedEip7702Authorization): bigint | undefined => {
	const address = tryRecoverAddress({
		hash: getEip7702AuthorizationSigningHash(authorization),
		signature: { r: authorization.r, s: authorization.s, yParity: authorization.yParity === 'even' ? 0 : 1 },
	})
	return address === undefined ? undefined : EthereumAddress.parse(address)
}

// Validate imported quantities before fixed-width encoding or curve recovery. Invalid tuples are skipped by the node; authority metadata is never part of its signed payload.
export const getNodeRecoveredEip7702Authority = (authorization: Eip7702Authorization): bigint | undefined => {
	if (!hasEip7702AuthorizationSignature(authorization)) return undefined
	if (authorization.chainId < 0n || authorization.chainId >= 2n ** 256n) return undefined
	if (authorization.nonce < 0n || authorization.nonce >= EIP7702_AUTHORIZATION_NONCE_LIMIT) return undefined
	if (authorization.address < 0n || authorization.address >= 2n ** 160n) return undefined
	if (authorization.r < 1n || authorization.r >= SECP256K1_ORDER || authorization.s < 1n || authorization.s > SECP256K1_HALF_ORDER) return undefined
	return recoverEip7702AuthorizationAuthority(authorization)
}

// The delegate named by an exact EIP-7702 designator, or undefined for any other code.
export const getDelegateFromCode = (code: Uint8Array) => {
	if (code.length !== 23 || code[0] !== 0xef || code[1] !== 0x01 || code[2] !== 0x00) return undefined
	return BigInt(`0x${ dataString(code.slice(3)) }`)
}

// Raw state at the authority's current position in the transaction sequence; undefined fields are unknown.
export type Eip7702AuthorityState = {
	readonly nonce: bigint | undefined
	readonly code: Uint8Array | undefined
}

// Owns all per-authorization validity rules and returns the applied authority, or undefined when the node skips it. Recover once, then request raw state only for a valid signature on this chain; unknown state fails closed.
export const getApplicableEip7702Authority = async (
	authorization: Eip7702Authorization,
	chainId: bigint,
	getAuthorityState: (authority: bigint) => Promise<Eip7702AuthorityState>,
): Promise<bigint | undefined> => {
	if (authorization.chainId !== 0n && authorization.chainId !== chainId) return undefined
	const authority = getNodeRecoveredEip7702Authority(authorization)
	if (authority === undefined) return undefined
	const state = await getAuthorityState(authority)
	if (state.nonce !== authorization.nonce || state.code === undefined) return undefined
	return state.code.length === 0 || getDelegateFromCode(state.code) !== undefined ? authority : undefined
}

const normalizeEip7702Authorization = async (authorization: Eip7702Authorization): Promise<NormalizedEip7702Authorization> => {
	const base = {
		chainId: authorization.chainId,
		address: authorization.address,
		nonce: authorization.nonce,
	}
	if (hasEip7702AuthorizationSignature(authorization)) {
		const authority = recoverEip7702AuthorizationAuthority(authorization)
		if (authority === undefined) throw new Error('EIP-7702 authorization signature has no recoverable authority')
		return { ...authorization, authority }
	}
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
