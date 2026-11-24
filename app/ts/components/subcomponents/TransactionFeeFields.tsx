import type { SendTransactionParams } from '../../types/JsonRpc-types.js'
import type { TransactionWithAddressBookEntries } from '../../types/visualizer-types.js'
import { nanoString } from '../../utils/bigint.js'
import { assertNever } from '../../utils/typescript.js'

// The fee fields the wallet is asked to sign, for every supported transaction type.
export function TransactionFeeFields({ transaction }: { transaction: Pick<SendTransactionParams['params'][0], 'gasPrice' | 'maxFeePerGas' | 'maxPriorityFeePerGas'> & { readonly type: TransactionWithAddressBookEntries['type'] } }) {
	const feeText = (amount: SendTransactionParams['params'][0]['maxFeePerGas']) => typeof amount === 'bigint' ? `${ nanoString(amount) } nanoeth/gas` : 'Selected by your wallet'
	switch (transaction.type) {
		case 'legacy':
		case '2930': return <>
			<dt>Gas Price</dt>
			<dd>{ feeText(transaction.gasPrice) }</dd>
		</>
		case '1559':
		case '4844':
		case '7702': return <>
			<dt>Max Fee Per Gas</dt>
			<dd>{ feeText(transaction.maxFeePerGas) }</dd>
			<dt>Max Priority Fee Per Gas</dt>
			<dd>{ feeText(transaction.maxPriorityFeePerGas) }</dd>
		</>
		default: return assertNever(transaction.type)
	}
}
