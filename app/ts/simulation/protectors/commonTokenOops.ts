import { UNISWAP_V2_ROUTER_ADDRESS, SUSHISWAP_V2_ROUTER_ADDRESS, UNISWAP_V3_ROUTER } from '../../utils/constants.js'
import { EthereumAddress, EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { erc1155Metadata, erc721Metadata, tokenMetadata } from '@darkflorist/address-metadata'
import { addressString } from '../../utils/bigint.js'
import { parseTransaction } from '../../utils/calldata.js'
import { SimulationState } from '../../types/visualizer-types.js'
import { EthereumClientService } from '../services/EthereumClientService.js'
import { getSimulatedCode } from '../services/SimulationModeEthereumClientService.js'
import { identifyAddress } from '../../background/metadataUtils.js'

const ADDITIONAL_BAD_TRANSFER_TARGETS = new Set<bigint>([
	UNISWAP_V2_ROUTER_ADDRESS,
	SUSHISWAP_V2_ROUTER_ADDRESS,
	UNISWAP_V3_ROUTER
])

export async function getCodeOrError(ethereum: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState, address: EthereumAddress) {
	const code = await getSimulatedCode(ethereum, requestAbortController, simulationState, address)
	if (code.statusCode !== 'failure') return code
	const identifiedAddress = await identifyAddress(ethereum, requestAbortController, address)
	return { statusCode: 'failure' as const, message: `Failed to verify whether address ${ identifiedAddress.address }(${ identifiedAddress.name }) contains code or not.` }
}
export async function commonTokenOops(transaction: EthereumUnsignedTransaction, ethereum: EthereumClientService, requestAbortController: AbortController | undefined, _simulationState: SimulationState) {
	const transferInfo = parseTransaction(transaction)
	if (transferInfo === undefined) return
	if (transaction.to === null) return
	if (transferInfo.name !== 'transfer' && transferInfo.name !== 'transferFrom') return
	if (!ADDITIONAL_BAD_TRANSFER_TARGETS.has(transferInfo.arguments.to)) return
	if (tokenMetadata.get(addressString(transferInfo.arguments.to)) === undefined) return
	if (erc721Metadata.get(addressString(transferInfo.arguments.to)) === undefined) return
	if (erc1155Metadata.get(addressString(transferInfo.arguments.to)) === undefined) return
	const to = await identifyAddress(ethereum, requestAbortController, transferInfo.arguments.to)
	return `Attempt to send tokens to a contract ${ to } that cannot receive such tokens`
}
