import type { IEthereumClientService } from './services/EthereumClientService.js'
import type { EthereumAddress } from '../types/wire-types.js'
import type { StateOverrides } from '../types/ethSimulate-types.js'
import type { Erc1155StorageOrder } from '../types/richMode.js'
import { Erc1155ABI, Erc20ABI } from '../utils/abi.js'
import { decodeFunctionOutputSafely, encodeFunctionCall } from '../utils/abiRuntime.js'
import { addressString, bytes32String, stringToUint8Array } from '../utils/bigint.js'
import { getErc20BalanceStorageKey, getErc1155BalanceStorageKey } from '../utils/richTokens.js'

const STORAGE_DISCOVERY_OWNER = 0x000000000000000000000000000000000000deadn
const STORAGE_DISCOVERY_SLOT_LIMIT = 64
const FIRST_STORAGE_DISCOVERY_VALUE = 0x123456789abcdefn
const SECOND_STORAGE_DISCOVERY_VALUE = 0xfedcba987654321n
const STORAGE_DISCOVERY_GAS_LIMIT = 500_000n
type RichTokenEthereumClient = Pick<IEthereumClientService, 'ethSimulateV1'>

const getErc20BalanceOfCall = (tokenAddress: EthereumAddress, owner: EthereumAddress) => ({
	to: tokenAddress,
	input: stringToUint8Array(encodeFunctionCall(Erc20ABI, 'balanceOf', [addressString(owner)])),
	gas: STORAGE_DISCOVERY_GAS_LIMIT,
})

const getErc1155BalanceOfCall = (tokenAddress: EthereumAddress, owner: EthereumAddress, tokenId: bigint) => ({
	to: tokenAddress,
	input: stringToUint8Array(encodeFunctionCall(Erc1155ABI, 'balanceOf', [addressString(owner), tokenId])),
	gas: STORAGE_DISCOVERY_GAS_LIMIT,
})

const getBalanceOverride = (tokenAddress: EthereumAddress, storageKey: bigint, amount: bigint): StateOverrides => ({
	[addressString(tokenAddress)]: {
		stateDiff: {
			[bytes32String(storageKey)]: amount,
		},
	},
})

const decodeBalanceOfResult = (abi: typeof Erc20ABI | typeof Erc1155ABI, result: { status: 'success' | 'failure', returnData: Uint8Array }) => {
	if (result.status === 'failure') return undefined
	return decodeFunctionOutputSafely(abi, 'balanceOf', result.returnData, (value): value is bigint => typeof value === 'bigint')
}

export async function verifyErc20BalanceStorageSlot(
	ethereum: RichTokenEthereumClient,
	requestAbortController: AbortController | undefined,
	tokenAddress: EthereumAddress,
	balanceSlot: bigint,
	amount = SECOND_STORAGE_DISCOVERY_VALUE,
) {
	const result = await ethereum.ethSimulateV1([{
		calls: [getErc20BalanceOfCall(tokenAddress, STORAGE_DISCOVERY_OWNER)],
		stateOverrides: getBalanceOverride(tokenAddress, getErc20BalanceStorageKey(STORAGE_DISCOVERY_OWNER, balanceSlot), amount),
	}], 'latest', requestAbortController)
	const call = result[0]?.calls[0]
	return call !== undefined && decodeBalanceOfResult(Erc20ABI, call) === amount
}

export async function discoverErc20BalanceStorageSlot(
	ethereum: RichTokenEthereumClient,
	requestAbortController: AbortController | undefined,
	tokenAddress: EthereumAddress,
) {
	const candidates = Array.from({ length: STORAGE_DISCOVERY_SLOT_LIMIT }, (_, index) => BigInt(index))
	const result = await ethereum.ethSimulateV1(candidates.map((balanceSlot) => ({
		calls: [getErc20BalanceOfCall(tokenAddress, STORAGE_DISCOVERY_OWNER)],
		stateOverrides: getBalanceOverride(tokenAddress, getErc20BalanceStorageKey(STORAGE_DISCOVERY_OWNER, balanceSlot), FIRST_STORAGE_DISCOVERY_VALUE),
	})), 'latest', requestAbortController)
	const discoveredIndex = result.findIndex((block) => {
		const call = block.calls[0]
		return call !== undefined && decodeBalanceOfResult(Erc20ABI, call) === FIRST_STORAGE_DISCOVERY_VALUE
	})
	const balanceSlot = candidates[discoveredIndex]
	if (balanceSlot === undefined) return undefined
	return await verifyErc20BalanceStorageSlot(ethereum, requestAbortController, tokenAddress, balanceSlot)
		? balanceSlot
		: undefined
}

export async function verifyErc1155BalanceStorageSlot(
	ethereum: RichTokenEthereumClient,
	requestAbortController: AbortController | undefined,
	tokenAddress: EthereumAddress,
	tokenId: bigint,
	balanceSlot: bigint,
	storageOrder: Erc1155StorageOrder,
	amount = SECOND_STORAGE_DISCOVERY_VALUE,
) {
	const result = await ethereum.ethSimulateV1([{
		calls: [getErc1155BalanceOfCall(tokenAddress, STORAGE_DISCOVERY_OWNER, tokenId)],
		stateOverrides: getBalanceOverride(tokenAddress, getErc1155BalanceStorageKey(STORAGE_DISCOVERY_OWNER, tokenId, balanceSlot, storageOrder), amount),
	}], 'latest', requestAbortController)
	const call = result[0]?.calls[0]
	return call !== undefined && decodeBalanceOfResult(Erc1155ABI, call) === amount
}

export async function discoverErc1155BalanceStorage(
	ethereum: RichTokenEthereumClient,
	requestAbortController: AbortController | undefined,
	tokenAddress: EthereumAddress,
	tokenId: bigint,
) {
	const candidates = Array.from({ length: STORAGE_DISCOVERY_SLOT_LIMIT }, (_, index) => BigInt(index))
		.flatMap((balanceSlot) => (['TokenIdThenOwner', 'OwnerThenTokenId'] as const).map((storageOrder) => ({ balanceSlot, storageOrder })))
	const result = await ethereum.ethSimulateV1(candidates.map(({ balanceSlot, storageOrder }) => ({
		calls: [getErc1155BalanceOfCall(tokenAddress, STORAGE_DISCOVERY_OWNER, tokenId)],
		stateOverrides: getBalanceOverride(tokenAddress, getErc1155BalanceStorageKey(STORAGE_DISCOVERY_OWNER, tokenId, balanceSlot, storageOrder), FIRST_STORAGE_DISCOVERY_VALUE),
	})), 'latest', requestAbortController)
	const discoveredIndex = result.findIndex((block) => {
		const call = block.calls[0]
		return call !== undefined && decodeBalanceOfResult(Erc1155ABI, call) === FIRST_STORAGE_DISCOVERY_VALUE
	})
	const discovered = candidates[discoveredIndex]
	if (discovered === undefined) return undefined
	return await verifyErc1155BalanceStorageSlot(ethereum, requestAbortController, tokenAddress, tokenId, discovered.balanceSlot, discovered.storageOrder)
		? discovered
		: undefined
}
