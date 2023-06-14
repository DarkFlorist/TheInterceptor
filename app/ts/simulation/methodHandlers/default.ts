import { Simulator } from '../simulator.js'
import { JsonRpcRequest } from '../../utils/JSONRPC-types.js'

export async function defaultHandler(_request: JsonRpcRequest, _simulator: Simulator) {
	return {
		quarantine: false,
		quarantineReasons: [],
		quarantineCodes: [],
		visualizerResults: {
			ethBalanceChanges: [],
			tokenResults: [],
			blockNumber: 0n,
		},
		result: "",
	}
}
