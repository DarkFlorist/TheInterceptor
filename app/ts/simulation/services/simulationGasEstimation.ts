import type { EthSimulateV1CallResult } from '../../types/ethSimulate-types.js'
import type { ErrorWithCodeAndOptionalData } from '../../types/error.js'
import { EthereumData } from '../../types/wire-types.js'
import { dataStringWith0xStart, max, min } from '../../utils/bigint.js'
import { ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED } from '../../utils/constants.js'
import { JsonRpcResponseError } from '../../utils/errors.js'

type GasEstimate = { error: ErrorWithCodeAndOptionalData } | { gas: bigint }

const gasEstimationError = (message: string): GasEstimate => ({ error: {
	code: ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED,
	message,
	data: '0x',
} })

export const jsonRpcErrorToGasEstimate = (error: JsonRpcResponseError): GasEstimate => {
	const safeParsedData = EthereumData.safeParse(error.data)
	return { error: { code: error.code, message: error.message, data: safeParsedData.success ? dataStringWith0xStart(safeParsedData.value) : '0x' } }
}

const failedSimulationToGasEstimate = (result: Extract<EthSimulateV1CallResult, { status: 'failure' }>): GasEstimate => ({
	error: { ...result.error, data: dataStringWith0xStart(result.returnData) },
})

// This is a wallet policy buffer, not an Ethereum protocol gas cost. The node-provided
// peak is increased by 25% so small state changes between estimation and mining do not
// make the submitted transaction run out of gas.
const addGasEstimateSafetyBuffer = (gas: bigint) => (gas * 125n + 99n) / 100n

export const getGasEstimateFromSimulation = async (
	initialResult: EthSimulateV1CallResult,
	maxGas: bigint,
	simulateWithGasLimit: (gasLimit: bigint) => Promise<EthSimulateV1CallResult | undefined>,
): Promise<GasEstimate> => {
	if (initialResult.status === 'failure') return failedSimulationToGasEstimate(initialResult)
	const nodeReportedPeakGas = initialResult.maxUsedGas
	if (nodeReportedPeakGas !== undefined) {
		if (nodeReportedPeakGas > maxGas) return gasEstimationError(
			`Node-reported peak gas ${ nodeReportedPeakGas.toString() } exceeds the available block gas ${ maxGas.toString() }`,
		)
		return { gas: min(addGasEstimateSafetyBuffer(nodeReportedPeakGas), maxGas) }
	}

	// maxUsedGas is a widely implemented eth_simulateV1 extension, but it is not yet
	// required by the RPC specification. For nodes that omit it, discover a working
	// limit by rerunning the exact call. This delegates fork-specific gas rules to the
	// execution client instead of duplicating mutable protocol constants here.
	let candidate = min(addGasEstimateSafetyBuffer(initialResult.gasUsed), maxGas)
	while (true) {
		try {
			const verificationResult = await simulateWithGasLimit(candidate)
			if (verificationResult === undefined) return gasEstimationError('ETH Simulate Failed to estimate gas')
			if (verificationResult.status === 'success') return { gas: min(addGasEstimateSafetyBuffer(candidate), maxGas) }
			if (candidate === maxGas) return failedSimulationToGasEstimate(verificationResult)
		} catch (error: unknown) {
			if (!(error instanceof JsonRpcResponseError)) throw error
			if (candidate === maxGas) return jsonRpcErrorToGasEstimate(error)
		}
		const largerCandidate = min(max(candidate * 2n, 1n), maxGas)
		if (largerCandidate === candidate) return gasEstimationError(
			`Unable to find a successful gas limit within the available block gas ${ maxGas.toString() }`,
		)
		candidate = largerCandidate
	}
}
