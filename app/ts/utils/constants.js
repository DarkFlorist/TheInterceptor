"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IS_DOT_ETH = exports.PARENT_CANNOT_CONTROL = exports.CANNOT_APPROVE = exports.CANNOT_CREATE_SUBDOMAIN = exports.CANNOT_SET_TTL = exports.CANNOT_SET_RESOLVER = exports.CANNOT_TRANSFER = exports.CANNOT_BURN_FUSES = exports.CANNOT_UNWRAP = exports.ENS_ADDR_REVERSE_NODE = exports.ENS_REVERSE_REGISTRAR = exports.ENS_REGISTRY_WITH_FALLBACK = exports.ENS_PUBLIC_RESOLVER_2 = exports.ENS_ETHEREUM_NAME_SERVICE = exports.ENS_ETH_REGISTRAR_CONTROLLER = exports.ENS_TOKEN_WRAPPER = exports.ENS_PUBLIC_RESOLVER = exports.MOCK_ADDRESS = exports.ENS_EXPIRY_EXTENDED = exports.ENS_NEW_TTL = exports.ENS_CONTROLLER_NAME_REGISTERED = exports.ENS_REVERSE_CLAIMED = exports.ENS_NAME_CHANGED = exports.ENS_NAME_WRAPPED = exports.ENS_NAME_UNWRAPPED = exports.ENS_FUSES_SET = exports.ENS_CONTENT_HASH_CHANGED = exports.ENS_TEXT_CHANGED_KEY_VALUE = exports.ENS_TEXT_CHANGED = exports.ENS_NEW_RESOLVER = exports.ENS_NEW_OWNER = exports.ENS_TRANSFER = exports.ENS_BASE_REGISTRAR_NAME_REGISTERED = exports.ENS_BASE_REGISTRAR_NAME_RENEWED = exports.ENS_CONTROLLER_NAME_RENEWED = exports.ENS_ADDRESS_CHANGED = exports.ENS_ADDR_CHANGED = exports.ERC1155_TRANSFERSINGLE_LOG = exports.ERC1155_TRANSFERBATCH_LOG = exports.WITHDRAWAL_LOG = exports.DEPOSIT_LOG = exports.ERC721_APPROVAL_FOR_ALL_LOG = exports.APPROVAL_LOG = exports.TRANSFER_LOG = exports.Multicall3ABI = exports.ETHEREUM_LOGS_LOGGER_ADDRESS = exports.MULTICALL3 = exports.UNISWAP_V3_ROUTER = exports.SUSHISWAP_V2_ROUTER_ADDRESS = exports.UNISWAP_V2_ROUTER_ADDRESS = void 0;
exports.BURN_ADDRESSES = exports.MAKE_YOU_RICH_TRANSACTION = exports.NEW_BLOCK_ABORT = exports.CANNOT_SIMULATE_OFF_LEGACY_BLOCK = exports.PRIMARY_COLOR = exports.WARNING_COLOR = exports.MOCK_PRIVATE_KEYS_ADDRESS = exports.ETHEREUM_EIP1559_BASEFEECHANGEDENOMINATOR = exports.ETHEREUM_EIP1559_ELASTICITY_MULTIPLIER = exports.getChainName = exports.COINBASEWALLET_LOGO = exports.BRAVE_LOGO = exports.METAMASK_LOGO = exports.GAS_PER_BLOB = exports.TIME_BETWEEN_BLOCKS = exports.MAX_BLOCK_CACHE = exports.DEFAULT_CALL_ADDRESS = exports.ETHEREUM_COIN_ICON = exports.DEFAULT_TAB_CONNECTION = exports.ICON_SIGNING_NOT_SUPPORTED_WITH_SHIELD = exports.ICON_SIGNING_WITH_SHIELD = exports.ICON_SIMULATING_WITH_SHIELD = exports.ICON_NOT_ACTIVE_WITH_SHIELD = exports.ICON_ACCESS_DENIED_WITH_SHIELD = exports.ICON_ACTIVE_WITH_SHIELD = exports.ICON_INTERCEPTOR_DISABLED = exports.ICON_SIGNING_NOT_SUPPORTED = exports.ICON_SIGNING = exports.ICON_SIMULATING = exports.ICON_NOT_ACTIVE = exports.ICON_ACCESS_DENIED = exports.ICON_ACTIVE = exports.FourByteExplanations = exports.ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED = exports.ERROR_INTERCEPTOR_GET_CODE_FAILED = exports.METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN = exports.ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS = exports.METAMASK_ERROR_ALREADY_PENDING = exports.ERROR_INTERCEPTOR_DISABLED = exports.METAMASK_ERROR_BLANKET_ERROR = exports.METAMASK_ERROR_FAILED_TO_PARSE_REQUEST = exports.METAMASK_ERROR_NOT_AUTHORIZED = exports.METAMASK_ERROR_USER_REJECTED_REQUEST = exports.CAN_DO_EVERYTHING = exports.CAN_EXTEND_EXPIRY = void 0;
const ethers_1 = require("ethers");
const chainNames_js_1 = require("./chainNames.js");
// common contract addresses
exports.UNISWAP_V2_ROUTER_ADDRESS = 0x7a250d5630b4cf539739df2c5dacb4c659f2488dn;
exports.SUSHISWAP_V2_ROUTER_ADDRESS = 0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9fn;
exports.UNISWAP_V3_ROUTER = 0xe592427a0aece92de3edee1f18e0157c05861564n;
exports.MULTICALL3 = 0xca11bde05977b3631167028862be2a173976ca11n; // Contract for bundling bulk call transactions, deployed on every chain. https://github.com/mds1/multicall
exports.ETHEREUM_LOGS_LOGGER_ADDRESS = 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeen;
// export const UNISWAP_V3_NFT_ROUTER = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88n
// export const SUSHISWAP_FACTORY_ADDRESS = 0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Acn
exports.Multicall3ABI = [
    'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
    'function getEthBalance(address) returns (uint256)',
];
// common 4-byte function sigs
// export const ERC20_TRANSFER_FROM_4BYTES = 0x23b872dd
// export const ERC20_TRANSFER_4BYTES = 0xa9059cbb
// export const ERC20_APPROVAL_4BYTES = 0x095ea7b3
// export const ERC721_APPROVAL_FOR_ALL_4BYTES = 0xa22cb465
// common event log signatures
exports.TRANSFER_LOG = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('Transfer(address,address,uint256)'));
exports.APPROVAL_LOG = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('Approval(address,address,uint256)'));
exports.ERC721_APPROVAL_FOR_ALL_LOG = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('ApprovalForAll(address,address,bool)'));
exports.DEPOSIT_LOG = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('Deposit(address,uint256)'));
exports.WITHDRAWAL_LOG = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('Withdrawal(address,uint256)'));
exports.ERC1155_TRANSFERBATCH_LOG = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('TransferBatch(address,address,address,uint256[],uint256[])'));
exports.ERC1155_TRANSFERSINGLE_LOG = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('TransferSingle(address,address,address,uint256,uint256)'));
// ENS event signatures
exports.ENS_ADDR_CHANGED = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('AddrChanged(bytes32,address)'));
exports.ENS_ADDRESS_CHANGED = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('AddressChanged(bytes32,uint256,bytes)'));
exports.ENS_CONTROLLER_NAME_RENEWED = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('NameRenewed(string,bytes32,uint256,uint256)'));
exports.ENS_BASE_REGISTRAR_NAME_RENEWED = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('NameRenewed(uint256,uint256)'));
exports.ENS_BASE_REGISTRAR_NAME_REGISTERED = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('NameRegistered(uint256,address,uint256)'));
exports.ENS_TRANSFER = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('Transfer(bytes32,address)'));
exports.ENS_NEW_OWNER = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('NewOwner(bytes32,bytes32,address)'));
exports.ENS_NEW_RESOLVER = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('NewResolver(bytes32,address)'));
exports.ENS_TEXT_CHANGED = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('TextChanged(bytes32,string,string)'));
exports.ENS_TEXT_CHANGED_KEY_VALUE = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('TextChanged(bytes32,string,string,string)'));
exports.ENS_CONTENT_HASH_CHANGED = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('ContenthashChanged(bytes32,bytes)'));
exports.ENS_FUSES_SET = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('FusesSet(bytes32,uint32)'));
exports.ENS_NAME_UNWRAPPED = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('NameUnwrapped(bytes32,address)'));
exports.ENS_NAME_WRAPPED = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('NameWrapped(bytes32,bytes,address,uint32,uint64)'));
exports.ENS_NAME_CHANGED = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('NameChanged(bytes32,string)'));
exports.ENS_REVERSE_CLAIMED = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('ReverseClaimed(address,bytes32)'));
exports.ENS_CONTROLLER_NAME_REGISTERED = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('NameRegistered(string,bytes32,address,uint256,uint256)'));
exports.ENS_NEW_TTL = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('NewTTL(bytes32,uint64)'));
exports.ENS_EXPIRY_EXTENDED = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('ExpiryExtended(bytes32,uint64)'));
// Other
exports.MOCK_ADDRESS = 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefn;
exports.ENS_PUBLIC_RESOLVER = 0x231b0ee14048e9dccd1d247744d114a4eb5e8e63n;
exports.ENS_TOKEN_WRAPPER = 0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401n; //mainnet only
exports.ENS_ETH_REGISTRAR_CONTROLLER = 0x253553366da8546fc250f225fe3d25d0c782303bn;
exports.ENS_ETHEREUM_NAME_SERVICE = 0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85n;
exports.ENS_PUBLIC_RESOLVER_2 = 0x4976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41n;
exports.ENS_REGISTRY_WITH_FALLBACK = 0x00000000000c2e074ec69a0dfb2997ba6c7d2e1en;
exports.ENS_REVERSE_REGISTRAR = 0xa58e81fe9b61b5c3fe2afd33cf304c454abfc7cbn;
// ENS Nodes
exports.ENS_ADDR_REVERSE_NODE = { name: 'addr.reverse', nameHash: BigInt((0, ethers_1.namehash)('addr.reverse')) };
// ENS Fuses
exports.CANNOT_UNWRAP = 1n;
exports.CANNOT_BURN_FUSES = 2n;
exports.CANNOT_TRANSFER = 4n;
exports.CANNOT_SET_RESOLVER = 8n;
exports.CANNOT_SET_TTL = 16n;
exports.CANNOT_CREATE_SUBDOMAIN = 32n;
exports.CANNOT_APPROVE = 64n;
exports.PARENT_CANNOT_CONTROL = 1n << 16n;
exports.IS_DOT_ETH = 1n << 17n;
exports.CAN_EXTEND_EXPIRY = 1n << 18n;
exports.CAN_DO_EVERYTHING = 0n;
// https://blog.logrocket.com/understanding-resolving-metamask-error-codes/#4001
exports.METAMASK_ERROR_USER_REJECTED_REQUEST = 4001;
exports.METAMASK_ERROR_NOT_AUTHORIZED = 4100;
exports.METAMASK_ERROR_FAILED_TO_PARSE_REQUEST = -32700;
exports.METAMASK_ERROR_BLANKET_ERROR = -32603;
// const METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER = 4200
// const METAMASK_ERROR_CHAIN_NOT_ADDED_TO_METAMASK = 4902
// const METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN = 4901
// const METAMASK_ERROR_REQUEST_STRUCTURE_INCORRECT = -32600
// const METAMASK_ERROR_METHOD_DOES_NOT_EXIST = -32601
// const METAMASK_ERROR_INVALID_ARGUMENT = -32602
// const METAMASK_ERROR_TRANSACTION_REJECTD = -32003
// const METAMASK_ERROR_METHOD_NOT_SUPPORTED = -32004
// const METAMASK_ERROR_RATE_LIMITED = -32005
exports.ERROR_INTERCEPTOR_DISABLED = { error: { code: exports.METAMASK_ERROR_USER_REJECTED_REQUEST, message: 'The Interceptor is disabled' } };
exports.METAMASK_ERROR_ALREADY_PENDING = { error: { code: -32002, message: 'Access request pending already.' } };
exports.ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS = { error: { code: 2, message: 'Interceptor: No active address' } };
exports.METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN = { error: { code: 4900, message: 'Interceptor: Not connected to chain' } };
exports.ERROR_INTERCEPTOR_GET_CODE_FAILED = { error: { code: -40001, message: 'Interceptor: Get code failed' } }; // I wonder how we should come up with these numbers?
exports.ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED = -40002;
// const ERROR_INTERCEPTOR_NOT_READY = { error: { code: 1, message: 'Interceptor: Not ready' } }
// const ERROR_INTERCEPTOR_UNKNOWN_ORIGIN = { error: { code: 400, message: 'Interceptor: Unknown website origin' } }
function get4Byte(functionAbi) {
    return Number(ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(functionAbi)).slice(0, 10));
}
exports.FourByteExplanations = {
    [get4Byte('transferFrom(address,address,uint256)')]: 'ERC20/ERC721 Transfer From',
    [get4Byte('transfer(address,uint256)')]: 'ERC20 Transfer',
    [get4Byte('approve(address,uint256)')]: 'ERC20 Approval',
    [get4Byte('setApprovalForAll(address,bool)')]: 'ERC721 Approval For All',
    [get4Byte('swapExactTokensForTokens(uint256,uint256,address[],address,uint256)')]: 'Swap Exact Tokens For Tokens',
    [get4Byte('swapExactETHForTokens(uint256,address[],address,uint256)')]: 'Swap Exact ETH For Tokens',
    [get4Byte('multicall((address,uint256,bytes)[])')]: 'Multicall',
    [get4Byte('exactInput((bytes,address,uint256,uint256,uint256))')]: 'Exact Input Swap',
    [get4Byte('multicall(uint256,bytes[])')]: 'Multicall',
    [get4Byte('multicall(bytes[])')]: 'Multicall',
    [get4Byte('mint(address)')]: 'Mint',
    [get4Byte('mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))')]: 'Mint',
    [get4Byte('burn(address)')]: 'Burn',
    [get4Byte('submitVote(uint256,bool)')]: 'Submit Vote',
    [get4Byte('castVote(uint256,uint8)')]: 'Cast Vote',
    [get4Byte('castVoteWithReason(uint256,uint8,string)')]: 'Cast Vote with Reason',
    [get4Byte('castVoteWithReasonAndParams(uint256,uint8,string,bytes)')]: 'Cast Vote with Reason and Additional Info',
    [get4Byte('castVoteBySig(uint256,uint8,voter,bytes)')]: 'Cast Vote by Signature',
    [get4Byte('castVoteWithReasonAndParamsBySig(uint256,uint8,address,string,bytes,bytes)')]: 'Cast Vote with Reason And Additional Info by Signature',
};
exports.ICON_ACTIVE = '../img/head.png';
exports.ICON_ACCESS_DENIED = '../img/head-access-denied.png';
exports.ICON_NOT_ACTIVE = '../img/head-not-active.png';
exports.ICON_SIMULATING = '../img/head-simulating.png';
exports.ICON_SIGNING = '../img/head-signing.png';
exports.ICON_SIGNING_NOT_SUPPORTED = '../img/head-signing-unsupported-network.png';
exports.ICON_INTERCEPTOR_DISABLED = '../img/head-interceptor-disabled.png';
exports.ICON_ACTIVE_WITH_SHIELD = '../img/head-shield.png';
exports.ICON_ACCESS_DENIED_WITH_SHIELD = '../img/head-access-denied-shield.png';
exports.ICON_NOT_ACTIVE_WITH_SHIELD = '../img/head-not-active-shield.png';
exports.ICON_SIMULATING_WITH_SHIELD = '../img/head-simulating-shield.png';
exports.ICON_SIGNING_WITH_SHIELD = '../img/head-signing-shield.png';
exports.ICON_SIGNING_NOT_SUPPORTED_WITH_SHIELD = '../img/head-signing-unsupported-network-shield.png';
exports.DEFAULT_TAB_CONNECTION = { icon: exports.ICON_NOT_ACTIVE, iconReason: 'The website has not requested to connect to The Interceptor.' };
// export const DEFAULT_TAB_CONNECTION_INTERCEPTOR_DISABLED = { icon: ICON_INTERCEPTOR_DISABLED, iconReason: 'The Interceptor is completely disabled by user request.' }
exports.ETHEREUM_COIN_ICON = '../../img/coins/ethereum.png';
exports.DEFAULT_CALL_ADDRESS = 0x1n;
exports.MAX_BLOCK_CACHE = 5;
exports.TIME_BETWEEN_BLOCKS = 12;
exports.GAS_PER_BLOB = 2n ** 17n;
exports.METAMASK_LOGO = '../img/signers/metamask.svg';
exports.BRAVE_LOGO = '../img/signers/brave.svg';
exports.COINBASEWALLET_LOGO = '../img/signers/coinbasewallet.svg';
function getChainName(chainId) { return chainNames_js_1.CHAIN_NAMES.get(chainId.toString()) || `Chain: ${chainId.toString()}`; }
exports.getChainName = getChainName;
exports.ETHEREUM_EIP1559_ELASTICITY_MULTIPLIER = 4n; // Bounds the maximum gas limit an EIP-1559 block may have, Ethereum = 4, Polygon = 8, lets just default to 4
exports.ETHEREUM_EIP1559_BASEFEECHANGEDENOMINATOR = 8n; // Bounds the amount the base fee can change between blocks.
exports.MOCK_PRIVATE_KEYS_ADDRESS = 0x7e5f4552091a69125d5dfcb7b8c2659029395bdfn; // an address represeting 0x1 privatekey
exports.WARNING_COLOR = '#FFC107';
exports.PRIMARY_COLOR = '#58a5b3';
exports.CANNOT_SIMULATE_OFF_LEGACY_BLOCK = 'Cannot simulate off a legacy block';
exports.NEW_BLOCK_ABORT = 'New Block Abort';
exports.MAKE_YOU_RICH_TRANSACTION = {
    transaction: {
        type: '1559',
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
    transactionSendingFormat: 'eth_sendTransaction',
};
exports.BURN_ADDRESSES = [
    0x0000000000000000000000000000000000000000n,
    0x000000000000000000000000000000000000deadn,
    0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddeadn,
];
