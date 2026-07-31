import assert from 'node:assert'
import { describe, test } from 'node:test'
import type { IEthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { addRichTokenBalanceOverrides, discoverErc1155BalanceStorage, discoverErc20BalanceStorageSlot, getDefaultRichTokenAmount, getErc1155BalanceStorageKey, getErc20BalanceStorageKey, getRichTokenOptions, MAX_RICH_TOKEN_AMOUNT, parseRichTokenAmountInput, verifyErc1155BalanceStorageSlot, verifyErc20BalanceStorageSlot } from '../../app/ts/utils/richTokens.js'
import { addressString, bigintToUint8Array, bytes32String } from '../../app/ts/utils/bigint.js'

const owner = 0x1111111111111111111111111111111111111111n
const otherOwner = 0x2222222222222222222222222222222222222222n
const tokenAddress = 0x3333333333333333333333333333333333333333n
const erc1155Address = 0x4444444444444444444444444444444444444444n

const successfulBalanceCall = (balance: bigint) => ({
	number: 1n,
	hash: 1n,
	timestamp: 1n,
	gasLimit: 30_000_000n,
	gasUsed: 10_000n,
	baseFeePerGas: 1n,
	calls: [{
		status: 'success' as const,
		returnData: bigintToUint8Array(balance, 32),
		gasUsed: 10_000n,
		logs: [],
	}],
})

describe('rich token support', () => {
	test('offers ERC-20 address book entries without requiring a preset', () => {
		const options = getRichTokenOptions(1n, [], [
			{
				type: 'contact',
				name: 'Not a token',
				address: owner,
				entrySource: 'User',
				chainId: 1n,
			},
			{
				type: 'ERC20',
				name: 'USD Coin',
				address: 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n,
				symbol: 'USDC',
				decimals: 6n,
				entrySource: 'User',
				chainId: 1n,
			},
		])
		assert.deepEqual(options, [{
			chainId: 1n,
			tokenAddress: 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n,
			tokenType: 'ERC20',
			tokenId: undefined,
			name: 'USD Coin',
			symbol: 'USDC',
			decimals: 6n,
			amount: 1_000_000_000_000n,
			balanceSlot: undefined,
			erc1155StorageOrder: undefined,
			enabled: false,
		}])
	})

	test('deep-merges token storage overrides for every rich address', () => {
		const amount = getDefaultRichTokenAmount(18n)
		const overrides = addRichTokenBalanceOverrides({
			[addressString(owner)]: { balance: 123n },
			[addressString(tokenAddress)]: { nonce: 4n },
		}, [owner, otherOwner], [
			{
				chainId: 1n,
				tokenAddress,
				tokenType: 'ERC20',
				tokenId: undefined,
				name: 'Token',
				symbol: 'TKN',
				decimals: 18n,
				amount,
				balanceSlot: 7n,
				erc1155StorageOrder: undefined,
			},
			{
				chainId: 1n,
				tokenAddress: erc1155Address,
				tokenType: 'ERC1155',
				tokenId: 42n,
				name: 'Game Items',
				symbol: 'ITEM',
				decimals: 0n,
				amount: 100n,
				balanceSlot: 5n,
				erc1155StorageOrder: 'TokenIdThenOwner',
			},
		])

		assert.equal(overrides[addressString(owner)]?.balance, 123n)
		assert.equal(overrides[addressString(tokenAddress)]?.nonce, 4n)
		assert.deepEqual(overrides[addressString(tokenAddress)]?.stateDiff, {
			[bytes32String(getErc20BalanceStorageKey(owner, 7n))]: amount,
			[bytes32String(getErc20BalanceStorageKey(otherOwner, 7n))]: amount,
		})
		assert.deepEqual(overrides[addressString(erc1155Address)]?.stateDiff, {
			[bytes32String(getErc1155BalanceStorageKey(owner, 42n, 5n, 'TokenIdThenOwner'))]: 100n,
			[bytes32String(getErc1155BalanceStorageKey(otherOwner, 42n, 5n, 'TokenIdThenOwner'))]: 100n,
		})
	})

	test('offers every watched ERC-1155 token ID from the address book', () => {
		const options = getRichTokenOptions(1n, [], [{
			type: 'ERC1155',
			name: 'Game Items',
			address: tokenAddress,
			symbol: 'ITEM',
			decimals: undefined,
			entrySource: 'User',
			chainId: 1n,
			watchedTokenIds: [7n, 42n],
		}])

		assert.deepEqual(options.map(({ tokenType, tokenId, decimals, amount }) => ({ tokenType, tokenId, decimals, amount })), [
			{ tokenType: 'ERC1155', tokenId: 7n, decimals: 0n, amount: 1_000_000n },
			{ tokenType: 'ERC1155', tokenId: 42n, decimals: 0n, amount: 1_000_000n },
		])
	})

	test('unions ERC-1155 IDs across duplicate entries while keeping precise metadata', () => {
		const configured = {
			chainId: 1n,
			tokenAddress,
			tokenType: 'ERC1155' as const,
			tokenId: 42n,
			name: 'Stored name',
			symbol: 'STORED',
			decimals: 0n,
			amount: 100n,
			balanceSlot: 5n,
			erc1155StorageOrder: 'TokenIdThenOwner' as const,
		}
		const options = getRichTokenOptions(1n, [configured], [
			{
				type: 'ERC1155',
				name: 'Exact Items',
				address: tokenAddress,
				symbol: 'EXACT',
				decimals: undefined,
				entrySource: 'User',
				chainId: 1n,
				watchedTokenIds: [7n],
			},
			{
				type: 'ERC1155',
				name: 'Global Items',
				address: tokenAddress,
				symbol: 'GLOBAL',
				decimals: undefined,
				entrySource: 'User',
				chainId: 'AllChains',
				watchedTokenIds: [42n],
			},
		])

		assert.deepEqual(options.map(({ tokenId, name, symbol, enabled }) => ({ tokenId, name, symbol, enabled })), [
			{ tokenId: 7n, name: 'Exact Items', symbol: 'EXACT', enabled: false },
			{ tokenId: 42n, name: 'Exact Items', symbol: 'EXACT', enabled: true },
		])
	})

	test('caps default amounts and excludes ERC-20 metadata with decimals above uint8', () => {
		assert.equal(getDefaultRichTokenAmount(2n ** 255n), MAX_RICH_TOKEN_AMOUNT)
		assert.deepEqual(getRichTokenOptions(1n, [], [{
			type: 'ERC20',
			name: 'Hostile token',
			address: tokenAddress,
			symbol: 'BAD',
			decimals: 256n,
			entrySource: 'User',
			chainId: 1n,
		}]), [])
	})

	test('validates rich-token amounts without depending on DOM event registration', () => {
		assert.deepEqual(parseRichTokenAmountInput('2.5', 6n), { valid: true, amount: 2_500_000n })
		assert.deepEqual(parseRichTokenAmountInput('0', 6n), { valid: false, reason: 'InvalidAmount' })
		assert.deepEqual(parseRichTokenAmountInput('1.0000001', 6n), { valid: false, reason: 'InvalidAmount' })
		assert.deepEqual(parseRichTokenAmountInput((MAX_RICH_TOKEN_AMOUNT + 1n).toString(), 0n), { valid: false, reason: 'ExceedsUint256' })
	})

	test('finds the first conventional Solidity balance mapping and reverifies it independently', async () => {
		const expectedSlot = 7
		let requestCount = 0
		const ethereum: Pick<IEthereumClientService, 'ethSimulateV1'> = {
			ethSimulateV1: async (blocks) => {
				requestCount += 1
				if (blocks.length === 1) return [successfulBalanceCall(0xfedcba987654321n)]
				return blocks.map((_block, index) => successfulBalanceCall(index >= expectedSlot ? 0x123456789abcdefn : 0n))
			},
		}

		assert.equal(await discoverErc20BalanceStorageSlot(ethereum, undefined, tokenAddress), 7n)
		assert.equal(requestCount, 2)
	})

	test('rejects a configured slot when balanceOf does not reflect its override', async () => {
		const ethereum: Pick<IEthereumClientService, 'ethSimulateV1'> = {
			ethSimulateV1: async () => [successfulBalanceCall(0n)],
		}
		assert.equal(await verifyErc20BalanceStorageSlot(ethereum, undefined, tokenAddress, 7n), false)
	})

	test('finds and verifies an ERC-1155 owner-then-token-id nested balance mapping', async () => {
		const expectedIndex = 11 // slot 5, with OwnerThenTokenId as the second tested order
		let requestCount = 0
		const ethereum: Pick<IEthereumClientService, 'ethSimulateV1'> = {
			ethSimulateV1: async (blocks) => {
				requestCount += 1
				if (blocks.length === 1) return [successfulBalanceCall(0xfedcba987654321n)]
				return blocks.map((_block, index) => successfulBalanceCall(index === expectedIndex ? 0x123456789abcdefn : 0n))
			},
		}

		assert.deepEqual(await discoverErc1155BalanceStorage(ethereum, undefined, tokenAddress, 42n), {
			balanceSlot: 5n,
			storageOrder: 'OwnerThenTokenId',
		})
		assert.equal(requestCount, 2)
		assert.equal(await verifyErc1155BalanceStorageSlot(ethereum, undefined, tokenAddress, 42n, 5n, 'OwnerThenTokenId'), true)
		assert.equal(getErc1155BalanceStorageKey(owner, 42n, 5n, 'OwnerThenTokenId') === getErc1155BalanceStorageKey(owner, 42n, 5n, 'TokenIdThenOwner'), false)
	})
})
