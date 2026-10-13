// Shared fixtures and DOM helpers for popup components whose actions wait on background replies (access requests, chain changes, address lookups, governance and Gnosis Safe simulations).
import { h } from 'preact'
import { type GovernanceVoteInputParameters, SimulateExecutionReply } from '../../app/ts/types/interceptor-messages.js'
import { PopupRequestsReplies } from '../../app/ts/types/interceptor-reply-messages.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import type { VisualizedPersonalSignRequestSafeTx } from '../../app/ts/types/personal-message-definitions.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { SimulatedAndVisualizedTransaction } from '../../app/ts/types/visualizer-types.js'
import type { PendingAccessRequest } from '../../app/ts/types/accessRequest.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import type { MockElement, MockNode } from './domMock.js'
import { getPreactEventHandler, normalizeWhitespace } from './domQueries.js'

// The popup action pages and visualizers. App modules read the browser globals when they load, so a test file installs its browser mock before it calls this.
export async function loadPopupActionModules() {
	return {
		...await import('../../app/ts/components/pages/AddNewAddress.js'),
		...await import('../../app/ts/components/pages/ChangeChain.js'),
		...await import('../../app/ts/components/pages/InterceptorAccess.js'),
		...await import('../../app/ts/components/simulationExplaining/customExplainers/GovernanceVoteVisualizer.js'),
		...await import('../../app/ts/components/simulationExplaining/customExplainers/GnosisSafeVisualizer.js'),
		...await import('../../app/ts/components/pages/PersonalSign.js'),
	}
}

// The trimmed, whitespace-normalized text of every non-empty text node under root, in document order.
export function collectTextSegments(root: MockNode): string[] {
	if (root.nodeType === 3) {
		const text = normalizeWhitespace(root.textContent)
		return text === '' ? [] : [text]
	}
	return root.childNodes.flatMap(collectTextSegments)
}

export async function changeElement(element: MockElement) {
	await getPreactEventHandler(element, 'Change')({ currentTarget: element })
}

export function createAccessRequestFixture(): PendingAccessRequest {
	return {
		website: { websiteOrigin: 'https://example.test', icon: undefined, title: 'Example' },
		requestAccessToAddress: undefined,
		originalRequestAccessToAddress: undefined,
		associatedAddresses: [],
		signerAccounts: [0x1111111111111111111111111111111111111111n],
		signerName: 'MetaMask',
		simulationMode: false,
		popupOrTabId: { type: 'popup', id: 1 },
		socket: { tabId: 1, connectionName: 1n },
		request: undefined,
		activeAddress: undefined,
		accessRequestId: 'access-request',
	}
}

export function createSimulationFailureReply(transactionOrMessageIdentifier: bigint, errorMessage: string) {
	const reply: SimulateExecutionReply = {
		method: 'popup_simulateExecutionReply',
		data: {
			success: false,
			errorType: 'Other',
			transactionOrMessageIdentifier,
			errorMessage,
		},
	}
	return serialize(SimulateExecutionReply, reply)
}

export function createSimulationFailureBroadcast(transactionOrMessageIdentifier: bigint, errorMessage: string) {
	return { role: 'all' as const, ...createSimulationFailureReply(transactionOrMessageIdentifier, errorMessage) }
}

export function createAbiLookupFailureReply(error: string) {
	return PopupRequestsReplies.popup_requestAbiAndNameFromBlockExplorer.serialize({
		method: 'popup_requestAbiAndNameFromBlockExplorer',
		data: {
			success: false as const,
			error,
		},
	})
}

export function createIdentifyAddressReply(address: bigint, name: string) {
	return PopupRequestsReplies.popup_requestIdentifyAddress.serialize({
		method: 'popup_requestIdentifyAddress',
		data: {
			chainId: 1n,
			addressBookEntry: {
				type: 'ERC20',
				name,
				address,
				symbol: 'TEST',
				decimals: 18n,
				entrySource: 'OnChain',
				chainId: 1n,
			},
		},
	})
}

export function createSafeContractStateReply(owners: readonly bigint[]) {
	return PopupRequestsReplies.popup_requestSafeContractState.serialize({
		method: 'popup_requestSafeContractState',
		data: {
			chainId: 1n,
			result: {
				ok: true,
				owners,
				ownerAddressBookEntries: owners.map((address, index) => ({ type: 'contact', name: `Safe Owner ${ index + 1 }`, address, entrySource: 'User', askForAddressAccess: true, useAsActiveAddress: true, chainId: 1n })),
				version: '1.4.1',
			},
		},
	})
}

export const ASYNC_CHANNEL_CLOSED_ERROR = 'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received'

export function createGovernanceVoteInputParameters(proposalId: bigint): GovernanceVoteInputParameters {
	return {
		proposalId,
		support: true,
		reason: undefined,
		params: undefined,
		signature: undefined,
		voter: undefined,
	}
}

// Without a governance contract ABI, the visualizer asks the user to add one instead of offering the execution simulation.
export function createGovernanceTransactionFixture(transactionIdentifier: bigint, { hasGovernanceContractAbi = true } = {}): SimulatedAndVisualizedTransaction {
	const voter: AddressBookEntry = { type: 'contact', name: 'Voter', address: 0x2n, entrySource: 'User', chainId: 1n }
	const governanceContract: AddressBookEntry = { type: 'contract', name: 'Governance', address: 0x1n, entrySource: 'User', abi: hasGovernanceContractAbi ? '[]' : undefined, chainId: 1n }
	return {
		website: { websiteOrigin: 'https://governance.example', icon: undefined, title: undefined },
		created: new Date('2024-01-01T00:00:00.000Z'),
		parsedInputData: { type: 'NonParsed', input: new Uint8Array() },
		transactionIdentifier,
		originalRequestParameters: { method: 'eth_sendTransaction', params: [{ from: voter.address, to: governanceContract.address, value: 0n, input: new Uint8Array() }] },
		tokenBalancesAfter: [],
		tokenPriceEstimates: [],
		tokenPriceQuoteToken: undefined,
		gasSpent: 0n,
		realizedGasPrice: 1n,
		quarantine: false,
		quarantineReasons: [],
		transactionStatus: 'Transaction Succeeded',
		transaction: {
			from: voter,
			to: governanceContract,
			rpcNetwork: gnosisRpcNetwork,
			type: '1559',
			nonce: 0n,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
			gas: 21_000n,
			value: 0n,
			input: new Uint8Array(),
			hash: transactionIdentifier,
		},
		events: [],
	}
}

// GovernanceVoteVisualizer renders the simulated proposal execution in the transaction card its caller passes in; these tests stop before a successful simulation, so a placeholder card is enough.
export const PlaceholderTransactionCard = () => h('div', {}, 'transaction card')

const gnosisRpcNetwork: RpcEntry = {
	name: 'Ethereum Mainnet',
	chainId: 1n,
	httpsRpc: 'https://rpc.example',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
}

export const gnosisSignerAddress = {
	type: 'contact' as const,
	name: 'Signer',
	address: 0x2n,
	entrySource: 'User' as const,
	chainId: 1n,
}

const zeroAddressEntry = {
	type: 'contact' as const,
	name: '0x0 Address',
	address: 0n,
	entrySource: 'Interceptor' as const,
	chainId: 1n,
}

export function createGnosisSafeMessageFixture(messageIdentifier: bigint): VisualizedPersonalSignRequestSafeTx {
	return {
		activeAddress: gnosisSignerAddress,
		rpcNetwork: gnosisRpcNetwork,
		simulationMode: true,
		signerName: 'NoSignerDetected',
		quarantineReasons: [],
		quarantine: false,
		account: gnosisSignerAddress,
		website: { websiteOrigin: 'https://safe.example', icon: undefined, title: undefined },
		created: new Date('2024-01-01T00:00:00.000Z'),
		rawMessage: '{}',
		stringifiedMessage: '{}',
		messageIdentifier,
		method: 'eth_signTypedData_v4',
		type: 'SafeTx',
		message: {
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
			domain: {
				chainId: 1n,
				verifyingContract: gnosisSignerAddress.address,
			},
			message: {
				to: 0x3n,
				value: 0n,
				data: new Uint8Array(),
				operation: 0n,
				safeTxGas: 0n,
				baseGas: 0n,
				gasPrice: 0n,
				gasToken: zeroAddressEntry.address,
				refundReceiver: zeroAddressEntry.address,
				nonce: 1n,
			},
		},
		parsedMessageDataAddressBookEntries: [],
		parsedMessageData: { type: 'NonParsed', input: new Uint8Array() },
		gasToken: zeroAddressEntry,
		to: {
			type: 'contact',
			name: 'Recipient',
			address: 0x3n,
			entrySource: 'User',
			chainId: 1n,
		},
		refundReceiver: zeroAddressEntry,
		verifyingContract: {
			type: 'contract',
			name: 'Safe',
			address: gnosisSignerAddress.address,
			entrySource: 'User',
			abi: '[]',
			chainId: 1n,
		},
		messageHash: '0x1',
		domainHash: '0x2',
		safeTxHash: '0x3',
	}
}

export function createChangeChainMessage() {
	return {
		role: 'all' as const,
		method: 'popup_ChangeChainRequest' as const,
		data: {
			website: { websiteOrigin: 'https://chain.example', icon: undefined, title: undefined },
			popupOrTabId: { type: 'tab' as const, id: 1 },
			request: {
				method: 'wallet_switchEthereumChain',
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: {
					requestId: 99,
					requestSocket: {
						tabId: 1,
						connectionName: '0x1',
					},
				},
			},
			rpcNetwork: {
				name: 'Ethereum Mainnet',
				chainId: '0x1',
				httpsRpc: 'https://rpc.example',
				currencyName: 'Ether',
				currencyTicker: 'ETH',
				primary: true,
				minimized: false,
			},
			simulationMode: false,
		},
	}
}
