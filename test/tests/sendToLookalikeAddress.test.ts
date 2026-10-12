import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { tokenMetadata } from '@darkflorist/address-metadata'
import { getSendToLookalikeAddressWarning, sendToLookalikeAddress } from '../../app/ts/simulation/protectors/sendToLookalikeAddress.js'
import { getSendToNonContactWarning, sendToNonContact } from '../../app/ts/simulation/protectors/sendToNonContactAddress.js'
import { createKnownAddressIndexesLoader, getKnownAddressIndexes, type KnownAddressIndex, type KnownAddressIndexesLoader } from '../../app/ts/simulation/lookalikeAddresses.js'
import { runProtectorsForTransaction } from '../../app/ts/simulation/protectorRunner.js'
import { updateUserAddressBookEntries } from '../../app/ts/background/storageVariables.js'
import type { AddressBookEntries, AddressBookEntry, Erc20TokenEntry } from '../../app/ts/types/addressBookTypes.js'
import type { EnrichedEthereumEvent, EnrichedEthereumEvents } from '../../app/ts/types/EnrichedEthereumData.js'
import type { WebsiteCreatedEthereumTransaction } from '../../app/ts/types/visualizer-types.js'
import type { EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { addressString, checksummedAddress, stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS } from '../../app/ts/utils/constants.js'
import type { Abi } from '../../app/ts/utils/ethereumPrimitives.js'
import { createOfflineMainnetEthereumClientService, failedMainnetSimulationState, installBrowserStorageMock } from './protectorTestHarness.js'

const sender: AddressBookEntry = {
	type: 'contact',
	name: 'Sender',
	address: 0x1111111111111111111111111111111111111111n,
	entrySource: 'User',
}

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

const proxy: AddressBookEntry = {
	type: 'contract',
	name: 'Unknown proxy',
	address: 0x2222222222222222222222222222222222222222n,
	entrySource: 'OnChain',
}

const WETH_ADDRESS = 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2n

const wethLookalike: AddressBookEntry = {
	type: 'contact',
	name: checksummedAddress(0xc02a000000000000000000000000000000006cc2n),
	address: 0xc02a000000000000000000000000000000006cc2n,
	entrySource: 'OnChain',
}

// Some bundled tokens exist only under checksummed keys, which identifyAddress looks up in lower case, so it reports them as OnChain.
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

const addressBook: AddressBookEntries = [sender, alice, bob, erc20Token, autoDiscovered]

const identifiableEntries = [sender, alice, aliceLookalike, bob, bobLookalike, aliceVanityTwin, autoDiscovered, autoDiscoveredLookalike, unrelatedUnknown, proxy, wethLookalike, compoundPaxDollarAsUnrecognized, compoundPaxDollarLookalike, nativeToken, erc20Token]
const entriesByAddress = new Map(identifiableEntries.map((entry) => [entry.address, entry]))

const identifyAddress = async (address: bigint) => {
	const entry = entriesByAddress.get(address)
	if (entry === undefined) throw new Error(`Missing test address ${ address }`)
	return entry
}

const transferAbi = [
	{
		type: 'function',
		name: 'transfer',
		stateMutability: 'nonpayable',
		inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }],
		outputs: [{ name: 'success', type: 'bool' }],
	},
	{
		type: 'function',
		name: 'transferFrom',
		stateMutability: 'nonpayable',
		inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }],
		outputs: [{ name: 'success', type: 'bool' }],
	},
] as const satisfies Abi

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

const sendEtherTo = (destination: AddressBookEntry) => createTransaction({ to: destination.address })

const transferTokensTo = (destination: AddressBookEntry) => createTransaction({
	to: erc20Token.address,
	value: 0n,
	input: stringToUint8Array(encodeFunctionCall(transferAbi, 'transfer', [addressString(destination.address), 100n])),
})

const transferTokensFromSenderTo = (destination: AddressBookEntry) => createTransaction({
	to: erc20Token.address,
	value: 0n,
	input: stringToUint8Array(encodeFunctionCall(transferAbi, 'transferFrom', [addressString(sender.address), addressString(destination.address), 100n])),
})

const createTransferEvent = ({ from, to, amount, token = nativeToken }: {
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

const mainnetKnownAddressIndexes = getKnownAddressIndexes(addressBook, 1n)

const createCountingLoader = (knownAddressIndexes: readonly KnownAddressIndex[]) => {
	const counter = { loads: 0 }
	const loadKnownAddressIndexes: KnownAddressIndexesLoader = async () => {
		counter.loads += 1
		return knownAddressIndexes
	}
	return { counter, loadKnownAddressIndexes }
}

const getLookalikeWarning = async (transaction: EthereumUnsignedTransaction, events: EnrichedEthereumEvents = [], knownAddressIndexes: readonly KnownAddressIndex[] = mainnetKnownAddressIndexes) => (
	await getSendToLookalikeAddressWarning(transaction, events, identifyAddress, async () => knownAddressIndexes)
)

const getNonContactWarning = async (transaction: EthereumUnsignedTransaction, events: EnrichedEthereumEvents = []) => (
	await getSendToNonContactWarning(transaction, events, identifyAddress, async () => mainnetKnownAddressIndexes)
)

const createWebsiteTransaction = (transaction: EthereumUnsignedTransaction): WebsiteCreatedEthereumTransaction => ({
	website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
	created: new Date('2024-01-01T00:00:00.000Z'),
	originalRequestParameters: { method: 'eth_sendTransaction', params: [{}] },
	transactionIdentifier: 1n,
	success: true,
	transaction,
})

const expectedAliceLookalikeWarning = `This transaction sends funds to ${ checksummedAddress(aliceLookalike.address) }, which looks like the address book entry "Alice" (${ checksummedAddress(alice.address) }) but is a different address. Scammers create addresses that share the first and last characters of addresses you use, hoping you copy the wrong one (address poisoning). Verify the full address before continuing.`

describe('sendToLookalikeAddress', () => {
	test('warns about an ether send to a lookalike, naming the imitated entry and showing both full addresses', async () => {
		assert.equal(await getLookalikeWarning(sendEtherTo(aliceLookalike)), expectedAliceLookalikeWarning)
	})

	test('does not warn when sending to the exact address book entry', async () => {
		assert.equal(await getLookalikeWarning(sendEtherTo(alice)), undefined)
	})

	test('does not warn about unknown addresses that do not resemble a known address', async () => {
		assert.equal(await getLookalikeWarning(sendEtherTo(unrelatedUnknown)), undefined)
	})

	test('does not warn about a vetted entry that resembles another vetted entry', async () => {
		const knownAddressIndexes = getKnownAddressIndexes([...addressBook, aliceVanityTwin], 1n)

		assert.equal(await getLookalikeWarning(sendEtherTo(aliceVanityTwin), [], knownAddressIndexes), undefined)
	})

	test('does not treat automatically added OnChain entries as imitation targets', async () => {
		assert.equal(await getLookalikeWarning(sendEtherTo(autoDiscoveredLookalike)), undefined)
	})

	test('warns about direct token transfer and transferFrom calls to a lookalike', async () => {
		const transferWarning = await getLookalikeWarning(transferTokensTo(bobLookalike))
		const transferFromWarning = await getLookalikeWarning(transferTokensFromSenderTo(bobLookalike))

		assert.equal(transferWarning?.includes(`"Bob Safe" (${ checksummedAddress(bob.address) })`), true)
		assert.equal(transferFromWarning?.includes(`"Bob Safe" (${ checksummedAddress(bob.address) })`), true)
	})

	test('warns about the final recipient of a proxied token transfer', async () => {
		const warning = await getLookalikeWarning(createTransaction({ input: new Uint8Array([1, 2, 3, 4]), value: 0n }), [
			createTransferEvent({ from: sender, to: proxy, amount: 100n, token: erc20Token }),
			createTransferEvent({ from: proxy, to: aliceLookalike, amount: 100n, token: erc20Token }),
		])

		assert.equal(warning?.includes(checksummedAddress(aliceLookalike.address)), true)
		assert.equal(warning?.includes('"Alice"'), true)
		assert.equal(warning?.includes(checksummedAddress(proxy.address)), false)
	})

	test('lists every lookalike destination of a proxy multisend', async () => {
		const warning = await getLookalikeWarning(createTransaction(), [
			createTransferEvent({ from: sender, to: proxy, amount: 100n }),
			createTransferEvent({ from: proxy, to: aliceLookalike, amount: 40n }),
			createTransferEvent({ from: proxy, to: unrelatedUnknown, amount: 20n }),
			createTransferEvent({ from: proxy, to: bobLookalike, amount: 40n }),
		])

		assert.equal(
			warning,
			`This transaction sends funds to ${ checksummedAddress(aliceLookalike.address) }, which looks like the address book entry "Alice" (${ checksummedAddress(alice.address) }); and to ${ checksummedAddress(bobLookalike.address) }, which looks like the address book entry "Bob Safe" (${ checksummedAddress(bob.address) }) but these are different addresses. Scammers create addresses that share the first and last characters of addresses you use, hoping you copy the wrong one (address poisoning). Verify the full address before continuing.`,
		)
	})

	test('compares addresses regardless of checksum casing', async () => {
		const knownAddressIndexes = getKnownAddressIndexes([{ ...alice, address: BigInt('0xAbCd000000000000000000000000000000001234') }], 10n)
		const upperCaseLookalike: AddressBookEntry = { ...aliceLookalike, address: BigInt('0xABCDEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE1234') }

		assert.equal((await getLookalikeWarning(sendEtherTo(upperCaseLookalike), [], knownAddressIndexes))?.includes('"Alice"'), true)
	})

	test('compares bundled mainnet metadata only on mainnet', async () => {
		const mainnetWarning = await getLookalikeWarning(sendEtherTo(wethLookalike))
		const otherChainWarning = await getLookalikeWarning(sendEtherTo(wethLookalike), [], getKnownAddressIndexes(addressBook, 10n))

		assert.equal(mainnetWarning?.includes(`"WETH" (${ checksummedAddress(WETH_ADDRESS) })`), true)
		assert.equal(otherChainWarning, undefined)
	})

	test('matches bundled tokens stored only under checksummed keys and never flags their exact address', async () => {
		const lookalikeWarning = await getLookalikeWarning(sendEtherTo(compoundPaxDollarLookalike))
		const exactWarning = await getLookalikeWarning(sendEtherTo(compoundPaxDollarAsUnrecognized))

		assert.equal(tokenMetadata.has(checksummedAddress(COMPOUND_PAX_DOLLAR_ADDRESS)), true)
		assert.equal(tokenMetadata.has(addressString(COMPOUND_PAX_DOLLAR_ADDRESS)), false)
		assert.equal(lookalikeWarning?.includes(`"Compound Pax Dollar" (${ checksummedAddress(COMPOUND_PAX_DOLLAR_ADDRESS) })`), true)
		assert.equal(exactWarning, undefined)
	})

	test('does not load the address book when no destination is unrecognized', async () => {
		const contractCallWithoutTransfers = createTransaction({ input: new Uint8Array([1, 2, 3, 4]), value: 0n })
		for (const transaction of [contractCallWithoutTransfers, sendEtherTo(alice)]) {
			const lookalikeLoader = createCountingLoader(mainnetKnownAddressIndexes)
			const nonContactLoader = createCountingLoader(mainnetKnownAddressIndexes)

			assert.equal(await getSendToLookalikeAddressWarning(transaction, [], identifyAddress, lookalikeLoader.loadKnownAddressIndexes), undefined)
			assert.equal(await getSendToNonContactWarning(transaction, [], identifyAddress, nonContactLoader.loadKnownAddressIndexes), undefined)
			assert.equal(lookalikeLoader.counter.loads, 0)
			assert.equal(nonContactLoader.counter.loads, 0)
		}
	})

	test('loads the address book once when an unrecognized destination needs comparing', async () => {
		const { counter, loadKnownAddressIndexes } = createCountingLoader(mainnetKnownAddressIndexes)

		assert.equal(await getSendToLookalikeAddressWarning(sendEtherTo(aliceLookalike), [], identifyAddress, loadKnownAddressIndexes), expectedAliceLookalikeWarning)
		assert.equal(counter.loads, 1)
	})
})

describe('sendToNonContact with lookalike destinations', () => {
	test('leaves lookalike destinations to the lookalike warning instead of suggesting to add them to the address book', async () => {
		assert.equal(await getNonContactWarning(sendEtherTo(aliceLookalike)), undefined)
		assert.equal((await getNonContactWarning(sendEtherTo(unrelatedUnknown)))?.includes('Unrelated unknown'), true)
	})

	test('still reports other unknown destinations of the same transaction', async () => {
		const events = [
			createTransferEvent({ from: sender, to: proxy, amount: 100n }),
			createTransferEvent({ from: proxy, to: aliceLookalike, amount: 50n }),
			createTransferEvent({ from: proxy, to: unrelatedUnknown, amount: 50n }),
		]
		const nonContactWarning = await getNonContactWarning(createTransaction(), events)
		const lookalikeWarning = await getLookalikeWarning(createTransaction(), events)

		assert.equal(nonContactWarning?.includes('Unrelated unknown'), true)
		assert.equal(nonContactWarning?.includes(aliceLookalike.name), false)
		assert.equal(lookalikeWarning?.includes('"Alice"'), true)
		assert.equal(lookalikeWarning?.includes(checksummedAddress(unrelatedUnknown.address)), false)
	})
})

describe('lookalike protectors with the stored address book', () => {
	test('quarantines a lookalike of a stored entry with only the lookalike warning when run through the protector runner', async () => {
		installBrowserStorageMock()
		// The lookalike was auto-added as an OnChain entry when the extension first saw it, which is also how identifyAddress resolves it without RPC calls.
		await updateUserAddressBookEntries(() => [sender, alice, aliceLookalike])

		const result = await runProtectorsForTransaction(failedMainnetSimulationState, createWebsiteTransaction(sendEtherTo(aliceLookalike)), createOfflineMainnetEthereumClientService(), undefined, Promise.resolve([]))

		assert.deepEqual(result, { quarantine: true, quarantineReasons: [expectedAliceLookalikeWarning] })
	})

	test('flags the lookalike through sendToLookalikeAddress and not through sendToNonContact', async () => {
		installBrowserStorageMock()
		await updateUserAddressBookEntries(() => [sender, alice, aliceLookalike])
		const ethereum = createOfflineMainnetEthereumClientService()
		const loadKnownAddressIndexes = createKnownAddressIndexesLoader(1n)
		const transaction = sendEtherTo(aliceLookalike)

		assert.equal(await sendToLookalikeAddress(transaction, ethereum, undefined, failedMainnetSimulationState, Promise.resolve([]), loadKnownAddressIndexes), expectedAliceLookalikeWarning)
		assert.equal(await sendToNonContact(transaction, ethereum, undefined, failedMainnetSimulationState, Promise.resolve([]), loadKnownAddressIndexes), undefined)
	})

	test('shares one address book load between callers of the same loader', async () => {
		installBrowserStorageMock()
		await updateUserAddressBookEntries(() => [sender, alice])
		const loadKnownAddressIndexes = createKnownAddressIndexesLoader(1n)

		const [firstLoad, secondLoad] = await Promise.all([loadKnownAddressIndexes(), loadKnownAddressIndexes()])

		assert.strictEqual(firstLoad, secondLoad)
	})

	test('does not read the stored address book for a transaction without fund destinations', async () => {
		const { readStorageKeys } = installBrowserStorageMock()
		const zeroValueSendWithoutCalldata = createTransaction({ to: aliceLookalike.address, value: 0n })

		const result = await runProtectorsForTransaction(failedMainnetSimulationState, createWebsiteTransaction(zeroValueSendWithoutCalldata), createOfflineMainnetEthereumClientService(), undefined, Promise.resolve([]))

		assert.deepEqual(result, { quarantine: false, quarantineReasons: [] })
		assert.equal(readStorageKeys.includes('userAddressBookEntriesV3'), false)
	})
})
