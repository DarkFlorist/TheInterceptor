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
	const normalizedRpcNetwork = rpcNetwork as unknown as {
		name: string
		chainId: bigint
		httpsRpc: string | undefined
		currencyName: string
		currencyTicker: string
		currencyLogoUri?: string
		blockExplorer?: {
			apiUrl: string
			apiKey: string
		}
		primary: boolean
		minimized: boolean
	}
	return {
		name: normalizedRpcNetwork.name,
		chainId: normalizedRpcNetwork.chainId,
		httpsRpc: normalizedRpcNetwork.httpsRpc,
		currencyName: normalizedRpcNetwork.currencyName,
		currencyTicker: normalizedRpcNetwork.currencyTicker,
		currencyLogoUri: normalizedRpcNetwork.currencyLogoUri,
		blockExplorer: normalizedRpcNetwork.blockExplorer === undefined ? undefined : {
			apiUrl: normalizedRpcNetwork.blockExplorer.apiUrl,
			apiKey: normalizedRpcNetwork.blockExplorer.apiKey,
		},
		primary: normalizedRpcNetwork.primary,
		minimized: normalizedRpcNetwork.minimized,
	}
}
