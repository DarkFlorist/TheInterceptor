import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { formSimulatedAndVisualizedTransactions } from '../../app/ts/components/formVisualizerResults.js'
import { mockSignTransaction } from '../../app/ts/simulation/services/simulationTransactionSigning.js'
import { encodeErrorString } from './errorDataFixtures.js'
import { stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { toFunctionSelector } from '../../app/ts/utils/ethereumPrimitives.js'

const senderAddress = 0x1111111111111111111111111111111111111111n
const routerAddress = 0x2222222222222222222222222222222222222222n
const rpcNetwork = { name: 'Ethereum Mainnet', chainId: 1n, httpsRpc: 'https://rpc.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
const website = { websiteOrigin: 'https://example.com', icon: undefined, title: undefined }

const getSimulatedFailureReason = (revertData: string, routerAbi: string | undefined) => {
	const transaction = {
		type: '1559' as const,
		from: senderAddress,
		chainId: 1n,
		nonce: 0n,
		maxFeePerGas: 1n,
		maxPriorityFeePerGas: 1n,
		gas: 100_000n,
		to: routerAddress,
		value: 0n,
		input: new Uint8Array(),
		accessList: [],
	}
	const simulatedTransaction = {
		realizedGasPrice: 1n,
		preSimulationTransaction: {
			signedTransaction: mockSignTransaction(transaction),
			website,
			created: new Date('2024-01-01T00:00:00.000Z'),
			originalRequestParameters: { method: 'eth_sendTransaction' as const, params: [{ from: senderAddress, to: routerAddress, value: 0n, input: new Uint8Array() }] as const },
			transactionIdentifier: 1n,
		},
		ethSimulateV1CallResult: { status: 'failure' as const, returnData: stringToUint8Array(revertData), gasUsed: 50_000n, error: { code: 3, message: 'execution reverted', data: revertData } },
		tokenBalancesAfter: [],
	}
	const addressBookEntries = [
		{ type: 'contact' as const, name: 'Sender', address: senderAddress, entrySource: 'User' as const },
		{ type: 'contract' as const, name: 'Router', address: routerAddress, entrySource: 'User' as const, ...(routerAbi === undefined ? {} : { abi: routerAbi }) },
	]
	const [visualizedTransaction] = formSimulatedAndVisualizedTransactions(
		[simulatedTransaction],
		[[]],
		rpcNetwork,
		[{ type: 'NonParsed', input: new Uint8Array() }],
		[{ quarantine: false, quarantineReasons: [] }],
		addressBookEntries,
		[],
		{ ensNameHashes: [], ensLabelHashes: [] },
		[],
		undefined,
		new Map(),
	)
	if (visualizedTransaction === undefined || visualizedTransaction.transactionStatus !== 'Transaction Failed') throw new Error('Expected a failed simulated transaction')
	return visualizedTransaction.error.decodedErrorMessage
}

describe('simulated transaction failure reasons', () => {
	test('explain Uniswap V3 revert codes in failed simulated rows', () => {
		assert.equal(getSimulatedFailureReason(encodeErrorString('STF'), undefined), 'STF - possible Uniswap V3 error: Token transfer from the sender via safeTransferFrom failed, usually due to insufficient token balance or allowance')
	})

	test('decode custom errors with ABIs from the simulation address book without protocol hints', () => {
		const routerAbi = JSON.stringify([{ type: 'error', name: 'STF', inputs: [] }])
		assert.equal(getSimulatedFailureReason(toFunctionSelector('STF()'), routerAbi), 'STF')
	})
})
