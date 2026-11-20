import * as assert from 'node:assert'
import { test } from 'bun:test'
import type { EnrichedEthereumEvents } from '../../app/ts/types/EnrichedEthereumData.js'
import type { MetadataLookups } from '../../app/ts/types/metadataLookups.js'
import { ENS_TOKEN_WRAPPER } from '../../app/ts/utils/constants.js'
import { namehash } from '../../app/ts/utils/ethereumPrimitives.js'
import { simulator } from './confirmTransactionTestHarness.js'

const { lookUpMetadataOnChain, nameTokenIds } = await import('../../app/ts/background/metadataUtils.js')
const name = 'lookup-chain-regression.eth'
const tokenId = BigInt(namehash(name))
const events: EnrichedEthereumEvents = [{
	type: 'TokenEvent', isParsed: 'Parsed', name: 'TransferSingle', signature: 'TransferSingle(address,address,address,uint256,uint256)', args: [], address: ENS_TOKEN_WRAPPER,
	loggersAddressBookEntry: { type: 'contract', address: ENS_TOKEN_WRAPPER, name: 'ENS wrapper', entrySource: 'OnChain', chainId: 1n },
	data: new Uint8Array(), topics: [],
	logInformation: { type: 'ERC1155', from: 1n, to: 2n, operator: 1n, tokenAddress: ENS_TOKEN_WRAPPER, tokenId, amount: 1n, isApproval: false },
}]

test('ENS token naming uses the chain owned by its lookup bundle', async () => {
	const requestedHashes: bigint[] = []
	const lookups: MetadataLookups = {
		chainId: 2n,
		identifyAddress: async () => { throw new Error('Token naming must not identify addresses') },
		lookUpEnsName: async (hash) => { requestedHashes.push(hash); return name },
	}
	assert.deepEqual(await nameTokenIds(lookups, events), [])
	assert.deepEqual(requestedHashes, [])
	assert.deepEqual(await nameTokenIds({ ...lookups, chainId: 1n }, events), [{ tokenAddress: ENS_TOKEN_WRAPPER, tokenId, tokenIdName: name }])
	assert.deepEqual(requestedHashes, [tokenId])
})

test('live lookup bundles carry the chain of their bound client', () => {
	assert.equal(lookUpMetadataOnChain(simulator.ethereum, undefined).chainId, simulator.ethereum.getChainId())
})
