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

export const CompoundGovernanceAbi = [
	{
		type: 'function',
		name: 'timelock',
		stateMutability: 'view',
		inputs: [],
		outputs: [{ type: 'address' }],
	},
	{
		type: 'function',
		name: 'getActions',
		stateMutability: 'view',
		inputs: [{ name: 'id', type: 'uint256' }],
		outputs: [
			{ name: 'targets', type: 'address[]' },
			{ name: 'values', type: 'uint256[]' },
			{ name: 'signatures', type: 'string[]' },
			{ name: 'calldatas', type: 'bytes[]' },
		],
	},
	{
		type: 'function',
		name: 'submitVote',
		stateMutability: 'nonpayable',
		inputs: [{ name: 'proposalId', type: 'uint256' }, { name: 'support', type: 'bool' }],
		outputs: [],
	},
	{
		type: 'function',
		name: 'castVote',
		stateMutability: 'nonpayable',
		inputs: [{ name: 'proposalId', type: 'uint256' }, { name: 'support', type: 'uint8' }],
		outputs: [],
	},
	{
		type: 'function',
		name: 'castVoteWithReason',
		stateMutability: 'nonpayable',
		inputs: [
			{ name: 'proposalId', type: 'uint256' },
			{ name: 'support', type: 'uint8' },
			{ name: 'reason', type: 'string' },
		],
		outputs: [{ name: 'balance', type: 'uint256' }],
	},
	{
		type: 'function',
		name: 'castVoteWithReasonAndParams',
		stateMutability: 'nonpayable',
		inputs: [
			{ name: 'proposalId', type: 'uint256' },
			{ name: 'support', type: 'uint8' },
			{ name: 'reason', type: 'string' },
			{ name: 'params', type: 'bytes' },
		],
		outputs: [{ name: 'balance', type: 'uint256' }],
	},
	{
		type: 'function',
		name: 'castVoteBySig',
		stateMutability: 'nonpayable',
		inputs: [
			{ name: 'proposalId', type: 'uint256' },
			{ name: 'support', type: 'uint8' },
			{ name: 'voter', type: 'address' },
			{ name: 'signature', type: 'bytes' },
		],
		outputs: [{ name: 'balance', type: 'uint256' }],
	},
	{
		type: 'function',
		name: 'castVoteWithReasonAndParamsBySig',
		stateMutability: 'nonpayable',
		inputs: [
			{ name: 'proposalId', type: 'uint256' },
			{ name: 'support', type: 'uint8' },
			{ name: 'voter', type: 'address' },
			{ name: 'reason', type: 'string' },
			{ name: 'params', type: 'bytes' },
			{ name: 'signature', type: 'bytes' },
		],
		outputs: [{ name: 'balance', type: 'int256' }],
	},
] as const satisfies Abi

export const CompoundTimeLock = [
	{
		type: 'function',
		name: 'executeTransactions',
		stateMutability: 'payable',
		inputs: [
			{ name: 'targets', type: 'address[]' },
			{ name: 'values', type: 'uint256[]' },
			{ name: 'signatures', type: 'string[]' },
			{ name: 'datas', type: 'bytes[]' },
			{ name: 'eta', type: 'uint256' },
		],
		outputs: [],
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

function getStringBetweenParentheses(inputString: string): string | undefined {
	const regex = /\((.*?)\)/
	const match = inputString.match(regex)
	if (match === null) return undefined
	return match[1]
}

export const extractFunctionArgumentTypes = (signature: string) => {
	const args = getStringBetweenParentheses(signature)
	return args === undefined || args.length === 0 ? [] : args.split(',')
}

export const removeTextBetweenBrackets = (inputString: string) => inputString.replace(/\[.*?\]/g, '')
