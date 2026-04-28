import * as assert from 'assert'
import { describe, run, runIfRoot, should } from '../micro-should.js'
import { summarizeLogs, summarizeLogsForAddress, SummaryOutcome } from '../../app/ts/simulation/services/LogSummarizer.js'
import { AddressBookEntry, Erc1155Entry, Erc20TokenEntry, Erc721Entry } from '../../app/ts/types/addressBookTypes.js'
import { TokenEvent, TokenVisualizerResultWithMetadata } from '../../app/ts/types/EnrichedEthereumData.js'
import { NamedTokenId, SimulatedAndVisualizedTransaction, TokenPriceEstimate } from '../../app/ts/types/visualizer-types.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS } from '../../app/ts/utils/constants.js'
import { addressString } from '../../app/ts/utils/bigint.js'

const emptyTokenPriceEstimates: readonly TokenPriceEstimate[] = []
const emptyNamedTokenIds: readonly NamedTokenId[] = []

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

function createTokenEvent(logInformation: TokenVisualizerResultWithMetadata): TokenEvent {
	return {
		type: 'TokenEvent',
		logInformation,
	} as unknown as TokenEvent
}

function createSimulatedTransaction(params: { transactionFrom: AddressBookEntry, tokenEvents: readonly TokenVisualizerResultWithMetadata[], gasSpent?: bigint, realizedGasPrice?: bigint }): SimulatedAndVisualizedTransaction {
	return {
		events: params.tokenEvents.map(createTokenEvent),
		gasSpent: params.gasSpent ?? 0n,
		realizedGasPrice: params.realizedGasPrice ?? 0n,
		transaction: {
			from: params.transactionFrom,
		},
	} as unknown as SimulatedAndVisualizedTransaction
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

async function main() {
	describe('summarizeLogs', () => {
		should('summarizes ERC20 transfers and sender gas fees', () => {
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

		should('surfaces ERC20 approvals with approved address metadata', () => {
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

		should('clears ERC721 token approvals when the token is transferred', () => {
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

		should('prunes addresses after ERC1155 balance changes net to zero', () => {
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

		should('surfaces NFT operator approvals and revocations', () => {
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

		should('matches direct address summaries with the corresponding full summary entry', () => {
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

		should('returns undefined for addresses without changes', () => {
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
}

await runIfRoot(async () => {
	await main()
	await run()
}, import.meta)
