import { Transaction } from 'micro-eth-signer'
import { ensureHex, type Hex } from './ethereumBytes.js'
import { normalizeSignatureYParity } from './ethereumSignature.js'
import { getRecordProperty, isRecord } from './runtimeTypeGuards.js'

type SerializableTransaction = {
	readonly type?: 'eip1559' | 'eip7702'
	readonly chainId?: number | bigint
	readonly nonce?: number | bigint
	readonly gas?: number | bigint
	readonly maxFeePerGas?: bigint
	readonly maxPriorityFeePerGas?: bigint
	readonly to?: string | null
	readonly value?: bigint
	readonly data?: Hex
	readonly accessList?: readonly { readonly address: string, readonly storageKeys: readonly Hex[] }[]
	readonly authorizationList?: readonly {
		readonly chainId: bigint
		readonly address: string
		readonly nonce: bigint
		readonly yParity: number
		readonly r: bigint
		readonly s: bigint
	}[]
}

type TransactionSignature = {
	readonly r: Hex | bigint
	readonly s: Hex | bigint
	readonly yParity?: number
	readonly v?: bigint | number
}

const EIP1559_TRANSACTION_TYPE = 'eip1559'

const bytes32FromBigint = (value: bigint): Hex => {
	if (value < 0n || value >= 2n ** 256n) throw new Error('Value is out of bytes32 range')
	return `0x${ value.toString(16).padStart(64, '0') }`
}

const normalizeTransactionSignature = (signature: TransactionSignature) => ({
	r: typeof signature.r === 'bigint' ? signature.r : BigInt(signature.r),
	s: typeof signature.s === 'bigint' ? signature.s : BigInt(signature.s),
	yParity: normalizeSignatureYParity(signature),
})

export const serializeTransaction = (transaction: SerializableTransaction, signature?: TransactionSignature): Hex => {
	const type = transaction.type ?? EIP1559_TRANSACTION_TYPE
	const commonFields = {
		chainId: BigInt(transaction.chainId ?? 0),
		nonce: BigInt(transaction.nonce ?? 0),
		maxFeePerGas: transaction.maxFeePerGas ?? 0n,
		maxPriorityFeePerGas: transaction.maxPriorityFeePerGas ?? 0n,
		gasLimit: BigInt(transaction.gas ?? 0),
		to: transaction.to === undefined || transaction.to === null ? '0x' : transaction.to,
		value: transaction.value ?? 0n,
		data: transaction.data ?? '0x',
		accessList: (transaction.accessList ?? []).map((entry) => ({ address: entry.address, storageKeys: [...entry.storageKeys] })),
		...(signature === undefined ? {} : normalizeTransactionSignature(signature)),
	}
	const prepared = type === 'eip7702'
		? signature === undefined
			? Transaction.prepare({ ...commonFields, type, authorizationList: transaction.authorizationList?.map((authorization) => ({ ...authorization })) ?? [] })
			: new Transaction(type, { ...commonFields, authorizationList: transaction.authorizationList?.map((authorization) => ({ ...authorization })) ?? [] }, false, true)
		: signature === undefined
			? Transaction.prepare({ ...commonFields, type })
			: new Transaction(type, commonFields, false, true)
	return ensureHex(prepared.toHex(signature !== undefined), 'serialized transaction')
}

const parseEip1559RawTransaction = (value: unknown) => {
	if (!isRecord(value)) throw new Error('Invalid EIP-1559 transaction data')
	const getBigint = (name: string) => {
		const field = value[name]
		if (typeof field !== 'bigint') throw new Error(`Invalid EIP-1559 ${ name }`)
		return field
	}
	const getString = (name: string) => {
		const field = value[name]
		if (typeof field !== 'string') throw new Error(`Invalid EIP-1559 ${ name }`)
		return field
	}
	const accessListValue = getRecordProperty(value, 'accessList')
	if (!Array.isArray(accessListValue)) throw new Error('Invalid EIP-1559 accessList')
	const accessList = accessListValue.map((entry) => {
		if (!isRecord(entry)) throw new Error('Invalid EIP-1559 accessList entry')
		const address = getRecordProperty(entry, 'address')
		const storageKeysValue = getRecordProperty(entry, 'storageKeys')
		if (typeof address !== 'string' || !Array.isArray(storageKeysValue)) throw new Error('Invalid EIP-1559 accessList entry')
		const storageKeys = storageKeysValue.map((storageKey) => {
			if (typeof storageKey !== 'string') throw new Error('Invalid EIP-1559 accessList storage key')
			return storageKey
		})
		return { address, storageKeys }
	})
	const r = getRecordProperty(value, 'r')
	const s = getRecordProperty(value, 's')
	const yParity = getRecordProperty(value, 'yParity')
	if (r !== undefined && typeof r !== 'bigint') throw new Error('Invalid EIP-1559 r')
	if (s !== undefined && typeof s !== 'bigint') throw new Error('Invalid EIP-1559 s')
	if (yParity !== undefined && typeof yParity !== 'number') throw new Error('Invalid EIP-1559 yParity')
	return {
		chainId: getBigint('chainId'),
		nonce: getBigint('nonce'),
		maxPriorityFeePerGas: getBigint('maxPriorityFeePerGas'),
		maxFeePerGas: getBigint('maxFeePerGas'),
		gasLimit: getBigint('gasLimit'),
		to: getString('to'),
		value: getBigint('value'),
		data: getString('data'),
		accessList,
		r,
		s,
		yParity,
	}
}

const parseEip7702RawTransaction = (value: unknown) => {
	const base = parseEip1559RawTransaction(value)
	if (!isRecord(value)) throw new Error('Invalid EIP-7702 transaction data')
	const authorizationListValue = getRecordProperty(value, 'authorizationList')
	if (!Array.isArray(authorizationListValue)) throw new Error('Invalid EIP-7702 authorizationList')
	const authorizationList = authorizationListValue.map((entry) => {
		if (!isRecord(entry)) throw new Error('Invalid EIP-7702 authorizationList entry')
		const chainId = getRecordProperty(entry, 'chainId')
		const address = getRecordProperty(entry, 'address')
		const nonce = getRecordProperty(entry, 'nonce')
		const yParity = getRecordProperty(entry, 'yParity')
		const r = getRecordProperty(entry, 'r')
		const s = getRecordProperty(entry, 's')
		if (typeof chainId !== 'bigint' || typeof address !== 'string' || typeof nonce !== 'bigint' || typeof yParity !== 'number' || typeof r !== 'bigint' || typeof s !== 'bigint') {
			throw new Error('Invalid EIP-7702 authorizationList entry')
		}
		return {
			chainId,
			address: ensureHex(address.toLowerCase(), 'authorization address'),
			nonce,
			yParity,
			r: bytes32FromBigint(r),
			s: bytes32FromBigint(s),
		}
	})
	return { ...base, authorizationList }
}

export const recoverTransactionSender = (serializedTransaction: Hex): Hex => {
	return ensureHex(Transaction.fromHex(serializedTransaction, false).sender, 'transaction sender')
}

export const parseTransaction = (serializedTransaction: Hex) => {
	const parsed = Transaction.fromHex(serializedTransaction, false)
	if (parsed.type !== EIP1559_TRANSACTION_TYPE && parsed.type !== 'eip7702') throw new Error(`Unsupported transaction type ${ parsed.type }`)
	const authorizationList = parsed.type === 'eip7702' ? parseEip7702RawTransaction(parsed.raw).authorizationList : undefined
	const raw = parseEip1559RawTransaction(parsed.raw)
	return {
		type: parsed.type,
		chainId: raw.chainId,
		nonce: raw.nonce,
		maxPriorityFeePerGas: raw.maxPriorityFeePerGas,
		maxFeePerGas: raw.maxFeePerGas,
		gas: raw.gasLimit,
		...(raw.to === '0x' ? {} : { to: ensureHex(raw.to.toLowerCase(), 'transaction recipient') }),
		...(raw.value === 0n ? {} : { value: raw.value }),
		...(raw.data === '0x' ? {} : { data: ensureHex(raw.data, 'transaction data') }),
		...(raw.accessList.length === 0 ? {} : {
			accessList: raw.accessList.map((entry) => ({
				address: ensureHex(entry.address.toLowerCase(), 'access list address'),
				storageKeys: entry.storageKeys.map((storageKey) => ensureHex(storageKey, 'access list storage key')),
			})),
		}),
		...(authorizationList === undefined ? {} : { authorizationList }),
		...(raw.r !== undefined && raw.s !== undefined && raw.yParity !== undefined ? {
			r: bytes32FromBigint(raw.r),
			s: bytes32FromBigint(raw.s),
			yParity: raw.yParity,
			v: BigInt(raw.yParity + 27),
		} : {}),
	}
}
