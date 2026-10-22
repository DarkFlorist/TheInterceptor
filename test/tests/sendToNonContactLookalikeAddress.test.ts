import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getSendToNonContactWarnings, sendToNonContact } from '../../app/ts/simulation/protectors/sendToNonContactAddress.js'
import type { KnownAddress, KnownAddressIndex, KnownAddressIndexesLoader } from '../../app/ts/utils/lookalikeAddresses.js'
import { runProtectorsForTransaction } from '../../app/ts/simulation/protectorRunner.js'
import { updateUserAddressBookEntries } from '../../app/ts/background/storageVariables.js'
import { getKnownAddressIndexes, loadKnownAddressIndexesForChain } from '../../app/ts/background/lookalikeKnownAddresses.js'
import { findBundledMetadata } from '../../app/ts/background/bundledMetadata.js'
import type { AddressBookEntries, AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import type { EnrichedEthereumEvents } from '../../app/ts/types/EnrichedEthereumData.js'
import type { WebsiteCreatedEthereumTransaction } from '../../app/ts/types/visualizer-types.js'
import type { EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import { Erc20ABI } from '../../app/ts/utils/abi.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { addressString, checksummedAddress, stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { createOfflineMainnetEthereumClientService, failedMainnetSimulationState, installBrowserStorageMock } from './protectorTestHarness.js'
import { createIdentifyAddress, createTransaction, createTransferEvent, erc20Token, nativeToken, proxy, sender } from './sendToNonContactFixtures.js'

const alice: AddressBookEntry = {
	type: 'contact',
	name: 'Alice',
	address: 0xabcd000000000000000000000000000000001234n,
	entrySource: 'User',
}

// Shares the first four and last four hex characters with Alice, like an address poisoning address would.
const aliceLookalike: AddressBookEntry = {
	type: 'contact',
	name: checksummedAddress(0xabcdeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee1234n),
	address: 0xabcdeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee1234n,
	entrySource: 'OnChain',
}

const bob: AddressBookEntry = {
	type: 'safe',
	name: 'Bob Safe',
	address: 0xb0b0000000000000000000000000000000005678n,
	chainId: 1n,
	entrySource: 'User',
	useAsActiveAddress: true,
}

const bobLookalike: AddressBookEntry = {
	type: 'contact',
	name: checksummedAddress(0xb0b0ffffffffffffffffffffffffffffffff5678n),
	address: 0xb0b0ffffffffffffffffffffffffffffffff5678n,
	entrySource: 'OnChain',
}

// Two vetted entries that resemble each other, as can happen with vanity addresses of the same owner.
const aliceVanityTwin: AddressBookEntry = {
	type: 'contact',
	name: 'Alice vanity twin',
	address: 0xabcd111111111111111111111111111111111234n,
	entrySource: 'User',
}

// Automatically added entries are not vetted by the user and must not be imitation targets.
const autoDiscovered: AddressBookEntry = {
	type: 'contact',
	name: checksummedAddress(0xcafe00000000000000000000000000000000beefn),
	address: 0xcafe00000000000000000000000000000000beefn,
	entrySource: 'OnChain',
}

const autoDiscoveredLookalike: AddressBookEntry = {
	type: 'contact',
	name: checksummedAddress(0xcafe99999999999999999999999999999999beefn),
	address: 0xcafe99999999999999999999999999999999beefn,
	entrySource: 'OnChain',
}

const unrelatedUnknown: AddressBookEntry = {
	type: 'contact',
	name: 'Unrelated unknown',
	address: 0x4444444444444444444444444444444444444444n,
	entrySource: 'OnChain',
}

const WETH_ADDRESS = 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2n

const wethLookalike: AddressBookEntry = {
	type: 'contact',
	name: checksummedAddress(0xc02a000000000000000000000000000000006cc2n),
	address: 0xc02a000000000000000000000000000000006cc2n,
	entrySource: 'OnChain',
}

// identifyAddress returns a stored OnChain entry before bundled metadata, as for an address auto-added before the bundled metadata listed it.
const wethAsStoredOnChainEntry: AddressBookEntry = {
	type: 'contract',
	name: checksummedAddress(WETH_ADDRESS),
	address: WETH_ADDRESS,
	entrySource: 'OnChain',
}

// Some bundled tokens exist only under checksummed keys, which the bundled metadata lookup does not find, so identifyAddress reports them as OnChain.
const COMPOUND_PAX_DOLLAR_ADDRESS = 0x041171993284df560249b57358f931d9eb7b925dn

const compoundPaxDollarAsUnrecognized: AddressBookEntry = {
	type: 'ERC20',
	name: 'Compound Pax Dollar',
	symbol: 'cUSDP',
	decimals: 8n,
	address: COMPOUND_PAX_DOLLAR_ADDRESS,
	entrySource: 'OnChain',
}

const compoundPaxDollarLookalike: AddressBookEntry = {
	type: 'contact',
	name: checksummedAddress(0x041100000000000000000000000000000000925dn),
	address: 0x041100000000000000000000000000000000925dn,
	entrySource: 'OnChain',
}

const optimismContact: AddressBookEntry = {
	type: 'contact',
	name: 'Optimism contact',
	address: 0x5555555555555555555555555555555555555555n,
	chainId: 10n,
	entrySource: 'User',
}

const everyChainContact: AddressBookEntry = {
	type: 'contact',
	name: 'Every chain contact',
	address: 0x6666666666666666666666666666666666666666n,
	chainId: 'AllChains',
	entrySource: 'User',
}

const addressBook: AddressBookEntries = [sender, alice, bob, erc20Token, autoDiscovered]

const identifyAddress = createIdentifyAddress([sender, alice, aliceLookalike, bob, bobLookalike, aliceVanityTwin, autoDiscovered, autoDiscoveredLookalike, unrelatedUnknown, proxy, wethLookalike, wethAsStoredOnChainEntry, compoundPaxDollarAsUnrecognized, compoundPaxDollarLookalike, nativeToken, erc20Token])

const sendEtherTo = (destination: AddressBookEntry) => createTransaction({ to: destination.address })

const transferTokensTo = (destination: AddressBookEntry) => createTransaction({
	to: erc20Token.address,
	value: 0n,
	input: stringToUint8Array(encodeFunctionCall(Erc20ABI, 'transfer', [addressString(destination.address), 100n])),
})

const transferTokensFromSenderTo = (destination: AddressBookEntry) => createTransaction({
	to: erc20Token.address,
	value: 0n,
	input: stringToUint8Array(encodeFunctionCall(Erc20ABI, 'transferFrom', [addressString(sender.address), addressString(destination.address), 100n])),
})

const mainnetKnownAddressIndexes = getKnownAddressIndexes(addressBook, 1n)

const createCountingLoader = (knownAddressIndexes: readonly KnownAddressIndex[]) => {
	const counter = { loads: 0 }
	const loadKnownAddressIndexes: KnownAddressIndexesLoader = async () => {
		counter.loads += 1
		return knownAddressIndexes
	}
	return { counter, loadKnownAddressIndexes }
}

const getWarnings = async (transaction: EthereumUnsignedTransaction, events: EnrichedEthereumEvents = [], knownAddressIndexes: readonly KnownAddressIndex[] = mainnetKnownAddressIndexes) => (
	await getSendToNonContactWarnings(transaction, events, identifyAddress, async () => knownAddressIndexes)
)

const createWebsiteTransaction = (transaction: EthereumUnsignedTransaction): WebsiteCreatedEthereumTransaction => ({
	website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
	created: new Date('2024-01-01T00:00:00.000Z'),
	originalRequestParameters: { method: 'eth_sendTransaction', params: [{}] },
	transactionIdentifier: 1n,
	success: true,
	transaction,
})

const ADDRESS_POISONING_EXPLANATION = 'Scammers create addresses that share the first and last characters of addresses you use, hoping you copy the wrong one (address poisoning). Verify the full address before continuing.'

const expectedLookalikeWarning = (destination: AddressBookEntry, lookalikeOf: KnownAddress) => `This transaction sends funds to ${ checksummedAddress(destination.address) }, which looks like the address book entry "${ lookalikeOf.name }" (${ checksummedAddress(lookalikeOf.address) }) but is a different address. ${ ADDRESS_POISONING_EXPLANATION }`

const expectedNotInAddressBookWarning = (destination: AddressBookEntry) => `This transaction sends funds to "${ destination.name }", which is not in the addressbook. Please add the address to addressbook to dismiss this error in the future.`

const expectedAliceLookalikeWarning = expectedLookalikeWarning(aliceLookalike, alice)

const proxyMultisendTo = (destinations: readonly AddressBookEntry[]) => [
	createTransferEvent({ from: sender, to: proxy, amount: 100n * BigInt(destinations.length) }),
	...destinations.map((destination) => createTransferEvent({ from: proxy, to: destination, amount: 100n })),
]

describe('sendToNonContact lookalike destinations', () => {
	test('warns about an ether send to a lookalike with only the address poisoning warning, naming the imitated entry and showing both full addresses', async () => {
		assert.deepEqual(await getWarnings(sendEtherTo(aliceLookalike)), [expectedAliceLookalikeWarning])
	})

	test('does not warn when sending to the exact address book entry', async () => {
		assert.deepEqual(await getWarnings(sendEtherTo(alice)), [])
	})

	test('gives an unknown address that does not resemble a known address only the not in address book warning', async () => {
		assert.deepEqual(await getWarnings(sendEtherTo(unrelatedUnknown)), [expectedNotInAddressBookWarning(unrelatedUnknown)])
	})

	test('does not warn about a vetted entry that resembles another vetted entry', async () => {
		const knownAddressIndexes = getKnownAddressIndexes([...addressBook, aliceVanityTwin], 1n)

		assert.deepEqual(await getWarnings(sendEtherTo(aliceVanityTwin), [], knownAddressIndexes), [])
	})

	test('does not treat automatically added OnChain entries as imitation targets', async () => {
		assert.deepEqual(await getWarnings(sendEtherTo(autoDiscoveredLookalike)), [expectedNotInAddressBookWarning(autoDiscoveredLookalike)])
	})

	test('warns about direct token transfer and transferFrom calls to a lookalike', async () => {
		assert.deepEqual(await getWarnings(transferTokensTo(bobLookalike)), [expectedLookalikeWarning(bobLookalike, bob)])
		assert.deepEqual(await getWarnings(transferTokensFromSenderTo(bobLookalike)), [expectedLookalikeWarning(bobLookalike, bob)])
	})

	test('warns about the final recipient of a proxied token transfer instead of the proxy', async () => {
		const warnings = await getWarnings(createTransaction({ input: new Uint8Array([1, 2, 3, 4]), value: 0n }), [
			createTransferEvent({ from: sender, to: proxy, amount: 100n, token: erc20Token }),
			createTransferEvent({ from: proxy, to: aliceLookalike, amount: 100n, token: erc20Token }),
		])

		assert.deepEqual(warnings, [expectedAliceLookalikeWarning])
	})

	test('lists every lookalike destination of a proxy multisend in one warning and the other unknown destination in a separate warning', async () => {
		const warnings = await getWarnings(createTransaction(), proxyMultisendTo([aliceLookalike, unrelatedUnknown, bobLookalike]))

		assert.deepEqual(warnings, [
			`This transaction sends funds to ${ checksummedAddress(aliceLookalike.address) }, which looks like the address book entry "Alice" (${ checksummedAddress(alice.address) }); and to ${ checksummedAddress(bobLookalike.address) }, which looks like the address book entry "Bob Safe" (${ checksummedAddress(bob.address) }) but these are different addresses. ${ ADDRESS_POISONING_EXPLANATION }`,
			expectedNotInAddressBookWarning(unrelatedUnknown),
		])
	})

	test('compares addresses regardless of checksum casing', async () => {
		const knownAddressIndexes = getKnownAddressIndexes([{ ...alice, address: BigInt('0xAbCd000000000000000000000000000000001234') }], 10n)
		const upperCaseLookalike: AddressBookEntry = { ...aliceLookalike, address: BigInt('0xABCDEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE1234') }

		assert.deepEqual(await getWarnings(sendEtherTo(upperCaseLookalike), [], knownAddressIndexes), [expectedLookalikeWarning(upperCaseLookalike, alice)])
	})

	test('compares bundled mainnet metadata only on mainnet', async () => {
		const mainnetWarnings = await getWarnings(sendEtherTo(wethLookalike))
		const otherChainWarnings = await getWarnings(sendEtherTo(wethLookalike), [], getKnownAddressIndexes(addressBook, 10n))

		assert.deepEqual(mainnetWarnings, [expectedLookalikeWarning(wethLookalike, { name: 'WETH', address: WETH_ADDRESS })])
		assert.deepEqual(otherChainWarnings, [expectedNotInAddressBookWarning(wethLookalike)])
	})

	test('does not flag a stored OnChain entry that is exactly a bundled address as its lookalike', async () => {
		assert.deepEqual(await getWarnings(sendEtherTo(wethAsStoredOnChainEntry)), [expectedNotInAddressBookWarning(wethAsStoredOnChainEntry)])
	})

	test('treats bundled tokens stored only under checksummed keys as unknown, like identifyAddress does', async () => {
		const lookalikeWarnings = await getWarnings(sendEtherTo(compoundPaxDollarLookalike))
		const exactWarnings = await getWarnings(sendEtherTo(compoundPaxDollarAsUnrecognized))

		assert.equal(findBundledMetadata(COMPOUND_PAX_DOLLAR_ADDRESS), undefined)
		assert.deepEqual(lookalikeWarnings, [expectedNotInAddressBookWarning(compoundPaxDollarLookalike)])
		assert.deepEqual(exactWarnings, [expectedNotInAddressBookWarning(compoundPaxDollarAsUnrecognized)])
	})

	test('does not load the address book when no destination is unrecognized', async () => {
		const contractCallWithoutTransfers = createTransaction({ input: new Uint8Array([1, 2, 3, 4]), value: 0n })
		for (const transaction of [contractCallWithoutTransfers, sendEtherTo(alice)]) {
			const { counter, loadKnownAddressIndexes } = createCountingLoader(mainnetKnownAddressIndexes)

			assert.deepEqual(await getSendToNonContactWarnings(transaction, [], identifyAddress, loadKnownAddressIndexes), [])
			assert.equal(counter.loads, 0)
		}
	})

	test('loads the address book once for a transaction with both a lookalike and an unrelated unknown destination', async () => {
		const { counter, loadKnownAddressIndexes } = createCountingLoader(mainnetKnownAddressIndexes)

		const warnings = await getSendToNonContactWarnings(createTransaction(), proxyMultisendTo([aliceLookalike, unrelatedUnknown]), identifyAddress, loadKnownAddressIndexes)

		assert.deepEqual(warnings, [expectedAliceLookalikeWarning, expectedNotInAddressBookWarning(unrelatedUnknown)])
		assert.equal(counter.loads, 1)
	})
})

// sendToNonContact alone decides both destination warnings, so these check its output directly and through the runner, where no other protector adds lookalike reasons.
describe('sendToNonContact with the stored address book', () => {
	const runWithStoredAddressBook = async (transaction: EthereumUnsignedTransaction, events: EnrichedEthereumEvents = []) => {
		installBrowserStorageMock()
		// The unknown destinations were auto-added as OnChain entries when the extension first saw them, which is also how identifyAddress resolves them without RPC calls.
		await updateUserAddressBookEntries(() => [sender, alice, aliceLookalike, unrelatedUnknown, proxy])
		const ethereum = createOfflineMainnetEthereumClientService()
		const protectorWarnings = await sendToNonContact(transaction, ethereum, undefined, failedMainnetSimulationState, Promise.resolve(events))
		const runnerResult = await runProtectorsForTransaction(failedMainnetSimulationState, createWebsiteTransaction(transaction), ethereum, undefined, Promise.resolve(events))
		return { protectorWarnings, runnerResult }
	}

	test('warns about a lookalike destination with the address poisoning warning and never advises adding it to the address book', async () => {
		const { protectorWarnings, runnerResult } = await runWithStoredAddressBook(sendEtherTo(aliceLookalike))

		assert.deepEqual(protectorWarnings, [expectedAliceLookalikeWarning])
		assert.deepEqual(runnerResult, { quarantine: true, quarantineReasons: [expectedAliceLookalikeWarning] })
	})

	test('reports a lookalike and an unrelated unknown destination of the same transaction as separate quarantine reasons', async () => {
		const { protectorWarnings, runnerResult } = await runWithStoredAddressBook(createTransaction(), proxyMultisendTo([aliceLookalike, unrelatedUnknown]))
		const expectedWarnings = [expectedAliceLookalikeWarning, expectedNotInAddressBookWarning(unrelatedUnknown)]

		assert.deepEqual(protectorWarnings, expectedWarnings)
		assert.deepEqual(runnerResult, { quarantine: true, quarantineReasons: expectedWarnings })
	})

	test('reports only the not in address book warning for an unknown destination that resembles no known address', async () => {
		const { protectorWarnings, runnerResult } = await runWithStoredAddressBook(sendEtherTo(unrelatedUnknown))

		assert.deepEqual(protectorWarnings, [expectedNotInAddressBookWarning(unrelatedUnknown)])
		assert.deepEqual(runnerResult, { quarantine: true, quarantineReasons: [expectedNotInAddressBookWarning(unrelatedUnknown)] })
	})

	test('does not read the stored address book for a transaction without fund destinations', async () => {
		const { readStorageKeys } = installBrowserStorageMock()
		const zeroValueSendWithoutCalldata = createTransaction({ to: aliceLookalike.address, value: 0n })

		const warnings = await sendToNonContact(zeroValueSendWithoutCalldata, createOfflineMainnetEthereumClientService(), undefined, failedMainnetSimulationState, Promise.resolve([]))

		assert.deepEqual(warnings, [])
		assert.equal(readStorageKeys.includes('userAddressBookEntriesV3'), false)
	})
})

describe('loadKnownAddressIndexesForChain', () => {
	// The index keeps whole address book entries, so only the fields a warning uses are compared.
	const toNameAndAddress = ({ name, address }: KnownAddress): KnownAddress => ({ name, address })
	// Lists the indexed addresses in insertion order, which decides the entry a warning names when several share a lookalike key.
	const listKnownAddresses = (index: KnownAddressIndex) => Array.from(index.values()).flat().map(toNameAndAddress)

	test('indexes the vetted stored entries of the chain with chain specific entries first, and adds the bundled metadata only on mainnet', async () => {
		installBrowserStorageMock()
		await updateUserAddressBookEntries(() => [alice, everyChainContact, autoDiscovered, optimismContact, bob])

		const mainnetIndexes = await loadKnownAddressIndexesForChain(1n)
		const optimismIndexes = await loadKnownAddressIndexesForChain(10n)

		assert.deepEqual(mainnetIndexes.slice(0, 1).map(listKnownAddresses), [[bob, alice, everyChainContact].map(toNameAndAddress)])
		// On mainnet the bundled metadata index follows the address book index.
		assert.deepEqual(mainnetIndexes.slice(1), getKnownAddressIndexes([], 1n).slice(1))
		assert.deepEqual(optimismIndexes.map(listKnownAddresses), [[optimismContact, everyChainContact].map(toNameAndAddress)])
	})
})
