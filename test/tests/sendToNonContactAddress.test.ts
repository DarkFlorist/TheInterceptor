import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getSendToNonContactWarning } from '../../app/ts/simulation/protectors/sendToNonContactAddress.js'
import type { AddressBookEntry, Erc20TokenEntry } from '../../app/ts/types/addressBookTypes.js'
import type { EnrichedEthereumEvent, EnrichedEthereumEvents } from '../../app/ts/types/EnrichedEthereumData.js'
import type { EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS } from '../../app/ts/utils/constants.js'

const sender: AddressBookEntry = {
	type: 'contact',
	name: 'Sender',
	address: 0x1111111111111111111111111111111111111111n,
	entrySource: 'User',
}

const proxy: AddressBookEntry = {
	type: 'contract',
	name: 'Unknown proxy',
	address: 0x2222222222222222222222222222222222222222n,
	entrySource: 'OnChain',
}

const knownRecipient: AddressBookEntry = {
	type: 'contact',
	name: 'Known recipient',
	address: 0x3333333333333333333333333333333333333333n,
	entrySource: 'User',
}

const unknownRecipient: AddressBookEntry = {
	type: 'contact',
	name: 'Unknown recipient',
	address: 0x4444444444444444444444444444444444444444n,
	entrySource: 'OnChain',
}

const secondUnknownRecipient: AddressBookEntry = {
	type: 'contact',
	name: 'Second unknown recipient',
	address: 0x5555555555555555555555555555555555555555n,
	entrySource: 'OnChain',
}

const knownNonContractIntermediate: AddressBookEntry = {
	type: 'contact',
	name: 'Known intermediary',
	address: 0x6666666666666666666666666666666666666666n,
	entrySource: 'User',
}

const nativeToken: Erc20TokenEntry = {
	type: 'ERC20',
	name: 'Ether',
	symbol: 'ETH',
	decimals: 18n,
	address: ETHEREUM_LOGS_LOGGER_ADDRESS,
	entrySource: 'Interceptor',
}

const erc20Token: Erc20TokenEntry = {
	type: 'ERC20',
	name: 'Token',
	symbol: 'TKN',
	decimals: 18n,
	address: 0x7777777777777777777777777777777777777777n,
	entrySource: 'User',
}

const allEntries = [sender, proxy, knownRecipient, unknownRecipient, secondUnknownRecipient, knownNonContractIntermediate, nativeToken, erc20Token]
const entriesByAddress = new Map(allEntries.map((entry) => [entry.address, entry]))

const identifyAddress = async (address: bigint) => {
	const entry = entriesByAddress.get(address)
	if (entry === undefined) throw new Error(`Missing test address ${ address }`)
	return entry
}

const createTransaction = ({ input = new Uint8Array(), value = 100n, to = proxy.address }: {
	input?: Uint8Array
	value?: bigint
	to?: bigint
} = {}): EthereumUnsignedTransaction => ({
	type: '1559',
	from: sender.address,
	nonce: 1n,
	maxFeePerGas: 1n,
	maxPriorityFeePerGas: 1n,
	gas: 100_000n,
	to,
	value,
	input,
	chainId: 1n,
})

const createTransferEvent = ({
	from,
	to,
	amount,
	token = nativeToken,
}: {
	from: AddressBookEntry
	to: AddressBookEntry
	amount: bigint
	token?: Erc20TokenEntry
}): EnrichedEthereumEvent => ({
	type: 'TokenEvent',
	isParsed: 'Parsed',
	name: 'Transfer',
	signature: 'Transfer(address,address,uint256)',
	args: [],
	address: token.address,
	loggersAddressBookEntry: token,
	data: new Uint8Array(),
	topics: [],
	logInformation: {
		type: 'ERC20',
		from: from.address,
		to: to.address,
		tokenAddress: token.address,
		amount,
		isApproval: false,
	},
})

const getWarning = async (transaction: EthereumUnsignedTransaction, events: EnrichedEthereumEvents) => (
	await getSendToNonContactWarning(transaction, events, identifyAddress)
)

describe('sendToNonContact proxy transfers', () => {
	test('does not warn about an unknown proxy when the final recipient is known', async () => {
		const warning = await getWarning(createTransaction(), [
			createTransferEvent({ from: sender, to: proxy, amount: 100n }),
			createTransferEvent({ from: proxy, to: knownRecipient, amount: 95n }),
		])

		assert.equal(warning, undefined)
	})

	test('warns about the unknown final recipient instead of the proxy', async () => {
		const warning = await getWarning(createTransaction(), [
			createTransferEvent({ from: sender, to: proxy, amount: 100n }),
			createTransferEvent({ from: proxy, to: unknownRecipient, amount: 100n }),
		])

		assert.equal(warning?.includes('Unknown recipient'), true)
		assert.equal(warning?.includes('Unknown proxy'), false)
	})

	test('checks final recipients for proxy calls with calldata', async () => {
		const warning = await getWarning(createTransaction({ input: new Uint8Array([1, 2, 3, 4]) }), [
			createTransferEvent({ from: sender, to: proxy, amount: 100n }),
			createTransferEvent({ from: proxy, to: unknownRecipient, amount: 95n }),
		])

		assert.equal(warning?.includes('Unknown recipient'), true)
	})

	test('checks every final recipient of a proxy multisend', async () => {
		const warning = await getWarning(createTransaction(), [
			createTransferEvent({ from: sender, to: proxy, amount: 100n }),
			createTransferEvent({ from: proxy, to: unknownRecipient, amount: 50n }),
			createTransferEvent({ from: proxy, to: secondUnknownRecipient, amount: 50n }),
		])

		assert.equal(warning?.includes('Unknown recipient'), true)
		assert.equal(warning?.includes('Second unknown recipient'), true)
	})

	test('checks proxied ERC20 transfer recipients', async () => {
		const warning = await getWarning(createTransaction({ input: new Uint8Array([1, 2, 3, 4]), value: 0n }), [
			createTransferEvent({ from: sender, to: proxy, amount: 100n, token: erc20Token }),
			createTransferEvent({ from: proxy, to: unknownRecipient, amount: 100n, token: erc20Token }),
		])

		assert.equal(warning?.includes('Unknown recipient'), true)
	})

	test('retains the immediate-recipient fallback for unrecognized routes', async () => {
		const warning = await getWarning(createTransaction({ to: knownNonContractIntermediate.address }), [
			createTransferEvent({ from: sender, to: knownNonContractIntermediate, amount: 100n }),
			createTransferEvent({ from: knownNonContractIntermediate, to: unknownRecipient, amount: 100n }),
		])

		assert.equal(warning, undefined)
	})

	test('retains the warning for direct transfers to unknown recipients', async () => {
		const warning = await getWarning(createTransaction({ to: unknownRecipient.address }), [])

		assert.equal(warning?.includes('Unknown recipient'), true)
	})
})
