import type { SendTransactionParams } from '../../types/JsonRpc-types.js'
import { getSupportedSendTransactionType } from '../../utils/signerTransactionEnvelope.js'
import { TransactionFeeFields } from './TransactionFeeFields.js'

// The wallet signs this request, whereas the execution simulation deliberately excludes the external executor's gas costs.
export function WalletTransactionDetails({ request }: { request: SendTransactionParams }) {
	const transaction = request.params[0]
	return <section class = 'notification' aria-label = 'Wallet execution fees'>
		<strong>Wallet execution fees</strong>
		<p>The execution preview excludes the executor’s gas costs. Your wallet receives the gas and fee choices below; omitted values are selected by your wallet.</p>
		<dl class = 'grid key-value-pair'>
			<dt>Transaction type</dt>
			<dd>{ transaction.type ?? 'Selected by your wallet' }</dd>
			<dt>Gas limit</dt>
			<dd>{ transaction.gas?.toString(10) ?? 'Selected by your wallet' }</dd>
			<TransactionFeeFields transaction = { { ...transaction, type: getSupportedSendTransactionType(transaction) } }/>
		</dl>
	</section>
}
