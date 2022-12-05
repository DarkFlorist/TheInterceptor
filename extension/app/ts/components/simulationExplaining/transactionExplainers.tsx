import { addressString } from "../../utils/bigint"
import { TransactionVisualizationParameters } from "../../utils/visualizer-types"
import { Ether } from "../subcomponents/coins"
import { nameTransaction } from "./identifyTransaction"

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
		<div class = 'block' style = 'background-color: var(--card-bg-color);'>
			<header class = 'card-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'icon'>
						<img src = { param.tx.multicallResponse.statusCode === 'success' ? ( param.tx.simResults && param.tx.simResults.quarantine ? '../img/warning-sign.svg' : '../img/success-icon.svg' ) : '../img/error-icon.svg' } />
					</span>
				</div>
				<p class = 'card-header-title'>
					<p className = 'paragraph'>
						{ nameTransaction(param.tx, param.simulationAndVisualisationResults.addressMetadata, param.activeAddress) }
					</p>
				</p>
				<button class = 'card-header-icon' aria-label = 'remove' onClick = { () => param.removeTransaction(param.tx.signedTransaction.hash) }>
					<span class = 'icon' style = 'color: var(--text-color);'> X </span>
				</button>
			</header>
			<div class = 'card-content'>
				<div class = 'container'>
					<div class = 'content' >
						<div class = 'vertical-center'>
							<p style = { `color: var(--text-color); margin-bottom: 0px`}> { explainer[0] } </p>
							<Ether
								amount = { param.tx.unsignedTransaction.value }
								showSign = { false }
								textColor = { 'var(--text-color)' }
								chain = { param.simulationAndVisualisationResults.chain }
							/>
							<p style = { `color: var(--text-color); margin-bottom: 0px; margin-left: 5px`}> { explainer[1] } </p>
						</div>
					</div>
				</div>
			</div>
		</div>
	)
}
