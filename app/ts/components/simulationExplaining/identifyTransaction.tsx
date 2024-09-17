import { get4Byte, get4ByteString } from '../../utils/calldata.js'
import { FourByteExplanations } from '../../utils/constants.js'
import { assertNever, createGuard } from '../../utils/typescript.js'
import { SimulatedAndVisualizedTransaction, SimulatedAndVisualizedTransactionBase, TransactionWithAddressBookEntries } from '../../types/visualizer-types.js'
import { getSwapName, identifySwap } from './SwapTransactions.js'
import * as funtypes from 'funtypes'
import { AddressBookEntry } from '../../types/addressBookTypes.js'
import { Interface } from 'ethers'
import { CompoundGovernanceAbi } from '../../utils/abi.js'
import { dataStringWith0xStart } from '../../utils/bigint.js'
import { parseVoteInputParameters } from '../../simulation/compoundGovernanceFaking.js'
import { GovernanceVoteInputParameters } from '../../types/interceptor-messages.js'
import { UniqueRequestIdentifier } from '../../utils/requests.js'
import { findDeadEnds } from '../../utils/findDeadEnds.js'
import { EthereumAddress, EthereumQuantity } from '../../types/wire-types.js'
import { extractTokenEvents } from '../../background/metadataUtils.js'
import { TokenVisualizerErc1155Event, TokenVisualizerErc20Event, TokenVisualizerErc721Event } from '../../types/EnrichedEthereumData.js'

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
	const governanceContractInterface = new Interface(CompoundGovernanceAbi)
	try {
		const functionFragment = governanceContractInterface.getFunction(fourByteString)
		if (functionFragment === null) return undefined
		const functionData = governanceContractInterface.decodeFunctionData(functionFragment, dataStringWith0xStart(simTx.transaction.input))
		return {
			type: 'GovernanceVote' as const,
			title: 'Governance Vote',
			signingAction: 'Cast Vote',
			simulationAction: 'Simulate Vote Casting',
			rejectAction: `Don't Vote`,
			governanceVoteInputParameters: parseVoteInputParameters(functionData),
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
		uniqueRequestIdentifier: UniqueRequestIdentifier,
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

export type TokenResult = funtypes.Static<typeof TokenResult>
export const TokenResult = funtypes.Intersect(funtypes.Union(TokenVisualizerErc20Event, TokenVisualizerErc721Event, TokenVisualizerErc1155Event), funtypes.ReadonlyObject({ isApproval: funtypes.Literal(false) }))

export type SimulatedAndVisualizedSimpleTokenTransferTransaction = funtypes.Static<typeof SimulatedAndVisualizedSimpleTokenTransferTransaction>
export const SimulatedAndVisualizedSimpleTokenTransferTransaction = funtypes.Intersect(
	SimulatedAndVisualizedTransactionBase,
	funtypes.ReadonlyObject({
		uniqueRequestIdentifier: UniqueRequestIdentifier,
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
		&& tokenResult.from.address === transaction.transaction.from.address) return true
	return false
}
const getSimpleTokenTransferOrUndefined = createGuard<SimulatedAndVisualizedTransaction, SimulatedAndVisualizedSimpleTokenTransferTransaction>((simTx) => isSimpleTokenTransfer(simTx) ? simTx : undefined)

type EntryAmount = funtypes.Static<typeof EntryAmount>
const EntryAmount = funtypes.ReadonlyObject({ entry: AddressBookEntry, amountDelta: funtypes.BigInt })

export type SimulatedAndVisualizedProxyTokenTransferTransaction = funtypes.Static<typeof SimulatedAndVisualizedProxyTokenTransferTransaction>
export const SimulatedAndVisualizedProxyTokenTransferTransaction = funtypes.Intersect(
	SimulatedAndVisualizedTransactionBase,
	funtypes.ReadonlyObject({
		uniqueRequestIdentifier: UniqueRequestIdentifier,
		transaction: funtypes.Intersect(TransactionWithAddressBookEntries, funtypes.ReadonlyObject({ to: AddressBookEntry })),
		transferRoute: funtypes.ReadonlyArray(AddressBookEntry),
		transferedTo: funtypes.ReadonlyArray(EntryAmount),
	})
)

const getNetSums = (edges: readonly { from: EthereumAddress, to: EthereumAddress,  amount: EthereumQuantity }[]) => {
	const netSums = new Map<bigint, bigint>()
	for (const edge of edges) {
		netSums.set(edge.from, (netSums.get(edge.from) || 0n) - edge.amount)
		netSums.set(edge.to, (netSums.get(edge.to) || 0n) + edge.amount)
	}
	return netSums
}

function isProxyTokenTransfer(transaction: SimulatedAndVisualizedTransaction): transaction is SimulatedAndVisualizedProxyTokenTransferTransaction {
	const tokenResults = extractTokenEvents(transaction.events)
	// no ENS logs allowed in proxy token transfer
	if (transaction.events.filter((x) => x.type === 'ENS').length > 0) return false
	// there need to be atleast two token logs (otherwise its a simple send)
	if (tokenResults.length < 2) return false
	// no approvals allowed
	if (tokenResults.filter((result) => result.isApproval).length !== 0) return false
	// sender has only one token leaving by logs (gas fees are not in logs)
	const senderLogs = tokenResults.filter((result) => result.from.address === transaction.transaction.from.address)
	const senderLog = senderLogs[0]
	if (senderLogs.length !== 1 || senderLog === undefined) return false
	// sender does not receive any tokens
	if (tokenResults.filter((result) => result.to.address === transaction.transaction.from.address).length !== 0) return false
	// only one token of specific address is being transacted in the logs
	if (tokenResults.filter((result) => result.token.address !== senderLog.token.address).length !== 0) return false
	// only one token id (or undefined) is mentioned inte the logs
	if (new Set(tokenResults.map((result) => 'tokenId' in result ? result.tokenId : undefined)).size !== 1) return false
	// can find a path
	const edges = tokenResults.map((tokenResult) => ({ from: tokenResult.from.address, to: tokenResult.to.address, data: tokenResult.to, amount: !tokenResult.isApproval && tokenResult.type !== 'ERC721' ? tokenResult.amount : 1n }))
	const deadEnds = findDeadEnds(edges, transaction.transaction.from.address)
	if (deadEnds.size === 0) return false

	// the sum of all currency in dead ends, must equal to the sum sent initially (multiplied by -1)
	const netSums = getNetSums(edges)
	const deadEndSum = Array.from(deadEnds).map((deadEnd) => netSums.get(deadEnd[0]) || 0n).reduce((prev, current) => prev + current, 0n)
	if (netSums.get(transaction.transaction.from.address) !== -deadEndSum) return false
	return true
}
const getProxyTokenTransferOrUndefined = createGuard<SimulatedAndVisualizedTransaction, SimulatedAndVisualizedSimpleTokenTransferTransaction>((simTx) => isProxyTokenTransfer(simTx) ? simTx : undefined)

export function identifyTransaction(simTx: SimulatedAndVisualizedTransaction): IdentifiedTransaction {
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

	if (getProxyTokenTransferOrUndefined(simTx)) {
		const tokenResult = tokenResults[0]
		if (tokenResult === undefined) throw new Error('token result were undefined')
		const symbol = tokenResult.token.symbol
		const edges = tokenResults.map((tokenResult) => ({ from: tokenResult.from.address, to: tokenResult.to.address, data: tokenResult.to, amount: !tokenResult.isApproval && tokenResult.type !== 'ERC721' ? tokenResult.amount : 1n }))
		const deadEnds = findDeadEnds(edges, simTx.transaction.from.address)

		function removeDuplicates(entries: AddressBookEntry[]): AddressBookEntry[] {
			const unique: Map<bigint, AddressBookEntry> = new Map()
			for (const entry of entries) {
				if (unique.has(entry.address)) continue
				unique.set(entry.address, entry)
			}
			return Array.from(unique.values())
		}

		const transferRoute = removeDuplicates(Array.from(deadEnds).flatMap(([_key, edges]) => edges.slice(0, -1).map((edge) => edge.data)))
		const netSums = getNetSums(edges)
		if (transferRoute === undefined) throw new Error('no path found')
		const texts = deadEnds.size > 1 ? {
			title: `${ symbol } Transfer to many via Proxy`,
			signingAction: `Transfer ${ symbol } to many via Proxy`,
			simulationAction: `Simulate ${ symbol } Transfer to many via Proxy`,
			rejectAction: `Reject ${ symbol } Transfer via to many Proxy`,
		} : {
			title: `${ symbol } Transfer via Proxy`,
			signingAction: `Transfer ${ symbol } via Proxy`,
			simulationAction: `Simulate ${ symbol } Transfer via Proxy`,
			rejectAction: `Reject ${ symbol } Transfer via Proxy`,
		}
		return {
			type: 'ProxyTokenTransfer',
			...texts,
			identifiedTransaction: {
				...simTx,
				transferRoute,
				transferedTo: Array.from(netSums).map(([address, amountDelta]) => {
					const deadEnd = deadEnds.get(address)
					if (deadEnd === undefined) return undefined
					const destinationEntry = deadEnd[deadEnd.length - 1]
					if (destinationEntry === undefined) throw new Error('path was missing')
					return { entry: destinationEntry.data, amountDelta }
				}).filter((x): x is EntryAmount => x !== undefined && x.amountDelta !== 0n)
			}
		}
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

	const simpleApproval = identifySimpleApproval(simTx)
	if (simpleApproval !== undefined) return simpleApproval

	const governanceVote = identifyGovernanceVote(simTx)
	if (governanceVote !== undefined) return governanceVote

	const fourByte = get4Byte(simTx.transaction.input)
	if (fourByte === undefined) return {
		type: 'ArbitraryContractExecution',
		title: 'Contract Fallback Method',
		signingAction: 'Execute Contract',
		simulationAction: 'Simulate Contract Execution',
		rejectAction: 'Reject Contract Execution',
	}

	const explanation = FourByteExplanations[fourByte]

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
		title: explanation === undefined ? 'Contract Execution' : explanation,
		signingAction: `Sign ${ explanation }`,
		simulationAction: `Simulate ${ explanation }`,
		rejectAction: `Reject ${ explanation }`,
	}
}
