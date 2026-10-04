import type { TransactionOrMessageIdentifier } from '../types/interceptor-messages.js'
import { getManagementPageHash, getManagementPageParameters } from './managementPages.js'

const SIMULATION_STACK_TARGET_HASH_KEY = 'simulation-stack-target'
const SIMULATION_STACK_TARGET_FOCUS_KEY = 'focus'

const bigintToQuantityString = (value: bigint) => `0x${ value.toString(16) }`

export function getSimulationStackElementId(identifier: TransactionOrMessageIdentifier) {
	switch(identifier.type) {
		case 'Transaction': return `simulation-stack-transaction-${ bigintToQuantityString(identifier.transactionIdentifier) }`
		case 'Message': return `simulation-stack-message-${ bigintToQuantityString(identifier.messageIdentifier) }`
	}
}

export function getSimulationStackTargetHash(identifier: TransactionOrMessageIdentifier, focusToken = Date.now().toString(36)) {
	const hashParameters = new URLSearchParams()
	hashParameters.set(SIMULATION_STACK_TARGET_HASH_KEY, getSimulationStackElementId(identifier))
	hashParameters.set(SIMULATION_STACK_TARGET_FOCUS_KEY, focusToken)
	return `${ getManagementPageHash('simulation-stack') }?${ hashParameters.toString() }`
}

export function getSimulationStackTargetElementIdFromHash(hash: string) {
	const targetElementId = getManagementPageParameters(hash, 'simulation-stack')?.get(SIMULATION_STACK_TARGET_HASH_KEY)
	if (targetElementId === null || targetElementId === undefined) return undefined
	if (!/^simulation-stack-(transaction|message)-0x[a-f0-9]+$/.test(targetElementId)) return undefined
	return targetElementId
}

export function getSimulationStackManagementHash(identifier?: TransactionOrMessageIdentifier): string {
	return identifier === undefined ? getManagementPageHash('simulation-stack') : getSimulationStackTargetHash(identifier)
}
