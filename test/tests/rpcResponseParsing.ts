import type * as funtypes from 'funtypes'
import { JsonRpcResponse } from '../../app/ts/types/JsonRpc-types.js'

// Returns the `result` of a JSON-RPC response fixture (for example from test/RPCResponses.ts) still in wire format, for mock RPC handlers that hand it to app code which parses it.
export function readJsonRpcResult(responseJson: string): unknown {
	const jsonRpcResponse = JsonRpcResponse.parse(JSON.parse(responseJson))
	if ('error' in jsonRpcResponse) throw new Error(`Ethereum Client Error: ${ jsonRpcResponse.error.message }`)
	return jsonRpcResponse.result
}

// Parses the `result` of a JSON-RPC response fixture with the codec the app uses for that result, for example EthSimulateV1Result.
export function parseJsonRpcResult<T>(responseJson: string, codec: funtypes.Codec<T>): T {
	return codec.parse(readJsonRpcResult(responseJson))
}
