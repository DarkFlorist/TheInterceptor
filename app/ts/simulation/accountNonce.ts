import { type Eip7702Authorization, getDelegateFromCode, getNodeRecoveredEip7702Authority } from '../utils/eip7702Authorization.js'

export type TransactionNonceInput = {
	readonly sender: bigint | undefined
	readonly authorizationList?: readonly Eip7702Authorization[]
}

// Own the ordered nonce fold and its lazy code snapshot: each sender advances first, then matching authorizations advance the same evolving nonce. Applied delegations keep code eligible, so one initial read suffices for the whole sequence.
export const getAccountNonceAfterTransactions = async ({ address, chainId, initialNonce, transactions, getCode }: {
	readonly address: bigint
	readonly chainId: bigint
	readonly initialNonce: bigint
	readonly transactions: Iterable<TransactionNonceInput>
	readonly getCode: (address: bigint) => Promise<Uint8Array | undefined>
}): Promise<bigint> => {
	let nonce = initialNonce
	let code: Uint8Array | undefined
	let codeLoaded = false
	for (const transaction of transactions) {
		if (transaction.sender === address) nonce += 1n
		for (const authorization of transaction.authorizationList ?? []) {
			if (authorization.chainId !== 0n && authorization.chainId !== chainId) continue
			if (getNodeRecoveredEip7702Authority(authorization) !== address || authorization.nonce !== nonce) continue
			if (!codeLoaded) { code = await getCode(address); codeLoaded = true }
			if (code !== undefined && (code.length === 0 || getDelegateFromCode(code) !== undefined)) nonce += 1n
		}
	}
	return nonce
}
