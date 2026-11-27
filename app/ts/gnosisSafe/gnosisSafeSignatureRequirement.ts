import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { simulatedCallFromInput } from '../simulation/services/SimulationModeEthereumClientService.js'
import type { GnosisSafeSignatureRequirement } from '../types/gnosisSafeTypes.js'
import { type SimulationStateInput, toResolvedSimulationInput } from '../types/visualizer-types.js'
import type { EthereumAddress } from '../types/wire-types.js'
import { decodeFunctionOutputSafely, encodeFunctionCall } from '../utils/abiRuntime.js'
import { stringToUint8Array } from '../utils/bigint.js'
import { GNOSIS_SAFE_ABI } from './gnosisSafeCore.js'

const isAddressList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string')
const isBigint = (value: unknown): value is bigint => typeof value === 'bigint'

const callGnosisSafeOnStack = async (ethereum: EthereumClientService, simulationInput: SimulationStateInput, safeAddress: EthereumAddress, functionName: 'getOwners' | 'getThreshold') => await simulatedCallFromInput(ethereum, undefined, toResolvedSimulationInput(simulationInput), {
	to: safeAddress,
	input: stringToUint8Array(encodeFunctionCall(GNOSIS_SAFE_ABI, functionName, [])),
	value: 0n,
	maxFeePerGas: 0n,
	maxPriorityFeePerGas: 0n,
})

// Reads the Gnosis Safe's owners and threshold on top of the same simulation stack the Gnosis Safe transaction preview runs on, so a Gnosis Safe deployed or reconfigured on the stack is read as the preview sees it. Returns undefined when the address does not answer as a Gnosis Safe: a revert, a reply that does not decode, or a threshold outside 1 to the owner count, which a Gnosis Safe's setup and owner changes never allow. A node failure is not caught here, as it fails the preview it belongs to as well. Only the account asked to sign counts as a signature the user can provide. Other address-book accounts are not counted: they include default demo accounts the user does not control, and counting one would hide that other owners must sign.
export async function getGnosisSafeSignatureRequirement(
	ethereum: EthereumClientService,
	simulationInput: SimulationStateInput,
	safeAddress: EthereumAddress,
	signer: EthereumAddress,
): Promise<GnosisSafeSignatureRequirement | undefined> {
	const [ownersReply, thresholdReply] = await Promise.all([
		callGnosisSafeOnStack(ethereum, simulationInput, safeAddress, 'getOwners'),
		callGnosisSafeOnStack(ethereum, simulationInput, safeAddress, 'getThreshold'),
	])
	if ('error' in ownersReply || 'error' in thresholdReply) return undefined
	const owners = decodeFunctionOutputSafely(GNOSIS_SAFE_ABI, 'getOwners', ownersReply.result, isAddressList)
	const threshold = decodeFunctionOutputSafely(GNOSIS_SAFE_ABI, 'getThreshold', thresholdReply.result, isBigint)
	if (owners === undefined || threshold === undefined) return undefined
	const ownerCount = BigInt(owners.length)
	if (threshold === 0n || threshold > ownerCount) return undefined
	return { threshold, ownerCount, signerIsOwner: owners.some((owner) => BigInt(owner) === signer) }
}
