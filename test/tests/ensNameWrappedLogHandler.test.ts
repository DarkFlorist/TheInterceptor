import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { handleNameWrapped } from '../../app/ts/simulation/logHandlers.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import type { ParsedEvent } from '../../app/ts/types/EnrichedEthereumData.js'

const nameWrapper: AddressBookEntry = {
	type: 'contract',
	name: 'ENS Name Wrapper',
	address: 0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401n,
	entrySource: 'User',
}

const owner = 0x1111111111111111111111111111111111111111n
const node = new Uint8Array(32).fill(0xab)

// DNS wire format: each label is prefixed with its byte length and the name ends with a zero-length label.
const dnsEncode = (labels: readonly string[]) => {
	const textEncoder = new TextEncoder()
	const encodedLabels = labels.flatMap((label) => {
		const labelBytes = textEncoder.encode(label)
		return [labelBytes.length, ...labelBytes]
	})
	return new Uint8Array([...encodedLabels, 0])
}

const nameWrappedEvent = (encodedName: Uint8Array): ParsedEvent => ({
	isParsed: 'Parsed',
	name: 'NameWrapped',
	signature: 'NameWrapped(bytes32,bytes,address,uint32,uint64)',
	args: [
		{ paramName: 'node', typeValue: { type: 'fixedBytes', value: node } },
		{ paramName: 'name', typeValue: { type: 'bytes', value: encodedName } },
		{ paramName: 'owner', typeValue: { type: 'address', value: owner } },
		{ paramName: 'fuses', typeValue: { type: 'unsignedInteger', value: 0n } },
		{ paramName: 'expiry', typeValue: { type: 'unsignedInteger', value: 1_800_000_000n } },
	],
	address: nameWrapper.address,
	loggersAddressBookEntry: nameWrapper,
	data: new Uint8Array(),
	topics: [],
})

describe('ENS NameWrapped log handler', () => {
	test('decodes every DNS-encoded label of the wrapped name', () => {
		const wrapped = handleNameWrapped(nameWrappedEvent(dnsEncode(['sub', 'vitalik', 'eth'])))
		assert.equal(wrapped.name, 'sub.vitalik.eth')
		assert.equal(wrapped.owner, owner)
		assert.equal(wrapped.expires, 1_800_000_000n)
	})

	test('decodes multi-byte UTF-8 labels', () => {
		assert.equal(handleNameWrapped(nameWrappedEvent(dnsEncode(['ünïcødé', 'eth']))).name, 'ünïcødé.eth')
	})

	test('stops at the terminating zero-length label', () => {
		const encodedName = new Uint8Array([...dnsEncode(['vitalik', 'eth']), ...dnsEncode(['ignored'])])
		assert.equal(handleNameWrapped(nameWrappedEvent(encodedName)).name, 'vitalik.eth')
	})
})
