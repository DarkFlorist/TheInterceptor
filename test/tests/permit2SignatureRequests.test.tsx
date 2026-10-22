import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { EIP712Message } from '../../app/ts/types/eip721.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { SignedMessageTransaction } from '../../app/ts/types/visualizer-types.js'
import { findPermit2WitnessField, getPermit2SignatureTransferKind, type VisualizedPersonalSignRequest } from '../../app/ts/types/personal-message-definitions.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import { checksummedAddress } from '../../app/ts/utils/bigint.js'
import { EthereumAddress } from '../../app/ts/types/wire-types.js'
import { MockRequestHandler } from '../MockRequestHandler.js'
import { clickRenderedElement, findRenderedElement, installDomMock } from './domMock.js'
import { permit2BatchTransferFromMessage, permit2BatchWitnessTransferFromMessage, permit2Message, permit2PermitBatchMessage, permit2Signer, permit2TransferFromMessage, permit2UniswapXWitnessTransferFromMessage, permit2WitnessTransferFromWitnessNotLastMessage, uniswapUniversalRouter, uniswapXExclusiveDutchOrderReactor } from './data/eip712Data.js'

// Address metadata, tab state and RPC lookups read extension storage, which is empty for these requests.
Object.defineProperty(globalThis, 'browser', {
	configurable: true,
	writable: true,
	value: {
		runtime: {
			lastError: undefined,
			getManifest: () => ({ manifest_version: 3 }),
			sendMessage: async () => undefined,
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get() { return {} },
				async set() { return undefined },
				async remove() { return undefined },
			},
		},
	},
})

const { craftPersonalSignPopupMessage } = await import('../../app/ts/background/windows/personalSign.js')
const { SignatureCard } = await import('../../app/ts/components/pages/PersonalSign.js')
const { identifySignature } = await import('../../app/ts/components/simulationExplaining/identifySignature.js')
const { EthereumClientService } = await import('../../app/ts/simulation/services/EthereumClientService.js')

const mainnet: RpcEntry = {
	name: 'Ethereum Mainnet',
	chainId: 1n,
	httpsRpc: new MockRequestHandler().rpcUrl,
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
}

const signer = EthereumAddress.parse(permit2Signer)

function createSignedTypedDataTransaction(typedData: EIP712Message): SignedMessageTransaction {
	return {
		website: { websiteOrigin: 'https://app.uniswap.org', title: 'Uniswap', icon: undefined },
		created: new Date('2024-01-01T00:00:00.000Z'),
		activeAddress: signer,
		fakeSignedFor: signer,
		originalRequestParameters: { method: 'eth_signTypedData_v4', params: [signer, typedData] },
		request: {
			method: 'eth_signTypedData_v4',
			params: [],
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 1n } },
		},
		simulationMode: false,
		messageIdentifier: 1n,
	}
}

async function visualizeParsedTypedData(typedData: EIP712Message, rpcNetwork: RpcEntry = mainnet) {
	const ethereum = new EthereumClientService(new MockRequestHandler(), async () => undefined, async () => undefined, rpcNetwork)
	return await craftPersonalSignPopupMessage(ethereum, undefined, createSignedTypedDataTransaction(typedData), rpcNetwork)
}

const visualizeTypedData = async (typedData: string, rpcNetwork: RpcEntry = mainnet) => await visualizeParsedTypedData(EIP712Message.parse(typedData), rpcNetwork)

// The address metadata identifies this MetaSamurai collection as an ERC721 token.
const erc721TokenAddress = '0x79f1c4cf7266746698e91034d658e56913e6644f'
// No address metadata or on-chain code exists for this address, so it is not identified as an ERC20 token.
const unidentifiedTokenAddress = '0x1111111111111111111111111111111111111111'

type RenderedElement = {
	readonly tagName?: string
	readonly textContent?: string
	readonly attributes?: Readonly<Record<string, string | undefined>>
	readonly childNodes?: readonly RenderedElement[]
}

function collectRenderedElements(node: RenderedElement, matches: (node: RenderedElement) => boolean): readonly RenderedElement[] {
	return [...(matches(node) ? [node] : []), ...(node.childNodes ?? []).flatMap((child) => collectRenderedElements(child, matches))]
}

async function renderExpandedSignatureCard<Inspection>(visualizedPersonalSignRequest: VisualizedPersonalSignRequest, inspect: (body: RenderedElement) => Inspection) {
	const dom = installDomMock()
	try {
		await act(() => {
			render(h(SignatureCard, {
				visualizedPersonalSignRequest,
				renameAddressCallBack: () => undefined,
				removeTransactionOrSignedMessage: undefined,
				numberOfUnderTransactions: 0,
				editEnsNamedHashCallBack: () => undefined,
			}), dom.document.body)
		})
		const extraDetailsHeader = findRenderedElement(dom.document.body, (node) => node.tagName === 'HEADER' && node.textContent?.includes('Extra details') === true)
		if (extraDetailsHeader === undefined) throw new Error('Expected the extra details card')
		await act(async () => { await clickRenderedElement(extraDetailsHeader) })
		const inspection = inspect(dom.document.body)
		await act(() => { render(null, dom.document.body) })
		return inspection
	} finally {
		dom.restore()
	}
}

const renderSignatureCardText = async (visualizedPersonalSignRequest: VisualizedPersonalSignRequest) => await renderExpandedSignatureCard(visualizedPersonalSignRequest, (body) => body.textContent ?? '')

// Named addresses render their name as text, while the copy button keeps the checksummed address.
const getCopyableAddresses = (body: RenderedElement) => collectRenderedElements(body, (node) => node.tagName === 'BUTTON' && node.attributes?.value !== undefined).map((button) => button.attributes?.value)

// Each PermitBatch token gets a nonce row and an expiration row whose label shows the token card with its copyable address and untrusted marker.
function getPermit2BatchTokenRows(body: RenderedElement) {
	const tokenRowLabels = collectRenderedElements(body, (node) => node.tagName === 'P' && /(?: nonce: |^Spender can spend .* for: )$/u.test(node.textContent ?? ''))
	return tokenRowLabels.map((label) => ({
		tokenAddress: getCopyableAddresses(label)[0],
		untrusted: collectRenderedElements(label, (node) => node.attributes?.role === 'alert' && node.attributes.title === 'Untrusted address').length > 0,
	}))
}

function assertIncludesAll(text: string, expectedSnippets: readonly string[]) {
	for (const expected of expectedSnippets) assert.equal(text.includes(expected), true, `expected "${ expected }" in "${ text }"`)
}

async function assertShowsUnidentifiedTokenApproval(visualizedPersonalSignRequest: VisualizedPersonalSignRequest, rawAmount: string) {
	const { text, copyableAddresses } = await renderExpandedSignatureCard(visualizedPersonalSignRequest, (body) => ({ text: body.textContent ?? '', copyableAddresses: getCopyableAddresses(body) }))
	assertIncludesAll(text, [
		'The permitted token is not an identified ERC20 token',
		'Spender: Uniswap Universal Router',
		`Token: ${ checksummedAddress(EthereumAddress.parse(unidentifiedTokenAddress)) }`,
		`Raw amount: ${ rawAmount }`,
	])
	assert.equal(copyableAddresses.includes(checksummedAddress(EthereumAddress.parse(uniswapUniversalRouter))), true)
	return text
}

function getTokenSymbols(visualizedPersonalSignRequest: VisualizedPersonalSignRequest) {
	if (visualizedPersonalSignRequest.type === 'Permit2Batch') return visualizedPersonalSignRequest.details.map(({ token }) => token.type === 'ERC20' ? token.symbol : token.name)
	if (visualizedPersonalSignRequest.type === 'Permit2SignatureTransfer') return visualizedPersonalSignRequest.permitted.map(({ token }) => token.type === 'ERC20' ? token.symbol : token.name)
	throw new Error(`Expected a Permit2 batch or signature transfer, got ${ visualizedPersonalSignRequest.type }`)
}

describe('Permit2 signature requests', () => {
	test('visualizes a PermitTransferFrom as a single token Permit2 transfer', async () => {
		const visualized = await visualizeTypedData(permit2TransferFromMessage)
		if (visualized.type !== 'Permit2SignatureTransfer') throw new Error(`Expected a Permit2 signature transfer, got ${ visualized.type }`)
		assert.deepEqual(getTokenSymbols(visualized), ['USDT'])
		assert.equal(visualized.permitted[0]?.amount, 1000000n)
		assert.equal(visualized.witness, undefined)
		assert.equal(visualized.verifyingContract.name, 'Uniswap Permit2')
		assert.deepEqual({ quarantine: visualized.quarantine, quarantineReasons: visualized.quarantineReasons }, { quarantine: false, quarantineReasons: [] })
		assert.deepEqual(identifySignature(visualized), {
			title: 'USDT Permit2 transfer',
			signingAction: 'Sign USDT Permit2 transfer',
			simulationAction: 'Simulate USDT Permit2 transfer',
			rejectAction: 'Reject USDT Permit2 transfer',
			to: visualized.spender,
		})

		assertIncludesAll(await renderSignatureCardText(visualized), [
			'USDT Permit2 transfer',
			'Allow',
			'To Spend',
			'USDT',
			'Chain: Ethereum Mainnet',
			'Verifying contract: Uniswap Permit2',
			'Nonce: 7',
			'Signature expires in: ',
			'(until 2023-11-14T22:13:20.000Z)',
			`Domain Hash: ${ visualized.domainHash }`,
			`Message Hash: ${ visualized.messageHash }`,
		])
	})

	test('lists every token of a PermitBatchTransferFrom and shows unlimited amounts and deadlines', async () => {
		const visualized = await visualizeTypedData(permit2BatchTransferFromMessage)
		if (visualized.type !== 'Permit2SignatureTransfer') throw new Error(`Expected a Permit2 signature transfer, got ${ visualized.type }`)
		assert.deepEqual(getTokenSymbols(visualized), ['USDC', 'WETH'])
		assert.equal(identifySignature(visualized).title, 'Permit2 batch transfer')

		assertIncludesAll(await renderSignatureCardText(visualized), [
			'Permit2 batch transfer',
			'ALL',
			'USDC',
			'2.5',
			'WETH',
			'Signature expires in: unlimited',
		])
	})

	test('shows the UniswapX ExclusiveDutchOrder witness of a PermitWitnessTransferFrom', async () => {
		const visualized = await visualizeTypedData(permit2UniswapXWitnessTransferFromMessage)
		if (visualized.type !== 'Permit2SignatureTransfer') throw new Error(`Expected a Permit2 signature transfer, got ${ visualized.type }`)
		assert.deepEqual(getTokenSymbols(visualized), ['USDC'])
		assert.equal(visualized.spender.address, EthereumAddress.parse(uniswapXExclusiveDutchOrderReactor))
		assert.equal(visualized.witness?.fieldName, 'witness')
		assert.equal(visualized.witness?.typeName, 'ExclusiveDutchOrder')
		assert.equal(visualized.witness?.value.type, 'record')
		assert.equal(identifySignature(visualized).title, 'USDC Permit2 transfer')
		// The raw message keeps the witness and its struct types that the Permit2 runtime type does not model.
		assertIncludesAll(visualized.rawMessage, ['"witness":{', '"ExclusiveDutchOrder":[', '"exclusiveFiller":"0xff8ba4d1fc3762f6154cc942ccf30049a2a0cec6"'])

		assertIncludesAll(await renderSignatureCardText(visualized), [
			'USDC Permit2 transfer',
			'This signature is only valid together with the following ExclusiveDutchOrder witness data:',
			'witness:',
			'info:',
			'swapper:',
			'decayStartTime:',
			'exclusiveFiller:',
			'exclusivityOverrideBps:',
			'inputToken:',
			'outputs:',
			'recipient:',
		])
	})

	test('accepts an integrator defined witness field name in a PermitBatchWitnessTransferFrom', async () => {
		const visualized = await visualizeTypedData(permit2BatchWitnessTransferFromMessage)
		if (visualized.type !== 'Permit2SignatureTransfer') throw new Error(`Expected a Permit2 signature transfer, got ${ visualized.type }`)
		assert.deepEqual(getTokenSymbols(visualized), ['USDC', 'USDT'])
		assert.equal(visualized.witness?.fieldName, 'slippageAndActions')
		assert.equal(visualized.witness?.typeName, 'SlippageAndActions')
		assert.equal(identifySignature(visualized).title, 'Permit2 batch transfer')

		assertIncludesAll(await renderSignatureCardText(visualized), [
			'SlippageAndActions witness data:',
			'slippageAndActions:',
			'minAmountOut:',
			'actions:',
		])
	})

	test('visualizes an AllowanceTransfer PermitBatch with per token expirations', async () => {
		const visualized = await visualizeTypedData(permit2PermitBatchMessage)
		if (visualized.type !== 'Permit2Batch') throw new Error(`Expected a Permit2 batch, got ${ visualized.type }`)
		assert.deepEqual(getTokenSymbols(visualized), ['USDC', 'USDT'])
		assert.deepEqual(visualized.details.map(({ nonce, expiration }) => ({ nonce, expiration })), [{ nonce: 0n, expiration: 281474976710655n }, { nonce: 3n, expiration: 1700000000n }])
		assert.deepEqual(identifySignature(visualized), {
			title: 'Permit2 batch approval',
			signingAction: 'Sign Permit2 batch approval',
			simulationAction: 'Simulate Permit2 batch approval',
			rejectAction: 'Reject Permit2 batch approval',
			to: visualized.spender,
		})

		assertIncludesAll(await renderSignatureCardText(visualized), [
			'Permit2 batch approval',
			'ALL',
			'USDC',
			'USDT',
			'Verifying contract: Uniswap Permit2',
			'Signature expires in: ',
			'USDCcopyedit nonce: 0',
			'Spender can spend USDCUSDCcopyedit for: unlimited',
			'USDTcopyedit nonce: 3',
			'Spender can spend USDTUSDTcopyedit for: ',
		])
	})

	test('keeps look-alike PermitBatch tokens with the same symbol distinguishable in the per token rows', async () => {
		const visualized = await visualizeTypedData(permit2PermitBatchMessage)
		if (visualized.type !== 'Permit2Batch') throw new Error(`Expected a Permit2 batch, got ${ visualized.type }`)
		const [usdcDetails, secondDetails] = visualized.details
		if (usdcDetails === undefined || secondDetails === undefined) throw new Error('Expected two PermitBatch entries')
		const lookalikeUsdc: AddressBookEntry = { type: 'ERC20', name: 'USD Coin', symbol: 'USDC', decimals: 6n, address: 0x5555555555555555555555555555555555555555n, entrySource: 'OnChain', chainId: 1n }
		const usdcRow = { tokenAddress: checksummedAddress(usdcDetails.token.address), untrusted: false }
		const lookalikeUsdcRow = { tokenAddress: checksummedAddress(lookalikeUsdc.address), untrusted: true }

		const tokenRows = await renderExpandedSignatureCard({ ...visualized, details: [usdcDetails, { ...secondDetails, token: lookalikeUsdc }] }, getPermit2BatchTokenRows)
		assert.deepEqual(tokenRows, [usdcRow, usdcRow, lookalikeUsdcRow, lookalikeUsdcRow])
	})

	test('renders a PermitSingle whose expiration is beyond any representable date', async () => {
		const maxExpirationPermit = JSON.parse(permit2Message)
		maxExpirationPermit.message.details.expiration = '281474976710655'
		const visualized = await visualizeTypedData(JSON.stringify(maxExpirationPermit))
		if (visualized.type !== 'Permit2') throw new Error(`Expected a Permit2 PermitSingle, got ${ visualized.type }`)
		assert.equal(identifySignature(visualized).title, 'USDT Permit')

		assertIncludesAll(await renderSignatureCardText(visualized), [
			'USDT Permit',
			'Allow',
			'To Spend',
			'ALL',
			'USDT',
			'Verifying contract: Uniswap Permit2',
			'Spender can spend for: unlimited',
		])
	})

	test('rejects EIP-2612 and Permit2 permits for an ERC721 token', async () => {
		const erc721Permit2Transfer = JSON.parse(permit2TransferFromMessage)
		erc721Permit2Transfer.message.permitted.token = erc721TokenAddress
		await assert.rejects(visualizeTypedData(JSON.stringify(erc721Permit2Transfer)), { message: 'Attempted to perform Permit to an ERC721' })

		// Request parsing turns every JSON number into a string, which the EIP-2612 runtime type does not accept for its nonce and deadline, so the EIP-2612 branch is reached with an already parsed request.
		const erc721Eip2612Permit: EIP712Message = {
			types: {
				EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
				Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
			},
			primaryType: 'Permit',
			domain: { name: 'MetaSamurai - OFFICIAL', version: '1', chainId: '1', verifyingContract: erc721TokenAddress },
			message: { owner: permit2Signer, spender: '0x5555555555555555555555555555555555555555', value: '1', nonce: 0, deadline: 1700000000 },
		}
		await assert.rejects(visualizeParsedTypedData(erc721Eip2612Permit), { message: 'Attempted to perform Permit to an ERC721' })
	})

	test('keeps the spender and raw amount visible when a Permit2 token is not an identified ERC20 token', async () => {
		const unidentifiedTokenTransfer = JSON.parse(permit2TransferFromMessage)
		unidentifiedTokenTransfer.message.permitted.token = unidentifiedTokenAddress
		const visualized = await visualizeTypedData(JSON.stringify(unidentifiedTokenTransfer))
		if (visualized.type !== 'Permit2SignatureTransfer') throw new Error(`Expected a Permit2 signature transfer, got ${ visualized.type }`)
		await assertShowsUnidentifiedTokenApproval(visualized, '1000000')
	})

	test('keeps the identified tokens of a PermitBatch formatted when another token is not an identified ERC20 token', async () => {
		const usdcAmount = '1461501637330902918203684832716283019655932542975'
		const batchWithUnidentifiedToken = JSON.parse(permit2PermitBatchMessage)
		batchWithUnidentifiedToken.message.details[1].token = unidentifiedTokenAddress
		const visualized = await visualizeTypedData(JSON.stringify(batchWithUnidentifiedToken))
		if (visualized.type !== 'Permit2Batch') throw new Error(`Expected a Permit2 batch, got ${ visualized.type }`)

		const text = await assertShowsUnidentifiedTokenApproval(visualized, '5000000')
		assertIncludesAll(text, ['Allow', 'To Spend', 'ALL', 'USDC'])
		assert.equal(text.includes(`Raw amount: ${ usdcAmount }`), false)

		const allTokensUnidentified = JSON.parse(permit2PermitBatchMessage)
		allTokensUnidentified.message.details[0].token = unidentifiedTokenAddress
		allTokensUnidentified.message.details[1].token = unidentifiedTokenAddress
		const allUnidentifiedText = await renderSignatureCardText(await visualizeTypedData(JSON.stringify(allTokensUnidentified)))
		assertIncludesAll(allUnidentifiedText, ['These permitted tokens are not identified ERC20 tokens', 'Spender: Uniswap Universal Router', `Raw amount: ${ usdcAmount }`, 'Raw amount: 5000000'])
		assert.equal(allUnidentifiedText.includes('To Spend'), false)
	})

	test('quarantines Permit2 transfers for a different chain than the active one', async () => {
		const visualized = await visualizeTypedData(permit2UniswapXWitnessTransferFromMessage, { ...mainnet, name: 'Goerli', chainId: 5n })
		if (visualized.type !== 'Permit2SignatureTransfer') throw new Error(`Expected a Permit2 signature transfer, got ${ visualized.type }`)
		assert.equal(visualized.quarantine, true)
		assert.equal(visualized.rpcNetwork.chainId, 1n)
		assert.deepEqual(visualized.quarantineReasons, ['The signature request is for a different chain (Ethereum Mainnet) than what is currently active (Goerli).'])
	})

	test('falls back to the generic EIP712 view when a Permit2 witness transfer does not match the Permit2 types', async () => {
		const visualized = await visualizeTypedData(permit2WitnessTransferFromWitnessNotLastMessage)
		if (visualized.type !== 'EIP712') throw new Error(`Expected a generic EIP712 message, got ${ visualized.type }`)
		assert.equal(identifySignature(visualized).title, 'Permit2 - PermitWitnessTransferFrom signing request')
		assert.deepEqual(Object.keys(visualized.message.message), ['permitted', 'spender', 'witness', 'nonce', 'deadline'])
	})

	test('classifies every SignatureTransfer primary type the same way for token grouping, witness lookup and naming', async () => {
		const expectedKinds = [
			{ typedData: permit2TransferFromMessage, primaryType: 'PermitTransferFrom', isBatch: false, hasWitness: false, tokenCount: 1 },
			{ typedData: permit2BatchTransferFromMessage, primaryType: 'PermitBatchTransferFrom', isBatch: true, hasWitness: false, tokenCount: 2 },
			{ typedData: permit2UniswapXWitnessTransferFromMessage, primaryType: 'PermitWitnessTransferFrom', isBatch: false, hasWitness: true, tokenCount: 1 },
			{ typedData: permit2BatchWitnessTransferFromMessage, primaryType: 'PermitBatchWitnessTransferFrom', isBatch: true, hasWitness: true, tokenCount: 2 },
		]
		for (const { typedData, ...expected } of expectedKinds) {
			const visualized = await visualizeTypedData(typedData)
			if (visualized.type !== 'Permit2SignatureTransfer') throw new Error(`Expected a Permit2 signature transfer, got ${ visualized.type }`)
			const { isBatch, hasWitness, permitted } = getPermit2SignatureTransferKind(visualized.message)
			assert.deepEqual({ primaryType: visualized.message.primaryType, isBatch, hasWitness, tokenCount: permitted.length }, expected)
			assert.deepEqual(visualized.permitted.map(({ token, amount }) => ({ token: token.address, amount })), permitted)
			assert.equal(visualized.witness !== undefined, hasWitness)
			assert.equal(identifySignature(visualized).title === 'Permit2 batch transfer', isBatch)
		}
	})

	test('finds the Permit2 witness field by name wherever it is declared and never takes a Permit2 field instead', () => {
		const permitted = { name: 'permitted', type: 'TokenPermissions' }
		const spender = { name: 'spender', type: 'address' }
		const nonce = { name: 'nonce', type: 'uint256' }
		const deadline = { name: 'deadline', type: 'uint256' }
		const witness = { name: 'witness', type: 'ExclusiveDutchOrder' }
		assert.deepEqual(findPermit2WitnessField([permitted, spender, nonce, deadline, witness]), witness)
		// The deadline is the fifth field in both of these, so a lookup by position would show the deadline as the witness.
		assert.deepEqual(findPermit2WitnessField([witness, permitted, spender, nonce, deadline]), witness)
		assert.deepEqual(findPermit2WitnessField([permitted, spender, nonce, witness, deadline]), witness)
		// A missing witness, an extra field that makes the witness ambiguous, or a witness named like a Permit2 field yields no witness instead of a guess.
		assert.equal(findPermit2WitnessField([permitted, spender, nonce, deadline]), undefined)
		assert.equal(findPermit2WitnessField([permitted, spender, nonce, deadline, witness, { name: 'salt', type: 'bytes32' }]), undefined)
		assert.equal(findPermit2WitnessField([permitted, spender, nonce, deadline, { name: 'deadline', type: 'uint256' }]), undefined)
	})
})
