import { stringToBytes, keccak256 } from '../utils/viem.js'
import { stringifyJSONWithBigInts } from '../utils/bigint.js'
import type { RpcNetwork } from '../types/rpc.js'
import type { SimulationStateInput } from '../types/visualizer-types.js'
import { getSimulationInputHash } from '../utils/simulationFingerprint.js'

export function getPopupVisualisationFingerprint(simulationStateInput: SimulationStateInput, rpcNetwork: RpcNetwork, blockNumber: bigint) {
	return keccak256(stringToBytes(stringifyJSONWithBigInts([getSimulationInputHash(simulationStateInput), normalizeRpcNetworkForFingerprint(rpcNetwork), blockNumber])))
}

function normalizeRpcNetworkForFingerprint(rpcNetwork: RpcNetwork) {
	return {
		name: rpcNetwork.name,
		chainId: rpcNetwork.chainId,
		httpsRpc: rpcNetwork.httpsRpc,
		currencyName: rpcNetwork.currencyName,
		currencyTicker: rpcNetwork.currencyTicker,
		currencyLogoUri: 'currencyLogoUri' in rpcNetwork ? rpcNetwork.currencyLogoUri : undefined,
		blockExplorer:
			'blockExplorer' in rpcNetwork && rpcNetwork.blockExplorer !== undefined
				? {
						apiUrl: rpcNetwork.blockExplorer.apiUrl,
						apiKey: rpcNetwork.blockExplorer.apiKey,
					}
				: undefined,
		primary: rpcNetwork.primary,
		minimized: rpcNetwork.minimized,
	}
}
