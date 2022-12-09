import { WETH, USDC, USDT, DAI, WBTC, UNISWAP_V2_ROUTER_ADDRESS, SUSHISWAP_V2_ROUTER_ADDRESS, UNISWAP_V3_ROUTER } from "../../utils/constants"
import { Simulator } from '../simulator'
import { EthereumUnsignedTransaction } from "../../utils/wire-types"
import { getTransferInfoFromTx } from "../../utils/calldata"

export const BAD_TRANSFER_TARGETS = new Set<bigint>([
	WETH,
	USDC,
	USDT,
	DAI,
	WBTC,
	UNISWAP_V2_ROUTER_ADDRESS,
	SUSHISWAP_V2_ROUTER_ADDRESS,
	UNISWAP_V3_ROUTER
])

export async function commonTokenOops(transaction: EthereumUnsignedTransaction, _simulator: Simulator) {
	const transferInfo = getTransferInfoFromTx(transaction)
	if (transferInfo === undefined) return
	if (transaction.to === null) return
	if (!BAD_TRANSFER_TARGETS.has(transferInfo.to)) return
	return 'ERC20_UNINTENDED_CONTRACT'
}
