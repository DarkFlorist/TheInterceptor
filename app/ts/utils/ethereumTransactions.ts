import { Transaction } from 'micro-eth-signer'
import { ensureHex, type Hex } from './ethereumBytes.js'
import { normalizeSignatureYParity } from './ethereumSignature.js'
import { getRecordProperty, isRecord } from './runtimeTypeGuards.js'

type SerializableTransaction = {
	readonly type?: 'eip1559'
	readonly chainId?: number | bigint
	readonly nonce?: number | bigint
	readonly gas?: number | bigint
	readonly maxFeePerGas?: bigint
	readonly maxPriorityFeePerGas?: bigint
	readonly to?: string | null
	readonly value?: bigint
	readonly data?: Hex
	readonly accessList?: readonly { readonly address: string, readonly storageKeys: readonly Hex[] }[]
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
	const raw = {
		type,
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
	const prepared = signature === undefined
		? Transaction.prepare(raw)
		: new Transaction(type, raw, false, true)
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

export const parseTransaction = (serializedTransaction: Hex) => {
	const parsed = Transaction.fromHex(serializedTransaction, false)
	if (parsed.type !== EIP1559_TRANSACTION_TYPE) throw new Error(`Unsupported transaction type ${ parsed.type }`)
	const raw = parseEip1559RawTransaction(parsed.raw)
	return {
		type: EIP1559_TRANSACTION_TYPE,
		chainId: Number(raw.chainId),
		nonce: Number(raw.nonce),
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
		...(raw.r !== undefined && raw.s !== undefined && raw.yParity !== undefined ? {
			r: bytes32FromBigint(raw.r),
			s: bytes32FromBigint(raw.s),
			yParity: raw.yParity,
			v: BigInt(raw.yParity + 27),
		} : {}),
	}
}
