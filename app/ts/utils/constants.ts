import { ethers } from 'ethers'

// common contract addresses
export const SUSHISWAP_FACTORY_ADDRESS = 0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Acn
export const UNISWAP_V2_ROUTER_ADDRESS = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488Dn
export const SUSHISWAP_V2_ROUTER_ADDRESS = 0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9Fn
export const UNISWAP_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564n
export const UNISWAP_V3_NFT_ROUTER = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88n
export const MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11n // Contract for bundling bulk call transactions, deployed on every chain. https://github.com/mds1/multicall

// common 4-byte function sigs
export const ERC20_TRANSFER_FROM_4BYTES = 0x23b872dd
export const ERC20_TRANSFER_4BYTES = 0xa9059cbb
export const ERC20_APPROVAL_4BYTES = 0x095ea7b3
export const ERC721_APPROVAL_FOR_ALL_4BYTES = 0xa22cb465

// common event log signatures
export const TRANSFER_LOG = ethers.keccak256(ethers.toUtf8Bytes('Transfer(address,address,uint256)'))
export const APPROVAL_LOG = ethers.keccak256(ethers.toUtf8Bytes('Approval(address,address,uint256)'))
export const ERC721_APPROVAL_FOR_ALL_LOG = ethers.keccak256(ethers.toUtf8Bytes('ApprovalForAll(address,address,bool)'))
export const DEPOSIT_LOG = ethers.keccak256(ethers.toUtf8Bytes('Deposit(address,uint256)'))
export const WITHDRAWAL_LOG = ethers.keccak256(ethers.toUtf8Bytes('Withdrawal(address,uint256)'))

// Other
export const MOCK_ADDRESS = 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefn

// https://blog.logrocket.com/understanding-resolving-metamask-error-codes/#4001
export const METAMASK_ERROR_USER_REJECTED_REQUEST = 4001
export const METAMASK_ERROR_NOT_AUTHORIZED = 4100
export const METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER = 4200
export const METAMASK_ERROR_CHAIN_NOT_ADDED_TO_METAMASK = 4902
export const METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN = 4901
export const METAMASK_ERROR_FAILED_TO_PARSE_REQUEST = -32700
export const METAMASK_ERROR_REQUEST_STRUCTURE_INCORRECT = -32600
export const METAMASK_ERROR_METHOD_DOES_NOT_EXIST = -32601
export const METAMASK_ERROR_INVALID_ARGUMENT = -32602
export const METAMASK_ERROR_BLANKET_ERROR = -32603
export const METAMASK_ERROR_TRANSACTION_REJECTD = -32003
export const METAMASK_ERROR_METHOD_NOT_SUPPORTED = -32004
export const METAMASK_ERROR_RATE_LIMITED = -32005

export const METAMASK_ERROR_ALREADY_PENDING = { error: { code: -32002, message: `Access request pending already.` } }
export const ERROR_INTERCEPTOR_NOT_READY = { error: { code: 1, message: 'Interceptor: Not ready' } }
export const ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS = { error: { code: 2, message: 'Interceptor: No active address' } }
export const ERROR_INTERCEPTOR_UNKNOWN_ORIGIN = { error: { code: 400, message: 'Interceptor: Unkown website origin' } }
export const METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN = { error: { code: 4900, message: 'Interceptor: Not connected to chain' } }
export const ERROR_INTERCEPTOR_GET_CODE_FAILED = { error: { code: -40001, message: 'Interceptor: Get code failed' } } // I wonder how we should come up with these numbers?
export const ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED = -40002

function get4Byte(functionAbi: string) {
	return Number(ethers.keccak256(ethers.toUtf8Bytes(functionAbi)).slice(0, 10))
}

export const FourByteExplanations = new Map<number, string >([
	[get4Byte('transferFrom(address,address,uint256)'), 'ERC20/ERC721 Transfer From'],
	[get4Byte('transfer(address,uint256)'), 'ERC20 Transfer'],
	[get4Byte('approve(address,uint256)'), 'ERC20 Approval'],
	[get4Byte('setApprovalForAll(address,bool)'), 'ERC721 Approval For All'],
	[get4Byte('swapExactTokensForTokens(uint256,uint256,address[],address,uint256)'), 'Swap Exact Tokens For Tokens'],
	[get4Byte('swapExactETHForTokens(uint256,address[],address,uint256)'), 'Swap Exact ETH For Tokens'],
	[get4Byte('multicall((address,uint256,bytes)[])'), 'Multicall'],
	[get4Byte('exactInput((bytes,address,uint256,uint256,uint256))'), 'Exact Input Swap'],
	[get4Byte('multicall(uint256,bytes[])'), 'Multicall'],
	[get4Byte('multicall(bytes[])'), 'Multicall'],
	[get4Byte('mint(address)'), 'Mint'],
	[get4Byte('mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))'), 'Mint'],
	[get4Byte('burn(address)'), 'Burn'],
])

export const ICON_ACTIVE = '../img/head.png' as const
export const ICON_ACCESS_DENIED = '../img/head-access-denied.png' as const
export const ICON_NOT_ACTIVE = '../img/head-not-active.png' as const
export const ICON_SIMULATING = '../img/head-simulating.png' as const
export const ICON_SIGNING = '../img/head-signing.png' as const
export const ICON_SIGNING_NOT_SUPPORTED = '../img/head-signing-unsupported-network.png' as const
export const DEFAULT_TAB_CONNECTION = { icon: ICON_NOT_ACTIVE, iconReason: 'The website has not requested to connect to The Interceptor.' }

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

export const TIME_BETWEEN_BLOCKS = 12
export const METAMASK_LOGO = '../img/signers/metamask.svg'
export const BRAVE_LOGO = '../img/signers/brave.svg'

export const CHAIN_NAMES = new Map<string, string>( [
	['0', 'Kardia'],
	['1', 'Ethereum Mainnet'],
	['4', 'Rinkeby'],
	['5', 'Goerli'],
	['8', 'Ubiq'],
	['10', 'Optimism'],
	['19', 'SongBird'],
	['20', 'Elastos'],
	['25', 'Cronos'],
	['30', 'RSK'],
	['40', 'Telos'],
	['50', 'XDC'],
	['52', 'CSC'],
	['55', 'ZYX'],
	['56', 'Binance'],
	['57', 'SysCoin'],
	['60', 'GoChain'],
	['61', 'EthereumClassic'],
	['66', 'OkexChain'],
	['70', 'Hoo'],
	['82', 'Meter'],
	['87', 'Nova Network'],
	['88', 'TomoChain'],
	['100', 'xDai'],
	['106', 'Velas'],
	['108', 'ThunderCore'],
	['122', 'Fuse'],
	['128', 'Heco'],
	['137', 'Polygon'],
	['200', 'xDaiArb'],
	['246', 'EnergyWeb'],
	['250', 'Fantom'],
	['269', 'HPB'],
	['288', 'Boba'],
	['321', 'KuCoin'],
	['336', 'Shiden'],
	['361', 'Theta'],
	['416', 'SX'],
	['534', 'Candle'],
	['592', 'aStar'],
	['820', 'Callisto'],
	['888', 'WanChain'],
	['1088', 'Metis'],
	['1231', 'Ultron'],
	['1234', 'Step'],
	['1284', 'MoonBeam'],
	['1285', 'MoonRiver'],
	['2000', 'DogeChain'],
	['2020', 'Ronin'],
	['2222', 'Kava'],
	['4689', 'IOTex'],
	['5050', 'XLC'],
	['5551', 'Nahmii'],
	['6969', 'TombChain'],
	['7700', 'Canto'],
	['8217', 'Klaytn'],
	['9001', 'Evmos'],
	['10000', 'SmartBCH'],
	['32520', 'Bitgert'],
	['32659', 'Fusion'],
	['42161', 'Arbitrum'],
	['42170', 'Arb-Nova'],
	['42220', 'Celo'],
	['42262', 'Oasis'],
	['43114', 'Avalanche'],
	['47805', 'Rei'],
	['55555', 'ReiChain'],
	['71402', 'GodWoken'],
	['333999', 'Polis'],
	['420420', 'KekChain'],
	['888888', 'Vision'],
	['11155111', 'Sepolia'],
	['1313161554', 'Aurora'],
	['1666600000', 'Harmony'],
	['11297108109', 'Palm'],
	['836542336838601', 'Curio']
] )

export function getChainName(chainId: bigint) { return CHAIN_NAMES.get(chainId.toString()) || `Chain: ${chainId.toString()}` }

export const MOCK_PRIVATE_KEYS_ADDRESS = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdfn // an address represeting 0x1 privatekey

export const KNOWN_CONTRACT_CALLER_ADDRESSES = [
	0xca11bde05977b3631167028862be2a173976ca11n // curve multicaller
]

export const WARNING_COLOR = '#FFC107'
export const PRIMARY_COLOR = '#58a5b3'

export const CHROME_NO_TAB_WITH_ID_ERROR = 'No tab with id'
export const CANNOT_SIMULATE_OFF_LEGACY_BLOCK = 'Cannot simulate off a legacy block'
