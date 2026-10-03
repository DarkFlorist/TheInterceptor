import { get4Byte, get4ByteString } from '../../utils/calldata.js'
import { BURN_ADDRESSES, FourByteExplanations } from '../../utils/constants.js'
import { assertNever, createGuard } from '../../utils/typescript.js'
import { type MaybeSimulatedTransaction, type SimulatedAndVisualizedTransaction, SimulatedAndVisualizedTransactionBase, TransactionWithAddressBookEntries } from '../../types/visualizer-types.js'
import { getSwapName, identifySwap } from './SwapTransactions.js'
import * as funtypes from 'funtypes'
import { AddressBookEntry } from '../../types/addressBookTypes.js'
import { CompoundGovernanceAbi } from '../../utils/abi.js'
import { dataStringWith0xStart } from '../../utils/bigint.js'
import { parseVoteInputParameters } from '../../simulation/compoundGovernanceFaking.js'
import type { GovernanceVoteInputParameters } from '../../types/interceptor-messages.js'
import { extractTokenEvents } from '../../background/metadataUtils.js'
import { decodeCallDataLoose } from '../../utils/abiRuntime.js'
import { TokenVisualizerResultWithMetadata } from '../../types/EnrichedEthereumData.js'
import { analyzeProxyTokenTransfer } from '../../simulation/proxyTokenTransfer.js'

type IdentifiedTransactionBase = {
	title: string
	signingAction: string
	simulationAction: string
	rejectAction: string
}

type IdentifiedTransaction =
	IdentifiedTransactionBase & { type: 'SimpleTokenApproval', identifiedTransaction: SimulatedAndVisualizedSimpleApprovalTransaction }
	| IdentifiedTransactionBase & { type: 'SimpleTokenTransfer', identifiedTransaction: SimulatedAndVisualizedSimpleTokenTransferTransaction }
	| IdentifiedTransactionBase & { type: 'ProxyTokenTransfer', identifiedTransaction: SimulatedAndVisualizedProxyTokenTransferTransaction }
	| IdentifiedTransactionBase & { type: 'Swap' }
	| IdentifiedTransactionBase & { type: 'ContractFallbackMethod' }
	| IdentifiedTransactionBase & { type: 'ArbitraryContractExecution' }
	| IdentifiedTransactionBase & { type: 'ContractDeployment' }
	| IdentifiedTransactionBase & { type: 'GovernanceVote', governanceVoteInputParameters: GovernanceVoteInputParameters }

function identifySimpleApproval(simTx: SimulatedAndVisualizedTransaction) {
	if (getSimpleTokenApprovalOrUndefined(simTx)) {
		const tokenResults = extractTokenEvents(simTx.events)
		const tokenResult = tokenResults[0]
		if (tokenResult === undefined) throw new Error('token result were undefined')
		const symbol = tokenResult.token.symbol
		switch (tokenResult.type) {
			case 'ERC20': return {
				type: 'SimpleTokenApproval' as const,
				title: `${ symbol } Approval`,
				signingAction: `Approve ${ symbol }`,
				simulationAction: `Simulate ${ symbol } Approval`,
				rejectAction: `Reject ${ symbol } Approval`,
				identifiedTransaction: simTx,
			}
			case 'NFT All approval': {
				if (tokenResult.allApprovalAdded) {
					return {
						type: 'SimpleTokenApproval' as const,
						title: `${ symbol } ALL Approval`,
						signingAction: `Approve ALL ${ symbol }`,
						simulationAction: `Simulate ${ symbol } ALL Approval`,
						rejectAction: `Reject ${ symbol } ALL Approval`,
						identifiedTransaction: simTx,
					}
				}
				return {
					type: 'SimpleTokenApproval' as const,
					title: `Remove ${ symbol } All Approval`,
					signingAction: `Remove ALL Approval Removal for ${ symbol }`,
					simulationAction: `Simulate Removal of All Approval for ${ symbol }`,
					rejectAction: 'Reject All Approval Removal',
					identifiedTransaction: simTx,
				}
			}
			case 'ERC721': return {
				type: 'SimpleTokenApproval' as const,
				title: `#${ tokenResult.tokenId } ${ symbol } Approval`,
				signingAction: `Approve #${ tokenResult.tokenId } ${ symbol }`,
				simulationAction: `Simulate #${ tokenResult.tokenId } ${ symbol } Approval`,
				rejectAction: `Reject #${ tokenResult.tokenId } ${ symbol } Approval`,
				identifiedTransaction: simTx,
			}
			case 'ERC1155': return {
				type: 'SimpleTokenApproval' as const,
				title: `#${ tokenResult.tokenId } ${ symbol } Approval`,
				signingAction: `Approve #${ tokenResult.tokenId } ${ symbol }`,
				simulationAction: `Simulate #${ tokenResult.tokenId } ${ symbol } Approval`,
				rejectAction: `Reject #${ tokenResult.tokenId } ${ symbol } Approval`,
				identifiedTransaction: simTx,
			}
			default: assertNever(tokenResult)
		}
	}
	return undefined
}

function identifyGovernanceVote(simTx: SimulatedAndVisualizedTransaction) {
	const fourByte = get4Byte(simTx.transaction.input)
	if (fourByte === undefined) return undefined
	const explanation = FourByteExplanations[fourByte]
	if (explanation !== 'Cast Vote'
		&& explanation !== 'Submit Vote'
		&& explanation !== 'Cast Vote by Signature'
		&& explanation !== 'Cast Vote with Reason'
		&& explanation !== 'Cast Vote with Reason and Additional Info'
		&& explanation !== 'Cast Vote with Reason And Additional Info by Signature'
	) return undefined
	const fourByteString = get4ByteString(simTx.transaction.input)
	if (fourByteString === undefined) return undefined
	try {
		const functionData = decodeCallDataLoose(CompoundGovernanceAbi, dataStringWith0xStart(simTx.transaction.input))
		if (functionData === undefined) return undefined
		return {
			type: 'GovernanceVote' as const,
			title: 'Governance Vote',
			signingAction: 'Cast Vote',
			simulationAction: 'Simulate Vote Casting',
			rejectAction: `Don't Vote`,
			governanceVoteInputParameters: parseVoteInputParameters(functionData.namedArgs),
		}
	} catch(e) {
		console.warn('malformed vote cast')
		console.warn(e)
		return undefined
	}
}

type SimulatedAndVisualizedSimpleApprovalTransaction = funtypes.Static<typeof SimulatedAndVisualizedSimpleApprovalTransaction>
const SimulatedAndVisualizedSimpleApprovalTransaction = funtypes.Intersect(
	SimulatedAndVisualizedTransactionBase,
	funtypes.ReadonlyObject({
		transaction: TransactionWithAddressBookEntries
	})
)

function isSimpleTokenApproval(simTx: SimulatedAndVisualizedTransaction): simTx is SimulatedAndVisualizedSimpleApprovalTransaction {
	const tokenResults = extractTokenEvents(simTx.events)
	const tokenResult = tokenResults[0]
	if (tokenResult === undefined) return false
	if (!(simTx.transaction.value === 0n
		&& tokenResults.length === 1
		&& tokenResult.isApproval === true
		&& tokenResult.from.address !== tokenResult.to.address
		&& tokenResult.from === simTx.transaction.from
	)) return false
	return true
}
const getSimpleTokenApprovalOrUndefined = createGuard<SimulatedAndVisualizedTransaction, SimulatedAndVisualizedSimpleApprovalTransaction>((simTx) => isSimpleTokenApproval(simTx) ? simTx : undefined)

export type SimulatedAndVisualizedSimpleTokenTransferTransaction = funtypes.Static<typeof SimulatedAndVisualizedSimpleTokenTransferTransaction>
export const SimulatedAndVisualizedSimpleTokenTransferTransaction = funtypes.Intersect(
	SimulatedAndVisualizedTransactionBase,
	funtypes.ReadonlyObject({
		transaction: funtypes.Intersect(TransactionWithAddressBookEntries, funtypes.ReadonlyObject({ to: AddressBookEntry })),
	})
)

function isSimpleTokenTransfer(transaction: SimulatedAndVisualizedTransaction): transaction is SimulatedAndVisualizedSimpleTokenTransferTransaction {
	const tokenResults = extractTokenEvents(transaction.events)
	const tokenResult = tokenResults[0]
	if (tokenResult === undefined) return false
	if (tokenResults.length === 1
		&& tokenResult.isApproval === false
		&& tokenResult.from.address !== tokenResult.to.address
		&& tokenResult.from.address === transaction.transaction.from.address
		&& !BURN_ADDRESSES.includes(tokenResult.from.address)
		&& !BURN_ADDRESSES.includes(tokenResult.to.address)
	) return true
	return false
}
const getSimpleTokenTransferOrUndefined = createGuard<SimulatedAndVisualizedTransaction, SimulatedAndVisualizedSimpleTokenTransferTransaction>((simTx) => isSimpleTokenTransfer(simTx) ? simTx : undefined)

type EntryAmount = funtypes.Static<typeof EntryAmount>
const EntryAmount = funtypes.ReadonlyObject({ entry: AddressBookEntry, amountDelta: funtypes.BigInt })

export type SimulatedAndVisualizedProxyTokenTransferTransaction = funtypes.Static<typeof SimulatedAndVisualizedProxyTokenTransferTransaction>
export const SimulatedAndVisualizedProxyTokenTransferTransaction = funtypes.Intersect(
	SimulatedAndVisualizedTransactionBase,
	funtypes.ReadonlyObject({
		transaction: funtypes.Intersect(TransactionWithAddressBookEntries, funtypes.ReadonlyObject({ to: AddressBookEntry })),
		sourceTransfer: TokenVisualizerResultWithMetadata,
		transferRoute: funtypes.ReadonlyArray(AddressBookEntry),
		transferedFrom: EntryAmount,
		transferedTo: funtypes.ReadonlyArray(EntryAmount),
	})
)

const getTokenTransferAmount = (tokenResult: TokenVisualizerResultWithMetadata) => tokenResult.isApproval || tokenResult.type === 'ERC721' ? 1n : tokenResult.amount

const getTokenId = (tokenResult: TokenVisualizerResultWithMetadata) => 'tokenId' in tokenResult ? tokenResult.tokenId : undefined

function analyzeVisualizedProxyTokenTransfer(transaction: SimulatedAndVisualizedTransaction) {
	const tokenResults = extractTokenEvents(transaction.events)
	return analyzeProxyTokenTransfer({
		transactionFrom: transaction.transaction.from.address,
		transactionHasDestination: transaction.transaction.to !== undefined,
		hasEnsEvents: transaction.events.some((event) => event.type === 'ENS'),
		tokenTransfers: tokenResults.map((tokenResult) => ({
			source: tokenResult,
			from: tokenResult.from,
			to: tokenResult.to,
			tokenAddress: tokenResult.token.address,
			tokenId: getTokenId(tokenResult),
			amount: getTokenTransferAmount(tokenResult),
			isApproval: tokenResult.isApproval,
		})),
	})
}

export function identifyTransaction(simTx: MaybeSimulatedTransaction): IdentifiedTransaction {
	if (simTx.transactionStatus === 'Transaction Succeeded') {
		const tokenResults = extractTokenEvents(simTx.events)
		const identifiedSwap = identifySwap(simTx)
		if (identifiedSwap) {
			const swapname = getSwapName(identifiedSwap)
			return {
				type: 'Swap',
				title: swapname === undefined ? 'Swap' : swapname,
				signingAction: 'Swap',
				simulationAction: 'Simulate Swap',
				rejectAction: 'Reject Swap',
			}
		}

		if (getSimpleTokenTransferOrUndefined(simTx)) {
			const tokenResult = tokenResults[0]
			if (tokenResult === undefined) throw new Error('token result were undefined')
			const symbol = tokenResult.token.symbol
			return {
				type: 'SimpleTokenTransfer',
				title: `${ symbol } Transfer`,
				signingAction: `Transfer ${ symbol }`,
				simulationAction: `Simulate ${ symbol } Transfer`,
				rejectAction: `Reject ${ symbol } Transfer`,
				identifiedTransaction: simTx,
			}
		}

		const proxyTokenTransfer = analyzeVisualizedProxyTokenTransfer(simTx)
		if (proxyTokenTransfer !== undefined) {
			const transactionTo = simTx.transaction.to
			if (transactionTo === undefined) throw new Error('proxy transfer transaction destination missing')
			const tokenResult = proxyTokenTransfer.sourceTransfer
			if (tokenResult === undefined) throw new Error('token result were undefined')
			const symbol = tokenResult.token.symbol
			const feeText = proxyTokenTransfer.hasTransferFee ? ' with fee' : ''
			const texts = proxyTokenTransfer.transferredTo.length > 1 ? {
				title: `${ symbol } Transfer to many${ feeText } via Proxy`,
				signingAction: `Transfer ${ symbol } to many${ feeText } via Proxy`,
				simulationAction: `Simulate ${ symbol } Transfer to many${ feeText } via Proxy`,
				rejectAction: `Reject ${ symbol } Transfer to many${ feeText } via Proxy`,
			} : {
				title: `${ symbol } Transfer${ feeText } via Proxy`,
				signingAction: `Transfer ${ symbol }${ feeText } via Proxy`,
				simulationAction: `Simulate ${ symbol } Transfer${ feeText } via Proxy`,
				rejectAction: `Reject ${ symbol } Transfer${ feeText } via Proxy`,
			}
			return {
				type: 'ProxyTokenTransfer',
				...texts,
				identifiedTransaction: {
					...simTx,
					transaction: { ...simTx.transaction, to: transactionTo },
					sourceTransfer: proxyTokenTransfer.sourceTransfer,
					transferRoute: proxyTokenTransfer.transferRoute,
					transferedFrom: proxyTokenTransfer.transferredFrom,
					transferedTo: proxyTokenTransfer.transferredTo,
				}
			}
		}

		const simpleApproval = identifySimpleApproval(simTx)
		if (simpleApproval !== undefined) return simpleApproval

		const governanceVote = identifyGovernanceVote(simTx)
		if (governanceVote !== undefined) return governanceVote
	}

	if (simTx.transaction.to === undefined) {
		return {
			type: 'ContractDeployment',
			title: 'Contract Deployment',
			signingAction: 'Deploy Contract',
			simulationAction: 'Simulate Contract Deployment',
			rejectAction: 'Reject Contract Deployment',
		}
	}

	const fourByte = get4Byte(simTx.transaction.input)
	if (fourByte === undefined) return {
		type: 'ArbitraryContractExecution',
		title: 'Contract Fallback Method',
		signingAction: 'Execute Contract',
		simulationAction: 'Simulate Contract Execution',
		rejectAction: 'Reject Contract Execution',
	}

	const explanation = simTx.parsedInputData.type === 'Parsed'
		? simTx.parsedInputData.name
		: FourByteExplanations[fourByte]

	if (explanation === undefined) {
		return {
			type: 'ArbitraryContractExecution',
			title: 'Contract Execution',
			signingAction: 'Execute Contract',
			simulationAction: 'Simulate Contract Execution',
			rejectAction: 'Reject Contract Execution',
		}
	}
	return {
		type: 'ArbitraryContractExecution',
		title: explanation,
		signingAction: `Sign ${ explanation }`,
		simulationAction: `Simulate ${ explanation }`,
		rejectAction: `Reject ${ explanation }`,
	}
}
