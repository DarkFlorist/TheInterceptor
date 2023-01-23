import { ethers } from 'ethers'

// common contract addresses
export const UNISWAP_FACTORY_ADDRESS = 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6fn
export const SUSHISWAP_FACTORY_ADDRESS = 0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Acn
export const UNISWAP_V2_ROUTER_ADDRESS = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488Dn
export const SUSHISWAP_V2_ROUTER_ADDRESS = 0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9Fn
export const UNISWAP_V3_FACTORY_ADDRESS = 0x1F98431c8aD98523631AE4a59f267346ea31F984n
export const UNISWAP_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564n
export const UNISWAP_V3_NFT_ROUTER = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88n

// common 4-byte function sigs
export const ERC20_TRANSFER_FROM_4BYTES = 0x23b872dd
export const ERC20_TRANSFER_4BYTES = 0xa9059cbb
export const ERC20_APPROVAL_4BYTES = 0x095ea7b3
export const ERC721_APPROVAL_FOR_ALL_4BYTES = 0xa22cb465

// common event log signatures
export const TRANSFER_LOG = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('Transfer(address,address,uint256)'))
export const APPROVAL_LOG = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('Approval(address,address,uint256)'))
export const ERC721_APPROVAL_FOR_ALL_LOG = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('ApprovalForAll(address,address,bool)'))
export const DEPOSIT_LOG = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('Deposit(address,uint256)'))
export const WITHDRAWAL_LOG = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('Withdrawal(address,uint256)'))

// Other
export const MOCK_ADDRESS = 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefn

export const CHAINS = {
	'1': {
		name: 'Ethereum Mainnet',
		chainId: 1n,
		https_rpc: 'https://rpc.dark.florist/flipcardtrustone',
		wss_rpc: 'wss://rpc.dark.florist/flipcardtrustone',
		eth_donator: 0xda9dfa130df4de4673b89022ee50ff26f6ea73cfn, // Kraken
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		weth: 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2n,
	},
	'5': {
		name: 'Goerli',
		chainId: 5n,
		https_rpc: 'https://rpc-goerli.dark.florist/flipcardtrustone',
		wss_rpc: 'wss://rpc-goerli.dark.florist/flipcardtrustone',
		eth_donator: 0xf36F155486299eCAff2D4F5160ed5114C1f66000n, // Some Goerli validator
		currencyName: 'Goerli Testnet ETH',
		currencyTicker: 'GÖETH',
		weth: 0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6n,
	}
} as const

export function isSupportedChain(chainId: string): chainId is keyof typeof CHAINS { return chainId in CHAINS }

// https://blog.logrocket.com/understanding-resolving-metamask-error-codes/#4001
export const METAMASK_ERROR_USER_REJECTED_REQUEST = 4001
export const METAMASK_ERROR_NOT_AUTHORIZED = 4100
export const METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER = 4200
export const METAMASK_ERROR_CHAIN_NOT_ADDED_TO_METAMASK = 4902
export const METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN = 4900
export const METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN = 4901
export const METAMASK_ERROR_INCOMPLETE_REQUEST = 32700
export const METAMASK_ERROR_REQUEST_STRUCTURE_INCORRECT = 32600
export const METAMASK_ERROR_METHOD_DOES_NOT_EXIST = 32601
export const METAMASK_ERROR_INVALID_ARGUMENT = 32602
export const METAMASK_ERROR_BLANKET_ERROR = 32603
export const METAMASK_ERROR_TRANSACTION_REJECTD = 32003
export const METAMASK_ERROR_METHOD_NOT_SUPPORTED= 32004
export const METAMASK_ERROR_RATE_LIMITED = 32005

function get4Byte(functionAbi: string) {
	return Number(ethers.utils.keccak256(ethers.utils.toUtf8Bytes(functionAbi)).slice(0, 10))
}

export const FourByteExplanations = new Map<number, string >([
	[get4Byte('transferFrom(address,address,uint256)'), 'ERC20 Transfer From'],
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

export const ICON_ACTIVE = '../img/head.png'
export const ICON_ACCESS_DENIED = '../img/head-access-denied.png'
export const ICON_NOT_ACTIVE = '../img/head-not-active.png'
export const ICON_SIMULATING = '../img/head-simulating.png'
export const ICON_SIGNING = '../img/head-signing.png'
export const ICON_SIGNING_NOT_SUPPORTED = '../img/head-signing-unsupported-network.png'
export const DEFAULT_TAB_CONNECTION = { icon: ICON_NOT_ACTIVE, iconReason: 'The website has not requested to connect to The Interceptor.' }

export const MAKE_YOU_RICH_TRANSACTION = {
	type: '1559' as const,
	maxFeePerGas: 0n,
	maxPriorityFeePerGas: 0n,
	gas: 21000n,
	value: 200000000000000000000000n,
	input: new Uint8Array(0),
	accessList: []
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
	['1313161554', 'Aurora'],
	['1666600000', 'Harmony'],
	['11297108109', 'Palm'],
	['836542336838601', 'Curio']
] )

export function getChainName(chainId: bigint) { return CHAIN_NAMES.get(chainId.toString()) || `Chain: ${chainId.toString()}` }

export const MOCK_PRIVATE_KEYS_ADDRESS = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdfn // an address represeting 0x1 privatekey
