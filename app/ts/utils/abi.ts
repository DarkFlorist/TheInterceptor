import type { Abi } from './ethereumPrimitives.js'
import type { AddressBookEntry } from '../types/addressBookTypes.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS } from './constants.js'
import type { AbiLike } from './abiRuntime.js'

export const Erc20ABI = [
	{
		type: 'function',
		name: 'name',
		stateMutability: 'view',
		inputs: [],
		outputs: [{ type: 'string' }],
	},
	{
		type: 'function',
		name: 'approve',
		stateMutability: 'nonpayable',
		inputs: [{ name: 'guy', type: 'address' }, { name: 'wad', type: 'uint256' }],
		outputs: [{ name: '', type: 'bool' }],
	},
	{
		type: 'function',
		name: 'totalSupply',
		stateMutability: 'view',
		inputs: [],
		outputs: [{ name: '', type: 'uint256' }],
	},
	{
		type: 'function',
		name: 'transferFrom',
		stateMutability: 'nonpayable',
		inputs: [{ name: 'src', type: 'address' }, { name: 'dst', type: 'address' }, { name: 'wad', type: 'uint256' }],
		outputs: [{ name: '', type: 'bool' }],
	},
	{
		type: 'function',
		name: 'withdraw',
		stateMutability: 'nonpayable',
		inputs: [{ name: 'wad', type: 'uint256' }],
		outputs: [],
	},
	{
		type: 'function',
		name: 'decimals',
		stateMutability: 'view',
		inputs: [],
		outputs: [{ name: '', type: 'uint8' }],
	},
	{
		type: 'function',
		name: 'balanceOf',
		stateMutability: 'view',
		inputs: [{ name: 'account', type: 'address' }],
		outputs: [{ name: '', type: 'uint256' }],
	},
	{
		type: 'function',
		name: 'symbol',
		stateMutability: 'view',
		inputs: [],
		outputs: [{ name: '', type: 'string' }],
	},
	{
		type: 'function',
		name: 'transfer',
		stateMutability: 'nonpayable',
		inputs: [{ name: 'dst', type: 'address' }, { name: 'wad', type: 'uint256' }],
		outputs: [{ name: '', type: 'bool' }],
	},
	{
		type: 'function',
		name: 'deposit',
		stateMutability: 'payable',
		inputs: [],
		outputs: [],
	},
	{
		type: 'function',
		name: 'allowance',
		stateMutability: 'view',
		inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
		outputs: [{ name: '', type: 'uint256' }],
	},
	{
		type: 'fallback',
		stateMutability: 'payable',
	},
	{
		type: 'event',
		name: 'Approval',
		inputs: [
			{ name: 'src', type: 'address', indexed: true },
			{ name: 'guy', type: 'address', indexed: true },
			{ name: 'wad', type: 'uint256', indexed: false },
		],
	},
	{
		type: 'event',
		name: 'Transfer',
		inputs: [
			{ name: 'src', type: 'address', indexed: true },
			{ name: 'dst', type: 'address', indexed: true },
			{ name: 'wad', type: 'uint256', indexed: false },
		],
	},
	{
		type: 'event',
		name: 'Deposit',
		inputs: [
			{ name: 'dst', type: 'address', indexed: true },
			{ name: 'wad', type: 'uint256', indexed: false },
		],
	},
	{
		type: 'event',
		name: 'Withdrawal',
		inputs: [
			{ name: 'src', type: 'address', indexed: true },
			{ name: 'wad', type: 'uint256', indexed: false },
		],
	},
] as const satisfies Abi

const Erc165ABI = [
	{
		type: 'function',
		name: 'supportsInterface',
		stateMutability: 'view',
		inputs: [{ name: 'interfaceId', type: 'bytes4' }],
		outputs: [{ type: 'bool' }],
	},
] as const satisfies Abi

export const Erc721ABI = [
	{
		type: 'event',
		name: 'Approval',
		inputs: [
			{ indexed: true, name: 'owner', type: 'address' },
			{ indexed: true, name: 'approved', type: 'address' },
			{ indexed: true, name: 'tokenId', type: 'uint256' },
		],
	},
	{
		type: 'event',
		name: 'ApprovalForAll',
		inputs: [
			{ indexed: true, name: 'owner', type: 'address' },
			{ indexed: true, name: 'operator', type: 'address' },
			{ indexed: false, name: 'approved', type: 'bool' },
		],
	},
	{
		type: 'event',
		name: 'Transfer',
		inputs: [
			{ indexed: true, name: 'from', type: 'address' },
			{ indexed: true, name: 'to', type: 'address' },
			{ indexed: true, name: 'tokenId', type: 'uint256' },
		],
	},
	{
		type: 'function',
		name: 'approve',
		stateMutability: 'nonpayable',
		inputs: [{ name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }],
		outputs: [],
	},
	{
		type: 'function',
		name: 'balanceOf',
		stateMutability: 'view',
		inputs: [{ name: 'owner', type: 'address' }],
		outputs: [{ name: 'balance', type: 'uint256' }],
	},
	{
		type: 'function',
		name: 'getApproved',
		stateMutability: 'view',
		inputs: [{ name: 'tokenId', type: 'uint256' }],
		outputs: [{ name: 'operator', type: 'address' }],
	},
	{
		type: 'function',
		name: 'isApprovedForAll',
		stateMutability: 'view',
		inputs: [{ name: 'owner', type: 'address' }, { name: 'operator', type: 'address' }],
		outputs: [{ name: '', type: 'bool' }],
	},
	{
		type: 'function',
		name: 'name',
		stateMutability: 'view',
		inputs: [],
		outputs: [{ name: '', type: 'string' }],
	},
	{
		type: 'function',
		name: 'ownerOf',
		stateMutability: 'view',
		inputs: [{ name: 'tokenId', type: 'uint256' }],
		outputs: [{ name: 'owner', type: 'address' }],
	},
	{
		type: 'function',
		name: 'safeTransferFrom',
		stateMutability: 'nonpayable',
		inputs: [
			{ name: 'from', type: 'address' },
			{ name: 'to', type: 'address' },
			{ name: 'tokenId', type: 'uint256' },
		],
		outputs: [],
	},
	{
		type: 'function',
		name: 'safeTransferFrom',
		stateMutability: 'nonpayable',
		inputs: [
			{ name: 'from', type: 'address' },
			{ name: 'to', type: 'address' },
			{ name: 'tokenId', type: 'uint256' },
			{ name: 'data', type: 'bytes' },
		],
		outputs: [],
	},
	{
		type: 'function',
		name: 'setApprovalForAll',
		stateMutability: 'nonpayable',
		inputs: [{ name: 'operator', type: 'address' }, { name: '_approved', type: 'bool' }],
		outputs: [],
	},
	...Erc165ABI,
	{
		type: 'function',
		name: 'symbol',
		stateMutability: 'view',
		inputs: [],
		outputs: [{ name: '', type: 'string' }],
	},
	{
		type: 'function',
		name: 'tokenByIndex',
		stateMutability: 'view',
		inputs: [{ name: 'index', type: 'uint256' }],
		outputs: [{ name: '', type: 'uint256' }],
	},
	{
		type: 'function',
		name: 'tokenOfOwnerByIndex',
		stateMutability: 'view',
		inputs: [{ name: 'owner', type: 'address' }, { name: 'index', type: 'uint256' }],
		outputs: [{ name: 'tokenId', type: 'uint256' }],
	},
	{
		type: 'function',
		name: 'tokenURI',
		stateMutability: 'view',
		inputs: [{ name: 'tokenId', type: 'uint256' }],
		outputs: [{ name: '', type: 'string' }],
	},
	{
		type: 'function',
		name: 'totalSupply',
		stateMutability: 'view',
		inputs: [],
		outputs: [{ name: '', type: 'uint256' }],
	},
	{
		type: 'function',
		name: 'transferFrom',
		stateMutability: 'nonpayable',
		inputs: [
			{ name: 'from', type: 'address' },
			{ name: 'to', type: 'address' },
			{ name: 'tokenId', type: 'uint256' },
		],
		outputs: [],
	},
] as const satisfies Abi

export const Erc1155ABI = [
	...Erc165ABI,
	{
		type: 'function',
		name: 'uri',
		stateMutability: 'view',
		inputs: [{ name: '_id', type: 'uint256' }],
		outputs: [{ type: 'string' }],
	},
	{
		type: 'event',
		name: 'TransferBatch',
		inputs: [
			{ name: '_operator', type: 'address', indexed: true },
			{ name: '_from', type: 'address', indexed: true },
			{ name: '_to', type: 'address', indexed: true },
			{ name: '_ids', type: 'uint256[]' },
			{ name: '_values', type: 'uint256[]' },
		],
	},
	{
		type: 'event',
		name: 'TransferSingle',
		inputs: [
			{ name: 'operator', type: 'address' },
			{ name: 'from', type: 'address' },
			{ name: 'to', type: 'address' },
			{ name: 'id', type: 'uint256' },
			{ name: 'value', type: 'uint256' },
		],
	},
	{
		type: 'event',
		name: 'ApprovalForAll',
		inputs: [
			{ name: '_owner', type: 'address', indexed: true },
			{ name: '_operator', type: 'address', indexed: true },
			{ name: '_approved', type: 'bool' },
		],
	},
	{
		type: 'event',
		name: 'URI',
		inputs: [
			{ name: '_value', type: 'string' },
			{ name: '_id', type: 'uint256', indexed: true },
		],
	},
	{
		type: 'function',
		name: 'safeTransferFrom',
		stateMutability: 'nonpayable',
		inputs: [
			{ name: '_from', type: 'address' },
			{ name: '_to', type: 'address' },
			{ name: '_id', type: 'uint256' },
			{ name: '_value', type: 'uint256' },
			{ name: '_data', type: 'bytes' },
		],
		outputs: [],
	},
	{
		type: 'function',
		name: 'safeBatchTransferFrom',
		stateMutability: 'nonpayable',
		inputs: [
			{ name: '_from', type: 'address' },
			{ name: '_to', type: 'address' },
			{ name: '_ids', type: 'uint256[]' },
			{ name: '_values', type: 'uint256[]' },
			{ name: '_data', type: 'bytes' },
		],
		outputs: [],
	},
	{
		type: 'function',
		name: 'balanceOf',
		stateMutability: 'view',
		inputs: [{ name: '_owner', type: 'address' }, { name: '_id', type: 'uint256' }],
		outputs: [{ type: 'uint256' }],
	},
	{
		type: 'function',
		name: 'balanceOfBatch',
		stateMutability: 'view',
		inputs: [{ name: '_owners', type: 'address[]' }, { name: '_ids', type: 'uint256[]' }],
		outputs: [{ type: 'uint256[]' }],
	},
	{
		type: 'function',
		name: 'setApprovalForAll',
		stateMutability: 'nonpayable',
		inputs: [{ name: '_operator', type: 'address' }, { name: '_approved', type: 'bool' }],
		outputs: [],
	},
	{
		type: 'function',
		name: 'isApprovedForAll',
		stateMutability: 'view',
		inputs: [{ name: '_owner', type: 'address' }, { name: '_operator', type: 'address' }],
		outputs: [{ type: 'bool' }],
	},
] as const satisfies Abi

export const Erc1046ABI = [
	{
		type: 'function',
		name: 'tokenURI',
		stateMutability: 'view',
		inputs: [],
		outputs: [{ name: '', type: 'string' }],
	},
] as const satisfies Abi

// Every vote function of Compound's GovernorAlpha and GovernorBravo and of OpenZeppelin's Governor (4.x and 5.x). The by-signature variants changed shape between OpenZeppelin 4 and 5, so both are listed.
export const GovernorVoteAbi = [
	{ type: 'function', name: 'castVote', stateMutability: 'nonpayable', inputs: [{ name: 'proposalId', type: 'uint256' }, { name: 'support', type: 'bool' }], outputs: [] },
	{ type: 'function', name: 'submitVote', stateMutability: 'nonpayable', inputs: [{ name: 'proposalId', type: 'uint256' }, { name: 'support', type: 'bool' }], outputs: [] },
	{ type: 'function', name: 'castVote', stateMutability: 'nonpayable', inputs: [{ name: 'proposalId', type: 'uint256' }, { name: 'support', type: 'uint8' }], outputs: [] },
	{ type: 'function', name: 'castVoteWithReason', stateMutability: 'nonpayable', inputs: [{ name: 'proposalId', type: 'uint256' }, { name: 'support', type: 'uint8' }, { name: 'reason', type: 'string' }], outputs: [] },
	{ type: 'function', name: 'castVoteWithReasonAndParams', stateMutability: 'nonpayable', inputs: [{ name: 'proposalId', type: 'uint256' }, { name: 'support', type: 'uint8' }, { name: 'reason', type: 'string' }, { name: 'params', type: 'bytes' }], outputs: [] },
	{ type: 'function', name: 'castVoteBySig', stateMutability: 'nonpayable', inputs: [{ name: 'proposalId', type: 'uint256' }, { name: 'support', type: 'uint8' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }], outputs: [] },
	{ type: 'function', name: 'castVoteBySig', stateMutability: 'nonpayable', inputs: [{ name: 'proposalId', type: 'uint256' }, { name: 'support', type: 'uint8' }, { name: 'voter', type: 'address' }, { name: 'signature', type: 'bytes' }], outputs: [] },
	{ type: 'function', name: 'castVoteWithReasonAndParamsBySig', stateMutability: 'nonpayable', inputs: [{ name: 'proposalId', type: 'uint256' }, { name: 'support', type: 'uint8' }, { name: 'reason', type: 'string' }, { name: 'params', type: 'bytes' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }], outputs: [] },
	{ type: 'function', name: 'castVoteWithReasonAndParamsBySig', stateMutability: 'nonpayable', inputs: [{ name: 'proposalId', type: 'uint256' }, { name: 'support', type: 'uint8' }, { name: 'voter', type: 'address' }, { name: 'reason', type: 'string' }, { name: 'params', type: 'bytes' }, { name: 'signature', type: 'bytes' }], outputs: [] },
] as const satisfies Abi

// The governor functions the execution preview reads or calls. Compound-style governors (GovernorAlpha, GovernorBravo and OpenZeppelin's GovernorCompatibilityBravo) answer getActions and proposals; OpenZeppelin governors answer proposalEta, proposalDeadline and proposalSnapshot, and list a proposal's actions through proposalDetails (GovernorStorage) or only in their ProposalCreated event.
export const GovernorAbi = [
	{ type: 'function', name: 'timelock', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
	{ type: 'function', name: 'state', stateMutability: 'view', inputs: [{ name: 'proposalId', type: 'uint256' }], outputs: [{ name: '', type: 'uint8' }] },
	{
		type: 'function',
		name: 'getActions',
		stateMutability: 'view',
		inputs: [{ name: 'proposalId', type: 'uint256' }],
		outputs: [{ name: 'targets', type: 'address[]' }, { name: 'values', type: 'uint256[]' }, { name: 'signatures', type: 'string[]' }, { name: 'calldatas', type: 'bytes[]' }],
	},
	// Only the fields GovernorAlpha and GovernorBravo share at the start of their proposals getter; the fields after endBlock differ between the two.
	{
		type: 'function',
		name: 'proposals',
		stateMutability: 'view',
		inputs: [{ name: 'proposalId', type: 'uint256' }],
		outputs: [{ name: 'id', type: 'uint256' }, { name: 'proposer', type: 'address' }, { name: 'eta', type: 'uint256' }, { name: 'startBlock', type: 'uint256' }, { name: 'endBlock', type: 'uint256' }],
	},
	{
		type: 'function',
		name: 'proposalDetails',
		stateMutability: 'view',
		inputs: [{ name: 'proposalId', type: 'uint256' }],
		outputs: [{ name: 'targets', type: 'address[]' }, { name: 'values', type: 'uint256[]' }, { name: 'calldatas', type: 'bytes[]' }, { name: 'descriptionHash', type: 'bytes32' }],
	},
	{ type: 'function', name: 'proposalEta', stateMutability: 'view', inputs: [{ name: 'proposalId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
	{ type: 'function', name: 'proposalDeadline', stateMutability: 'view', inputs: [{ name: 'proposalId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
	{ type: 'function', name: 'proposalSnapshot', stateMutability: 'view', inputs: [{ name: 'proposalId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
	{ type: 'function', name: 'votingDelay', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
	{ type: 'function', name: 'CLOCK_MODE', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
	{ type: 'function', name: 'COUNTING_MODE', stateMutability: 'pure', inputs: [], outputs: [{ name: '', type: 'string' }] },
	{ type: 'function', name: 'execute', stateMutability: 'payable', inputs: [{ name: 'proposalId', type: 'uint256' }], outputs: [] },
	{
		type: 'function',
		name: 'execute',
		stateMutability: 'payable',
		inputs: [{ name: 'targets', type: 'address[]' }, { name: 'values', type: 'uint256[]' }, { name: 'calldatas', type: 'bytes[]' }, { name: 'descriptionHash', type: 'bytes32' }],
		outputs: [{ name: '', type: 'uint256' }],
	},
	{
		type: 'event',
		name: 'ProposalCreated',
		anonymous: false,
		inputs: [
			{ name: 'proposalId', type: 'uint256', indexed: false },
			{ name: 'proposer', type: 'address', indexed: false },
			{ name: 'targets', type: 'address[]', indexed: false },
			{ name: 'values', type: 'uint256[]', indexed: false },
			{ name: 'signatures', type: 'string[]', indexed: false },
			{ name: 'calldatas', type: 'bytes[]', indexed: false },
			{ name: 'voteStart', type: 'uint256', indexed: false },
			{ name: 'voteEnd', type: 'uint256', indexed: false },
			{ name: 'description', type: 'string', indexed: false },
		],
	},
] as const satisfies Abi

// Compound's Timelock, which GovernorAlpha, GovernorBravo and OpenZeppelin's GovernorTimelockCompound execute through.
export const CompoundTimelockAbi = [
	{ type: 'function', name: 'admin', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
	{ type: 'function', name: 'delay', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
	{ type: 'function', name: 'GRACE_PERIOD', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
	{
		type: 'event',
		name: 'ExecuteTransaction',
		anonymous: false,
		inputs: [
			{ name: 'txHash', type: 'bytes32', indexed: true },
			{ name: 'target', type: 'address', indexed: true },
			{ name: 'value', type: 'uint256', indexed: false },
			{ name: 'signature', type: 'string', indexed: false },
			{ name: 'data', type: 'bytes', indexed: false },
			{ name: 'eta', type: 'uint256', indexed: false },
		],
	},
] as const satisfies Abi

// contracts/GovernorProposalForwarder.sol, which the governance preview stands in at a governor's address to queue and execute through its Compound Timelock in one transaction each.
export const GovernorProposalForwarderAbi = [
	{
		type: 'function',
		name: 'queueProposalActions',
		stateMutability: 'nonpayable',
		inputs: [{ name: 'timelock', type: 'address' }, { name: 'targets', type: 'address[]' }, { name: 'values', type: 'uint256[]' }, { name: 'signatures', type: 'string[]' }, { name: 'calldatas', type: 'bytes[]' }, { name: 'eta', type: 'uint256' }],
		outputs: [],
	},
	{
		type: 'function',
		name: 'executeProposalActions',
		stateMutability: 'nonpayable',
		inputs: [{ name: 'timelock', type: 'address' }, { name: 'targets', type: 'address[]' }, { name: 'values', type: 'uint256[]' }, { name: 'signatures', type: 'string[]' }, { name: 'calldatas', type: 'bytes[]' }, { name: 'eta', type: 'uint256' }, { name: 'forwardValues', type: 'bool' }],
		outputs: [],
	},
] as const satisfies Abi

// OpenZeppelin's TimelockController, which OpenZeppelin's GovernorTimelockControl executes through.
export const TimelockControllerAbi = [
	{ type: 'function', name: 'getMinDelay', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
	{ type: 'function', name: 'hasRole', stateMutability: 'view', inputs: [{ name: 'role', type: 'bytes32' }, { name: 'account', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
	{
		type: 'function',
		name: 'scheduleBatch',
		stateMutability: 'nonpayable',
		inputs: [{ name: 'targets', type: 'address[]' }, { name: 'values', type: 'uint256[]' }, { name: 'payloads', type: 'bytes[]' }, { name: 'predecessor', type: 'bytes32' }, { name: 'salt', type: 'bytes32' }, { name: 'delay', type: 'uint256' }],
		outputs: [],
	},
	{
		type: 'function',
		name: 'executeBatch',
		stateMutability: 'payable',
		inputs: [{ name: 'targets', type: 'address[]' }, { name: 'values', type: 'uint256[]' }, { name: 'payloads', type: 'bytes[]' }, { name: 'predecessor', type: 'bytes32' }, { name: 'salt', type: 'bytes32' }],
		outputs: [],
	},
	{
		type: 'event',
		name: 'CallExecuted',
		anonymous: false,
		inputs: [
			{ name: 'id', type: 'bytes32', indexed: true },
			{ name: 'index', type: 'uint256', indexed: true },
			{ name: 'target', type: 'address', indexed: false },
			{ name: 'value', type: 'uint256', indexed: false },
			{ name: 'data', type: 'bytes', indexed: false },
		],
	},
] as const satisfies Abi

export const getAbi = (entry: AddressBookEntry): AbiLike | undefined => {
	if (entry?.address === ETHEREUM_LOGS_LOGGER_ADDRESS) return Erc20ABI
	if (entry === undefined) return undefined
	if ('abi' in entry && entry.abi !== undefined) return entry.abi
	if (entry.type === 'ERC1155') return Erc1155ABI
	if (entry.type === 'ERC20') return Erc20ABI
	if (entry.type === 'ERC721') return Erc721ABI
	return undefined
}
