import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { summarizeLogs, summarizeLogsForAddress, type SummaryOutcome } from '../../app/ts/simulation/services/LogSummarizer.js'
import type { AddressBookEntry, Erc1155Entry, Erc20TokenEntry, Erc721Entry } from '../../app/ts/types/addressBookTypes.js'
import type { TokenEvent, TokenVisualizerResultWithMetadata } from '../../app/ts/types/EnrichedEthereumData.js'
import type { SafeTx } from '../../app/ts/types/personal-message-definitions.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import type { SafeStackTransaction } from '../../app/ts/types/safeTypes.js'
import type { NamedTokenId, SimulatedAndVisualizedTransaction, TokenPriceEstimate } from '../../app/ts/types/visualizer-types.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS } from '../../app/ts/utils/constants.js'
import { addressString } from '../../app/ts/utils/bigint.js'

const emptyTokenPriceEstimates: readonly TokenPriceEstimate[] = []
const emptyNamedTokenIds: readonly NamedTokenId[] = []
const fixtureCreated = new Date('2024-01-01T00:00:00.000Z')
const rpcNetwork: RpcNetwork = {
	name: 'Ethereum',
	chainId: 1n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
}

function createContactEntry(address: bigint, name: string): AddressBookEntry {
	return {
		type: 'contact',
		address,
		name,
		entrySource: 'User',
	}
}

function createErc20Entry(address: bigint, name: string, symbol: string): Erc20TokenEntry {
	return {
		type: 'ERC20',
		address,
		name,
		symbol,
		decimals: 18n,
		entrySource: 'User',
	}
}

function createErc721Entry(address: bigint, name: string, symbol: string): Erc721Entry {
	return {
		type: 'ERC721',
		address,
		name,
		symbol,
		entrySource: 'User',
	}
}

function createErc1155Entry(address: bigint, name: string, symbol: string): Erc1155Entry {
	return {
		type: 'ERC1155',
		address,
		name,
		symbol,
		decimals: undefined,
		entrySource: 'User',
	}
}

function getTokenEventSignature(logInformation: TokenVisualizerResultWithMetadata) {
	switch (logInformation.type) {
		case 'ERC20':
		case 'ERC721': return logInformation.isApproval ? 'Approval(address,address,uint256)' : 'Transfer(address,address,uint256)'
		case 'ERC1155': return 'TransferSingle(address,address,address,uint256,uint256)'
		case 'NFT All approval': return 'ApprovalForAll(address,address,bool)'
	}
}

// The summarizer only reads logInformation, so the raw log fields stay empty apart from the emitting token.
function createTokenEvent(logInformation: TokenVisualizerResultWithMetadata): TokenEvent {
	const signature = getTokenEventSignature(logInformation)
	return {
		type: 'TokenEvent',
		isParsed: 'Parsed',
		name: signature.slice(0, signature.indexOf('(')),
		signature,
		args: [],
		address: logInformation.token.address,
		loggersAddressBookEntry: logInformation.token,
		data: new Uint8Array(),
		topics: [],
		logInformation,
	}
}

// A Safe transaction whose executor is not reimbursed for gas (gasPrice and refundReceiver are zero).
function createZeroReimbursementSafeTransaction(safeAddress: bigint): SafeStackTransaction {
	const safeTx: SafeTx = {
		types: {
			SafeTx: [
				{ name: 'to', type: 'address' },
				{ name: 'value', type: 'uint256' },
				{ name: 'data', type: 'bytes' },
				{ name: 'operation', type: 'uint8' },
				{ name: 'safeTxGas', type: 'uint256' },
				{ name: 'baseGas', type: 'uint256' },
				{ name: 'gasPrice', type: 'uint256' },
				{ name: 'gasToken', type: 'address' },
				{ name: 'refundReceiver', type: 'address' },
				{ name: 'nonce', type: 'uint256' },
			],
			EIP712Domain: [
				{ name: 'chainId', type: 'uint256' },
				{ name: 'verifyingContract', type: 'address' },
			],
		},
		primaryType: 'SafeTx',
		domain: { chainId: rpcNetwork.chainId, verifyingContract: safeAddress },
		message: {
			to: 0n,
			value: 0n,
			data: new Uint8Array(),
			operation: 0n,
			safeTxGas: 0n,
			baseGas: 0n,
			gasPrice: 0n,
			gasToken: 0n,
			refundReceiver: 0n,
			nonce: 0n,
		},
	}
	return {
		safeTx,
		safeTxHash: 1n,
		created: fixtureCreated,
		websiteOrigin: 'https://example.com',
		transactionIdentifier: 1n,
		signatures: [],
	}
}

function createSimulatedTransaction(params: { transactionFrom: AddressBookEntry, tokenEvents: readonly TokenVisualizerResultWithMetadata[], gasSpent?: bigint, realizedGasPrice?: bigint, safeTransaction?: boolean }): SimulatedAndVisualizedTransaction {
	return {
		website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
		created: fixtureCreated,
		parsedInputData: { type: 'NonParsed', input: new Uint8Array() },
		transactionIdentifier: 1n,
		originalRequestParameters: { method: 'eth_sendTransaction', params: [{ from: params.transactionFrom.address, value: 0n, input: new Uint8Array() }] },
		tokenBalancesAfter: [],
		tokenPriceEstimates: [],
		tokenPriceQuoteToken: undefined,
		quarantine: false,
		quarantineReasons: [],
		transactionStatus: 'Transaction Succeeded',
		events: params.tokenEvents.map(createTokenEvent),
		gasSpent: params.gasSpent ?? 0n,
		realizedGasPrice: params.realizedGasPrice ?? 0n,
		...(params.safeTransaction === true ? { safeTransaction: createZeroReimbursementSafeTransaction(params.transactionFrom.address) } : {}),
		transaction: {
			from: params.transactionFrom,
			to: undefined,
			value: 0n,
			input: new Uint8Array(),
			rpcNetwork,
			hash: 1n,
			gas: 21_000n,
			nonce: 0n,
			type: '1559',
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
		},
	}
}

function createAddressMetadataMap(entries: readonly AddressBookEntry[]) {
	return new Map(entries.map((entry) => [addressString(entry.address), entry] as const))
}

function getSummary(summary: SummaryOutcome[], address: bigint) {
	return summary.find((entry) => entry.summaryFor.address === address)
}

function omitSummaryFor(summary: SummaryOutcome) {
	const { summaryFor, ...rest } = summary
	return rest
}

describe('summarizeLogs', () => {
	test('summarizes ERC20 transfers and sender gas fees', () => {
		const alice = createContactEntry(0x11n, 'Alice')
		const bob = createContactEntry(0x12n, 'Bob')
		const token = createErc20Entry(0x101n, 'Mock Token', 'MOCK')
		const nativeToken = createErc20Entry(ETHEREUM_LOGS_LOGGER_ADDRESS, 'Ether', 'ETH')
		const transaction = createSimulatedTransaction({
			transactionFrom: alice,
			tokenEvents: [{
				logObject: undefined,
				type: 'ERC20',
				from: alice,
				to: bob,
				token,
				amount: 10n,
				isApproval: false,
			}],
			gasSpent: 2n,
			realizedGasPrice: 3n,
		})

		const summary = summarizeLogs([transaction], createAddressMetadataMap([alice, bob, token, nativeToken]), emptyTokenPriceEstimates, emptyNamedTokenIds)
		const aliceSummary = getSummary(summary, alice.address)
		const bobSummary = getSummary(summary, bob.address)

		assert.notEqual(aliceSummary, undefined)
		assert.notEqual(bobSummary, undefined)
		assert.deepEqual(aliceSummary?.erc20TokenBalanceChanges.map(({ address, changeAmount }) => ({ address, changeAmount })), [
			{ address: token.address, changeAmount: -10n },
			{ address: nativeToken.address, changeAmount: -6n },
		])
		assert.deepEqual(bobSummary?.erc20TokenBalanceChanges.map(({ address, changeAmount }) => ({ address, changeAmount })), [
			{ address: token.address, changeAmount: 10n },
		])
	})

	test('does not debit executor gas from an optimistic zero-reimbursement Safe transaction', () => {
		const safe = createContactEntry(0x13n, 'Safe')
		const bob = createContactEntry(0x14n, 'Bob')
		const token = createErc20Entry(0x102n, 'Mock Token', 'MOCK')
		const nativeToken = createErc20Entry(ETHEREUM_LOGS_LOGGER_ADDRESS, 'Ether', 'ETH')
		const transaction = createSimulatedTransaction({
			transactionFrom: safe,
			tokenEvents: [{
				logObject: undefined,
				type: 'ERC20',
				from: safe,
				to: bob,
				token,
				amount: 10n,
				isApproval: false,
			}],
			gasSpent: 2n,
			realizedGasPrice: 3n,
			safeTransaction: true,
		})

		const summary = summarizeLogs([transaction], createAddressMetadataMap([safe, bob, token, nativeToken]), emptyTokenPriceEstimates, emptyNamedTokenIds)
		const safeSummary = getSummary(summary, safe.address)

		assert.deepEqual(safeSummary?.erc20TokenBalanceChanges.map(({ address, changeAmount }) => ({ address, changeAmount })), [
			{ address: token.address, changeAmount: -10n },
		])
	})

	test('surfaces ERC20 approvals with approved address metadata', () => {
		const alice = createContactEntry(0x21n, 'Alice')
		const spender = createContactEntry(0x22n, 'Spender')
		const token = createErc20Entry(0x201n, 'Mock Token', 'MOCK')
		const nativeToken = createErc20Entry(ETHEREUM_LOGS_LOGGER_ADDRESS, 'Ether', 'ETH')
		const transaction = createSimulatedTransaction({
			transactionFrom: alice,
			tokenEvents: [{
				logObject: undefined,
				type: 'ERC20',
				from: alice,
				to: spender,
				token,
				amount: 123n,
				isApproval: true,
			}],
		})

		const summary = summarizeLogs([transaction], createAddressMetadataMap([alice, spender, token, nativeToken]), emptyTokenPriceEstimates, emptyNamedTokenIds)
		const aliceSummary = getSummary(summary, alice.address)

		assert.notEqual(aliceSummary, undefined)
		assert.deepEqual(aliceSummary?.erc20TokenApprovalChanges.map((approvalChange) => ({
			tokenAddress: approvalChange.address,
			approvals: approvalChange.approvals.map(({ address, change }) => ({ address, change })),
		})), [
			{
				tokenAddress: token.address,
				approvals: [{ address: spender.address, change: 123n }],
			}
		])
	})

	test('clears ERC721 token approvals when the token is transferred', () => {
		const alice = createContactEntry(0x31n, 'Alice')
		const bob = createContactEntry(0x32n, 'Bob')
		const spender = createContactEntry(0x33n, 'Spender')
		const nft = createErc721Entry(0x301n, 'Collectible', 'NFT')
		const nativeToken = createErc20Entry(ETHEREUM_LOGS_LOGGER_ADDRESS, 'Ether', 'ETH')
		const transaction = createSimulatedTransaction({
			transactionFrom: alice,
			tokenEvents: [
				{
					logObject: undefined,
					type: 'ERC721',
					from: alice,
					to: spender,
					token: nft,
					tokenId: 1n,
					isApproval: true,
				},
				{
					logObject: undefined,
					type: 'ERC721',
					from: alice,
					to: bob,
					token: nft,
					tokenId: 1n,
					isApproval: false,
				},
			],
		})

		const summary = summarizeLogs([transaction], createAddressMetadataMap([alice, bob, spender, nft, nativeToken]), emptyTokenPriceEstimates, emptyNamedTokenIds)
		const aliceSummary = getSummary(summary, alice.address)
		const bobSummary = getSummary(summary, bob.address)

		assert.notEqual(aliceSummary, undefined)
		assert.notEqual(bobSummary, undefined)
		assert.deepEqual(aliceSummary?.erc721TokenIdApprovalChanges, [])
		assert.deepEqual(aliceSummary?.erc721TokenBalanceChanges.map(({ address, tokenId, received }) => ({ address, tokenId, received })), [
			{ address: nft.address, tokenId: 1n, received: false },
		])
		assert.deepEqual(bobSummary?.erc721TokenBalanceChanges.map(({ address, tokenId, received }) => ({ address, tokenId, received })), [
			{ address: nft.address, tokenId: 1n, received: true },
		])
	})

	test('prunes addresses after ERC1155 balance changes net to zero', () => {
		const alice = createContactEntry(0x41n, 'Alice')
		const bob = createContactEntry(0x42n, 'Bob')
		const token = createErc1155Entry(0x401n, 'Game Items', 'ITEM')
		const nativeToken = createErc20Entry(ETHEREUM_LOGS_LOGGER_ADDRESS, 'Ether', 'ETH')
		const firstTransaction = createSimulatedTransaction({
			transactionFrom: alice,
			tokenEvents: [{
				logObject: undefined,
				type: 'ERC1155',
				from: alice,
				to: bob,
				token,
				tokenId: 7n,
				tokenIdName: undefined,
				amount: 5n,
				isApproval: false,
			}],
		})
		const secondTransaction = createSimulatedTransaction({
			transactionFrom: bob,
			tokenEvents: [{
				logObject: undefined,
				type: 'ERC1155',
				from: bob,
				to: alice,
				token,
				tokenId: 7n,
				tokenIdName: undefined,
				amount: 5n,
				isApproval: false,
			}],
		})

		const summary = summarizeLogs([firstTransaction, undefined, secondTransaction], createAddressMetadataMap([alice, bob, token, nativeToken]), emptyTokenPriceEstimates, emptyNamedTokenIds)

		assert.deepEqual(summary, [])
	})

	test('surfaces NFT operator approvals and revocations', () => {
		const alice = createContactEntry(0x51n, 'Alice')
		const operator = createContactEntry(0x52n, 'Operator')
		const nft = createErc721Entry(0x501n, 'Collectible', 'NFT')
		const nativeToken = createErc20Entry(ETHEREUM_LOGS_LOGGER_ADDRESS, 'Ether', 'ETH')
		const addApprovalTransaction = createSimulatedTransaction({
			transactionFrom: alice,
			tokenEvents: [{
				logObject: undefined,
				type: 'NFT All approval',
				from: alice,
				to: operator,
				token: nft,
				allApprovalAdded: true,
				isApproval: true,
			}],
		})
		const revokeApprovalTransaction = createSimulatedTransaction({
			transactionFrom: alice,
			tokenEvents: [{
				logObject: undefined,
				type: 'NFT All approval',
				from: alice,
				to: operator,
				token: nft,
				allApprovalAdded: false,
				isApproval: true,
			}],
		})
		const addressMetadata = createAddressMetadataMap([alice, operator, nft, nativeToken])

		const addSummary = summarizeLogs([addApprovalTransaction], addressMetadata, emptyTokenPriceEstimates, emptyNamedTokenIds)
		const revokeSummary = summarizeLogs([revokeApprovalTransaction], addressMetadata, emptyTokenPriceEstimates, emptyNamedTokenIds)

		assert.deepEqual(getSummary(addSummary, alice.address)?.erc721and1155OperatorChanges.map(({ address, operator: approvedOperator }) => ({
			address,
			operator: approvedOperator?.address,
		})), [
			{ address: nft.address, operator: operator.address },
		])
		assert.deepEqual(getSummary(revokeSummary, alice.address)?.erc721and1155OperatorChanges.map(({ address, operator: approvedOperator }) => ({
			address,
			operator: approvedOperator?.address,
		})), [
			{ address: nft.address, operator: undefined },
		])
	})

	test('matches direct address summaries with the corresponding full summary entry', () => {
		const alice = createContactEntry(0x61n, 'Alice')
		const bob = createContactEntry(0x62n, 'Bob')
		const token = createErc20Entry(0x601n, 'Mock Token', 'MOCK')
		const nativeToken = createErc20Entry(ETHEREUM_LOGS_LOGGER_ADDRESS, 'Ether', 'ETH')
		const transaction = createSimulatedTransaction({
			transactionFrom: alice,
			tokenEvents: [{
				logObject: undefined,
				type: 'ERC20',
				from: alice,
				to: bob,
				token,
				amount: 99n,
				isApproval: false,
			}],
			gasSpent: 1n,
			realizedGasPrice: 2n,
		})
		const addressMetadata = createAddressMetadataMap([alice, bob, token, nativeToken])

		const summary = summarizeLogs([transaction], addressMetadata, emptyTokenPriceEstimates, emptyNamedTokenIds)
		const aliceSummary = getSummary(summary, alice.address)
		const directSummary = summarizeLogsForAddress([transaction], addressString(alice.address), addressMetadata, emptyTokenPriceEstimates, emptyNamedTokenIds)

		assert.notEqual(aliceSummary, undefined)
		assert.deepEqual(directSummary, aliceSummary === undefined ? undefined : omitSummaryFor(aliceSummary))
	})

	test('returns undefined for addresses without changes', () => {
		const alice = createContactEntry(0x71n, 'Alice')
		const bob = createContactEntry(0x72n, 'Bob')
		const carol = createContactEntry(0x73n, 'Carol')
		const token = createErc20Entry(0x701n, 'Mock Token', 'MOCK')
		const nativeToken = createErc20Entry(ETHEREUM_LOGS_LOGGER_ADDRESS, 'Ether', 'ETH')
		const transaction = createSimulatedTransaction({
			transactionFrom: alice,
			tokenEvents: [{
				logObject: undefined,
				type: 'ERC20',
				from: alice,
				to: bob,
				token,
				amount: 1n,
				isApproval: false,
			}],
		})

		const directSummary = summarizeLogsForAddress([transaction], addressString(carol.address), createAddressMetadataMap([alice, bob, carol, token, nativeToken]), emptyTokenPriceEstimates, emptyNamedTokenIds)

		assert.equal(directSummary, undefined)
	})
})
