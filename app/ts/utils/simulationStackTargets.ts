import type { TransactionOrMessageIdentifier } from '../types/interceptor-messages.js'
import type { SimulationStackRoute } from './managementPages.js'

export const isSimulationStackElementId = (value: string) => /^simulation-stack-(transaction|message)-0x[a-f0-9]+$/.test(value)

const bigintToQuantityString = (value: bigint) => `0x${ value.toString(16) }`

export function getSimulationStackElementId(identifier: TransactionOrMessageIdentifier) {
	switch(identifier.type) {
		case 'Transaction': return `simulation-stack-transaction-${ bigintToQuantityString(identifier.transactionIdentifier) }`
		case 'Message': return `simulation-stack-message-${ bigintToQuantityString(identifier.messageIdentifier) }`
	}
}

export function getSimulationStackRoute(identifier?: TransactionOrMessageIdentifier, focus = Date.now().toString(36)): SimulationStackRoute {
	return identifier === undefined ? { page: 'simulation-stack' } : { page: 'simulation-stack', stackTarget: { elementId: getSimulationStackElementId(identifier), focus } }
}
