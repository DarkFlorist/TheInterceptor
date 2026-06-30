import * as funtypes from 'funtypes'
import { AddressBookEntry } from './addressBookTypes.js'
import { NamedTokenId, SimulationState, TokenPriceEstimate, VisualizedSimulationState } from './visualizer-types.js'
import { EthereumQuantity, serialize } from './wire-types.js'

export type SimulateExecutionReplyData = funtypes.Static<typeof SimulateExecutionReplyData>
export const SimulateExecutionReplyData = funtypes.Union(
	funtypes.ReadonlyObject({
		success: funtypes.Literal(false),
		errorType: funtypes.Literal('Other'),
		transactionOrMessageIdentifier: EthereumQuantity,
		errorMessage: funtypes.String,
	}),
	funtypes.ReadonlyObject({
		success: funtypes.Literal(false),
		errorType: funtypes.Literal('MissingAbi'),
		transactionOrMessageIdentifier: EthereumQuantity,
		errorMessage: funtypes.String,
		errorAddressBookEntry: AddressBookEntry,
	}),
	funtypes.ReadonlyObject({
		success: funtypes.Literal(true),
		transactionOrMessageIdentifier: EthereumQuantity,
		result: funtypes.ReadonlyObject({
			namedTokenIds: funtypes.ReadonlyArray(NamedTokenId),
			addressBookEntries: funtypes.ReadonlyArray(AddressBookEntry),
			visualizedSimulationState: VisualizedSimulationState,
			tokenPriceEstimates: funtypes.ReadonlyArray(TokenPriceEstimate),
			simulationState: funtypes.Union(SimulationState),
		}),
	}),
)

export type SimulateExecutionReply = funtypes.Static<typeof SimulateExecutionReply>
export const SimulateExecutionReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_simulateExecutionReply'),
	data: SimulateExecutionReplyData,
}).asReadonly()

export function serializeSimulateExecutionReply(reply: SimulateExecutionReply) {
	return serialize(SimulateExecutionReply, reply)
}
