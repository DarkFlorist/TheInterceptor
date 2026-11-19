import { type Eip7702Authorization, getDelegateFromCode, getNodeRecoveredEip7702Authority } from '../utils/eip7702Authorization.js'

export type TransactionNonceInput = {
	readonly sender: bigint | undefined
	readonly authorizationList?: readonly Eip7702Authorization[]
}

// Advance each sender first, then its authorizations. Code is read before each transaction; within that authorization list, writes only clear code or install delegation designators, so one read suffices. Earlier transactions may change code arbitrarily.
export const getAccountNonceAfterTransactions = async ({ address, chainId, initialNonce, transactions, getCode }: {
	readonly address: bigint
	readonly chainId: bigint
	readonly initialNonce: bigint
	readonly transactions: readonly TransactionNonceInput[]
	readonly getCode: (address: bigint, transactionIndex: number) => Promise<Uint8Array | undefined>
}): Promise<bigint> => {
	let nonce = initialNonce
	for (const [transactionIndex, transaction] of transactions.entries()) {
		let code: Uint8Array | undefined
		let codeLoaded = false
		if (transaction.sender === address) nonce += 1n
		for (const authorization of transaction.authorizationList ?? []) {
			if (authorization.chainId !== 0n && authorization.chainId !== chainId) continue
			if (getNodeRecoveredEip7702Authority(authorization) !== address || authorization.nonce !== nonce) continue
			if (!codeLoaded) { code = await getCode(address, transactionIndex); codeLoaded = true }
			if (code !== undefined && (code.length === 0 || getDelegateFromCode(code) !== undefined)) nonce += 1n
		}
	}
	return nonce
}
