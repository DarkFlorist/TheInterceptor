import { keccak256, toUtf8Bytes } from 'ethers'
import { stringifyJSONWithBigInts } from '../utils/bigint.js'
import { RpcNetwork } from '../types/rpc.js'
import { SimulationStateInput } from '../types/visualizer-types.js'

export function getSimulationInputHash(simulationStateInput: SimulationStateInput) {
	const messages = stringifyJSONWithBigInts(simulationStateInput.map((x) => x.signedMessages.map((x) => x.originalRequestParameters)))
	const overrides = stringifyJSONWithBigInts(simulationStateInput.map((x) => x.stateOverrides))
	const transactions = stringifyJSONWithBigInts(simulationStateInput.map((x) => x.transactions.map((x) => x.originalRequestParameters)))
	const blockTime = stringifyJSONWithBigInts(simulationStateInput.map((x) => x.blockTimeManipulation))
	const baseFee = stringifyJSONWithBigInts(simulationStateInput.map((x) => x.simulateWithZeroBaseFee))
	return keccak256(toUtf8Bytes(JSON.stringify([messages, overrides, transactions, blockTime, baseFee])))
}

export function getPopupVisualisationFingerprint(simulationStateInput: SimulationStateInput, rpcNetwork: RpcNetwork, blockNumber: bigint) {
	return keccak256(toUtf8Bytes(stringifyJSONWithBigInts([getSimulationInputHash(simulationStateInput), normalizeRpcNetworkForFingerprint(rpcNetwork), blockNumber])))
}

function normalizeRpcNetworkForFingerprint(rpcNetwork: RpcNetwork) {
	return {
		name: rpcNetwork.name,
		chainId: rpcNetwork.chainId,
		httpsRpc: rpcNetwork.httpsRpc,
		currencyName: rpcNetwork.currencyName,
		currencyTicker: rpcNetwork.currencyTicker,
		currencyLogoUri: 'currencyLogoUri' in rpcNetwork ? rpcNetwork.currencyLogoUri : undefined,
		blockExplorer: 'blockExplorer' in rpcNetwork && rpcNetwork.blockExplorer !== undefined ? {
			apiUrl: rpcNetwork.blockExplorer.apiUrl,
			apiKey: rpcNetwork.blockExplorer.apiKey,
		} : undefined,
		primary: rpcNetwork.primary,
		minimized: rpcNetwork.minimized,
	}
}
