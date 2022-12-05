import { Simulator } from '../simulator'
import { JsonRpcRequest } from "../../utils/wire-types"

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
