import { getEthDonator } from '../../background/storageVariables.js'
import { get4Byte } from '../../utils/calldata.js'
import { FourByteExplanations, MAKE_YOU_RICH_TRANSACTION } from '../../utils/constants.js'
import { assertNever, createGuard } from '../../utils/typescript.js'
import { SimulatedAndVisualizedTransaction, SimulatedAndVisualizedTransactionBase, TokenVisualizerErc1155Event, TokenVisualizerErc20Event, TokenVisualizerErc721Event, TokenVisualizerResultWithMetadata, TransactionWithAddressBookEntries } from '../../utils/visualizer-types.js'
import { getSwapName, identifySwap } from './SwapTransactions.js'
import * as funtypes from 'funtypes'
import { AddressBookEntry } from '../../utils/addressBookTypes.js'

type IdentifiedTransactionBase = {
	title: string
	signingAction: string
	simulationAction: string
	rejectAction: string
}

type IdentifiedTransaction =
	IdentifiedTransactionBase & { type: 'SimpleTokenApproval', identifiedTransaction: SimulatedAndVisualizedSimpleApprovalTransaction }
	| IdentifiedTransactionBase & { type: 'EtherTransfer', identifiedTransaction: SimulatedAndVisualizedEtherTransferTransaction }
	| IdentifiedTransactionBase & { type: 'SimpleTokenTransfer', identifiedTransaction: SimulatedAndVisualizedSimpleTokenTransferTransaction }
	| IdentifiedTransactionBase & { type: 'Swap' }
	| IdentifiedTransactionBase & { type: 'ContractFallbackMethod' }
	| IdentifiedTransactionBase & { type: 'ArbitaryContractExecution' }
	| IdentifiedTransactionBase & { type: 'MakeYouRichTransaction' }
	| IdentifiedTransactionBase & { type: 'ContractDeployment' }

export function identifySimpleApproval(simTx: SimulatedAndVisualizedTransaction) {
	if (getSimpleTokenApprovalOrUndefined(simTx)) {
		const tokenResult = simTx.tokenResults[0]
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
					rejectAction: `Reject All Approval Removal`,
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

export type SimulatedAndVisualizedSimpleApprovalTransaction = funtypes.Static<typeof SimulatedAndVisualizedSimpleApprovalTransaction>
export const SimulatedAndVisualizedSimpleApprovalTransaction = funtypes.Intersect(
	SimulatedAndVisualizedTransactionBase,
	funtypes.ReadonlyObject({
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
	if (!(simTx.transaction.value === 0n
		&& simTx.tokenResults.length === 1
		&& simTx.tokenResults[0].isApproval == true
		&& simTx.tokenResults[0].from.address !== simTx.tokenResults[0].to.address
		&& simTx.tokenResults[0].from === simTx.transaction.from
	)) return false
	return true
}
const getSimpleTokenApprovalOrUndefined = createGuard<SimulatedAndVisualizedTransaction, SimulatedAndVisualizedSimpleApprovalTransaction>((simTx) => isSimpleTokenApproval(simTx) ? simTx : undefined)

export type SimulatedAndVisualizedEtherTransferTransaction = funtypes.Static<typeof SimulatedAndVisualizedEtherTransferTransaction>
export const SimulatedAndVisualizedEtherTransferTransaction = funtypes.Intersect(
	SimulatedAndVisualizedTransactionBase,
	funtypes.ReadonlyObject({
		transaction: funtypes.Intersect(
			TransactionWithAddressBookEntries,
			funtypes.ReadonlyObject({
				to: AddressBookEntry,
			}),
		),
	})
)

function isEtherTransfer(simTx: SimulatedAndVisualizedTransaction): simTx is SimulatedAndVisualizedEtherTransferTransaction {
	if (simTx.transaction.input.length == 0
		&& simTx.tokenResults.length == 0
		&& simTx.transaction.to
		&& simTx.gasSpent == 21000n) return true
	return false
}
const getEtherTransferOrUndefined = createGuard<SimulatedAndVisualizedTransaction, SimulatedAndVisualizedEtherTransferTransaction>((simTx) => isEtherTransfer(simTx) ? simTx : undefined)

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
		transaction: funtypes.Intersect(TransactionWithAddressBookEntries, funtypes.ReadonlyObject({ to: AddressBookEntry })),
	})
)

export function isSimpleTokenTransfer(transaction: SimulatedAndVisualizedTransaction): transaction is SimulatedAndVisualizedSimpleTokenTransferTransaction {
	if (transaction.transaction.value === 0n
		&& transaction.tokenResults.length === 1
		&& transaction.tokenResults[0].isApproval == false
		&& transaction.tokenResults[0].from.address !== transaction.tokenResults[0].to.address
		&& transaction.tokenResults[0].from.address === transaction.transaction.from.address) return true
	return false
}
const getSimpleTokenTransferOrUndefined = createGuard<SimulatedAndVisualizedTransaction, SimulatedAndVisualizedSimpleTokenTransferTransaction>((simTx) => isSimpleTokenTransfer(simTx) ? simTx : undefined)


export function identifyTransaction(simTx: SimulatedAndVisualizedTransaction): IdentifiedTransaction {
	const richTxParams = MAKE_YOU_RICH_TRANSACTION.transaction
	if (simTx.transaction.rpcNetwork.httpsRpc !== undefined
		&& getEthDonator(simTx.transaction.rpcNetwork.chainId) === simTx.transaction.from.address
		&& simTx.transaction.type === richTxParams.type
		&& simTx.transaction.maxFeePerGas === richTxParams.maxFeePerGas
		&& simTx.transaction.maxPriorityFeePerGas === richTxParams.maxPriorityFeePerGas
		&& simTx.transaction.input.toString() === richTxParams.input.toString()
		&& simTx.transaction.value === richTxParams.value
		&& simTx.website.websiteOrigin === MAKE_YOU_RICH_TRANSACTION.website.websiteOrigin
	) {
		return {
			type: 'MakeYouRichTransaction',
			title: 'Simply making you rich',
			signingAction: 'Make me rich',
			simulationAction: 'Simulate richies',
			rejectAction: 'Reject richies',
		}
	}

	if (getEtherTransferOrUndefined(simTx)) return {
		type: 'EtherTransfer',
		title: 'Ether Transfer',
		signingAction: 'Transfer Ether',
		simulationAction: 'Simulate Ether Transfer',
		rejectAction: 'Reject Ether Transfer',
		identifiedTransaction: simTx
	}

	const identifiedSwap = identifySwap(simTx)
	if (identifiedSwap) {
		const swapname = getSwapName(identifiedSwap, simTx.transaction.rpcNetwork)
		return {
			type: 'Swap',
			title: swapname === undefined ? 'Swap' : swapname,
			signingAction: 'Swap',
			simulationAction: 'Simulate Swap',
			rejectAction: 'Reject Swap',
		}
	}

	if (getSimpleTokenTransferOrUndefined(simTx)) {
		const symbol = simTx.tokenResults[0].token.symbol
		return {
			type: 'SimpleTokenTransfer',
			title: `${ symbol } Transfer`,
			signingAction: `Transfer ${ symbol }`,
			simulationAction: `Simulate ${ symbol } Transfer`,
			rejectAction: `Reject ${ symbol } Transfer`,
			identifiedTransaction: simTx,
		}
	}

	if (simTx.transaction.to === undefined) {
		return {
			type: 'ContractDeployment',
			title: `Contract Deployment`,
			signingAction: `Deploy Contract`,
			simulationAction: `Simulate Contract Deployment`,
			rejectAction: `Reject Contract Deployment`,
		}
	}

	const simpleApproval = identifySimpleApproval(simTx)
	if (simpleApproval !== undefined) return simpleApproval

	const fourByte = get4Byte(simTx.transaction.input)
	if (fourByte === undefined) return {
		type: 'ArbitaryContractExecution',
		title: 'Contract Fallback Method',
		signingAction: 'Execute Contract',
		simulationAction: 'Simulate Contract Execution',
		rejectAction: 'Reject Contract Execution',
	}

	const explanation = FourByteExplanations.get(fourByte)

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
