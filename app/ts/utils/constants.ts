import { ethers } from 'ethers'
import { CHAIN_NAMES } from './chainNames.js'

// common contract addresses
export const UNISWAP_V2_ROUTER_ADDRESS = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488Dn
export const SUSHISWAP_V2_ROUTER_ADDRESS = 0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9Fn
export const UNISWAP_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564n
export const MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11n // Contract for bundling bulk call transactions, deployed on every chain. https://github.com/mds1/multicall
export const ETHEREUM_LOGS_LOGGER_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeEn
// export const UNISWAP_V3_NFT_ROUTER = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88n
// export const SUSHISWAP_FACTORY_ADDRESS = 0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Acn

export const Multicall3ABI = [
	'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
	'function getEthBalance(address) returns (uint256)',
]
export const UniswapV3Multicall2 = 0x5ba1e12693dc8f9c48aad8770482f4739beed696n

// common 4-byte function sigs
// export const ERC20_TRANSFER_FROM_4BYTES = 0x23b872dd
// export const ERC20_TRANSFER_4BYTES = 0xa9059cbb
// export const ERC20_APPROVAL_4BYTES = 0x095ea7b3
// export const ERC721_APPROVAL_FOR_ALL_4BYTES = 0xa22cb465

// common event log signatures
export const TRANSFER_LOG = ethers.keccak256(ethers.toUtf8Bytes('Transfer(address,address,uint256)'))
export const APPROVAL_LOG = ethers.keccak256(ethers.toUtf8Bytes('Approval(address,address,uint256)'))
export const ERC721_APPROVAL_FOR_ALL_LOG = ethers.keccak256(ethers.toUtf8Bytes('ApprovalForAll(address,address,bool)'))
export const DEPOSIT_LOG = ethers.keccak256(ethers.toUtf8Bytes('Deposit(address,uint256)'))
export const WITHDRAWAL_LOG = ethers.keccak256(ethers.toUtf8Bytes('Withdrawal(address,uint256)'))
export const ERC1155_TRANSFERBATCH_LOG = ethers.keccak256(ethers.toUtf8Bytes('TransferBatch(address,address,address,uint256[],uint256[])'))
export const ERC1155_TRANSFERSINGLE_LOG = ethers.keccak256(ethers.toUtf8Bytes('TransferSingle(address,address,address,uint256,uint256)'))

// ENS event signatures
export const ENS_ADDR_CHANGED = ethers.keccak256(ethers.toUtf8Bytes('AddrChanged(bytes32,address)'))
export const ENS_ADDRESS_CHANGED = ethers.keccak256(ethers.toUtf8Bytes('AddressChanged(bytes32,uint256,bytes)'))
export const ENS_REGISTRAR_NAME_RENEWED = ethers.keccak256(ethers.toUtf8Bytes('NameRenewed(string,bytes32,uint256,uint256)'))
export const ENS_NAME_RENEWED = ethers.keccak256(ethers.toUtf8Bytes('NameRenewed(uint256,uint256)'))
export const ENS_TRANSFER = ethers.keccak256(ethers.toUtf8Bytes('Transfer(bytes32,address)'))
export const ENS_NEW_OWNER = ethers.keccak256(ethers.toUtf8Bytes('NewOwner(bytes32,bytes32,address)'))
export const ENS_NEW_RESOLVER = ethers.keccak256(ethers.toUtf8Bytes('NewResolver(bytes32,address)'))
export const ENS_TEXT_CHANGED = ethers.keccak256(ethers.toUtf8Bytes('TextChanged(bytes32,string,string)'))
export const ENS_TEXT_CHANGED_KEY_VALUE = ethers.keccak256(ethers.toUtf8Bytes('TextChanged(bytes32,string,string,string)'))
export const ENS_CONTENT_HASH_CHANGED = ethers.keccak256(ethers.toUtf8Bytes('ContenthashChanged(bytes32,bytes)'))
export const ENS_FUSES_SET = ethers.keccak256(ethers.toUtf8Bytes('FusesSet(bytes32,uint32)'))

// Other
export const MOCK_ADDRESS = 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefn
export const ENS_PUBLIC_RESOLVER = 0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63n
export const ENS_TOKEN_WRAPPER = 0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401n //mainnet only
export const ENS_ETH_REGISTRAR_CONTROLLER = 0x253553366Da8546fC250F225fe3d25d0C782303bn
export const ENS_ETHEREUM_NAME_SERVICE = 0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85n
export const ENS_PUBLIC_RESOLVER_2 = 0x4976fb03C32e5B8cfe2b6cCB31c09Ba78EBaBa41n
export const ENS_REGISTRY_WITH_FALLBACK = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1en

// ENS Fuses
export const CANNOT_UNWRAP = 1n
export const CANNOT_BURN_FUSES = 2n
export const CANNOT_TRANSFER = 4n
export const CANNOT_SET_RESOLVER = 8n
export const CANNOT_SET_TTL = 16n
export const CANNOT_CREATE_SUBDOMAIN = 32n
export const CANNOT_APPROVE = 64n
export const PARENT_CANNOT_CONTROL = 1n << 16n
export const IS_DOT_ETH = 1n << 17n
export const CAN_EXTEND_EXPIRY = 1n << 18n
export const CAN_DO_EVERYTHING = 0n

// https://blog.logrocket.com/understanding-resolving-metamask-error-codes/#4001
export const METAMASK_ERROR_USER_REJECTED_REQUEST = 4001
export const METAMASK_ERROR_NOT_AUTHORIZED = 4100
export const METAMASK_ERROR_FAILED_TO_PARSE_REQUEST = -32700
export const METAMASK_ERROR_BLANKET_ERROR = -32603
// const METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER = 4200
// const METAMASK_ERROR_CHAIN_NOT_ADDED_TO_METAMASK = 4902
// const METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN = 4901
// const METAMASK_ERROR_REQUEST_STRUCTURE_INCORRECT = -32600
// const METAMASK_ERROR_METHOD_DOES_NOT_EXIST = -32601
// const METAMASK_ERROR_INVALID_ARGUMENT = -32602
// const METAMASK_ERROR_TRANSACTION_REJECTD = -32003
// const METAMASK_ERROR_METHOD_NOT_SUPPORTED = -32004
// const METAMASK_ERROR_RATE_LIMITED = -32005

export const ERROR_INTERCEPTOR_DISABLED = { error: { code: METAMASK_ERROR_USER_REJECTED_REQUEST, message: 'The Interceptor is disabled' } }
export const METAMASK_ERROR_ALREADY_PENDING = { error: { code: -32002, message: 'Access request pending already.' } }
export const ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS = { error: { code: 2, message: 'Interceptor: No active address' } }
export const METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN = { error: { code: 4900, message: 'Interceptor: Not connected to chain' } }
export const ERROR_INTERCEPTOR_GET_CODE_FAILED = { error: { code: -40001, message: 'Interceptor: Get code failed' } } // I wonder how we should come up with these numbers?
export const ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED = -40002
// const ERROR_INTERCEPTOR_NOT_READY = { error: { code: 1, message: 'Interceptor: Not ready' } }
// const ERROR_INTERCEPTOR_UNKNOWN_ORIGIN = { error: { code: 400, message: 'Interceptor: Unknown website origin' } }

function get4Byte(functionAbi: string) {
	return Number(ethers.keccak256(ethers.toUtf8Bytes(functionAbi)).slice(0, 10))
}

export const FourByteExplanations = {
	[get4Byte('transferFrom(address,address,uint256)')]: 'ERC20/ERC721 Transfer From' as const,
	[get4Byte('transfer(address,uint256)')]: 'ERC20 Transfer' as const,
	[get4Byte('approve(address,uint256)')]:'ERC20 Approval' as const,
	[get4Byte('setApprovalForAll(address,bool)')]: 'ERC721 Approval For All' as const,
	[get4Byte('swapExactTokensForTokens(uint256,uint256,address[],address,uint256)')]: 'Swap Exact Tokens For Tokens' as const,
	[get4Byte('swapExactETHForTokens(uint256,address[],address,uint256)')]: 'Swap Exact ETH For Tokens' as const,
	[get4Byte('multicall((address,uint256,bytes)[])')]: 'Multicall' as const,
	[get4Byte('exactInput((bytes,address,uint256,uint256,uint256))')]: 'Exact Input Swap' as const,
	[get4Byte('multicall(uint256,bytes[])')]: 'Multicall' as const,
	[get4Byte('multicall(bytes[])')]: 'Multicall' as const,
	[get4Byte('mint(address)')]: 'Mint' as const,
	[get4Byte('mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))')]: 'Mint' as const,
	[get4Byte('burn(address)')]: 'Burn' as const,
	[get4Byte('submitVote(uint256,bool)')]: 'Submit Vote' as const,
	[get4Byte('castVote(uint256,uint8)')]: 'Cast Vote' as const,
	[get4Byte('castVoteWithReason(uint256,uint8,string)')]: 'Cast Vote with Reason' as const,
	[get4Byte('castVoteWithReasonAndParams(uint256,uint8,string,bytes)')]: 'Cast Vote with Reason and Additional Info' as const,
	[get4Byte('castVoteBySig(uint256,uint8,voter,bytes)')]: 'Cast Vote by Signature' as const,
	[get4Byte('castVoteWithReasonAndParamsBySig(uint256,uint8,address,string,bytes,bytes)')]: 'Cast Vote with Reason And Additional Info by Signature' as const,
}

export const ICON_ACTIVE = '../img/head.png' as const
export const ICON_ACCESS_DENIED = '../img/head-access-denied.png' as const
export const ICON_NOT_ACTIVE = '../img/head-not-active.png' as const
export const ICON_SIMULATING = '../img/head-simulating.png' as const
export const ICON_SIGNING = '../img/head-signing.png' as const
export const ICON_SIGNING_NOT_SUPPORTED = '../img/head-signing-unsupported-network.png' as const
export const ICON_INTERCEPTOR_DISABLED = '../img/head-interceptor-disabled.png' as const
export const DEFAULT_TAB_CONNECTION = { icon: ICON_NOT_ACTIVE, iconReason: 'The website has not requested to connect to The Interceptor.' }
// export const DEFAULT_TAB_CONNECTION_INTERCEPTOR_DISABLED = { icon: ICON_INTERCEPTOR_DISABLED, iconReason: 'The Interceptor is completely disabled by user request.' }

export const ETHEREUM_COIN_ICON = '../../img/coins/ethereum.png'

export const DEFAULT_CALL_ADDRESS = 0x1n

export const TIME_BETWEEN_BLOCKS = 12
export const GAS_PER_BLOB = 2n**17n
export const METAMASK_LOGO = '../img/signers/metamask.svg'
export const BRAVE_LOGO = '../img/signers/brave.svg'
export const COINBASEWALLET_LOGO = '../img/signers/coinbasewallet.svg'

export function getChainName(chainId: bigint) { return CHAIN_NAMES.get(chainId.toString()) || `Chain: ${chainId.toString()}` }

export const ETHEREUM_EIP1559_ELASTICITY_MULTIPLIER = 4n // Bounds the maximum gas limit an EIP-1559 block may have, Ethereum = 4, Polygon = 8, lets just default to 4
export const ETHEREUM_EIP1559_BASEFEECHANGEDENOMINATOR = 8n // Bounds the amount the base fee can change between blocks.

export const MOCK_PRIVATE_KEYS_ADDRESS = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdfn // an address represeting 0x1 privatekey

export const KNOWN_CONTRACT_CALLER_ADDRESSES = [
	0xca11bde05977b3631167028862be2a173976ca11n // curve multicaller
]

export const WARNING_COLOR = '#FFC107'
export const PRIMARY_COLOR = '#58a5b3'

export const CANNOT_SIMULATE_OFF_LEGACY_BLOCK = 'Cannot simulate off a legacy block'

export const BIG_FONT_SIZE = '28px'
export const NORMAL_FONT_SIZE = '14px'

export const NEW_BLOCK_ABORT = 'New Block Abort'

export const MAKE_YOU_RICH_TRANSACTION = {
	transaction: {
		type: '1559' as const,
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n,
		gas: 21000n,
		value: 200000000000000000000000n,
		input: new Uint8Array(0),
		accessList: [],
	},
	website: {
		websiteOrigin: 'The Interceptor',
		title: 'The Interceptor',
		icon: undefined,
	},
	transactionSendingFormat: 'eth_sendTransaction' as const,
}
