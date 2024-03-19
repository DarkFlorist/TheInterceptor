import { Simulator } from '../simulator.js'
import { JsonRpcRequest } from '../../types/JsonRpc-types.js'

export async function defaultHandler(_request: JsonRpcRequest, _simulator: Simulator) {
	return {
		quarantine: false,
		quarantineReasons: [],
		events: {
			ethBalanceChanges: [],
			tokenResults: [],
			blockNumber: 0n,
		},
		result: "",
	}
}
