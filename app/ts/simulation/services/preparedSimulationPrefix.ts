import type { PreparedEthSimulateV1Input } from './EthereumClientService.js'

export type SimulationPrefixPosition = { readonly blockCount: number } | { readonly transactionIndex: number }
type TransactionPosition = { readonly blockIndex: number, readonly callIndex: number }
const transactionPositions = new WeakMap<PreparedEthSimulateV1Input, readonly TransactionPosition[]>()

// Preparation preserves transaction identity and flat order while splitting blocks by gas. Validate that contract once per immutable prepared input, so layout changes fail at this boundary instead of silently selecting a different account state.
const getTransactionPositions = (prepared: PreparedEthSimulateV1Input) => {
	const cached = transactionPositions.get(prepared)
	if (cached !== undefined) return cached
	const expected = prepared.inputBlocks.flatMap(block => block.inputBlock.transactions)
	const positions: TransactionPosition[] = []
	const blocks = prepared.request.params[0].blockStateCalls
	if (blocks.length !== prepared.rpcBlocks.length || blocks.length !== prepared.blockOverrides.length) throw new Error('Inconsistent prepared simulation block layout')
	for (const [blockIndex, block] of prepared.rpcBlocks.entries()) {
		if (blocks[blockIndex]?.calls.length !== block.transactions.length) throw new Error('Prepared simulation calls do not match transaction positions')
		for (const [callIndex, transaction] of block.transactions.entries()) {
			if (expected[positions.length] !== transaction) throw new Error('Prepared simulation changed flat transaction order or identity')
			positions.push({ blockIndex, callIndex })
		}
	}
	if (positions.length !== expected.length) throw new Error('Prepared simulation omitted transactions')
	transactionPositions.set(prepared, positions)
	return positions
}

export const getPreparedSimulationPrefix = (prepared: PreparedEthSimulateV1Input | undefined, position: SimulationPrefixPosition) => {
	const blocks = prepared?.request.params[0].blockStateCalls ?? []
	let transaction: TransactionPosition | undefined
	let blockCount: number
	if ('blockCount' in position) blockCount = position.blockCount
	else { transaction = getTransactionPosition(prepared, position.transactionIndex); blockCount = transaction.blockIndex + 1 }
	if (!Number.isSafeInteger(blockCount) || blockCount < 0 || blockCount > blocks.length) throw new Error('Simulation prefix block count is out of bounds')
	const prefix = blocks.slice(0, blockCount).map((block, index) => transaction !== undefined && index === transaction.blockIndex ? { ...block, calls: block.calls.slice(0, transaction.callIndex) } : block)
	const previousBlockOverride = blockCount === 0 ? undefined : prepared?.blockOverrides[blockCount - 1]
	if (blockCount > 0 && previousBlockOverride === undefined) throw new Error('Missing prepared simulation block override')
	return { prefix, previousBlockOverride }
}

const getTransactionPosition = (prepared: PreparedEthSimulateV1Input | undefined, index: number): TransactionPosition => {
	if (prepared === undefined || !Number.isSafeInteger(index) || index < 0) throw new Error('Invalid prepared transaction position')
	const position = getTransactionPositions(prepared)[index]
	if (position === undefined) throw new Error('Missing prepared transaction position')
	return position
}
