import { get4Byte, get4ByteString } from '../../utils/calldata.js'
import { BURN_ADDRESSES, FourByteExplanations } from '../../utils/constants.js'
import { assertNever, createGuard } from '../../utils/typescript.js'
import { type MaybeSimulatedTransaction, type SimulatedAndVisualizedTransaction, SimulatedAndVisualizedTransactionBase, TransactionWithAddressBookEntries } from '../../types/visualizer-types.js'
import { getSwapName, identifySwap } from './SwapTransactions.js'
import * as funtypes from 'funtypes'
import { AddressBookEntry } from '../../types/addressBookTypes.js'
import { CompoundGovernanceAbi } from '../../utils/abi.js'
import { addressString, dataStringWith0xStart } from '../../utils/bigint.js'
import { parseVoteInputParameters } from '../../simulation/compoundGovernanceFaking.js'
import type { GovernanceVoteInputParameters } from '../../types/interceptor-messages.js'
import { findDeadEnds } from '../../utils/findDeadEnds.js'
import type { EthereumAddress, EthereumQuantity } from '../../types/wire-types.js'
import { extractTokenEvents } from '../../background/metadataUtils.js'
import { deduplicateByFunction } from '../../utils/array.js'
import { decodeCallDataLoose } from '../../utils/abiRuntime.js'
import { TokenVisualizerResultWithMetadata } from '../../types/EnrichedEthereumData.js'

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

type ProxyTokenTransferAnalysis = {
	sourceTransfer: TokenVisualizerResultWithMetadata
	transferRoute: readonly AddressBookEntry[]
	transferedFrom: EntryAmount
	transferedTo: readonly EntryAmount[]
	hasTransferFee: boolean
}

const PROXY_TRANSFER_MINIMUM_FORWARDED_NUMERATOR = 95n
const PROXY_TRANSFER_MINIMUM_FORWARDED_DENOMINATOR = 100n

const getTokenTransferAmount = (tokenResult: TokenVisualizerResultWithMetadata) => tokenResult.isApproval || tokenResult.type === 'ERC721' ? 1n : tokenResult.amount

const getTokenId = (tokenResult: TokenVisualizerResultWithMetadata) => 'tokenId' in tokenResult ? tokenResult.tokenId : undefined

const isContractLikeAddressBookEntry = (entry: AddressBookEntry) => (
	entry.type === 'contract'
	|| entry.type === 'ERC20'
	|| entry.type === 'ERC721'
	|| entry.type === 'ERC1155'
)

const isEnoughForwardedForProxyPayment = (forwardedAmount: bigint, sentAmount: bigint) => (
	sentAmount > 0n
	&& forwardedAmount <= sentAmount
	&& forwardedAmount * PROXY_TRANSFER_MINIMUM_FORWARDED_DENOMINATOR >= sentAmount * PROXY_TRANSFER_MINIMUM_FORWARDED_NUMERATOR
)

const getNetSums = (edges: readonly { from: EthereumAddress, to: EthereumAddress,  amount: EthereumQuantity }[]) => {
	const netSums = new Map<bigint, bigint>()
	for (const edge of edges) {
		netSums.set(edge.from, (netSums.get(edge.from) || 0n) - edge.amount)
		netSums.set(edge.to, (netSums.get(edge.to) || 0n) + edge.amount)
	}
	return netSums
}

function analyzeProxyTokenTransfer(transaction: SimulatedAndVisualizedTransaction): ProxyTokenTransferAnalysis | undefined {
	if (transaction.transaction.to === undefined) return undefined
	const tokenResults = extractTokenEvents(transaction.events)
	// no ENS logs allowed in proxy token transfer
	if (transaction.events.some((x) => x.type === 'ENS')) return undefined
	// there need to be atleast two token logs (otherwise its a simple send)
	if (tokenResults.length < 2) return undefined

	// no burning allowed
	if (tokenResults.some((result) => BURN_ADDRESSES.includes(result.to.address))) return undefined
	if (tokenResults.some((result) => BURN_ADDRESSES.includes(result.from.address))) return undefined

	// no approvals allowed
	if (tokenResults.filter((result) => result.isApproval).length !== 0) return undefined
	// sender has only one token leaving by logs (gas fees are not in logs)
	const senderLogs = tokenResults.filter((result) => result.from.address === transaction.transaction.from.address)
	const senderLog = senderLogs[0]
	if (senderLogs.length !== 1 || senderLog === undefined) return undefined
	if (!isContractLikeAddressBookEntry(senderLog.to)) return undefined
	// sender does not receive any tokens
	if (tokenResults.filter((result) => result.to.address === transaction.transaction.from.address).length !== 0) return undefined
	// only one token of specific address is being transacted in the logs
	if (tokenResults.filter((result) => result.token.address !== senderLog.token.address).length !== 0) return undefined
	// only one token id (or undefined) is mentioned inte the logs
	if (new Set(tokenResults.map((result) => getTokenId(result))).size !== 1) return undefined
	// can find a path
	const edges = tokenResults.map((tokenResult) => ({ from: tokenResult.from.address, to: tokenResult.to.address, data: tokenResult.to, amount: getTokenTransferAmount(tokenResult) }))
	const deadEnds = findDeadEnds(edges, transaction.transaction.from.address)
	if (deadEnds.size === 0) return undefined
	const netSums = getNetSums(edges)
	const sentAmount = -(netSums.get(transaction.transaction.from.address) || 0n)
	if (sentAmount <= 0n) return undefined
	const positiveDeadEnds = Array.from(deadEnds)
		.map(([address, path]) => ({ address, path, amount: netSums.get(address) || 0n }))
		.filter((deadEnd) => deadEnd.amount > 0n)
	if (positiveDeadEnds.length === 0) return undefined
	const nonDuplicatedPath = positiveDeadEnds.flatMap(({ path }) => path.slice(0, -1))
	if (nonDuplicatedPath.length === 0) return undefined
	const forwardedAmount = positiveDeadEnds.reduce((prev, current) => prev + current.amount, 0n)
	if (!isEnoughForwardedForProxyPayment(forwardedAmount, sentAmount)) return undefined
	const transferRoute = deduplicateByFunction(positiveDeadEnds.flatMap(({ path }) => path.slice(0, -1).map((edge) => edge.data)), (entry: AddressBookEntry) => addressString(entry.address))
	if (transferRoute === undefined) throw new Error('no path found')
	const transferedTo = positiveDeadEnds.map((deadEnd) => {
		const destinationEntry = deadEnd.path[deadEnd.path.length - 1]
		if (destinationEntry === undefined) throw new Error('path was missing')
		return { entry: destinationEntry.data, amountDelta: deadEnd.amount }
	})
	return {
		sourceTransfer: senderLog,
		transferRoute,
		transferedFrom: { entry: senderLog.from, amountDelta: sentAmount },
		transferedTo,
		hasTransferFee: forwardedAmount !== sentAmount,
	}
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

		const proxyTokenTransfer = analyzeProxyTokenTransfer(simTx)
		if (proxyTokenTransfer !== undefined) {
			const transactionTo = simTx.transaction.to
			if (transactionTo === undefined) throw new Error('proxy transfer transaction destination missing')
			const tokenResult = proxyTokenTransfer.sourceTransfer
			if (tokenResult === undefined) throw new Error('token result were undefined')
			const symbol = tokenResult.token.symbol
			const feeText = proxyTokenTransfer.hasTransferFee ? ' with fee' : ''
			const texts = proxyTokenTransfer.transferedTo.length > 1 ? {
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
					transferedFrom: proxyTokenTransfer.transferedFrom,
					transferedTo: proxyTokenTransfer.transferedTo,
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
