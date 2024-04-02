import { addressString } from '../../../utils/bigint.js'
import { EtherAmount, EtherSymbol } from '../../subcomponents/coins.js'
import { TransactionImportanceBlockParams } from '../Transactions.js'

const transactionExplainers = new Map<string, [string, string]>([
	['0', ['Airdropping you', '🚁']],
	['1', ['Giving you', 'for some party time 🥳']],
	['2', ['Granting you', 'for your enjoyment 🤑']],
	['3', ['Loaning you', 'for your business 💳']],
	['4', ['Chipping you', 'as a gift 🎁']],
	['5', ['Forking you', 'because you deserve it! 😍']],
	['6', ['Setting you forward for ', '💰']],
	['7', ['Simulating you some ', '🤖']],
	['8', ['Donating you', 'for good health ♥']],
	['9', ['Inflating your balance by', '💸']],
	['a', ['Aping some for you! ', '🐒']],
])

export function makeYouRichTransaction(param: TransactionImportanceBlockParams) {
	const lastLetterOfActiveAddress = addressString(param.simulationAndVisualisationResults.activeAddress).slice(-1)
	const explainer = transactionExplainers.get(lastLetterOfActiveAddress) || ['Receive', 'for fun and profit 🎉']
	return (
		<div class = 'content' style = 'display: inline-block;'>
			<table class = 'log-table'>
				<div class = 'log-cell'>
					<p class = 'ellipsis' style = {'color: var(--text-color); margin-bottom: 0px'}> { explainer[0] }&nbsp; </p>
				</div>
				<div class = 'log-cell' style = 'justify-content: right;'>
					<EtherAmount amount = { param.simTx.transaction.value } fontSize = 'normal'/>
				</div>
				<div class = 'log-cell'>
					<EtherSymbol rpcNetwork = { param.simulationAndVisualisationResults.rpcNetwork } fontSize = 'normal' />
				</div>
				<div class = 'log-cell'>
					<p class = 'ellipsis' style = {'color: var(--text-color); margin-bottom: 0px'}> &nbsp;{ explainer[1] } </p>
				</div>
			</table>
		</div>
	)
}
