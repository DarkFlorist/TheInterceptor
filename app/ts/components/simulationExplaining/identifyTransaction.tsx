import { get4Byte, get4ByteString } from '../../utils/calldata.js'
import { FourByteExplanations } from '../../utils/constants.js'
import { assertNever, createGuard } from '../../utils/typescript.js'
import { SimulatedAndVisualizedTransaction, SimulatedAndVisualizedTransactionBase, TokenVisualizerErc1155Event, TokenVisualizerErc20Event, TokenVisualizerErc721Event, TokenVisualizerResultWithMetadata, TransactionWithAddressBookEntries } from '../../types/visualizer-types.js'
import { getSwapName, identifySwap } from './SwapTransactions.js'
import * as funtypes from 'funtypes'
import { AddressBookEntry } from '../../types/addressBookTypes.js'
import { Interface } from 'ethers'
import { CompoundGovernanceAbi } from '../../utils/abi.js'
import { dataStringWith0xStart } from '../../utils/bigint.js'
import { parseVoteInputParameters } from '../../simulation/compoundGovernanceFaking.js'
import { GovernanceVoteInputParameters } from '../../types/interceptor-messages.js'
import { UniqueRequestIdentifier } from '../../utils/requests.js'
import { findLongestPathFromStart } from '../../utils/depthFirstSearch.js'

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
	| IdentifiedTransactionBase & { type: 'ArbitaryContractExecution' }
	| IdentifiedTransactionBase & { type: 'ContractDeployment' }
	| IdentifiedTransactionBase & { type: 'GovernanceVote', governanceVoteInputParameters: GovernanceVoteInputParameters }

function identifySimpleApproval(simTx: SimulatedAndVisualizedTransaction) {
	if (getSimpleTokenApprovalOrUndefined(simTx)) {
		const tokenResult = simTx.tokenResults[0]
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
		transaction: funtypes.Intersect(
			TransactionWithAddressBookEntries,
			funtypes.ReadonlyObject({
				to: AddressBookEntry,
				tokenResults: funtypes.ReadonlyArray(funtypes.Union(TokenVisualizerResultWithMetadata, funtypes.ReadonlyObject({ isApproval: funtypes.Literal(true) })))
			}),
		),
	})
)

function isSimpleTokenApproval(simTx: SimulatedAndVisualizedTransaction): simTx is SimulatedAndVisualizedSimpleApprovalTransaction {
	const tokenResult = simTx.tokenResults[0]
	if (tokenResult === undefined) return false
	if (!(simTx.transaction.value === 0n
		&& simTx.tokenResults.length === 1
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
	funtypes.Intersect(
		SimulatedAndVisualizedTransactionBase,
		funtypes.ReadonlyObject({
			tokenResults: funtypes.ReadonlyArray(TokenResult)
		})
	),
	funtypes.ReadonlyObject({
		uniqueRequestIdentifier: UniqueRequestIdentifier,
		transaction: funtypes.Intersect(TransactionWithAddressBookEntries, funtypes.ReadonlyObject({ to: AddressBookEntry })),
	})
)

function isSimpleTokenTransfer(transaction: SimulatedAndVisualizedTransaction): transaction is SimulatedAndVisualizedSimpleTokenTransferTransaction {
	const tokenResult = transaction.tokenResults[0]
	if (tokenResult === undefined) return false
	if (transaction.tokenResults.length === 1
		&& tokenResult.isApproval === false
		&& tokenResult.from.address !== tokenResult.to.address
		&& tokenResult.from.address === transaction.transaction.from.address) return true
	return false
}
const getSimpleTokenTransferOrUndefined = createGuard<SimulatedAndVisualizedTransaction, SimulatedAndVisualizedSimpleTokenTransferTransaction>((simTx) => isSimpleTokenTransfer(simTx) ? simTx : undefined)

export type SimulatedAndVisualizedProxyTokenTransferTransaction = funtypes.Static<typeof SimulatedAndVisualizedProxyTokenTransferTransaction>
export const SimulatedAndVisualizedProxyTokenTransferTransaction = funtypes.Intersect(
	funtypes.Intersect(
		SimulatedAndVisualizedTransactionBase,
		funtypes.ReadonlyObject({
			tokenResults: funtypes.ReadonlyArray(TokenResult)
		})
	),
	funtypes.ReadonlyObject({
		uniqueRequestIdentifier: UniqueRequestIdentifier,
		transaction: funtypes.Intersect(TransactionWithAddressBookEntries, funtypes.ReadonlyObject({ to: AddressBookEntry })),
		transferRoute: funtypes.ReadonlyArray(AddressBookEntry)
	})
)

function isProxyTokenTransfer(transaction: SimulatedAndVisualizedTransaction): transaction is SimulatedAndVisualizedProxyTokenTransferTransaction {
	// there need to be atleast two logs (otherwise its a simple send)
	if (transaction.tokenResults.length < 2) return false
	// no approvals allowed
	if (transaction.tokenResults.filter((result) => result.isApproval).length !== 0) return false
	// sender has only one token leaving by logs (gas fees are not in logs)
	const senderLogs = transaction.tokenResults.filter((result) => result.from.address === transaction.transaction.from.address)
	const senderLog = senderLogs[0]
	if (senderLogs.length !== 1 || senderLog === undefined) return false
	// sender does not receive any tokens
	if (transaction.tokenResults.filter((result) => result.to.address === transaction.transaction.from.address).length !== 0) return false
	// only one token of specific address is being transacted in the logs
	if (transaction.tokenResults.filter((result) => result.token.address !== senderLog.token.address).length !== 0) return false
	// only one token id (or undefined) is mentioned inte the logs
	if (new Set(transaction.tokenResults.map((result) => 'tokenId' in result ? result.tokenId : undefined)).size !== 1) return false
	// all transfer amounts are equal
	if (new Set(transaction.tokenResults.map((tokenResult) => !tokenResult.isApproval && tokenResult.type !== 'ERC721' ? tokenResult.amount : -1n)).size !== 1) return false
	
	// can find a path
	const edges = transaction.tokenResults.map((tokenResult) => ({ from: tokenResult.from.address, to: tokenResult.to.address, id: tokenResult.to }))
	const transferRoute = findLongestPathFromStart(edges, transaction.transaction.from.address).map((x) => x.id)
	if (transferRoute.length === 0 || transferRoute.length !== transaction.tokenResults.length) return false
	return true
}
const getProxyTokenTransferOrUndefined = createGuard<SimulatedAndVisualizedTransaction, SimulatedAndVisualizedSimpleTokenTransferTransaction>((simTx) => isProxyTokenTransfer(simTx) ? simTx : undefined)

export function identifyTransaction(simTx: SimulatedAndVisualizedTransaction): IdentifiedTransaction {
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
		const tokenResult = simTx.tokenResults[0]
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
		const tokenResult = simTx.tokenResults[0]
		if (tokenResult === undefined) throw new Error('token result were undefined')
		const symbol = tokenResult.token.symbol
		const edges = simTx.tokenResults.map((tokenResult) => ({ from: tokenResult.from.address, to: tokenResult.to.address, id: tokenResult.to }))
		const transferRoute = findLongestPathFromStart(edges, simTx.transaction.from.address).map((x) => x.id)
		return {
			type: 'ProxyTokenTransfer',
			title: `${ symbol } Transfer via Proxy`,
			signingAction: `Transfer ${ symbol } via Proxy`,
			simulationAction: `Simulate ${ symbol } Transfer via Proxy`,
			rejectAction: `Reject ${ symbol } Transfer via Proxy`,
			identifiedTransaction: {...simTx, transferRoute },
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
		type: 'ArbitaryContractExecution',
		title: 'Contract Fallback Method',
		signingAction: 'Execute Contract',
		simulationAction: 'Simulate Contract Execution',
		rejectAction: 'Reject Contract Execution',
	}

	const explanation = FourByteExplanations[fourByte]

	if (explanation === undefined) {
		return {
			type: 'ArbitaryContractExecution',
			title: 'Contract Execution',
			signingAction: 'Execute Contract',
			simulationAction: 'Simulate Contract Execution',
			rejectAction: 'Reject Contract Execution',
		}
	}
	return {
		type: 'ArbitaryContractExecution',
		title: explanation === undefined ? 'Contract Execution' : explanation,
		signingAction: `Sign ${ explanation }`,
		simulationAction: `Simulate ${ explanation }`,
		rejectAction: `Reject ${ explanation }`,
	}
}
