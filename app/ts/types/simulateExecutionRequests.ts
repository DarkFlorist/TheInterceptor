import * as funtypes from 'funtypes'
import { VisualizedPersonalSignRequestSafeTx } from './personal-message-definitions.js'
import { EthereumQuantity } from './wire-types.js'

export type SimulateGovernanceContractExecution = funtypes.Static<typeof SimulateGovernanceContractExecution>
export const SimulateGovernanceContractExecution = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_simulateGovernanceContractExecution'),
	data: funtypes.ReadonlyObject({ transactionIdentifier: EthereumQuantity }),
})

export type SimulateGnosisSafeTransaction = funtypes.Static<typeof SimulateGnosisSafeTransaction>
export const SimulateGnosisSafeTransaction = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_simulateGnosisSafeTransaction'),
	data: funtypes.ReadonlyObject({
		gnosisSafeMessage: VisualizedPersonalSignRequestSafeTx,
	}),
})
