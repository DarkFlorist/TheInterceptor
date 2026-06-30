import { EthereumAddress } from '../types/wire-types.js'
import { addressString, bytes32String } from './bigint.js'
import { recoverAuthorizationAddress } from './viem.js'

export type Eip7702Authorization = {
	readonly chainId: bigint
	readonly address: bigint
	readonly nonce: bigint
	readonly authority?: bigint
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

type SignedEip7702Authorization = Eip7702Authorization & {
	readonly r: bigint
	readonly s: bigint
	readonly yParity: 'even' | 'odd'
}

type SignedNormalizedEip7702Authorization = SignedEip7702Authorization & {
	readonly authority: bigint
}

export type NormalizedEip7702Authorization = UnsignedNormalizedEip7702Authorization | SignedNormalizedEip7702Authorization

const hasAuthorizationSignature = (authorization: Eip7702Authorization): authorization is SignedEip7702Authorization => {
	return authorization.r !== undefined && authorization.s !== undefined && authorization.yParity !== undefined
}

const hasPartialAuthorizationSignature = (authorization: Eip7702Authorization) => {
	return authorization.r !== undefined || authorization.s !== undefined || authorization.yParity !== undefined
}

const maximumSafeAuthorizationNumber = BigInt(Number.MAX_SAFE_INTEGER)

const toSafeAuthorizationNumber = (value: bigint, fieldName: 'chainId' | 'nonce') => {
	if (value < 0n || value > maximumSafeAuthorizationNumber) throw new Error(`EIP-7702 authorization ${ fieldName } exceeds the maximum safe integer`)
	return Number(value)
}

export const recoverEip7702AuthorizationAuthority = async (authorization: SignedEip7702Authorization): Promise<bigint> => {
	return EthereumAddress.parse(await recoverAuthorizationAddress({
		authorization: {
			chainId: toSafeAuthorizationNumber(authorization.chainId, 'chainId'),
			address: addressString(authorization.address),
			nonce: toSafeAuthorizationNumber(authorization.nonce, 'nonce'),
			r: bytes32String(authorization.r),
			s: bytes32String(authorization.s),
			yParity: authorization.yParity === 'even' ? 0 : 1,
		},
	}))
}

export const normalizeEip7702Authorization = async (authorization: Eip7702Authorization): Promise<NormalizedEip7702Authorization> => {
	const base = {
		chainId: authorization.chainId,
		address: authorization.address,
		nonce: authorization.nonce,
	}
	if (hasAuthorizationSignature(authorization)) return { ...authorization, authority: await recoverEip7702AuthorizationAuthority(authorization) }
	if (hasPartialAuthorizationSignature(authorization)) throw new Error('EIP-7702 authorization signature is missing required fields')
	if (authorization.authority !== undefined) return { ...base, authority: authorization.authority }
	return base
}

export const normalizeEip7702AuthorizationList = async (
	authorizationList: readonly Eip7702Authorization[]
): Promise<readonly NormalizedEip7702Authorization[]> => {
	return await Promise.all(authorizationList.map(normalizeEip7702Authorization))
}
