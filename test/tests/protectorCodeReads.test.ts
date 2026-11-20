import { test } from 'bun:test'
import * as assert from 'assert'
import { getCodeOrError } from '../../app/ts/simulation/protectors/codeVerification.js'
import type { ProtectorChainReads } from '../../app/ts/simulation/protectorTypes.js'
import type { IdentifyAddress } from '../../app/ts/types/metadataLookups.js'

const address = 123n
const identify: IdentifyAddress = async (address) => ({ address, type: 'contact', name: 'Recipient', entrySource: 'OnChain', chainId: 1n })
const noGasPriceRead = async (): Promise<bigint> => { throw new Error('Unexpected gas price read') }

const codeStates: readonly ('present' | 'absent')[] = ['present', 'absent']
for (const code of codeStates) {
	test(`protector code lookup preserves ${ code } without identifying the address`, async () => {
		const reads: ProtectorChainReads = { readCode: async () => code, readGasPrice: noGasPriceRead }
		assert.deepEqual(await getCodeOrError(reads, async () => { throw new Error('Unexpected address identification') }, address), { statusCode: 'success', hasCode: code === 'present' })
	})
}

test('an unverified code lookup retains the named warning instead of treating it as an EOA', async () => {
	const reads: ProtectorChainReads = { readCode: async () => 'unverified', readGasPrice: noGasPriceRead }
	assert.deepEqual(await getCodeOrError(reads, identify, address), { statusCode: 'failure', message: 'Failed to verify whether address 123(Recipient) contains code or not.' })
})

test('unexpected code-read failures propagate', async () => {
	const failure = new Error('Unexpected code read failure')
	const reads: ProtectorChainReads = { readCode: async () => { throw failure }, readGasPrice: noGasPriceRead }
	await assert.rejects(getCodeOrError(reads, identify, address), (error) => error === failure)
})
