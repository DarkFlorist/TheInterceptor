import type { TransactionOrMessageIdentifier } from '../types/interceptor-messages.js'

const bigintToQuantityString = (value: bigint) => `0x${ value.toString(16) }`

export function getSimulationStackElementId(identifier: TransactionOrMessageIdentifier) {
	switch(identifier.type) {
		case 'Transaction': return `simulation-stack-transaction-${ bigintToQuantityString(identifier.transactionIdentifier) }`
		case 'Message': return `simulation-stack-message-${ bigintToQuantityString(identifier.messageIdentifier) }`
	}
}
