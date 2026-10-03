import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { getNativeTokenErc20 } from '../../app/ts/background/metadataUtils.js'
import { ConfirmationActionButtons, getSimulationStackPosition, isSignatureAdvisedAgainst, isTransactionAdvisedAgainst } from '../../app/ts/components/pages/ConfirmTransaction.js'
import { identifyTransaction } from '../../app/ts/components/simulationExplaining/identifyTransaction.js'
import { identifySwap, SwapVisualization } from '../../app/ts/components/simulationExplaining/SwapTransactions.js'
import { getTransactionChecks } from '../../app/ts/components/simulationExplaining/TransactionChecks.js'
import { getAddressOutcomeChips, TransactionOutcomeChips } from '../../app/ts/components/simulationExplaining/TransactionOutcomeChips.js'
import { getSimulationStackRowStatus, type SimulationStackMessageRow, type SimulationStackTransactionRow } from '../../app/ts/components/simulationExplaining/simulationStackRows.js'
import { getInterceptorModeClass } from '../../app/ts/components/ui-utils.js'
import { mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import type { AddressBookEntry, Erc20TokenEntry, Erc721Entry } from '../../app/ts/types/addressBookTypes.js'
import type { TokenEvent } from '../../app/ts/types/EnrichedEthereumData.js'
import type { SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import type { VisualizedPersonalSignRequest } from '../../app/ts/types/personal-message-definitions.js'
import { getApprovalChangeOfTokenEvent, grantsSpendingRights, tokenEventGrantsSpendingRights } from '../../app/ts/utils/approvals.js'
import { isUnlimitedErc20Approval } from '../../app/ts/utils/erc20.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { summarizeLogsForAddress } from '../../app/ts/simulation/services/LogSummarizer.js'
import type { NonSimulatedAndVisualizedTransaction, PreSimulationTransaction, SignedMessageTransaction, SimulatedAndVisualizedTransaction } from '../../app/ts/types/visualizer-types.js'
import type { Website } from '../../app/ts/types/websiteAccessTypes.js'
import { installDomMock } from './domMock.js'
import { readInterceptorAppCss } from './cssTestUtils.js'
import { signal } from '@preact/signals'
import { SimpleTokenApprovalVisualisation } from '../../app/ts/components/simulationExplaining/customExplainers/SimpleTokenApprovalVisualisation.js'
import { Erc721TokenIdApprovalChanges } from '../../app/ts/components/simulationExplaining/SimulationSummary.js'
import { isPositiveEvent } from '../../app/ts/components/simulationExplaining/Transactions.js'

const website: Website = { websiteOrigin: 'https://example.com', title: 'Example', icon: undefined }
const rpcNetwork: RpcNetwork = { name: 'Ethereum', chainId: 1n, httpsRpc: 'https://example.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
const sender: AddressBookEntry = { type: 'contact', name: 'Sender', address: 0x1000000000000000000000000000000000000001n, entrySource: 'User' }
const knownContract: AddressBookEntry = { type: 'contract', name: 'Known Router', address: 0x2000000000000000000000000000000000000002n, entrySource: 'DarkFloristMetadata' }
const unknownAddress: AddressBookEntry = { type: 'contact', name: '0x3000000000000000000000000000000000000003', address: 0x3000000000000000000000000000000000000003n, entrySource: 'FilledIn' }
const selfNamedToken: Erc20TokenEntry = { type: 'ERC20', name: 'Self Named', symbol: 'SELF', decimals: 18n, address: 0x4000000000000000000000000000000000000004n, entrySource: 'OnChain' }
const usdc: Erc20TokenEntry = { type: 'ERC20', name: 'USD Coin', symbol: 'USDC', decimals: 6n, address: 0x5000000000000000000000000000000000000005n, entrySource: 'DarkFloristMetadata' }
const nativeToken = getNativeTokenErc20(rpcNetwork)
const sendParameters = { from: sender.address, to: knownContract.address, value: 0n, input: new Uint8Array(), gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }
const originalRequestParameters: SendTransactionParams = { method: 'eth_sendTransaction', params: [sendParameters] }

function createTokenEvent(token: Erc20TokenEntry, from: AddressBookEntry, to: AddressBookEntry, amount: bigint, isApproval: boolean): TokenEvent {
	return {
		isParsed: 'Parsed',
		name: isApproval ? 'Approval' : 'Transfer',
		signature: isApproval ? 'Approval(address,address,uint256)' : 'Transfer(address,address,uint256)',
		args: [],
		address: token.address,
		loggersAddressBookEntry: token,
		data: new Uint8Array(),
		topics: [],
		type: 'TokenEvent',
		logInformation: { logObject: undefined, type: 'ERC20', from, to, token, amount, isApproval },
	}
}

function createSimulatedTransaction(overrides: Partial<Pick<SimulatedAndVisualizedTransaction, 'events' | 'quarantine' | 'quarantineReasons'>> & { to?: AddressBookEntry | undefined, failed?: boolean }): SimulatedAndVisualizedTransaction {
	const base = {
		website,
		created: new Date('2024-01-01T00:00:00.000Z'),
		parsedInputData: { type: 'NonParsed' as const, input: new Uint8Array() },
		transactionIdentifier: 1n,
		originalRequestParameters,
		tokenBalancesAfter: [],
		tokenPriceEstimates: [],
		tokenPriceQuoteToken: undefined,
		gasSpent: 0n,
		realizedGasPrice: 1n,
		quarantine: overrides.quarantine ?? false,
		quarantineReasons: overrides.quarantineReasons ?? [],
		events: overrides.events ?? [],
		transaction: { from: sender, to: 'to' in overrides ? overrides.to : knownContract, rpcNetwork, input: new Uint8Array(), value: 0n, gas: 21_000n, nonce: 0n, hash: 1n, type: '1559' as const, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
	}
	if (overrides.failed === true) return { ...base, transactionStatus: 'Transaction Failed', error: { code: 3, message: 'execution reverted', decodedErrorMessage: 'execution reverted' } }
	return { ...base, transactionStatus: 'Transaction Succeeded' }
}

function createStackRow(status: SimulationStackTransactionRow['status'], simulatedTransaction: SimulationStackTransactionRow['simulatedTransaction']): SimulationStackTransactionRow {
	const preSimulationTransaction: PreSimulationTransaction = {
		signedTransaction: mockSignTransaction({ type: '1559', ...sendParameters, nonce: 0n, chainId: 1n }),
		website,
		created: new Date('2024-01-01T00:00:00.000Z'),
		originalRequestParameters,
		transactionIdentifier: 1n,
	}
	return { type: 'Transaction', blockIndex: 0, transactionIndex: 0, status, preSimulationTransaction, simulatedTransaction }
}

function contrastRatioWithWhite(hex: string) {
	const [red = 0, green = 0, blue = 0] = [1, 3, 5]
		.map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
		.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
	return 1.05 / ((0.2126 * red) + (0.7152 * green) + (0.0722 * blue) + 0.05)
}

const signedMessage: SignedMessageTransaction = {
	website,
	created: new Date('2024-01-01T00:00:00.000Z'),
	activeAddress: sender.address,
	fakeSignedFor: sender.address,
	originalRequestParameters: { method: 'personal_sign', params: ['0x', sender.address] },
	request: { method: 'personal_sign', params: ['0x', sender.address], interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 1n } } },
	simulationMode: true,
	messageIdentifier: 1n,
}

function createSignRequest(overrides: { quarantine?: boolean, isValidMessage?: boolean }): VisualizedPersonalSignRequest {
	return {
		activeAddress: sender,
		type: 'NotParsed',
		method: 'personal_sign',
		message: 'hello',
		account: sender,
		quarantine: overrides.quarantine ?? false,
		quarantineReasons: overrides.quarantine === true ? ['flagged'] : [],
		isValidMessage: overrides.isValidMessage ?? true,
		rpcNetwork,
		simulationMode: true,
		signerName: 'NoSigner',
		website,
		created: new Date('2024-01-01T00:00:00.000Z'),
		rawMessage: '0x',
		stringifiedMessage: 'hello',
		messageIdentifier: 1n,
		messageHash: '0x',
	}
}

function createMessageRow(visualizedPersonalSignRequest: VisualizedPersonalSignRequest | undefined): SimulationStackMessageRow {
	return { type: 'Message', blockIndex: 0, messageIndex: 0, status: visualizedPersonalSignRequest === undefined ? 'pending' : 'simulated', signedMessageTransaction: signedMessage, visualizedPersonalSignRequest }
}

type TestNode = {
	readonly tagName?: string
	readonly childNodes?: readonly TestNode[]
	readonly textContent?: string | null
	readonly getAttribute?: (name: string) => string | null
}

function collectByTag(node: TestNode, tagName: string, results: TestNode[] = []) {
	if (node.tagName === tagName) results.push(node)
	for (const child of node.childNodes ?? []) collectByTag(child, tagName, results)
	return results
}

const collectButtons = (node: TestNode) => collectByTag(node, 'BUTTON')

describe('transaction outcome UI', () => {
	test('summarises a stack row with one status where failures outrank warnings', () => {
		const notSimulated: NonSimulatedAndVisualizedTransaction = {
			website,
			created: new Date('2024-01-01T00:00:00.000Z'),
			parsedInputData: { type: 'NonParsed', input: new Uint8Array() },
			transactionIdentifier: 1n,
			originalRequestParameters,
			transaction: createSimulatedTransaction({}).transaction,
			transactionStatus: 'Failed To Simulate',
			error: { code: 3, message: 'failed', decodedErrorMessage: 'failed' },
		}
		assert.equal(getSimulationStackRowStatus(createStackRow('pending', undefined)), 'pending')
		assert.equal(getSimulationStackRowStatus(createStackRow('failed', notSimulated)), 'failed')
		assert.equal(getSimulationStackRowStatus(createStackRow('simulated', createSimulatedTransaction({}))), 'success')
		assert.equal(getSimulationStackRowStatus(createStackRow('simulated', createSimulatedTransaction({ quarantine: true, quarantineReasons: ['flagged'] }))), 'warning')
		assert.equal(getSimulationStackRowStatus(createStackRow('simulated', createSimulatedTransaction({ failed: true, quarantine: true }))), 'failed')

		assert.equal(getSimulationStackRowStatus(createMessageRow(undefined)), 'pending')
		assert.equal(getSimulationStackRowStatus(createMessageRow(createSignRequest({}))), 'success')
		assert.equal(getSimulationStackRowStatus(createMessageRow(createSignRequest({ quarantine: true }))), 'warning')
		assert.equal(getSimulationStackRowStatus(createMessageRow(createSignRequest({ quarantine: true, isValidMessage: false }))), 'failed')
	})

	test('numbers the pending request after the earlier stack steps and leaves the rich prelude unnumbered', () => {
		assert.deepEqual(getSimulationStackPosition([], 0), { stepNumber: 1, earlierStepNames: [], simulatedAfter: [] })
		assert.deepEqual(getSimulationStackPosition(['ETH Transfer', 'Swap'], 0), { stepNumber: 3, earlierStepNames: ['ETH Transfer', 'Swap'], simulatedAfter: ['ETH Transfer', 'Swap'] })
		assert.deepEqual(getSimulationStackPosition(['ETH Transfer'], 2), { stepNumber: 2, earlierStepNames: ['ETH Transfer'], simulatedAfter: ['Simply making 2 addresses rich', 'ETH Transfer'] })
	})

	test('treats uint96-max and larger approvals as unlimited', () => {
		assert.equal(isUnlimitedErc20Approval(2n ** 96n - 2n), false)
		assert.equal(isUnlimitedErc20Approval(2n ** 96n - 1n), true)
		assert.equal(isUnlimitedErc20Approval(2n ** 256n - 1n), true)
	})

	test('derives the confirmation checks only from the simulation result', () => {
		assert.deepEqual(getTransactionChecks(createSimulatedTransaction({})), [
			{ tone: 'positive', text: 'The simulation succeeded' },
			{ tone: 'positive', text: 'Sent to Known Router, a known address' },
			{ tone: 'positive', text: 'No token approvals are changed' },
		])
		const riskyApproval = createSimulatedTransaction({
			to: selfNamedToken,
			events: [createTokenEvent(selfNamedToken, sender, unknownAddress, 2n ** 256n - 1n, true)],
			quarantine: true,
			quarantineReasons: ['first issue', 'second issue'],
		})
		assert.deepEqual(getTransactionChecks(riskyApproval), [
			{ tone: 'positive', text: 'The simulation succeeded' },
			{ tone: 'warning', text: 'Sent to Self Named, whose name is self-reported and unverified' },
			{ tone: 'warning', text: 'Grants one token approval' },
			{ tone: 'negative', text: 'The Interceptor flagged 2 issues' },
		])
		assert.deepEqual(getTransactionChecks(createSimulatedTransaction({ to: sender }))[1], { tone: 'positive', text: 'Sent to Sender, which is in your address book' })
		assert.deepEqual(getTransactionChecks(createSimulatedTransaction({ to: unknownAddress }))[1], { tone: 'neutral', text: 'Sent to an address that is not in your address book' })
		// Revoking an allowance is not a risk, so it must not read as a warning.
		const revocation = createSimulatedTransaction({ to: usdc, events: [createTokenEvent(usdc, sender, unknownAddress, 0n, true)] })
		assert.deepEqual(getTransactionChecks(revocation)[2], { tone: 'positive', text: 'Only removes a token approval' })
		// A failing transaction has no trustworthy events, so only the failure and the destination are reported.
		assert.deepEqual(getTransactionChecks(createSimulatedTransaction({ failed: true, to: undefined })), [
			{ tone: 'negative', text: 'The transaction fails in the simulation' },
			{ tone: 'neutral', text: 'Deploys a new contract' },
		])
	})

	test('tones outcome chips by what happens to the account', () => {
		const chips = getAddressOutcomeChips({
			erc20TokenBalanceChanges: [
				{ ...nativeToken, changeAmount: -5n * 10n ** 18n, tokenPriceEstimate: undefined, tokenPriceEstimateQuoteToken: undefined },
				{ ...usdc, changeAmount: 1_000_000n, tokenPriceEstimate: undefined, tokenPriceEstimateQuoteToken: undefined },
			],
			erc20TokenApprovalChanges: [{ ...usdc, approvals: [{ ...unknownAddress, change: 2n ** 256n - 1n }, { ...knownContract, change: 5_000_000n }, { ...sender, change: 0n }] }],
			erc721TokenBalanceChanges: [],
			erc721and1155OperatorChanges: [],
			erc721TokenIdApprovalChanges: [],
			erc1155TokenBalanceChanges: [],
		}, [])
		// Approval warnings lead, so the four-chip limit can never hide them behind "+N more".
		assert.deepEqual(chips.map((chip) => chip.tone), ['warning', 'warning', 'negative', 'positive', 'positive'])
		assert.equal(new Set(chips.map((chip) => chip.key)).size, chips.length)
	})

	test('renders the balance changes of the active account as chips', async () => {
		const dom = installDomMock()
		const transfer = createSimulatedTransaction({ events: [createTokenEvent(usdc, sender, knownContract, 2_500_000n, false)] })
		const renderChips = async (activeAddress: bigint | undefined) => {
			await act(() => render(<TransactionOutcomeChips simTx = { transfer } activeAddress = { activeAddress } addressMetaData = { [sender, knownContract, usdc, nativeToken] } tokenPriceEstimates = { [] } namedTokenIds = { [] }/>, dom.document.body))
			return dom.document.body.textContent ?? ''
		}
		try {
			assert.match(await renderChips(sender.address), /−2\.5\s*USDC/)
			assert.match(await renderChips(knownContract.address), /\+2\.5\s*USDC/)
			assert.equal(await renderChips(unknownAddress.address), 'No changes to your account')
			assert.equal(await renderChips(undefined), '')
			await act(() => render(<TransactionOutcomeChips simTx = { createSimulatedTransaction({ failed: true }) } activeAddress = { sender.address } addressMetaData = { [sender] } tokenPriceEstimates = { [] } namedTokenIds = { [] }/>, dom.document.body))
			assert.equal(dom.document.body.textContent, 'Transaction fails')
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('emphasises rejecting only when the Interceptor advises against the request', async () => {
		assert.equal(isTransactionAdvisedAgainst(createSimulatedTransaction({})), false)
		assert.equal(isTransactionAdvisedAgainst(createSimulatedTransaction({ quarantine: true, quarantineReasons: ['flagged'] })), true)
		assert.equal(isTransactionAdvisedAgainst(createSimulatedTransaction({ failed: true })), true)
		assert.equal(isSignatureAdvisedAgainst(createSignRequest({})), false)
		assert.equal(isSignatureAdvisedAgainst(createSignRequest({ quarantine: true })), true)
		assert.equal(isSignatureAdvisedAgainst(createSignRequest({ isValidMessage: false })), true)

		const dom = installDomMock()
		const getButtonClasses = async (recommendReject: boolean) => {
			await act(() => render(h(ConfirmationActionButtons, {
				identified: identifyTransaction(createSimulatedTransaction({})),
				signerName: 'NoSigner',
				simulationMode: true,
				waitingForSigner: false,
				reject: () => undefined,
				rejectButtonState: 'inactive',
				approve: () => undefined,
				approveButtonState: 'inactive',
				confirmDisabled: false,
				addToSafeStack: () => undefined,
				recommendReject,
			}), dom.document.body))
			const buttons = collectButtons(dom.document.body)
			const classesOf = (text: string) => (buttons.find((button) => button.textContent?.includes(text))?.getAttribute?.('class') ?? '').split(/\s+/)
			return { reject: classesOf('Reject'), confirm: classesOf('Simulate'), addUnsigned: classesOf('Add unsigned') }
		}
		try {
			const routine = await getButtonClasses(false)
			assert.ok(routine.reject.includes('button--secondary'))
			// Only the Safe "Add unsigned" action may carry the class that moves a button onto its own row in narrow dialogs.
			assert.ok(routine.addUnsigned.includes('dialog-action-button--unsigned'))
			assert.equal(routine.reject.includes('dialog-action-button--unsigned') || routine.confirm.includes('dialog-action-button--unsigned'), false)
			assert.ok(routine.confirm.includes('is-primary') && routine.confirm.includes('dialog-action-button--confirm'))
			const advisedAgainst = await getButtonClasses(true)
			assert.ok(advisedAgainst.reject.includes('button--recommended') && !advisedAgainst.reject.includes('button--secondary'))
			assert.ok(advisedAgainst.confirm.includes('button--danger-outline') && advisedAgainst.confirm.includes('dialog-action-button--confirm'))
			// Confirming must never look like the primary action when it is advised against.
			assert.equal(advisedAgainst.confirm.includes('is-primary'), false)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('declares browser versions that support the light-dark() colour tokens', async () => {
		const themeCss = await Bun.file('app/css/interceptor-theme.css').text()
		assert.match(themeCss, /light-dark\(/)
		// light-dark() needs Firefox 120 and Chrome 123; on older browsers every themed colour would be invalid.
		const firefoxManifest = await Bun.file('app/manifestV2.json').text()
		const firefoxMinimumVersion = Number(/"strict_min_version":\s*"(\d+)/.exec(firefoxManifest)?.[1])
		assert.ok(firefoxMinimumVersion >= 120, 'Firefox minimum version must support light-dark()')
		const chromeManifest = await Bun.file('app/manifestV3.json').text()
		const chromeMinimumVersion = Number(/"minimum_chrome_version":\s*"(\d+)/.exec(chromeManifest)?.[1])
		assert.ok(chromeMinimumVersion >= 123, 'Chrome minimum version must support light-dark()')
	})

	test('keeps both layout classes on the signer connection chip', async () => {
		const homeSource = await Bun.file('app/ts/components/pages/Home.tsx').text()
		assert.match(homeSource, /class = \{ `popup-home-connection-status popup-data-reveal-inline connection-chip \$\{ getToneClass\('connection-chip', 'positive'\) \}` \}>CONNECTED/)
		assert.match(homeSource, /class = \{ `popup-home-connection-status popup-data-reveal-inline connection-chip \$\{ getToneClass\('connection-chip', 'negative'\) \}` \}>NOT CONNECTED/)
	})

	test('classifies granted and removed approvals with one shared rule', async () => {
		assert.equal(grantsSpendingRights({ kind: 'erc20Allowance', allowance: 1n }), true)
		assert.equal(grantsSpendingRights({ kind: 'erc20Allowance', allowance: 0n }), false)
		assert.equal(grantsSpendingRights({ kind: 'operator', operatorApproved: true }), true)
		assert.equal(grantsSpendingRights({ kind: 'operator', operatorApproved: false }), false)
		assert.equal(grantsSpendingRights({ kind: 'tokenId', approvedAddress: unknownAddress.address }), true)
		assert.equal(grantsSpendingRights({ kind: 'tokenId', approvedAddress: 0n }), false)
		const collection: Erc721Entry = { type: 'ERC721', name: 'Collection', symbol: 'NFT', address: 0x6000000000000000000000000000000000000006n, entrySource: 'DarkFloristMetadata' }
		const createNftEvent = (logInformation: TokenEvent['logInformation']): TokenEvent => ({ ...createTokenEvent(usdc, sender, unknownAddress, 0n, true), address: collection.address, loggersAddressBookEntry: collection, logInformation })
		const erc20Grant = createTokenEvent(usdc, sender, unknownAddress, 5n, true)
		const erc20Revocation = createTokenEvent(usdc, sender, unknownAddress, 0n, true)
		const operatorGrant = createNftEvent({ logObject: undefined, type: 'NFT All approval', from: sender, to: unknownAddress, token: collection, allApprovalAdded: true, isApproval: true })
		const operatorRevocation = createNftEvent({ logObject: undefined, type: 'NFT All approval', from: sender, to: unknownAddress, token: collection, allApprovalAdded: false, isApproval: true })
		const tokenIdGrant = createNftEvent({ logObject: undefined, type: 'ERC721', from: sender, to: unknownAddress, token: collection, tokenId: 7n, isApproval: true })
		// ERC721 removes a single token's approval by approving the zero address.
		const zeroAddress: AddressBookEntry = { type: 'contact', name: '0x0000000000000000000000000000000000000000', address: 0n, entrySource: 'FilledIn' }
		const tokenIdRevocation = createNftEvent({ logObject: undefined, type: 'ERC721', from: sender, to: zeroAddress, token: collection, tokenId: 7n, isApproval: true })
		assert.deepEqual(getApprovalChangeOfTokenEvent(erc20Grant.logInformation), { kind: 'erc20Allowance', allowance: 5n })
		assert.deepEqual(getApprovalChangeOfTokenEvent(operatorRevocation.logInformation), { kind: 'operator', operatorApproved: false })
		assert.deepEqual(getApprovalChangeOfTokenEvent(tokenIdGrant.logInformation), { kind: 'tokenId', approvedAddress: unknownAddress.address })
		// A transfer is not an approval, so it can never be read as a grant.
		assert.equal(getApprovalChangeOfTokenEvent(createTokenEvent(usdc, sender, unknownAddress, 5n, false).logInformation), undefined)
		assert.equal(tokenEventGrantsSpendingRights(createTokenEvent(usdc, sender, unknownAddress, 5n, false).logInformation), false)
		// The confirmation checks, the transaction title and the stack row chips must agree on the same transaction, for every kind of grant and revocation.
		const addressMetaData = new Map([sender, unknownAddress, zeroAddress, usdc, collection].map((entry) => [addressString(entry.address), entry]))
		for (const [approvalEvent, granted] of [[erc20Grant, true], [erc20Revocation, false], [operatorGrant, true], [operatorRevocation, false], [tokenIdGrant, true], [tokenIdRevocation, false]] as const) {
			const expectedTone = granted ? 'warning' : 'positive'
			const transaction = createSimulatedTransaction({ events: [approvalEvent] })
			assert.equal(tokenEventGrantsSpendingRights(approvalEvent.logInformation), granted)
			assert.equal(getTransactionChecks(transaction)[2]?.tone, expectedTone)
			const outcome = summarizeLogsForAddress([transaction], addressString(sender.address), addressMetaData, [], [])
			if (outcome === undefined) throw new Error('the sender has no summarized outcome')
			assert.deepEqual(getAddressOutcomeChips(outcome, []).map((chip) => chip.tone), [expectedTone])
		}
		assert.equal(identifyTransaction(createSimulatedTransaction({ to: collection, events: [operatorGrant] })).title, 'NFT ALL Approval')
		assert.equal(identifyTransaction(createSimulatedTransaction({ to: collection, events: [operatorRevocation] })).title, 'Remove NFT All Approval')
		assert.equal(identifyTransaction(createSimulatedTransaction({ to: collection, events: [tokenIdGrant] })).title, '#7 NFT Approval')
		assert.equal(identifyTransaction(createSimulatedTransaction({ to: collection, events: [tokenIdRevocation] })).title, 'Remove #7 NFT Approval')
		// The token event rows colour a removal as good news for the owner and a grant as bad news.
		for (const [approvalEvent, granted] of [[erc20Grant, true], [erc20Revocation, false], [operatorGrant, true], [operatorRevocation, false], [tokenIdGrant, true], [tokenIdRevocation, false]] as const) {
			assert.equal(isPositiveEvent(approvalEvent.logInformation, sender.address), !granted)
		}

		const renderApprovalPanel = async (approvalEvent: TokenEvent) => {
			const dom = installDomMock()
			try {
				await act(() => render(<SimpleTokenApprovalVisualisation approval = { approvalEvent.logInformation } renameAddressCallBack = { () => undefined } transactionGasses = { { gasSpent: 21_000n, realizedGasPrice: 1n } } rpcNetwork = { rpcNetwork }/>, dom.document.body))
				const labels = collectByTag(dom.document.body, 'P').filter((paragraph) => (paragraph.getAttribute?.('class') ?? '').split(' ').includes('summary-label')).map((paragraph) => paragraph.textContent)
				const toneClasses = collectByTag(dom.document.body, 'SPAN').map((span) => span.getAttribute?.('class') ?? '').filter((className) => className.includes('coin-text--strong'))
				return { labels, toneClasses, text: (dom.document.body.textContent ?? '').replace(/\s+/g, ' ') }
			} finally {
				render(null, dom.document.body)
				dom.restore()
			}
		}
		const grantPanel = await renderApprovalPanel(erc20Grant)
		assert.deepEqual(grantPanel.labels, ['Allow', 'To spend'])
		assert.equal(grantPanel.toneClasses.every((className) => className.includes('coin-text--negative')), true)
		// A removal never shows an amount or "NONE" next to "Stop allowing", and a single token's removal has no spender at all.
		const allowanceRemovalPanel = await renderApprovalPanel(erc20Revocation)
		assert.deepEqual(allowanceRemovalPanel.labels, ['Stop allowing', 'From spending'])
		assert.equal(allowanceRemovalPanel.toneClasses.every((className) => className.includes('coin-text--positive')), true)
		const operatorRemovalPanel = await renderApprovalPanel(operatorRevocation)
		assert.deepEqual(operatorRemovalPanel.labels, ['Stop allowing', 'From spending'])
		assert.doesNotMatch(operatorRemovalPanel.text, /NONE/)
		const tokenIdRemovalPanel = await renderApprovalPanel(tokenIdRevocation)
		assert.deepEqual(tokenIdRemovalPanel.labels, ['Remove the approval for'])
		assert.doesNotMatch(tokenIdRemovalPanel.text, /0x0000000000000000000000000000000000000000/)
		assert.match(tokenIdRemovalPanel.text, /#7/)

		// The account summary shows a removed single-token approval as a positive row without a spender.
		const dom = installDomMock()
		try {
			const approvalChange = (approvedEntry: AddressBookEntry) => ({ tokenEntry: collection, tokenId: 7n, approvedEntry })
			await act(() => render(<Erc721TokenIdApprovalChanges Erc721TokenIdApprovalChanges = { [approvalChange(zeroAddress), approvalChange(unknownAddress)] } positiveColor = 'positive' negativeColor = 'negative' isImportant = { signal(true) } renameAddressCallBack = { () => undefined }/>, dom.document.body))
			const rows = collectByTag(dom.document.body, 'DIV').filter((row) => (row.getAttribute?.('class') ?? '').includes('token-box'))
			assert.equal(rows.length, 2)
			assert.match(rows[0]?.getAttribute?.('class') ?? '', /positive-box/)
			assert.match((rows[0]?.textContent ?? '').replace(/\s+/g, ' '), /Remove approval for/)
			assert.match(rows[1]?.getAttribute?.('class') ?? '', /negative-box/)
			assert.match((rows[1]?.textContent ?? '').replace(/\s+/g, ' '), /Approve/)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('shows a swap as a paid leg and a received leg from the sender\'s point of view', async () => {
		const swap = createSimulatedTransaction({ events: [createTokenEvent(nativeToken, sender, knownContract, 5n * 10n ** 18n, false), createTokenEvent(usdc, knownContract, sender, 2_500_000n, false)] })
		const dom = installDomMock()
		try {
			await act(() => render(<SwapVisualization identifiedSwap = { identifySwap(swap) } renameAddressCallBack = { () => undefined }/>, dom.document.body))
			const text = (dom.document.body.textContent ?? '').replace(/\s+/g, ' ')
			assert.match(text, /You pay\s*- 5/)
			assert.match(text, /You receive\s*\+ 2\.5/)
			// The paid amount carries the negative tone and the received amount the positive one; the tones map to the loss and gain colours.
			const amountClasses = collectByTag(dom.document.body, 'P').map((paragraph) => paragraph.getAttribute?.('class') ?? '').filter((className) => className.includes('token-amount') || className.includes('coin-ether-amount'))
			assert.equal(amountClasses.filter((className) => className.includes('coin-text--negative')).length, 1)
			assert.equal(amountClasses.filter((className) => className.includes('coin-text--positive')).length, 1)
			const css = await readInterceptorAppCss()
			assert.match(css, /\.coin-text--negative, \.inline-card data\.coin-text--negative \{ color: var\(--danger-color\) \}/)
			assert.match(css, /\.coin-text--positive, \.inline-card data\.coin-text--positive \{ color: var\(--positive-color\) \}/)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('gives every text field and summary leg one shared style', async () => {
		const css = await readInterceptorAppCss()
		assert.match(css, /\.input,\s*\.address-editor \.address-editor-field \.btn\s*\{[\s\S]*?border:\s*1px solid var\(--white-alpha-20\);[\s\S]*?border-radius:\s*var\(--radius-small\);/)
		assert.match(css, /\.text-input > input\s*\{[\s\S]*?border:\s*1px solid var\(--border-color\);[\s\S]*?border-radius:\s*var\(--radius-small\);/)
		assert.match(css, /\.box\.summary-leg, \.box\.swap-box\s*\{[\s\S]*?background-color:\s*var\(--alpha-005\);[\s\S]*?border-radius:\s*var\(--radius-medium\);/)
		// Disabled fields must not react to hover as if they were editable.
		assert.match(css, /\.input:not\(:disabled\):hover,/)
		assert.doesNotMatch(css, /(^|\n)\.input:hover/)
		// Focus needs the same specificity as hover, or a hovered field would lose its focus border.
		assert.match(css, /\.input:not\(:disabled\):focus,/)
		// Legs must not fall back to the framework's white box, which is what an unstyled `.box` renders as.
		for (const sourcePath of ['app/ts/components/simulationExplaining/customExplainers/SimpleSendVisualisations.tsx', 'app/ts/components/simulationExplaining/customExplainers/ProxySendVisualisations.tsx', 'app/ts/components/simulationExplaining/customExplainers/SimpleTokenApprovalVisualisation.tsx']) {
			assert.doesNotMatch(await Bun.file(sourcePath).text(), /class = 'box'/, sourcePath)
		}
	})

	test('tints pages by mode and themes every colour for light and dark', async () => {
		assert.equal(getInterceptorModeClass(true), 'interceptor-mode-simulating')
		assert.equal(getInterceptorModeClass(false), 'interceptor-mode-signing')
		const themeCss = await Bun.file('app/css/interceptor-theme.css').text()
		assert.match(themeCss, /:root\s*\{\s*color-scheme:\s*light dark;/)
		for (const token of ['bg-color', 'card-bg-color', 'text-color', 'accent-color', 'positive-color', 'danger-color', 'warning-color', 'error-box-color', 'warning-box-color']) {
			assert.match(themeCss, new RegExp(`--${ token }:\\s*light-dark\\(`), `${ token } must define a light and a dark value`)
		}
		const signingScope = /\.interceptor-mode-signing\s*\{([^}]*)\}/.exec(themeCss.slice(themeCss.indexOf('/* Signing mode')))?.[1] ?? ''
		assert.match(signingScope, /--accent-color:\s*light-dark\(/)
		// Action buttons keep white labels in signing mode, so the amber fills need the same 4.5:1 contrast as the default ones.
		for (const token of ['primary-action-color', 'highlighted-primary-action-color']) {
			const color = new RegExp(`--${ token }:\\s*(#[0-9a-fA-F]{6})`).exec(signingScope)?.[1]
			assert.notEqual(color, undefined, `${ token } must be redefined for signing mode`)
			assert.ok(contrastRatioWithWhite(color ?? '#ffffff') >= 4.5, `${ token } must have at least 4.5:1 contrast with white in signing mode`)
		}
		// The tints must be re-declared in the signing scope, or they would keep mixing the simulation accent.
		assert.match(themeCss, /:root, \.interceptor-mode-signing\s*\{[\s\S]*?--accent-soft-color:\s*color-mix\(in srgb, var\(--accent-color\)/)
		// Tooltips sit on a surface that is dark in both themes, so their text must not use the themed text colour.
		assert.match(themeCss, /\.preact-hint__content\s*\{[\s\S]*?color:\s*var\(--tooltip-text-color\);/)
		assert.match(themeCss, /--tooltip-text-color:\s*#[0-9a-fA-F]{6};/)
		const css = await readInterceptorAppCss()
		assert.match(css, /\.simulation-stack-list--timeline > li\[data-stack-status='failed'\]::before\s*\{[\s\S]*?border-color:\s*var\(--danger-color\);/)
		assert.match(css, /\.simulation-stack-list--timeline > li\[data-stack-status='warning'\]::before\s*\{[\s\S]*?border-color:\s*var\(--warning-color\);/)
	})
})
