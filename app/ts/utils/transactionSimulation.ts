import { mockSignTransaction } from '../simulation/services/SimulationModeEthereumClientService.js'
import type { WebsiteCreatedEthereumUnsignedTransaction } from '../types/visualizer-types.js'

export const getSignedTransactionForSimulation = (transactionToSimulate: WebsiteCreatedEthereumUnsignedTransaction) => (
	transactionToSimulate.signedTransaction ?? mockSignTransaction(transactionToSimulate.transaction)
)
