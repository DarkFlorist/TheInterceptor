import { describe, test } from 'bun:test'
import * as assert from 'assert'
import { decodeGovernanceVote } from '../../app/ts/utils/governanceVote.js'
import { FourByteExplanations } from '../../app/ts/utils/constants.js'
import { encodeAbiValues } from '../../app/ts/utils/abiRuntime.js'
import { stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { concat, toFunctionSelector } from '../../app/ts/utils/ethereumPrimitives.js'

const VOTER = 0x1111111111111111111111111111111111111111n
const R = `0x${ '22'.repeat(32) }` as const
const S = `0x${ '33'.repeat(32) }` as const

const fourByteOf = (signature: string) => Number(toFunctionSelector(signature))
// Several vote functions share a name and argument count, so the call data is built from the full signature.
const voteCall = (signature: string, values: readonly unknown[]) => concat([toFunctionSelector(signature), encodeAbiValues(signature.slice(signature.indexOf('(') + 1, -1).split(','), values)])
const decodeVote = (signature: string, values: readonly unknown[]) => decodeGovernanceVote(stringToUint8Array(voteCall(signature, values)))

describe('governance vote identification', () => {
	test('names every vote function the preview supports, including the OpenZeppelin 5 vote by signature', () => {
		const voteSignatures = [
			['castVote(uint256,bool)', 'Cast Vote'],
			['castVote(uint256,uint8)', 'Cast Vote'],
			['castVoteBySig(uint256,uint8,uint8,bytes32,bytes32)', 'Cast Vote by Signature'],
			['castVoteBySig(uint256,uint8,address,bytes)', 'Cast Vote by Signature'],
			['castVoteWithReasonAndParamsBySig(uint256,uint8,string,bytes,uint8,bytes32,bytes32)', 'Cast Vote with Reason And Additional Info by Signature'],
			['castVoteWithReasonAndParamsBySig(uint256,uint8,address,string,bytes,bytes)', 'Cast Vote with Reason And Additional Info by Signature'],
		] as const
		for (const [signature, explanation] of voteSignatures) assert.equal(FourByteExplanations[fourByteOf(signature)], explanation, signature)
	})

	test('decodes GovernorAlpha and GovernorBravo votes', () => {
		assert.deepEqual(decodeVote('castVote(uint256,bool)', [7n, true]), { proposalId: 7n, support: true, reason: undefined, params: undefined, signature: undefined, voter: undefined })
		assert.deepEqual(decodeVote('castVote(uint256,uint8)', [8n, 2n]), { proposalId: 8n, support: 2n, reason: undefined, params: undefined, signature: undefined, voter: undefined })
		assert.equal(decodeVote('castVoteBySig(uint256,uint8,uint8,bytes32,bytes32)', [9n, 1n, 27n, R, S])?.proposalId, 9n)
		assert.equal(decodeVote('castVoteWithReasonAndParamsBySig(uint256,uint8,string,bytes,uint8,bytes32,bytes32)', [11n, 1n, 'reason', '0x', 27n, R, S])?.reason, 'reason')
	})

	test('decodes the voter of an OpenZeppelin 5 vote by signature', () => {
		const vote = decodeVote('castVoteBySig(uint256,uint8,address,bytes)', [10n, 0n, `0x${ VOTER.toString(16) }`, '0x1234'])
		assert.equal(vote?.proposalId, 10n)
		assert.equal(vote?.voter, VOTER)
		assert.deepEqual(vote?.signature, stringToUint8Array('0x1234'))
	})

	test('does not identify other calls, or a vote selector with arguments that do not decode, as votes', () => {
		assert.equal(decodeGovernanceVote(stringToUint8Array('0xa9059cbb')), undefined)
		assert.equal(decodeGovernanceVote(stringToUint8Array(voteCall('castVote(uint256,uint8)', [8n, 2n]).slice(0, 20))), undefined)
	})
})
