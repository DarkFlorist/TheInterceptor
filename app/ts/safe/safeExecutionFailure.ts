import type { ErrorWithCodeAndOptionalData } from '../types/error.js'
import type { PreSimulationTransaction } from '../types/visualizer-types.js'
import { dataStringWith0xStart } from '../utils/bigint.js'
import { decodeEthereumError } from '../utils/errorDecoding.js'

// When the Safe's call fails, execTransaction reverts with GS013 and drops the call's own revert reason, so the bare code is explained instead.
export const SAFE_CALL_REVERTED_MESSAGE = 'The Gnosis Safe\'s call reverted (GS013). The Safe does not pass on the call\'s own revert reason.'

// Nodes report the revert reason in the message, in the error's data, in the call's return data, or in several of them.
export const isSafeCallRevert = (error: ErrorWithCodeAndOptionalData, returnData?: Uint8Array) => error.message.endsWith('GS013')
	|| [error.data, returnData === undefined ? undefined : dataStringWith0xStart(returnData)].some((data) => data !== undefined && decodeEthereumError([], { ...error, data }).reason === 'GS013')

// Only a transaction the simulation runs through the Safe's execTransaction (safe/safeExecutionSimulation.ts) fails with the Safe's GS013.
export function describeSafeExecutionFailure(transaction: Pick<PreSimulationTransaction, 'simulationOptions'>, failure: { readonly error: ErrorWithCodeAndOptionalData, readonly returnData: Uint8Array }, decodedErrorMessage: string) {
	if (transaction.simulationOptions?.executeThroughSafe !== true || !isSafeCallRevert(failure.error, failure.returnData)) return decodedErrorMessage
	return SAFE_CALL_REVERTED_MESSAGE
}
