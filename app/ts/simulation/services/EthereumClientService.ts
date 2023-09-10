import { EthereumUnsignedTransaction, EthereumSignedTransactionWithBlockData, EthereumQuantity, EthereumBlockTag, EthereumData, EthereumBlockHeader, EthereumBlockHeaderWithTransactionHashes, EthereumAddress } from '../../types/wire-types.js'
import { IUnsignedTransaction1559 } from '../../utils/ethereum.js'
import { TIME_BETWEEN_BLOCKS, MOCK_ADDRESS, MULTICALL3, Multicall3ABI } from '../../utils/constants.js'
import { IEthereumJSONRpcRequestHandler } from './EthereumJSONRpcRequestHandler.js'
import { Interface, LogDescription, ethers } from 'ethers'
import { stringToUint8Array, addressString, bytes32String, dataStringWith0xStart } from '../../utils/bigint.js'
import { BlockCalls, ExecutionSpec383MultiCallResult, CallResultLog } from '../../types/multicall-types.js'
import { MulticallResponse, EthGetStorageAtResponse, EthTransactionReceiptResponse, EthGetLogsRequest, EthGetLogsResponse, DappRequestTransaction, SignMessageParams } from '../../types/JsonRpc-types.js'
import { assertNever } from '../../utils/typescript.js'
import { parseLogIfPossible } from './SimulationModeEthereumClientService.js'

const getEcRecoverOverride = () => {
	/*
		pragma solidity ^0.8.18;

		contract ecRecoverOverride {
		    struct EcRecoverOverrideParams {
		        bytes32 hash;
		        uint8 v;
		        bytes32 r;
		        bytes32 s;
		        address returnAddress;
		    }
		    mapping(bytes32 => address) overrideToAddress;

		    function setOverride(bytes32 hash, uint8 v, bytes32 r, bytes32 s, address returnAddress) public {
		        require(returnAddress != address(0x0), 'return address cannot be 0x0');
		        overrideToAddress[keccak256(abi.encodePacked(hash, v, r, s))] = returnAddress;
		    }

		    function setOverrides(EcRecoverOverrideParams[] memory overrides) public {
		        for (uint i = 0; i < overrides.length; i++) {
		            setOverride(overrides[i].hash, overrides[i].v, overrides[i].r, overrides[i].s, overrides[i].returnAddress);
		        }
		    }
		    fallback (bytes calldata input) external returns (bytes memory) {
		        (bytes32 hash, uint8 v, bytes32 r, bytes32 s) = abi.decode(input, (bytes32, uint8, bytes32, bytes32));
		        address overridedAddress = overrideToAddress[keccak256(abi.encodePacked(hash, v, r, s))];
		        if (overridedAddress == address(0x0)) {
		            (bool success, bytes memory data) = address(0x0000000000000000000000000000000000123456).call{gas: 10000}(input);
		            require(success, 'failed to call moved ecrecover at address 0x0000000000000000000000000000000000123456');
		            return data;
		        } else {
		            return abi.encodePacked(overridedAddress);
		        }
		    }
		}
	*/
	return EthereumData.parse('0x608060405234801561001057600080fd5b506004361061003a5760003560e01c806305fdbc81146101ee578063c00692601461020a5761003b565b5b600036606060008060008086868101906100559190610462565b93509350935093506000806000868686866040516020016100799493929190610520565b60405160208183030381529060405280519060200120815260200190815260200160002060009054906101000a900473ffffffffffffffffffffffffffffffffffffffff169050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16036101bb576000806212345673ffffffffffffffffffffffffffffffffffffffff166127108b8b6040516101249291906105ad565b60006040518083038160008787f1925050503d8060008114610162576040519150601f19603f3d011682016040523d82523d6000602084013e610167565b606091505b5091509150816101ac576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016101a39061066f565b60405180910390fd5b809750505050505050506101e3565b806040516020016101cc9190610709565b604051602081830303815290604052955050505050505b915050805190602001f35b6102086004803603810190610203919061093a565b610226565b005b610224600480360381019061021f9190610983565b6102ec565b005b60005b81518110156102e8576102d5828281518110610248576102476109fe565b5b602002602001015160000151838381518110610267576102666109fe565b5b602002602001015160200151848481518110610286576102856109fe565b5b6020026020010151604001518585815181106102a5576102a46109fe565b5b6020026020010151606001518686815181106102c4576102c36109fe565b5b6020026020010151608001516102ec565b80806102e090610a66565b915050610229565b5050565b600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff160361035b576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161035290610afa565b60405180910390fd5b80600080878787876040516020016103769493929190610520565b60405160208183030381529060405280519060200120815260200190815260200160002060006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505050505050565b6000604051905090565b600080fd5b600080fd5b6000819050919050565b610406816103f3565b811461041157600080fd5b50565b600081359050610423816103fd565b92915050565b600060ff82169050919050565b61043f81610429565b811461044a57600080fd5b50565b60008135905061045c81610436565b92915050565b6000806000806080858703121561047c5761047b6103e9565b5b600061048a87828801610414565b945050602061049b8782880161044d565b93505060406104ac87828801610414565b92505060606104bd87828801610414565b91505092959194509250565b6000819050919050565b6104e46104df826103f3565b6104c9565b82525050565b60008160f81b9050919050565b6000610502826104ea565b9050919050565b61051a61051582610429565b6104f7565b82525050565b600061052c82876104d3565b60208201915061053c8286610509565b60018201915061054c82856104d3565b60208201915061055c82846104d3565b60208201915081905095945050505050565b600081905092915050565b82818337600083830152505050565b6000610594838561056e565b93506105a1838584610579565b82840190509392505050565b60006105ba828486610588565b91508190509392505050565b600082825260208201905092915050565b7f6661696c656420746f2063616c6c206d6f7665642065637265636f766572206160008201527f742061646472657373203078303030303030303030303030303030303030303060208201527f3030303030303030303030303030313233343536000000000000000000000000604082015250565b60006106596054836105c6565b9150610664826105d7565b606082019050919050565b600060208201905081810360008301526106888161064c565b9050919050565b600073ffffffffffffffffffffffffffffffffffffffff82169050919050565b60006106ba8261068f565b9050919050565b60008160601b9050919050565b60006106d9826106c1565b9050919050565b60006106eb826106ce565b9050919050565b6107036106fe826106af565b6106e0565b82525050565b600061071582846106f2565b60148201915081905092915050565b600080fd5b6000601f19601f8301169050919050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b61077282610729565b810181811067ffffffffffffffff821117156107915761079061073a565b5b80604052505050565b60006107a46103df565b90506107b08282610769565b919050565b600067ffffffffffffffff8211156107d0576107cf61073a565b5b602082029050602081019050919050565b600080fd5b600080fd5b6107f4816106af565b81146107ff57600080fd5b50565b600081359050610811816107eb565b92915050565b600060a0828403121561082d5761082c6107e6565b5b61083760a061079a565b9050600061084784828501610414565b600083015250602061085b8482850161044d565b602083015250604061086f84828501610414565b604083015250606061088384828501610414565b606083015250608061089784828501610802565b60808301525092915050565b60006108b66108b1846107b5565b61079a565b90508083825260208201905060a084028301858111156108d9576108d86107e1565b5b835b8181101561090257806108ee8882610817565b84526020840193505060a0810190506108db565b5050509392505050565b600082601f83011261092157610920610724565b5b81356109318482602086016108a3565b91505092915050565b6000602082840312156109505761094f6103e9565b5b600082013567ffffffffffffffff81111561096e5761096d6103ee565b5b61097a8482850161090c565b91505092915050565b600080600080600060a0868803121561099f5761099e6103e9565b5b60006109ad88828901610414565b95505060206109be8882890161044d565b94505060406109cf88828901610414565b93505060606109e088828901610414565b92505060806109f188828901610802565b9150509295509295909350565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052603260045260246000fd5b7f4e487b7100000000000000000000000000000000000000000000000000000000600052601160045260246000fd5b6000819050919050565b6000610a7182610a5c565b91507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8203610aa357610aa2610a2d565b5b600182019050919050565b7f72657475726e20616464726573732063616e6e6f742062652030783000000000600082015250565b6000610ae4601c836105c6565b9150610aef82610aae565b602082019050919050565b60006020820190508181036000830152610b1381610ad7565b905091905056fea2646970667358221220154f5b68ccfa5be744e7245765a3530dac4035052284a68b5dded1945b45075e64736f6c63430008120033')
}

export type IEthereumClientService = Pick<EthereumClientService, keyof EthereumClientService>
export class EthereumClientService {
	private cachedBlock: EthereumBlockHeader | undefined = undefined
	private cacheRefreshTimer: NodeJS.Timer | undefined = undefined
	private lastCacheAccess: number = 0
	private retrievingBlock: boolean = false
	private newBlockAttemptCallback: (blockHeader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean) => void
	private onErrorBlockCallback: (ethereumClientService: EthereumClientService) => void
	private requestHandler
	private cleanedUp = false

    constructor(requestHandler: IEthereumJSONRpcRequestHandler, newBlockAttemptCallback: (blockHeader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean) => void, onErrorBlockCallback: (ethereumClientService: EthereumClientService) => void) {
		this.requestHandler = requestHandler
		this.newBlockAttemptCallback = newBlockAttemptCallback
		this.onErrorBlockCallback = onErrorBlockCallback
    }

	public readonly getRpcNetwork = () => this.requestHandler.getRpcNetwork()
	
	public readonly getNewBlockAttemptCallback = () => this.newBlockAttemptCallback
	public readonly getOnErrorBlockCallback = () => this.onErrorBlockCallback

	public getLastKnownCachedBlockOrUndefined = () => this.cachedBlock

	public getCachedBlock() {
		if (this.cleanedUp === false) {
			this.setBlockPolling(true)
		}
		this.lastCacheAccess = Date.now()
		return this.cachedBlock
	}

	public cleanup = () => {
		this.cleanedUp = true
		this.setBlockPolling(false)
	}

	public readonly setBlockPolling = (enabled: boolean) => {
		if (enabled && this.cacheRefreshTimer === undefined) {
			const now = Date.now()

			// query block everytime clock hits time % 12 + 7
			this.updateCache()
			const timeToTarget = Math.floor(now / 1000 / TIME_BETWEEN_BLOCKS) * 1000 * TIME_BETWEEN_BLOCKS + 7 * 1000 - now
			this.cacheRefreshTimer = setTimeout( () => { // wait until the clock is just right ( % 12 + 7 ), an then start querying every TIME_BETWEEN_BLOCKS secs
				this.updateCache()
				this.cacheRefreshTimer = setInterval(this.updateCache, TIME_BETWEEN_BLOCKS * 1000)
				if (this.lastCacheAccess - Date.now() > 180000) {
					this.setBlockPolling(false)
				}
			}, timeToTarget > 0 ? timeToTarget : timeToTarget + TIME_BETWEEN_BLOCKS * 1000 )
			return
		}
		if (!enabled) {
			clearTimeout(this.cacheRefreshTimer)
			clearInterval(this.cacheRefreshTimer)
			this.cacheRefreshTimer = undefined
			this.cachedBlock = undefined
			return
		}
	}

	private readonly updateCache = async () => {
		if (this.retrievingBlock) return
		try {
			this.retrievingBlock = true
			const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getBlockByNumber', params: ['latest', true] })
			if (this.cacheRefreshTimer === undefined) return
			const newBlock = EthereumBlockHeader.parse(response)
			console.log(`Current block number: ${ newBlock.number }`)
			this.newBlockAttemptCallback(newBlock, this, this.cachedBlock?.number != newBlock.number)
			this.cachedBlock = newBlock
		} catch(error) {
			console.warn(error)
			return this.onErrorBlockCallback(this)
		} finally {
			this.retrievingBlock = false
		}
	}

	public readonly estimateGas = async (data: DappRequestTransaction) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_estimateGas', params: [data] } )
		return EthereumQuantity.parse(response)
	}

	public readonly getStorageAt = async (contract: bigint, slot: bigint, blockTag: EthereumBlockTag = 'latest') => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getStorageAt', params: [contract, slot, blockTag] })
		return EthGetStorageAtResponse.parse(response)
	}

	public readonly getTransactionCount = async (address: bigint, blockTag: EthereumBlockTag = 'latest') => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getTransactionCount', params: [address, blockTag] })
		return EthereumQuantity.parse(response)
	}

	public readonly getTransactionReceipt = async (hash: bigint) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getTransactionReceipt', params: [hash] })
		return EthTransactionReceiptResponse.parse(response)
	}

	public readonly getBalance = async (address: bigint, blockTag: EthereumBlockTag = 'latest') => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getBalance', params: [address, blockTag] })
		return EthereumQuantity.parse(response)
	}

	public readonly getCode = async (address: bigint, blockTag: EthereumBlockTag = 'latest') => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getCode', params: [address, blockTag] })
		return EthereumData.parse(response)
	}

	public async getBlock(blockTag?: EthereumBlockTag, fullObjects?: true): Promise<EthereumBlockHeader>
	public async getBlock(blockTag: EthereumBlockTag, fullObjects: boolean): Promise<EthereumBlockHeaderWithTransactionHashes | EthereumBlockHeader>
	public async getBlock(blockTag: EthereumBlockTag, fullObjects: false): Promise<EthereumBlockHeaderWithTransactionHashes>
	public async getBlock(blockTag: EthereumBlockTag = 'latest', fullObjects: boolean = true): Promise<EthereumBlockHeaderWithTransactionHashes | EthereumBlockHeader> {
		const cached = this.getCachedBlock()
		if (cached && (blockTag === 'latest' || blockTag === cached.number)) {
			if (fullObjects === false) {
				return { ...cached, transactions: cached.transactions.map((transaction) => transaction.hash) }
			}
			return cached
		}
		if (fullObjects === false) {
			return EthereumBlockHeaderWithTransactionHashes.parse(await this.requestHandler.jsonRpcRequest({ method: 'eth_getBlockByNumber', params: [blockTag, false] }))
		}
		return EthereumBlockHeader.parse(await this.requestHandler.jsonRpcRequest({ method: 'eth_getBlockByNumber', params: [blockTag, fullObjects] }))
	}

	public readonly getChainId = () => this.requestHandler.getRpcNetwork().chainId

	public readonly getLogs = async (logFilter: EthGetLogsRequest) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getLogs', params: [logFilter] })
		return EthGetLogsResponse.parse(response)
	}

	public readonly getBlockNumber = async () => {
		const cached = this.getCachedBlock()
		if (cached) {
			return cached.number
		}
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_blockNumber' })
		return EthereumQuantity.parse(response)
	}

	public readonly getGasPrice = async() => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_gasPrice' })
		return EthereumQuantity.parse(response)
	}

	public readonly getTransactionByHash = async (hash: bigint) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getTransactionByHash', params: [hash] })
		if( response === null) return undefined
		return EthereumSignedTransactionWithBlockData.parse(response)
	}

	public readonly call = async (transaction: Partial<Pick<IUnsignedTransaction1559, 'to' | 'from' | 'input' | 'value' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'gasLimit'>>, blockTag: EthereumBlockTag = 'latest') => {
		if (transaction.to === null) throw new Error('To cannot be null')
		const params = {
			to: transaction.to,
			from: transaction.from,
			data: transaction.input,
			value: transaction.value,
			...transaction.maxFeePerGas !== undefined && transaction.maxPriorityFeePerGas !== undefined ? { gasPrice: transaction.maxFeePerGas + transaction.maxPriorityFeePerGas } : {},
			gas: transaction.gasLimit
		}
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_call', params: [params, blockTag] })
		return response as string
	}

	public readonly multicall = async (transactions: readonly EthereumUnsignedTransaction[], blockNumber: bigint) => {
		const httpsRpc = this.requestHandler.getRpcNetwork().httpsRpc
		if (httpsRpc === 'https://rpc.dark.florist/winedancemuffinborrow' || httpsRpc === 'https://rpc.dark.florist/birdchalkrenewtip') {
			//TODO: Remove this when we get rid of our old multicall
			return this.executionSpec383MultiCallOnlyTransactionsAndSignatures(transactions, [], blockNumber)
		}

		const blockAuthor: bigint = MOCK_ADDRESS
		const unvalidatedResult = await this.requestHandler.jsonRpcRequest({ method: 'eth_multicall', params: [blockNumber, blockAuthor, transactions] })
		return MulticallResponse.parse(unvalidatedResult)
	}

	public readonly executionSpec383MultiCall = async (blockStateCalls: readonly BlockCalls[], blockTag: EthereumBlockTag) => {
		const parentBlock = await this.getBlock()
		const call = {
			method: 'eth_multicallV1',
			params: [{
				blockStateCalls: blockStateCalls,
				traceTransfers: true,
				validation: false,
			},
			blockTag === parentBlock.number + 1n ? blockTag - 1n : blockTag
		] } as const
		const unvalidatedResult = await this.requestHandler.jsonRpcRequest(call)
		return ExecutionSpec383MultiCallResult.parse(unvalidatedResult)
	}

	public readonly getEthBalancesOfAccounts = async (blockNumber: bigint, accounts: readonly EthereumAddress[]) => {
		if (accounts.length === 0) return []
		const IMulticall3 = new Interface(Multicall3ABI)
		const ethBalanceQueryInput = stringToUint8Array(IMulticall3.encodeFunctionData('aggregate3', [accounts.map((account) => ({
			target: addressString(MULTICALL3),
			allowFailure: false,
			callData: IMulticall3.encodeFunctionData('getEthBalance', [addressString(account)])
		}))]))
		const callTransaction: EthereumUnsignedTransaction = {
			type: '1559' as const,
			from: MOCK_ADDRESS,
			to: MULTICALL3,
			value: 0n,
			input: ethBalanceQueryInput,
			maxFeePerGas: 0n,
			maxPriorityFeePerGas: 0n,
			gas: 15_000_000n,
			nonce: 0n,
			chainId: this.getChainId(),
		} as const
		const parentBlock = await this.getBlock()
		const multicallResults = await this.executionSpec383MultiCall([{
			calls: [callTransaction],
			blockOverride: {
				number: blockNumber + 1n,
				prevRandao: 0x1n,
				time: new Date(parentBlock.timestamp.getTime() + 12 * 1000),
				gasLimit: parentBlock.gasLimit,
				feeRecipient: parentBlock.miner,
				baseFee: parentBlock.baseFeePerGas === undefined ? 15000000n : parentBlock.baseFeePerGas
			},
		}], blockNumber)
		if (multicallResults.length !== 1) throw new Error('multicall returned too many or too few blocks')
		const callResults = multicallResults[0]
		if (callResults.calls.length !== 1) throw new Error('invalid multicall results length')
		const aggregate3CallResult = callResults.calls[0]
		if (aggregate3CallResult.status === 'failure' || aggregate3CallResult.status === 'invalid') throw Error('Failed aggregate3')
		const multicallReturnData: { success: boolean, returnData: string }[] = IMulticall3.decodeFunctionResult('aggregate3', dataStringWith0xStart(aggregate3CallResult.return))[0]
		
		if (multicallReturnData.length !== accounts.length) throw Error('Got wrong number of balances back')
		return multicallReturnData.map((singleCallResult, callIndex) => {
			if (singleCallResult.success === false) throw new Error('aggregate3 failed to get eth balance')
			return { address: accounts[callIndex], balance: EthereumQuantity.parse(singleCallResult.returnData) }
		})
	}

	public readonly getBalanceChanges = async (blockNumber: bigint, events: readonly (readonly CallResultLog[])[], senders: readonly EthereumAddress[]) => {
		const parseEthLogs = (logs: readonly CallResultLog[]) => {
			return logs.filter((log) => log.address == 0n).map((log) => parseLogIfPossible(erc20, { topics: log.topics.map((x) => bytes32String(x)), data: dataStringWith0xStart(log.data) })).filter((x): x is LogDescription => x !== null)
		}
		const erc20ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)']
		const erc20 = new ethers.Interface(erc20ABI)
		const flattenedLogs = events.flat()
		const parsedEthLogs = parseEthLogs(flattenedLogs)
		const extractEthSender = (log: LogDescription) => EthereumAddress.parse(log.args[0])
		const extractEthReceiver = (log: LogDescription) => EthereumAddress.parse(log.args[1])
		const addressesWithEthTransfers = new Set<bigint>(parsedEthLogs.map(extractEthSender).concat(parsedEthLogs.map(extractEthReceiver).concat(senders)))
		const initialBalances = await this.getEthBalancesOfAccounts(blockNumber, Array.from(addressesWithEthTransfers))
		const currentBalance = new Map<string, bigint>(initialBalances.map((balance) => [addressString(balance.address), balance.balance]))
		
		const balanceChanges = []
		for (const [index, logs] of events.entries()) {
			const senderBalance = currentBalance.get(addressString(senders[index]))
			if (senderBalance === undefined) throw new Error('sender ETH balance is missing')
			const changesForCall = [{
				address: senders[index],
				before: senderBalance,
				after: senderBalance,
			}]
			const parsedLogsForCall = parseEthLogs(logs)
			for (const parsed of parsedLogsForCall) {
				if (parsed === null) continue
				if (parsed.name !== 'Transfer') throw new Error(`wrong name: ${ parsed.name }`)
				const from = extractEthSender(parsed)
				const to = extractEthReceiver(parsed)
				const amount = parsed.args[2]
				const previousFromBalance = currentBalance.get(addressString(from))
				const previousToBalance = currentBalance.get(addressString(to))
				if (previousFromBalance === undefined || previousToBalance === undefined) throw new Error('Did not find previous ETH balance')
				currentBalance.set(addressString(from), previousFromBalance - amount)
				currentBalance.set(addressString(to), previousToBalance + amount)
				changesForCall.push({ address: from, before: previousFromBalance, after: previousFromBalance - amount })
				changesForCall.push({ address: to, before: previousToBalance, after: previousToBalance + amount })
			}
			balanceChanges.push(changesForCall)
		}
		return balanceChanges
	}

	// intended drop in replacement of the old multicall
	public readonly executionSpec383MultiCallOnlyTransactionsAndSignatures = async (transactions: readonly EthereumUnsignedTransaction[], signatures: readonly SignMessageParams[], blockNumber: bigint): Promise<MulticallResponse> => {
		const ecRecoverMovedToAddress = 0x123456n
		const ecRecoverAddress = 1n
		const parentBlock = await this.getBlock()

		const setOverridesInterface = new Interface(['function setOverrides(EcRecoverOverrideParams[] memory overrides)'])
		const setOverrides = {
			type: '1559' as const,
			from: '0x12342n',
			chainId: transactions[0].chainId,
			nonce: 0n,
			maxFeePerGas: 0n,
			maxPriorityFeePerGas: 0n,
			to: ecRecoverMovedToAddress,
			value: 0n,
			input: transactionDetails.input,
			accessList: [],
			gas: ethersTransaction.gasLimit,
		}

		const multicallResults = await this.executionSpec383MultiCall([{
			calls: signatures.length > 0 ? [].concat(transactions) : transactions,
			blockOverride: {
				number: blockNumber + 1n,
				prevRandao: 0x1n,
				time: new Date(parentBlock.timestamp.getTime() + 12 * 1000),
				gasLimit: parentBlock.gasLimit,
				feeRecipient: parentBlock.miner,
				baseFee: parentBlock.baseFeePerGas === undefined ? 15000000n : parentBlock.baseFeePerGas
			},
			...signatures.length > 0 ? { stateOverrides: { [addressString(ecRecoverAddress)]: { moveToAddress: ecRecoverMovedToAddress, code: getEcRecoverOverride() } } } : {},
		}], blockNumber)
		if (multicallResults.length !== 1) throw new Error('Multicalled for one block but did not get one block')
		const calls = multicallResults[0].calls
		const allLogs = calls.map((singleResult) => singleResult.status !== 'success' || singleResult.logs === undefined ? [] : singleResult.logs)
		const balanceChanges = await this.getBalanceChanges(blockNumber, allLogs, transactions.map((tx) => tx.from))
		const endResult = calls.map((singleResult, callIndex) => {
			switch (singleResult.status) {
				case 'success': return {
					statusCode: 'success' as const,
					gasSpent: singleResult.gasUsed,
					returnValue: singleResult.return,
					events: (singleResult.logs === undefined ? [] : singleResult.logs).map((log) => ({
						loggersAddress: log.address,
						data: 'data' in log && log.data !== undefined ? log.data : new Uint8Array(),
						topics: 'topics' in log && log.topics !== undefined ? log.topics : [],
					})).filter((x) => x.loggersAddress !== 0x0n), //TODO, keep eth logs
					balanceChanges: balanceChanges[callIndex],
				}
				case 'failure': return {
					statusCode: 'failure' as const,
					gasSpent: singleResult.gasUsed,
					error: singleResult.error.message,
					returnValue: singleResult.return,
				}
				case 'invalid': throw new Error(`Invalid multicall: ${ singleResult.error }`)
				default: assertNever(singleResult)
			}
		})
		return endResult
	}
}
