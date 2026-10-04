// Only methods implemented without wallet interaction belong here. Unknown methods and unsupported networks can still forward to the wallet.
const signerIndependentRpcMethods = new Set<string>([
	'eth_getCode', 'eth_subscribe', 'eth_unsubscribe', 'eth_chainId', 'net_version', 'eth_call', 'eth_getBalance', 'eth_blockNumber',
	'eth_estimateGas', 'eth_getBlockByNumber', 'eth_getBlockByHash',
	'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_gasPrice',
	'eth_getTransactionCount', 'eth_getLogs', 'web3_clientVersion',
	'eth_feeHistory', 'eth_maxPriorityFeePerGas', 'eth_newFilter',
	'eth_uninstallFilter', 'eth_getFilterChanges', 'eth_getFilterLogs', 'eth_simulateV1',
])

export const isSignerIndependentRpcMethod = (method: string) => signerIndependentRpcMethods.has(method)
