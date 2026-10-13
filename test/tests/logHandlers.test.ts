import { describe, test } from 'bun:test'
import * as assert from 'node:assert'
import { handleApprovalLog, handleDepositLog, handleERC1155TransferBatch, handleERC1155TransferSingle, handleERC20TransferLog, handleErc721ApprovalForAllLog, handleWithdrawalLog } from '../../app/ts/simulation/logHandlers.js'
import type { EthereumEvent } from '../../app/ts/types/ethSimulate-types.js'
import { encodeAbiValues } from '../../app/ts/utils/abiRuntime.js'
import { addressString, stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { Erc1155ABI } from '../../app/ts/utils/abi.js'
import { parseEventIfPossible } from '../../app/ts/simulation/services/simulationTokenBalanceQueries.js'
import { APPROVAL_LOG, DEPOSIT_LOG, ERC1155_TRANSFERBATCH_LOG, ERC1155_TRANSFERSINGLE_LOG, ERC721_APPROVAL_FOR_ALL_LOG, TRANSFER_LOG, WITHDRAWAL_LOG } from '../../app/ts/utils/constants.js'

const TOKEN_ADDRESS = 0x5555555555555555555555555555555555555555n
const ALICE = 0x1111111111111111111111111111111111111111n
const BOB = 0x2222222222222222222222222222222222222222n
const OPERATOR = 0x3333333333333333333333333333333333333333n
const MAX_UINT256 = 2n ** 256n - 1n

const encodeData = (types: readonly string[], values: readonly unknown[]) => stringToUint8Array(encodeAbiValues(types, values))

const createLog = (signature: `0x${ string }`, indexedTopics: readonly bigint[], data = new Uint8Array()): EthereumEvent => ({
	address: TOKEN_ADDRESS,
	topics: [BigInt(signature), ...indexedTopics],
	data,
})

describe('handleERC20TransferLog', () => {
	test('decodes an ERC20 Transfer amount from the log data', () => {
		const log = createLog(TRANSFER_LOG, [ALICE, BOB], encodeData(['uint256'], [1234n]))

		assert.deepStrictEqual(handleERC20TransferLog(log), [{
			from: ALICE,
			to: BOB,
			tokenAddress: TOKEN_ADDRESS,
			isApproval: false,
			originalLogObject: log,
			amount: 1234n,
			type: 'ERC20',
		}])
	})

	test('decodes an ERC721 Transfer token id from the third indexed topic', () => {
		const log = createLog(TRANSFER_LOG, [ALICE, BOB, 42n])

		assert.deepStrictEqual(handleERC20TransferLog(log), [{
			from: ALICE,
			to: BOB,
			tokenAddress: TOKEN_ADDRESS,
			isApproval: false,
			originalLogObject: log,
			tokenId: 42n,
			type: 'ERC721',
		}])
	})

	test('rejects Transfer logs without a recipient topic', () => {
		const log = createLog(TRANSFER_LOG, [ALICE], encodeData(['uint256'], [1n]))

		assert.throws(() => handleERC20TransferLog(log), /unknown log/)
	})
})

describe('handleApprovalLog', () => {
	test('decodes an ERC20 Approval allowance from the log data', () => {
		const log = createLog(APPROVAL_LOG, [ALICE, OPERATOR], encodeData(['uint256'], [MAX_UINT256]))

		assert.deepStrictEqual(handleApprovalLog(log), [{
			from: ALICE,
			to: OPERATOR,
			tokenAddress: TOKEN_ADDRESS,
			isApproval: true,
			originalLogObject: log,
			amount: MAX_UINT256,
			type: 'ERC20',
		}])
	})

	test('decodes an ERC721 Approval token id from the third indexed topic', () => {
		const log = createLog(APPROVAL_LOG, [ALICE, OPERATOR, 7n])

		assert.deepStrictEqual(handleApprovalLog(log), [{
			from: ALICE,
			to: OPERATOR,
			tokenAddress: TOKEN_ADDRESS,
			isApproval: true,
			originalLogObject: log,
			tokenId: 7n,
			type: 'ERC721',
		}])
	})

	test('rejects Approval logs without a spender topic', () => {
		const log = createLog(APPROVAL_LOG, [ALICE], encodeData(['uint256'], [1n]))

		assert.throws(() => handleApprovalLog(log), /unknown log/)
	})
})

describe('handleErc721ApprovalForAllLog', () => {
	test('decodes an ApprovalForAll grant from owner to operator', () => {
		const log = createLog(ERC721_APPROVAL_FOR_ALL_LOG, [ALICE, OPERATOR], encodeData(['bool'], [true]))

		assert.deepStrictEqual(handleErc721ApprovalForAllLog(log), [{
			from: ALICE,
			to: OPERATOR,
			tokenAddress: TOKEN_ADDRESS,
			type: 'NFT All approval',
			isApproval: true,
			allApprovalAdded: true,
		}])
	})

	test('decodes an ApprovalForAll revocation from the approved flag in the log data', () => {
		const log = createLog(ERC721_APPROVAL_FOR_ALL_LOG, [ALICE, OPERATOR], encodeData(['bool'], [false]))

		assert.deepStrictEqual(handleErc721ApprovalForAllLog(log), [{
			from: ALICE,
			to: OPERATOR,
			tokenAddress: TOKEN_ADDRESS,
			type: 'NFT All approval',
			isApproval: true,
			allApprovalAdded: false,
		}])
	})

	test('reads the approved flag from a fourth topic when a contract indexes it and leaves the log data empty', () => {
		const grantedApproval = { from: ALICE, to: OPERATOR, tokenAddress: TOKEN_ADDRESS, type: 'NFT All approval', isApproval: true, allApprovalAdded: true }

		assert.deepStrictEqual(handleErc721ApprovalForAllLog(createLog(ERC721_APPROVAL_FOR_ALL_LOG, [ALICE, OPERATOR, 1n])), [grantedApproval])
		assert.deepStrictEqual(handleErc721ApprovalForAllLog(createLog(ERC721_APPROVAL_FOR_ALL_LOG, [ALICE, OPERATOR, 0n])), [{ ...grantedApproval, allApprovalAdded: false }])
	})

	test('prefers an indexed approved flag over the log data', () => {
		const revokedTopicWithGrantedData = createLog(ERC721_APPROVAL_FOR_ALL_LOG, [ALICE, OPERATOR, 0n], encodeData(['bool'], [true]))

		assert.deepStrictEqual(handleErc721ApprovalForAllLog(revokedTopicWithGrantedData), [{
			from: ALICE,
			to: OPERATOR,
			tokenAddress: TOKEN_ADDRESS,
			type: 'NFT All approval',
			isApproval: true,
			allApprovalAdded: false,
		}])
	})

	test('rejects ApprovalForAll logs without an operator topic', () => {
		const log = createLog(ERC721_APPROVAL_FOR_ALL_LOG, [ALICE], encodeData(['bool'], [true]))

		assert.throws(() => handleErc721ApprovalForAllLog(log), /unknown log/)
	})
})

describe('wrapped ether Deposit and Withdrawal logs', () => {
	test('treats a Deposit as a transfer from the wrapper contract to the depositor', () => {
		const log = createLog(DEPOSIT_LOG, [ALICE], encodeData(['uint256'], [5n * 10n ** 18n]))

		assert.deepStrictEqual(handleDepositLog(log), [{
			from: TOKEN_ADDRESS,
			to: ALICE,
			tokenAddress: TOKEN_ADDRESS,
			isApproval: false,
			amount: 5n * 10n ** 18n,
			type: 'ERC20',
		}])
	})

	test('treats a Withdrawal as a transfer from the withdrawer to the wrapper contract', () => {
		const log = createLog(WITHDRAWAL_LOG, [ALICE], encodeData(['uint256'], [3n * 10n ** 18n]))

		assert.deepStrictEqual(handleWithdrawalLog(log), [{
			from: ALICE,
			to: TOKEN_ADDRESS,
			tokenAddress: TOKEN_ADDRESS,
			isApproval: false,
			amount: 3n * 10n ** 18n,
			type: 'ERC20',
		}])
	})

	test('rejects Deposit and Withdrawal logs without an account topic', () => {
		const amount = encodeData(['uint256'], [1n])

		assert.throws(() => handleDepositLog(createLog(DEPOSIT_LOG, [], amount)), /unknown log/)
		assert.throws(() => handleWithdrawalLog(createLog(WITHDRAWAL_LOG, [], amount)), /unknown log/)
	})
})

describe('handleERC1155TransferSingle', () => {
	test('decodes operator, sender and recipient topics plus token id and amount data', () => {
		const log = createLog(ERC1155_TRANSFERSINGLE_LOG, [OPERATOR, ALICE, BOB], encodeData(['uint256', 'uint256'], [77n, 3n]))

		assert.deepStrictEqual(handleERC1155TransferSingle(log), [{
			type: 'ERC1155',
			operator: OPERATOR,
			from: ALICE,
			to: BOB,
			tokenAddress: TOKEN_ADDRESS,
			isApproval: false,
			tokenId: 77n,
			amount: 3n,
		}])
	})

	test('decodes TransferSingle with the ERC1155 ABI used for event parsing', () => {
		const log = createLog(ERC1155_TRANSFERSINGLE_LOG, [OPERATOR, ALICE, BOB], encodeData(['uint256', 'uint256'], [77n, 3n]))
		const parsed = parseEventIfPossible(Erc1155ABI, log)

		assert.equal(parsed?.name, 'TransferSingle')
		assert.deepStrictEqual(parsed?.args, [addressString(OPERATOR), addressString(ALICE), addressString(BOB), 77n, 3n])
	})

	test('rejects TransferSingle logs without a recipient topic', () => {
		const log = createLog(ERC1155_TRANSFERSINGLE_LOG, [OPERATOR, ALICE], encodeData(['uint256', 'uint256'], [77n, 3n]))

		assert.throws(() => handleERC1155TransferSingle(log), /Malformed ERC1155 TransferSingle Event/)
	})
})

describe('handleERC1155TransferBatch', () => {
	test('returns one transfer per token id and amount pair', () => {
		const log = createLog(ERC1155_TRANSFERBATCH_LOG, [OPERATOR, ALICE, BOB], encodeData(['uint256[]', 'uint256[]'], [[1n, 2n], [10n, 20n]]))
		const sharedFields = { type: 'ERC1155', operator: OPERATOR, from: ALICE, to: BOB, tokenAddress: TOKEN_ADDRESS, isApproval: false, originalLogObject: log }

		assert.deepStrictEqual(handleERC1155TransferBatch(log), [
			{ ...sharedFields, tokenId: 1n, amount: 10n },
			{ ...sharedFields, tokenId: 2n, amount: 20n },
		])
	})

	test('returns no transfers for an empty batch', () => {
		const log = createLog(ERC1155_TRANSFERBATCH_LOG, [OPERATOR, ALICE, BOB], encodeData(['uint256[]', 'uint256[]'], [[], []]))

		assert.deepStrictEqual(handleERC1155TransferBatch(log), [])
	})

	test('rejects batches with fewer amounts than token ids', () => {
		const log = createLog(ERC1155_TRANSFERBATCH_LOG, [OPERATOR, ALICE, BOB], encodeData(['uint256[]', 'uint256[]'], [[1n, 2n], [10n]]))

		assert.throws(() => handleERC1155TransferBatch(log), /Malformed ERC1155 TransferBatch Event/)
	})

	test('rejects TransferBatch logs without a recipient topic', () => {
		const log = createLog(ERC1155_TRANSFERBATCH_LOG, [OPERATOR, ALICE], encodeData(['uint256[]', 'uint256[]'], [[1n], [10n]]))

		assert.throws(() => handleERC1155TransferBatch(log), /Malformed ERC1155 TransferBatch Event/)
	})

	test('rejects logs that are not TransferBatch events', () => {
		const log = createLog(ERC1155_TRANSFERSINGLE_LOG, [OPERATOR, ALICE, BOB], encodeData(['uint256[]', 'uint256[]'], [[1n], [10n]]))

		assert.throws(() => handleERC1155TransferBatch(log))
	})
})
