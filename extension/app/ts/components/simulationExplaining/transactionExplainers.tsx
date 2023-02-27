import { addressString } from '../../utils/bigint.js'
import { TransactionVisualizationParameters } from '../../utils/visualizer-types.js'
import { EtherAmount, EtherSymbol } from '../subcomponents/coins.js'
import { identifyTransaction } from './identifyTransaction.js'

export const transactionExplainers = new Map<string, [string, string]>([
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

export function makeYouRichTransaction(param: TransactionVisualizationParameters) {
	const lastLetterOfActiveAddress = addressString(param.activeAddress).slice(-1)
	const explainer = transactionExplainers.get(lastLetterOfActiveAddress) || ['Receive', 'for fun and profit 🎉']
	return (
		<div class = 'card' style = 'background-color: var(--card-bg-color);'>
			<header class = 'card-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'icon'>
						<img src = { param.tx.statusCode === 'success' ? ( param.tx.quarantine ? '../img/warning-sign.svg' : '../img/success-icon.svg' ) : '../img/error-icon.svg' } />
					</span>
				</div>
				<p class = 'card-header-title'>
					<p className = 'paragraph'>
						{ identifyTransaction(param.tx, param.activeAddress).title }
					</p>
				</p>
				<button class = 'card-header-icon' aria-label = 'remove' onClick = { () => param.removeTransaction(param.tx.hash) }>
					<span class = 'icon' style = 'color: var(--text-color);'> X </span>
				</button>
			</header>
			<div class = 'card-content'>
				<div class = 'container'>
					<div class = 'content' style = 'display: inline-block;'>
						<table class = 'log-table'>
							<div class = 'log-cell'>
								<p class = 'ellipsis' style = {`color: var(--text-color); margin-bottom: 0px`}> { explainer[0] }&nbsp; </p>
							</div>
							<div class = 'log-cell' style = 'justify-content: right;'>
								<EtherAmount
									amount = { param.tx.value }
								/>
							</div>
							<div class = 'log-cell'>
								<EtherSymbol
									amount = { param.tx.value }
									chain = { param.simulationAndVisualisationResults.chain }
								/>
							</div>
							<div class = 'log-cell'>
								<p class = 'ellipsis' style = {`color: var(--text-color); margin-bottom: 0px`}> &nbsp;{ explainer[1] } </p>
							</div>
						</table>
					</div>
				</div>
			</div>
		</div>
	)
}
