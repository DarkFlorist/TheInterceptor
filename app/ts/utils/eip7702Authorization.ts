import { authorization as eip7702Authorization } from 'micro-eth-signer'
import { EthereumAddress } from '../types/wire-types.js'
import { addressString, bytes32String } from './bigint.js'

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

// Half the secp256k1 group order. EIP-7702 rejects an authorization whose s is above it: replacing s with n - s and flipping yParity yields a second signature that recovers the same authority.
export const SECP256K1_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n

// The authority's account state an authorization is checked against; undefined fields are unknown.
export type Eip7702AuthorityState = {
	readonly nonce: bigint | undefined
	// Whether the authority's code may be replaced: empty code or a delegation designator.
	readonly acceptsAuthorization: boolean | undefined
}

// The single owner of EIP-7702's per-authorization validity rules: a known authority, chain ID 0 or the current chain, an s no greater than half the curve order, an authority whose code is empty or a delegation, and a nonce equal to the authority's current nonce. Unknown authority state fails closed. Without a signature (s undefined) the authority comes from metadata and there is no s to check.
export const isApplicableEip7702Authorization = <TAuthorization extends Eip7702Authorization>(
	authorization: TAuthorization,
	chainId: bigint,
	getAuthorityState: (authority: bigint) => Eip7702AuthorityState,
): authorization is TAuthorization & { readonly authority: bigint } => {
	if (authorization.authority === undefined) return false
	if (authorization.chainId !== 0n && authorization.chainId !== chainId) return false
	if (authorization.s !== undefined && authorization.s > SECP256K1_HALF_ORDER) return false
	const authorityState = getAuthorityState(authorization.authority)
	return authorityState.acceptsAuthorization === true && authorityState.nonce !== undefined && authorityState.nonce === authorization.nonce
}

const recoverEip7702AuthorizationAuthority = async (authorization: SignedEip7702Authorization): Promise<bigint> => {
	return EthereumAddress.parse(eip7702Authorization.getAuthority({
		chainId: authorization.chainId,
		address: addressString(authorization.address),
		nonce: authorization.nonce,
		r: BigInt(bytes32String(authorization.r)),
		s: BigInt(bytes32String(authorization.s)),
		yParity: authorization.yParity === 'even' ? 0 : 1,
	}))
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
