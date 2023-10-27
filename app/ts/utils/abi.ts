import { InterfaceAbi } from 'ethers'

export const MulticallABI: InterfaceAbi = [
	'function aggregate(tuple(address target, bytes callData)[] calls) returns (uint256 blockNumber, bytes[] returnData)',
	'function blockAndAggregate(tuple(address target, bytes callData)[] calls) returns (uint256 blockNumber, bytes32 blockHash, tuple(bool success, bytes returnData)[] returnData)',
	'function getBlockHash(uint256 blockNumber) view returns (bytes32 blockHash)',
	'function getBlockNumber() view returns (uint256 blockNumber)',
	'function getCurrentBlockCoinbase() view returns (address coinbase)',
	'function getCurrentBlockDifficulty() view returns (uint256 difficulty)',
	'function getCurrentBlockGasLimit() view returns (uint256 gaslimit)',
	'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
	'function getEthBalance(address addr) view returns (uint256 balance)',
	'function getLastBlockHash() view returns (bytes32 blockHash)',
	'function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) returns (tuple(bool success, bytes returnData)[] returnData)',
	'function tryBlockAndAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) returns (uint256 blockNumber, bytes32 blockHash, tuple(bool success, bytes returnData)[] returnData)'
]

export const TokenMetadataABI: InterfaceAbi = [
	'function name() external view returns(string memory)',
	'function symbol() external view returns(string memory)',
	'function decimals() external view returns(uint8)',
	'function balanceOf(address addr) returns (uint)',
]

export const Erc20ABI: InterfaceAbi = [
	...TokenMetadataABI,
	'event Transfer(address indexed from, address indexed to, uint256 value)',
	'event Approval(address indexed owner, address indexed spender, uint256 value)',
	'function totalSupply() external view returns(uint256)',
	'function balanceOf(address account) external view returns(uint256)',
	'function transfer(address to, uint256 amount) external returns(bool)',
	'function allowance(address owner, address spender) external view returns(uint256)',
	'function approve(address spender, uint256 amount) external returns(bool)',
	'function transferFrom(address from, address to, uint256 amount) external returns(bool)'
]

export const Erc165ABI: InterfaceAbi = [
	'function supportsInterface(bytes4 interfaceId) external view returns (bool)'
]

export const Erc721ABI: InterfaceAbi = [
	...TokenMetadataABI,
	...Erc165ABI,
	'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
	'event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)',
	'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)',
	'function balanceOf(address owner) external view returns(uint256 balance)',
	'function ownerOf(uint256 tokenId) external view returns(address owner)',
	'function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external',
	'function safeTransferFrom(address from, address to, uint256 tokenId) external',
	'function transferFrom(address from, address to, uint256 tokenId) external',
	'function approve(address to, uint256 tokenId) external',
	'function setApprovalForAll(address operator, bool _approved) external',
	'function getApproved(uint256 tokenId) external view returns(address operator)',
	'function isApprovedForAll(address owner, address operator) external view returns(bool)',
	'function tokenURI(uint256 id) external view returns (string memory)'
]

export const Erc1155ABI: InterfaceAbi = [
	...Erc165ABI,
	'function uri(uint256 _id) view returns (string memory)',
	'event TransferBatch(address indexed _operator, address indexed _from, address indexed _to, uint256[] _ids, uint256[] _values)',
	'event TransferSingle(address operator, address from, address to, uint256 id, uint256 value)',
	'event ApprovalForAll(address indexed _owner, address indexed _operator, bool _approved)',
	'event URI(string _value, uint256 indexed _id)',
	'function safeTransferFrom(address _from, address _to, uint256 _id, uint256 _value, bytes calldata _data) external',
	'function safeBatchTransferFrom(address _from, address _to, uint256[] calldata _ids, uint256[] calldata _values, bytes calldata _data) external',
	'function balanceOf(address _owner, uint256 _id) external view returns(uint256)',
	'function balanceOfBatch(address[] calldata _owners, uint256[] calldata _ids) external view returns(uint256[] memory)',
	'function setApprovalForAll(address _operator, bool _approved) external',
	'function isApprovedForAll(address _owner, address _operator) external view returns(bool)'
]

export const CompoundGovernanceAbi: InterfaceAbi = [
	'function timelock() view returns (address)',
	'function proposals(uint256 id) external view returns (uint256 id, address proposer, uint256 eta, uint256 startBlock, uint256 endBlock, uint256 forVotes, uint256 againstVotes, uint256 abstainVotes, bool canceled, bool executed)',
	'function getActions(uint256 id) external view returns (address[] targets, uint256[] values, string[] signatures, bytes[] calldatas)',
	'function submitVote(uint256 proposalId, bool support) external',
	'function castVote(uint256 proposalId, uint8 support) external',
]

export const CompoundTimeLock: InterfaceAbi = [
	'function executeTransactions(address[] memory targets, uint[] memory values, string[] memory signatures, bytes[] memory datas, uint eta) public payable'
]
