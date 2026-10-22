import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getSendToNonContactWarnings } from '../../app/ts/simulation/protectors/sendToNonContactAddress.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import type { EnrichedEthereumEvents } from '../../app/ts/types/EnrichedEthereumData.js'
import type { EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import { createIdentifyAddress, createTransaction, createTransferEvent, erc20Token, nativeToken, proxy, sender } from './sendToNonContactFixtures.js'

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

const identifyAddress = createIdentifyAddress([sender, proxy, knownRecipient, unknownRecipient, secondUnknownRecipient, knownNonContractIntermediate, nativeToken, erc20Token])

// No known addresses are loaded, so no destination is a lookalike and the protector reports at most the not in address book warning.
const getWarning = async (transaction: EthereumUnsignedTransaction, events: EnrichedEthereumEvents) => {
	const warnings = await getSendToNonContactWarnings(transaction, events, identifyAddress, async () => [])
	assert.deepEqual(warnings.slice(1), [], `expected at most one warning, got ${ JSON.stringify(warnings) }`)
	return warnings[0]
}

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
