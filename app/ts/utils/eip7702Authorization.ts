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

// secp256k1n / 2: EIP-7702 takes the s value of an authorization signature only up to this bound (EIP-2), although the authority still recovers from a higher one.
const SECP256K1_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n
const EIP7702_AUTHORIZATION_NONCE_LIMIT = 2n ** 64n - 1n

// An EIP-7702 delegation indicator (0xef0100 || address), which an account may hold and still accept an authorization.
export const isEip7702DelegationIndicator = (code: Uint8Array) => code.length === 23 && code[0] === 0xef && code[1] === 0x01 && code[2] === 0x00

type Eip7702AuthorityState = {
	readonly chainId: bigint
	readonly authorityNonce: bigint
	readonly authorityCode: Uint8Array
}

// Whether a node applies the authorization under EIP-7702 for an authority in this state. A skipped one sets no delegate and raises no nonce: it needs a signature, chain ID 0 or this chain, a nonce below 2**64 - 1 that equals the authority's nonce, an s value of at most secp256k1n/2, and an authority whose code is empty or a delegation indicator. The authority is the signer recovered when the transaction was formed or parsed.
export const isAppliedEip7702Authorization = (authorization: Eip7702Authorization, { chainId, authorityNonce, authorityCode }: Eip7702AuthorityState) => {
	return hasEip7702AuthorizationSignature(authorization)
		&& (authorization.chainId === 0n || authorization.chainId === chainId)
		&& authorization.nonce < EIP7702_AUTHORIZATION_NONCE_LIMIT
		&& authorization.s <= SECP256K1_HALF_ORDER
		&& (authorityCode.length === 0 || isEip7702DelegationIndicator(authorityCode))
		&& authorization.nonce === authorityNonce
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
